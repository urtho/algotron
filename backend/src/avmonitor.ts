/**
 * Client for the avmonitor WebSocket protocol v2 (per-relay vote timing).
 * Spec: avmonitor repo, docs/WS-PROTOCOL-V2.md, frozen 2026-11-12.
 *
 * Text frames are JSON control messages (hello, relays, voters); binary
 * frames are ROUND frames, little-endian. Unknown message types, fields and
 * section kinds are ignored, as the spec requires.
 */

import type { VoteBox } from '../../shared/types.ts';

export const NONE = 0xffff;
export const KIND = { proposal: 0, soft: 1, cert: 2 } as const;
const HEADER = 32;
const RELAY_ROW = 8;
const SECTION_HEADER = 8;

export interface AvRelayCol {
  id: number;
  /** One-way delay already subtracted, 0.1 ms; NONE = times are uncorrected */
  owd: number;
  /** Uncertainty of the correction, ± 0.1 ms; NONE = unknown */
  err: number;
  monitor: number;
  /** bit 0: connected for the whole round; bit 1: delay from websocket ping */
  flags: number;
}

export interface AvSection {
  kind: number;
  period: number;
  /** Voter ids, sorted by `first` */
  voters: Uint16Array;
  /** ms from t0 to the vote's earliest arrival at any relay */
  first: Uint16Array;
  /** Per relay column: count, d_first, d_p50, d_p90 (ms from t0; NONE when count is 0) */
  summary: Uint16Array;
  /** level full only: voter × relay, ms from first[i]; NONE = never delivered */
  matrix?: Uint16Array;
}

export interface AvRound {
  level: number;
  /** bit 0: winner known; bit 1: partial round */
  flags: number;
  round: number;
  t0Us: number;
  /** Voter id of the winning proposer, NONE if unknown */
  winner: number;
  relays: AvRelayCol[];
  sections: AvSection[];
}

export function decodeRound(buf: Uint8Array): AvRound {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < HEADER) throw new Error('avmonitor: frame shorter than its header');
  if (v.getUint8(0) !== 1) throw new Error(`avmonitor: unknown frame type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== 2) throw new Error(`avmonitor: unsupported frame version ${v.getUint8(1)}`);
  const level = v.getUint8(2);
  const nRelays = v.getUint16(22, true);
  const nSections = v.getUint8(24);

  let p = HEADER;
  const need = (n: number) => {
    if (p + n > buf.length) throw new Error('avmonitor: truncated frame');
  };
  need(nRelays * RELAY_ROW);
  const relays: AvRelayCol[] = [];
  for (let c = 0; c < nRelays; c++, p += RELAY_ROW) {
    relays.push({
      id: v.getUint16(p, true),
      owd: v.getUint16(p + 2, true),
      err: v.getUint16(p + 4, true),
      monitor: v.getUint8(p + 6),
      flags: v.getUint8(p + 7),
    });
  }

  const u16s = (at: number, n: number) => {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = v.getUint16(at + i * 2, true);
    return out;
  };

  const sections: AvSection[] = [];
  for (let s = 0; s < nSections; s++) {
    need(SECTION_HEADER);
    const kind = v.getUint8(p);
    const period = v.getUint8(p + 1);
    const nVoters = v.getUint16(p + 2, true);
    const bodyLen = v.getUint32(p + 4, true);
    p += SECTION_HEADER;
    need(bodyLen);
    const body = p;
    p += bodyLen; // always advance by body_len, so unknown kinds and later additions are skipped
    if (kind > KIND.cert) continue;
    const base = nVoters * 4 + nRelays * 8;
    if (bodyLen < base) throw new Error(`avmonitor: section ${kind} body too short`);
    const hasMatrix = level === 1 && bodyLen >= base + nVoters * nRelays * 2;
    sections.push({
      kind,
      period,
      voters: u16s(body, nVoters),
      first: u16s(body + nVoters * 2, nVoters),
      summary: u16s(body + nVoters * 4, nRelays * 4),
      matrix: hasMatrix ? u16s(body + base, nVoters * nRelays) : undefined,
    });
  }

  return {
    level,
    flags: v.getUint8(3),
    round: Number(v.getBigUint64(4, true)),
    t0Us: Number(v.getBigInt64(12, true)),
    winner: v.getUint16(20, true),
    relays,
    sections,
  };
}

/** Inverse of decodeRound. Used by the tests and the development mock server. */
export function encodeRound(r: AvRound): Uint8Array {
  const n = r.relays.length;
  const bodies = r.sections.map((s) => s.voters.length * 4 + n * 8 + (s.matrix ? s.matrix.length * 2 : 0));
  const size = HEADER + n * RELAY_ROW + bodies.reduce((a, b) => a + SECTION_HEADER + b, 0);
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 2);
  v.setUint8(2, r.level);
  v.setUint8(3, r.flags);
  v.setBigUint64(4, BigInt(r.round), true);
  v.setBigInt64(12, BigInt(r.t0Us), true);
  v.setUint16(20, r.winner, true);
  v.setUint16(22, n, true);
  v.setUint8(24, r.sections.length);
  let p = HEADER;
  for (const c of r.relays) {
    v.setUint16(p, c.id, true);
    v.setUint16(p + 2, c.owd, true);
    v.setUint16(p + 4, c.err, true);
    v.setUint8(p + 6, c.monitor);
    v.setUint8(p + 7, c.flags);
    p += RELAY_ROW;
  }
  r.sections.forEach((s, i) => {
    v.setUint8(p, s.kind);
    v.setUint8(p + 1, s.period);
    v.setUint16(p + 2, s.voters.length, true);
    v.setUint32(p + 4, bodies[i]!, true);
    p += SECTION_HEADER;
    for (const part of [s.voters, s.first, s.summary, s.matrix]) {
      if (!part) continue;
      for (const x of part) {
        v.setUint16(p, x, true);
        p += 2;
      }
    }
  });
  return buf;
}

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
  if (prop?.matrix && row >= 0) {
    for (const { i } of cols) {
      const d = prop.matrix[row * n + i]!;
      if (d < 0xfffe) proposal.set(i, d);
    }
  } else if (prop) {
    const firsts = cols.map(({ i }) => prop.summary[i * 4 + 1]!).filter((d) => d !== NONE);
    const min = Math.min(...firsts);
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
    return { abs, rel: new Map([...abs].map(([i, d]) => [i, d - min])) };
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
