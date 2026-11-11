import type { BlockStat, LogLine, NodeState, NodeStatus, ServerMessage } from '../../shared/types.ts';
import { parseBlock, type RawBlock } from './blocks.ts';
import { appConfig, BACKFILL_BLOCKS, FAST_POLL_MS, HISTORY_BLOCKS, POLL_MS } from './config.ts';
import { fetchBlock, probe } from './probe.ts';

/** A round no chain has reached: asking for it returns the node's height in X-Latest-Round */
const FAR_ROUND = 2 ** 40;
const OFFLINE_AFTER = 3;
const FLUSH_MS = 250;
const V6_CHECK_MS = 60_000;
const EWMA = 0.2;
const FAR_BEHIND = 20;
/** Fast polling starts this long before the next block is expected */
const DUE_LEAD_MS = 900;

interface Runtime {
  fails: number;
  stopped: boolean;
  rttSent: number;
  propSent: number;
  /** A warning was logged for this node and not yet cleared */
  flagged: boolean;
}

interface RoundSeen {
  t0: number;
  first: string;
  seen: Map<string, number>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (addr: string) => (addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '?');

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/**
 * Owns all state: nodes, chain tip, per-round propagation and the block ring.
 * Every node is polled by one sequential loop, however many browsers are connected.
 */
export class Monitor {
  readonly nodes = new Map<string, NodeState>();
  private rt = new Map<string, Runtime>();
  tip = 0;
  blocks: BlockStat[] = [];
  bootLines: string[] = [];
  ready = false;
  private logs: LogLine[] = [];

  private rounds = new Map<number, RoundSeen>();
  private raw = new Map<number, RawBlock & { at: number }>();
  private emitted = new Set<number>();
  private fetching = new Set<number>();
  private backfillDone = false;
  private backfillFloor = 0;
  /** Propagation is only measured once the first sweep is over */
  private liveAt = Number.POSITIVE_INFINITY;

  private add: NodeState[] = [];
  private patch: Record<string, Partial<NodeState>> = {};
  private remove: string[] = [];
  private tipDirty = false;
  /** When the tip last moved and the smoothed time between tips, for the fast-poll window */
  private tipAt = 0;
  private tipEvery = 2800;

  constructor(private send: (msg: ServerMessage) => void) {
    setInterval(() => this.flush(), FLUSH_MS);
    setInterval(() => void this.checkV6(), V6_CHECK_MS);
  }

  // ─── output ────────────────────────────────────────────────────────────────

  hello(): ServerMessage {
    return {
      type: 'hello',
      config: appConfig,
      boot: this.bootLines,
      ready: this.ready,
      nodes: [...this.nodes.values()],
      blocks: this.blocks,
      tip: this.tip,
      logs: this.logs.slice(-60),
    };
  }

  boot(line: string): void {
    console.log(line);
    this.bootLines.push(line);
    if (this.bootLines.length > 200) this.bootLines.shift();
    this.send({ type: 'boot', line });
  }

  log(message: string, level: LogLine['level'] = 'info'): void {
    const line: LogLine = { message, level, ts: Date.now() };
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.send({ type: 'log', ...line });
  }

  private touch(id: string, patch: Partial<NodeState>): void {
    this.patch[id] = { ...this.patch[id], ...patch };
  }

  private flush(): void {
    const hasPatch = Object.keys(this.patch).length > 0;
    if (!hasPatch && !this.add.length && !this.remove.length && !this.tipDirty) return;
    this.send({
      type: 'nodes',
      add: this.add.length ? this.add : undefined,
      patch: hasPatch ? this.patch : undefined,
      remove: this.remove.length ? this.remove : undefined,
      tip: this.tipDirty ? this.tip : undefined,
    });
    this.add = [];
    this.patch = {};
    this.remove = [];
    this.tipDirty = false;
  }

  // ─── membership ────────────────────────────────────────────────────────────

  /** Replace the node set with what discovery found: add new hosts, drop vanished ones. */
  sync(found: NodeState[], complete: boolean): void {
    const ids = new Set(found.map((n) => n.id));
    for (const n of found) {
      const have = this.nodes.get(n.id);
      if (have) {
        // keep runtime figures, refresh address and location
        const { ip, ip6, lat, lng, country, countryCode, city, net } = n;
        if (have.ip !== ip || have.ip6 !== ip6 || have.lat !== lat || have.city !== city) {
          Object.assign(have, { ip, ip6, lat, lng, country, countryCode, city, net });
          this.touch(n.id, { ip, ip6, lat, lng, country, countryCode, city, net });
        }
        continue;
      }
      this.nodes.set(n.id, n);
      this.add.push(n);
      const rt: Runtime = { fails: 0, stopped: false, rttSent: 0, propSent: 0, flagged: false };
      this.rt.set(n.id, rt);
      void this.run(n, rt);
    }
    if (complete) {
      for (const id of [...this.nodes.keys()]) {
        if (ids.has(id)) continue;
        this.rt.get(id)!.stopped = true;
        this.rt.delete(id);
        this.nodes.delete(id);
        this.remove.push(id);
        this.log(`[DNS] ${id} left the SRV records — removed`, 'warn');
      }
    }
    if (this.liveAt === Number.POSITIVE_INFINITY) this.liveAt = Date.now() + 8000;
  }

  // ─── polling ───────────────────────────────────────────────────────────────

  private async run(node: NodeState, rt: Runtime): Promise<void> {
    await sleep(Math.random() * POLL_MS);
    while (!rt.stopped) {
      const want = node.lastBlock > 0 ? node.lastBlock + 1 : FAR_ROUND;
      const r = await probe(node.ip, node.port, want);
      if (rt.stopped) return;
      // the node answered about half a round trip ago
      const now = Date.now() - r.rtt / 2;
      let again = false;

      if (r.alive) {
        rt.fails = 0;
        node.rtt = node.rtt ? node.rtt + EWMA * (r.rtt - node.rtt) : r.rtt;
        if (Math.abs(node.rtt - rt.rttSent) > Math.max(3, rt.rttSent * 0.1)) {
          rt.rttSent = node.rtt;
          this.touch(node.id, { rtt: Math.round(node.rtt) });
        }
        if (node.err) {
          node.err = undefined;
          this.touch(node.id, { err: '' });
        }
        if (r.has) {
          this.advance(node, rt, want, now);
          again = true; // it may have more
        } else if (r.latest !== undefined) {
          if (r.latest !== node.lastBlock) this.advance(node, rt, r.latest, now);
        } else if (node.lastBlock === 0 && this.tip > 0) {
          // older node without X-Latest-Round: see whether it has the tip or the round before
          for (const round of [this.tip, this.tip - 1]) {
            if ((await probe(node.ip, node.port, round)).has) {
              this.advance(node, rt, round, Date.now());
              break;
            }
          }
        }
      } else {
        rt.fails++;
        if (rt.fails === OFFLINE_AFTER) {
          node.err = r.err ?? 'error';
          this.touch(node.id, { err: node.err });
          this.log(`[${node.type.toUpperCase()}] ${node.label} (${node.ip}) no answer: ${node.err}`, 'warn');
        }
      }

      this.restatus(node, rt);
      if (again) continue;
      if (rt.fails >= OFFLINE_AFTER) {
        await sleep(Math.min(15_000, POLL_MS * 2 ** (rt.fails - 1)) * (0.9 + Math.random() * 0.2));
      } else {
        await sleep(this.pause(node));
      }
    }
  }

  /**
   * Poll slowly while nothing can happen and every FAST_POLL_MS from shortly
   * before the next block is expected until this node has it.
   */
  private pause(node: NodeState): number {
    if (this.tip === 0 || !this.tipAt) return POLL_MS;
    const now = Date.now();
    if (node.lastBlock < this.tip) return this.tip - node.lastBlock > 3 ? POLL_MS : FAST_POLL_MS;
    const dueIn = this.tipAt + this.tipEvery - DUE_LEAD_MS - now;
    if (dueIn <= 0) return now - this.tipAt > this.tipEvery * 4 ? POLL_MS : FAST_POLL_MS; // stalled chain: back off
    return Math.min(POLL_MS, dueIn) + Math.random() * FAST_POLL_MS;
  }

  private status(node: NodeState, rt: Runtime): NodeStatus {
    if (rt.fails >= OFFLINE_AFTER) return 'offline';
    if (node.lastBlock === 0 || this.tip === 0) return 'unknown';
    const lag = this.tip - node.lastBlock;
    if (lag <= 1) return 'synced';
    if (lag <= 3) return 'lagging';
    return 'behind';
  }

  private restatus(node: NodeState, rt: Runtime): void {
    const s = this.status(node, rt);
    if (s === node.status) return;
    const was = node.status;
    node.status = s;
    this.touch(node.id, { status: s });
    // a few rounds of lag come and go; only far-behind and unreachable nodes are worth a line
    const tag = `[${node.type.toUpperCase()}] ${node.label}`;
    const lag = this.tip - node.lastBlock;
    if (s === 'behind' && lag > FAR_BEHIND && !rt.flagged) {
      rt.flagged = true;
      this.log(`${tag} is ${lag.toLocaleString('en-US')} rounds behind`, 'warn');
    } else if ((s === 'synced' || s === 'lagging') && (was === 'offline' || rt.flagged)) {
      rt.flagged = false;
      this.log(`${tag} recovered → ${s}`, 'info');
    }
  }

  private advance(node: NodeState, rt: Runtime, round: number, now: number): void {
    const old = node.lastBlock;
    if (this.tip > 0 && round > this.tip + 1000) {
      // one node claiming a far future round must not move the tip
      console.warn(`[MONITOR] ${node.label} claims round ${round}, tip is ${this.tip} — ignored`);
      return;
    }
    node.lastBlock = round;
    this.touch(node.id, { lastBlock: round });
    if (round > this.tip) this.newTip(round, node, now);
    if (round <= old) return;

    for (let r = Math.max(old + 1, round - 2); r <= round; r++) {
      const entry = this.rounds.get(r);
      if (!entry || entry.seen.has(node.id)) continue;
      const delay = now - entry.t0;
      entry.seen.set(node.id, delay);
      if (r === round && delay < 20_000) {
        node.prop = node.prop ? node.prop + EWMA * (delay - node.prop) : delay;
        if (Math.abs(node.prop - rt.propSent) > Math.max(10, rt.propSent * 0.1)) {
          rt.propSent = node.prop;
          this.touch(node.id, { prop: Math.round(node.prop) });
        }
      }
    }
  }

  private newTip(round: number, node: NodeState, now: number): void {
    const prev = this.tip;
    this.tip = round;
    this.tipDirty = true;
    if (this.tipAt && round === prev + 1) {
      const gap = Math.min(10_000, now - this.tipAt);
      this.tipEvery += EWMA * (gap - this.tipEvery);
    }
    this.tipAt = now;

    if (now >= this.liveAt) {
      this.rounds.set(round, { t0: now, first: node.id, seen: new Map([[node.id, 0]]) });
      node.firsts++;
      this.touch(node.id, { firsts: node.firsts });
      this.closeRound(round - 2);
      for (const r of this.rounds.keys()) if (r < round - 8) this.rounds.delete(r);
    }

    for (const [id, n] of this.nodes) this.restatus(n, this.rt.get(id)!);

    const from = prev > 0 ? Math.max(prev + 1, round - 4) : round;
    for (let r = from; r <= round; r++) void this.loadBlock(r, node);
    if (prev === 0) void this.backfill(round);
  }

  /** Propagation summary for a round, once two newer rounds exist. */
  private closeRound(round: number): void {
    const entry = this.rounds.get(round);
    if (!entry) return;
    const delays = [...entry.seen.values()].filter((d) => d > 0).sort((a, b) => a - b);
    const patch = {
      p50: Math.round(quantile(delays, 0.5)),
      p90: Math.round(quantile(delays, 0.9)),
      reach: entry.seen.size,
    };
    const block = this.blocks.find((b) => b.round === round);
    if (block) Object.assign(block, patch);
    this.send({ type: 'block_patch', round, patch });
  }

  // ─── blocks ────────────────────────────────────────────────────────────────

  /** Nodes worth asking for a block: the given one first, then synced archivers, then synced relays. */
  private sources(prefer?: NodeState): NodeState[] {
    const synced = [...this.nodes.values()].filter((n) => n.status === 'synced' && n !== prefer);
    synced.sort((a, b) => (a.type === b.type ? a.rtt - b.rtt : a.type === 'archiver' ? -1 : 1));
    return prefer ? [prefer, ...synced] : synced;
  }

  private async loadBlock(round: number, prefer?: NodeState, tries = 4): Promise<boolean> {
    if (this.raw.has(round) || this.fetching.has(round)) return true;
    this.fetching.add(round);
    try {
      for (const src of this.sources(prefer).slice(0, tries)) {
        const body = await fetchBlock(src.ip, src.port, round);
        if (!body) continue;
        try {
          const parsed = parseBlock(body);
          if (parsed.round !== round) continue;
          this.raw.set(round, { ...parsed, at: Date.now() });
          this.finalize();
          return true;
        } catch (err) {
          console.warn(`[BLOCK] ${round} from ${src.label}: ${err instanceof Error ? err.message : err}`);
        }
      }
      return false;
    } finally {
      this.fetching.delete(round);
    }
  }

  private async backfill(tip: number): Promise<void> {
    await sleep(1500); // let the first sweep find synced nodes
    const floor = Math.max(1, tip - BACKFILL_BLOCKS);
    this.backfillFloor = floor;
    const queue: number[] = [];
    for (let r = tip; r >= floor; r--) queue.push(r);
    const pool = this.sources().slice(0, 8);
    this.log(`[BLOCKS] Loading ${queue.length} recent blocks for the charts…`);
    await Promise.all(
      (pool.length ? pool : [undefined]).map(async (src) => {
        for (let r = queue.shift(); r !== undefined; r = queue.shift()) await this.loadBlock(r, src, 3);
      }),
    );
    this.backfillDone = true;
    this.finalize();
    this.log(`[BLOCKS] History ready: ${this.blocks.length} blocks`);
  }

  /** Turn fetched blocks into BlockStat as soon as the parent's counter is known. */
  private finalize(): void {
    const pending = [...this.raw.keys()].filter((r) => !this.emitted.has(r)).sort((a, b) => a - b);
    const now = Date.now();
    for (const round of pending) {
      const raw = this.raw.get(round)!;
      const parent = this.raw.get(round - 1);
      if (round === this.backfillFloor) {
        this.emitted.add(round); // only fetched for its counter
        continue;
      }
      // without the parent, wait for it; give up after 3 s and count top-level only
      if (!parent && !(this.backfillDone && now - raw.at > 3000)) continue;
      const seen = this.rounds.get(round);
      const { at: _at, ...rest } = raw;
      const stat: BlockStat = {
        ...rest,
        txns: parent && raw.tc >= parent.tc ? raw.tc - parent.tc : raw.top,
        seenAt: Math.round(seen?.t0 ?? 0),
        first: seen?.first,
      };
      this.emitted.add(round);
      this.insert(stat);
      this.send({ type: 'block', block: stat });
      if (seen) {
        const kb = (stat.bytes / 1024).toFixed(0);
        this.log(
          `[BLOCK] #${round.toLocaleString('en-US')} · ${stat.txns} txns · ${kb} KB · ${stat.votes} votes · proposer ${short(stat.proposer)}`,
        );
      }
    }
    if (pending.length && this.backfillDone && pending.some((r) => !this.emitted.has(r))) {
      setTimeout(() => this.finalize(), 3100);
    }
    const floor = this.tip - HISTORY_BLOCKS - 8;
    for (const r of this.raw.keys()) if (r < floor) this.raw.delete(r);
    for (const r of this.emitted) if (r < floor) this.emitted.delete(r);
    if (!this.ready && this.backfillDone) {
      this.ready = true;
      this.send({ type: 'ready' });
    }
  }

  private insert(stat: BlockStat): void {
    const b = this.blocks;
    let i = b.length;
    while (i > 0 && b[i - 1]!.round > stat.round) i--;
    if (b[i - 1]?.round === stat.round) return;
    b.splice(i, 0, stat);
    if (b.length > HISTORY_BLOCKS) b.splice(0, b.length - HISTORY_BLOCKS);
  }

  // ─── second address family ─────────────────────────────────────────────────

  async checkV6(): Promise<void> {
    await Promise.all(
      [...this.nodes.values()]
        .filter((n) => n.ip6)
        .map(async (n) => {
          const r = await probe(n.ip6!, n.port, FAR_ROUND);
          const v6 = r.alive ? 'ok' : 'fail';
          if (v6 !== n.v6) {
            n.v6 = v6;
            this.touch(n.id, { v6 });
          }
        }),
    );
  }
}
