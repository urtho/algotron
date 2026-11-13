/**
 * Client for the avmonitor WebSocket protocol v2 (per-relay vote timing).
 * Spec: avmonitor repo, docs/WS-PROTOCOL-V2.md, frozen 2026-11-12.
 *
 * Text frames are JSON control messages (hello, relays, voters); binary
 * frames are ROUND frames, little-endian. Unknown message types, fields and
 * section kinds are ignored, as the spec requires.
 */

import { type AvRound, decodeRound, KIND, NONE } from '../../shared/avframe.ts';
import type { VoteBox } from '../../shared/types.ts';

export {
  type AvRelayCol,
  type AvRound,
  type AvSection,
  decodeRound,
  encodeRound,
  KIND,
  NONE,
} from '../../shared/avframe.ts';

export interface AvRelayInfo {
  id: number;
  host: string;
  ip: string;
  up?: boolean;
  rtt_ms?: number;
}

/** Per-relay timing of one round, in ms after the fastest relay. */
export interface AvRelayTiming {
  relay: AvRelayInfo;
  /** Winning proposal vote: ms after its first arrival at any relay */
  proposal?: number;
  /** Median soft / cert vote delivery, ms after the fastest relay's median */
  soft?: number;
  cert?: number;
  /** Uncertainty of this relay's time correction, ms */
  err?: number;
}

export interface AvRoundTiming {
  round: number;
  partial: boolean;
  relays: AvRelayTiming[];
  /** ms from the round's first vote to the median relay's median soft / cert vote */
  softMs?: number;
  certMs?: number;
  /** Per voting account: ms after the first vote of that kind to reach any relay, ascending */
  accounts: { proposal: number[]; soft: number[]; cert: number[] };
  /** Per kind: vote count and when the votes first reached any relay, ms from the round's first vote */
  boxes: { proposal?: VoteBox; soft?: VoteBox; cert?: VoteBox };
  /** ms into the round at which each relay figure (`proposal`, `soft`, `cert` of `relays`) counts from zero */
  zero: { proposal: number; soft: number; cert: number };
  /** ms into the round of the first entry of each `accounts` list */
  accountsZero: { proposal: number; soft: number; cert: number };
}

const median = (xs: number[]) => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * Reduce a ROUND frame to what the dashboard shows. Only period 0 is used,
 * and only relays that were connected for the whole round.
 *
 * The block wave is the winning proposer's row of the kind 0 matrix
 * (level full). Without the matrix or the winner, a relay's first proposal
 * vote of any proposer stands in for it.
 */
export function summarizeRound(r: AvRound, dict: Map<number, AvRelayInfo>): AvRoundTiming {
  const n = r.relays.length;
  const section = (kind: number) => r.sections.find((s) => s.kind === kind && s.period === 0);
  const cols = r.relays
    .map((c, i) => ({ c, i, relay: dict.get(c.id) }))
    .filter((x) => x.relay && x.c.flags & 1);

  const prop = section(KIND.proposal);
  const row = prop && r.winner !== NONE ? prop.voters.indexOf(r.winner) : -1;
  const proposal = new Map<number, number>();
  let proposalZero = 0;
  if (prop?.matrix && row >= 0) {
    proposalZero = prop.first[row]!;
    for (const { i } of cols) {
      const d = prop.matrix[row * n + i]!;
      if (d < 0xfffe) proposal.set(i, d);
    }
  } else if (prop) {
    const firsts = cols.map(({ i }) => prop.summary[i * 4 + 1]!).filter((d) => d !== NONE);
    const min = Math.min(...firsts);
    if (firsts.length) proposalZero = min;
    for (const { i } of cols) {
      const d = prop.summary[i * 4 + 1]!;
      if (d !== NONE) proposal.set(i, d - min);
    }
  }

  /** d_p50 per column for a kind, and the same relative to the fastest relay */
  const p50 = (kind: number) => {
    const s = section(kind);
    const abs = new Map<number, number>();
    if (s) {
      for (const { i } of cols) {
        if (s.summary[i * 4]! > 0 && s.summary[i * 4 + 2] !== NONE) abs.set(i, s.summary[i * 4 + 2]!);
      }
    }
    const min = Math.min(...abs.values());
    return { abs, min: abs.size ? min : 0, rel: new Map([...abs].map(([i, d]) => [i, d - min])) };
  };
  const soft = p50(KIND.soft);
  const cert = p50(KIND.cert);

  /** When each account's vote first reached any relay, counted from the earliest one */
  const firsts = (kind: number) =>
    [...(section(kind)?.first ?? [])].filter((ms) => ms !== NONE).sort((a, b) => a - b);
  const accounts = (kind: number) => {
    const first = firsts(kind);
    return first.map((ms) => ms - first[0]!);
  };
  const box = (kind: number): VoteBox | undefined => {
    const first = firsts(kind);
    if (first.length === 0) return undefined;
    const at = (p: number) => first[Math.min(first.length - 1, Math.floor(first.length * p))]!;
    return [first.length, first[0]!, at(0.05), at(0.25), at(0.5), at(0.75), at(0.95)];
  };

  return {
    round: r.round,
    partial: (r.flags & 2) !== 0,
    relays: cols.map(({ c, i, relay }) => ({
      relay: relay!,
      proposal: proposal.get(i),
      soft: soft.rel.get(i),
      cert: cert.rel.get(i),
      err: c.err === NONE ? undefined : c.err / 10,
    })),
    softMs: median([...soft.abs.values()]),
    certMs: median([...cert.abs.values()]),
    accounts: { proposal: accounts(KIND.proposal), soft: accounts(KIND.soft), cert: accounts(KIND.cert) },
    boxes: { proposal: box(KIND.proposal), soft: box(KIND.soft), cert: box(KIND.cert) },
    zero: { proposal: proposalZero, soft: soft.min, cert: cert.min },
    accountsZero: {
      proposal: firsts(KIND.proposal)[0] ?? 0,
      soft: firsts(KIND.soft)[0] ?? 0,
      cert: firsts(KIND.cert)[0] ?? 0,
    },
  };
}

interface Handlers {
  onRound: (t: AvRoundTiming) => void;
  onState: (line: string, level: 'info' | 'warn') => void;
}

/** Keeps one connection to avmonitor open and turns ROUND frames into AvRoundTiming. */
export class AvClient {
  private relays = new Map<number, AvRelayInfo>();
  private epoch = '';
  private retry = 1000;
  private lastRound = 0;

  constructor(
    private base: string,
    private on: Handlers,
  ) {}

  start(): void {
    // level=full: the block wave needs the winner's row of the proposal matrix
    const url = `${this.base.replace(/\/$/, '')}/v2/stream?level=full&fmt=bin`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.retry = 1000;
    };
    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === 'string') this.control(JSON.parse(ev.data));
        else this.frame(new Uint8Array(ev.data as ArrayBuffer));
      } catch (err) {
        console.warn(`[AVMON] ${err instanceof Error ? err.message : err}`);
      }
    };
    ws.onclose = () => {
      if (this.epoch) this.on.onState('[AVMON] connection lost — falling back to polled propagation', 'warn');
      this.epoch = '';
      setTimeout(() => this.start(), this.retry);
      this.retry = Math.min(30_000, this.retry * 2);
    };
    ws.onerror = () => ws.close();
  }

  private control(msg: { t?: string; [k: string]: unknown }): void {
    if (msg.t === 'hello') {
      if (msg.v !== 2) throw new Error(`avmonitor: protocol version ${msg.v}, expected 2`);
      if (msg.epoch !== this.epoch) {
        this.relays.clear(); // ids are valid for one epoch only
        this.lastRound = 0;
      }
      this.epoch = String(msg.epoch);
      this.on.onState(
        `[AVMON] connected: ${msg.net}, level ${msg.level}, rounds arrive ${msg.delay_rounds} rounds late`,
        'info',
      );
    } else if (msg.t === 'relays') {
      if (msg.full) this.relays.clear();
      for (const r of msg.relays as AvRelayInfo[]) this.relays.set(r.id, r);
    }
    // voters: the dashboard does not need voter labels yet; other types are ignored
  }

  private frame(buf: Uint8Array): void {
    const round = decodeRound(buf);
    if (this.lastRound && round.round > this.lastRound + 1) {
      console.warn(`[AVMON] missed rounds ${this.lastRound + 1}..${round.round - 1}`);
    }
    this.lastRound = round.round;
    this.on.onRound(summarizeRound(round, this.relays));
  }
}
