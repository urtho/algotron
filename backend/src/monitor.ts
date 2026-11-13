import type { BlockStat, LogLine, NodeState, NodeStatus, ServerMessage, Wave } from '../../shared/types.ts';
import type { AvRoundTiming } from './avmonitor.ts';
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
/** A round further ahead of the tip than this is one node's error, not the chain */
const FAR_AHEAD = 1000;
/** Answers needed before the first tip is chosen */
const BOOT_QUORUM = 3;
/** Fast polling starts this long before the next block is expected */
const DUE_LEAD_MS = 900;
/** A node's avmonitor timing is used while it is at most this old; after that polling takes over again */
const AV_FRESH_MS = 20_000;

interface Runtime {
  fails: number;
  stopped: boolean;
  rttSent: number;
  propSent: number;
  /** A warning was logged for this node and not yet cleared */
  flagged: boolean;
  /** When avmonitor last supplied this node's propagation delay */
  avAt: number;
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
 * The first tip, from the rounds the first nodes reported: the highest round within FAR_AHEAD of their median.
 * A stuck relay (r-c7 sat 235,786 rounds behind on 2026-11-13) or one claiming a far-future round cannot set it alone.
 */
export function bootTip(rounds: number[]): number {
  if (rounds.length === 0) return 0;
  const sorted = [...rounds].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]!;
  return Math.max(...sorted.filter((r) => Math.abs(r - median) <= FAR_AHEAD));
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
  /** The newest finished round's propagation, replayed by the globe and the wall */
  private wave?: Wave;

  private rounds = new Map<number, RoundSeen>();
  /** Rounds reported before the first tip was chosen, by node */
  private bootRounds = new Map<string, number>();
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
      wave: this.wave,
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
      const rt: Runtime = { fails: 0, stopped: false, rttSent: 0, propSent: 0, flagged: false, avAt: 0 };
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
    // avmonitor times this node far better than polling can: no need to poll it fast
    if (this.avFresh(this.rt.get(node.id))) return POLL_MS;
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
    if (this.tip === 0) {
      // the first answers choose the tip together; the first one alone could come from a stuck relay, and every
      // healthy round after it would then look like a far-future claim and be ignored for good
      this.bootRounds.set(node.id, round);
      if (this.bootRounds.size < Math.min(BOOT_QUORUM, this.nodes.size)) {
        node.lastBlock = round;
        this.touch(node.id, { lastBlock: round });
        return;
      }
      const tip = bootTip([...this.bootRounds.values()]);
      this.bootRounds.clear();
      this.newTip(tip, node, now);
    }
    if (round > this.tip + FAR_AHEAD) {
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
      if (r === round && delay < 20_000 && !this.avFresh(rt)) {
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
    if (!entry || Date.now() - this.avRoundAt < AV_FRESH_MS) return; // avmonitor reports the round instead
    const delays = [...entry.seen.values()].filter((d) => d > 0).sort((a, b) => a - b);
    const patch = {
      p50: Math.round(quantile(delays, 0.5)),
      p90: Math.round(quantile(delays, 0.9)),
      reach: entry.seen.size,
    };
    const block = this.blocks.find((b) => b.round === round);
    if (block) Object.assign(block, patch);
    this.send({ type: 'block_patch', round, patch });
    this.sendWave({
      round,
      origin: entry.first,
      delays: Object.fromEntries([...entry.seen].map(([id, d]) => [id, Math.max(0, Math.round(d))])),
      source: 'poll',
    });
  }

  private sendWave(wave: Wave): void {
    if (Object.keys(wave.delays).length < 2) return;
    this.wave = wave;
    this.send({ type: 'wave', wave });
  }

  // ─── avmonitor ─────────────────────────────────────────────────────────────

  private avRoundAt = 0;
  private avFresh(rt: Runtime | undefined): boolean {
    return !!rt && Date.now() - rt.avAt < AV_FRESH_MS;
  }

  /**
   * One finished round from avmonitor: per-relay delay of the winning
   * proposal vote and of the median soft and cert vote. Relays are matched
   * to nodes by address, then by host; a dual-stack host has two avmonitor
   * relays and the faster one counts. Nodes avmonitor does not cover
   * (archivers) keep their polled figures.
   */
  applyAv(t: AvRoundTiming): void {
    const byIp = new Map<string, NodeState>();
    const byHost = new Map<string, NodeState>();
    for (const n of this.nodes.values()) {
      if (n.type !== 'relay') continue;
      byIp.set(n.ip, n);
      if (n.ip6) byIp.set(n.ip6, n);
      byHost.set(n.host, n);
    }
    const best = new Map<NodeState, { proposal?: number; soft?: number; cert?: number }>();
    const low = (a: number | undefined, b: number | undefined) =>
      a === undefined ? b : b === undefined ? a : Math.min(a, b);
    for (const r of t.relays) {
      const node = byIp.get(r.relay.ip) ?? byHost.get(r.relay.host);
      if (!node) continue;
      const have = best.get(node) ?? {};
      best.set(node, {
        proposal: low(have.proposal, r.proposal),
        soft: low(have.soft, r.soft),
        cert: low(have.cert, r.cert),
      });
    }

    const now = Date.now();
    const delays: number[] = [];
    const byNode: Record<string, number> = {};
    let origin: NodeState | undefined;
    for (const [node, d] of best) {
      const rt = this.rt.get(node.id);
      if (!rt || d.proposal === undefined) continue;
      delays.push(d.proposal);
      byNode[node.id] = d.proposal;
      if (!origin || d.proposal < byNode[origin.id]!) origin = node;
      if (t.partial) continue; // a partial round still draws, but does not move the averages
      const first = !this.avFresh(rt);
      rt.avAt = now;
      const smooth = (old: number | undefined, x: number | undefined) =>
        x === undefined ? old : first || old === undefined ? x : old + EWMA * (x - old);
      node.prop = smooth(node.prop, d.proposal)!;
      node.soft = smooth(node.soft, d.soft);
      node.cert = smooth(node.cert, d.cert);
      if (first || Math.abs(node.prop - rt.propSent) > Math.max(2, rt.propSent * 0.05)) {
        rt.propSent = node.prop;
        const r1 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 10) / 10);
        this.touch(node.id, { prop: r1(node.prop), soft: r1(node.soft), cert: r1(node.cert) });
      }
    }
    if (delays.length === 0) return;
    this.avRoundAt = now;
    delays.sort((a, b) => a - b);
    const patch = {
      p50: quantile(delays, 0.5),
      p90: quantile(delays, 0.9),
      reach: delays.length,
      softMs: t.softMs,
      certMs: t.certMs,
      voteBox: t.boxes,
    };
    const block = this.blocks.find((b) => b.round === t.round);
    if (block) Object.assign(block, patch);
    this.send({ type: 'block_patch', round: t.round, patch });
    if (origin) {
      // delays are counted from the first relay that had the winning proposal vote
      const t0 = byNode[origin.id]!;
      for (const id in byNode) byNode[id] = byNode[id]! - t0;
      /** One vote kind by node id, counted from the fastest node; left out when fewer than two nodes have it */
      const votes = (kind: 'soft' | 'cert') => {
        const rows = [...best].flatMap(([node, d]) =>
          d[kind] === undefined ? [] : [[node.id, d[kind]] as const],
        );
        if (rows.length < 2) return undefined;
        const min = Math.min(...rows.map(([, ms]) => ms));
        return {
          min,
          by: Object.fromEntries(rows.map(([id, ms]) => [id, Math.round((ms - min) * 10) / 10])),
        };
      };
      const soft = votes('soft');
      const cert = votes('cert');
      this.sendWave({
        round: t.round,
        origin: origin.id,
        delays: byNode,
        soft: soft?.by,
        cert: cert?.by,
        accounts: { block: t.accounts.proposal, soft: t.accounts.soft, cert: t.accounts.cert },
        // each list was re-zeroed to its own fastest node: this is what that zero is on the round's clock
        zero: {
          block: t.zero.proposal + t0,
          soft: t.zero.soft + (soft?.min ?? 0),
          cert: t.zero.cert + (cert?.min ?? 0),
        },
        accountsZero: {
          block: t.accountsZero.proposal,
          soft: t.accountsZero.soft,
          cert: t.accountsZero.cert,
        },
        source: 'avmonitor',
      });
    }
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
