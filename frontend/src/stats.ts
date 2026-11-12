import type { BlockStat, NodeState, VoteBox, Wave } from '../../shared/types.ts';

/** Every replay is stretched (or left alone) so the 95th-percentile node lands this long after the first */
export const WAVE_PLAY_MS = 2000;

export interface WavePlan {
  /** Delay drawn as the darkest step of the colour ramp: the 95th percentile, ms */
  max: number;
  /** Playback slowdown; 1 = real time */
  slow: number;
  /** When a node lights up in the replay, ms after it starts. Stragglers are capped so a replay ends. */
  at: (delay: number) => number;
}

export function wavePlan(wave: Wave | undefined): WavePlan {
  const delays = Object.values(wave?.delays ?? {})
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  return planFor(Math.max(10, delays[Math.floor(delays.length * 0.95)] ?? 1000));
}

/** A replay whose darkest step, `max` ms, lands WAVE_PLAY_MS in. */
function planFor(max: number): WavePlan {
  const raw = WAVE_PLAY_MS / max;
  const slow = raw <= 1.2 ? 1 : Math.min(60, Math.round(raw));
  return { max, slow, at: (delay) => Math.min(delay, max * 1.3) * slow };
}

/** The arrival curves under the globe, in round order. Colors: the first three chart series colors */
export const CURVE_KINDS = ['block', 'soft', 'cert'] as const;
export type CurveKind = (typeof CURVE_KINDS)[number];
export const CURVE_LABELS: Record<CurveKind, string> = {
  block: 'proposal',
  soft: 'soft vote',
  cert: 'cert vote',
};

/** What one step of a curve is: a relay, or a voting account taken as if it were a node */
export type CurveMode = 'relay' | 'address';

/**
 * One round's arrivals per kind, ascending, on the round's own clock: ms after the round's first vote of
 * any kind. A kind without data is empty. Polled rounds have no clock, so their block counts from zero.
 */
export type WaveCurves = { round: number } & Record<CurveKind, number[]>;

export function waveCurves(wave: Wave, mode: CurveMode = 'relay'): WaveCurves {
  const at = (list: number[] | undefined, zero: number | undefined) =>
    (list ?? []).map((ms) => ms + (zero ?? 0)).sort((a, b) => a - b);
  if (mode === 'address') {
    const z = wave.accountsZero;
    return {
      round: wave.round,
      block: at(wave.accounts?.block, z?.block),
      soft: at(wave.accounts?.soft, z?.soft),
      cert: at(wave.accounts?.cert, z?.cert),
    };
  }
  const of = (by: Record<string, number> | undefined) => (by ? Object.values(by) : undefined);
  const z = wave.zero;
  return {
    round: wave.round,
    block: at(of(wave.delays), z?.block),
    soft: at(of(wave.soft), z?.soft),
    cert: at(of(wave.cert), z?.cert),
  };
}

/**
 * Share of a kind's votes that carries its step of the round, taken from the consensus parameters
 * (soft: 2267 of a committee of 2990, cert: 1112 of 1500). The curves count relays or accounts, not
 * stake, so the line drawn there is where an equal-weight network would cross it.
 */
export const QUORUM: Partial<Record<CurveKind, number>> = { soft: 2267 / 2990, cert: 1112 / 1500 };

/** When a curve reaches a share of its nodes, ms on the curve's own clock; undefined for an empty curve. */
export function reachedAt(sorted: number[], share: number): number | undefined {
  return sorted.length
    ? sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * share))) - 1]
    : undefined;
}

export interface CurveScale {
  /** The votes are there: the proposal is drawn on the first third, soft and cert on the rest */
  split: boolean;
  /** ms across the full width while a round is drawn zoomed (both zoomed axes have this scale) */
  zoom: number;
  /** ms across the full width on the round's clock */
  round: number;
}

const p95 = (sorted: number[]) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
const ceilTo = (v: number, step: number) => Math.max(step, Math.ceil(v / step) * step);

/**
 * Axes that fit a set of rounds (the one on screen and the ones behind it), so they hold still from round
 * to round. Zoomed, the proposal's 95th percentile fits a third of the width and the later of the soft and
 * cert 95th percentiles, counted from the first soft vote, fits the other two thirds.
 */
export function curveScale(rounds: WaveCurves[]): CurveScale {
  const voted = rounds.filter((r) => r.soft.length > 1);
  const proposal = Math.max(10, ...rounds.map((r) => p95(r.block) - (r.block[0] ?? 0)));
  if (voted.length === 0) {
    const span = ceilTo(Math.max(...rounds.map((r) => p95(r.block)), 10) * 1.15, 10);
    return { split: false, zoom: span, round: span };
  }
  const votes = Math.max(...voted.map((r) => Math.max(p95(r.soft), p95(r.cert)) - r.soft[0]!));
  return {
    split: true,
    zoom: ceilTo(Math.max(3 * proposal, 1.5 * votes) * 1.05, 150),
    round: ceilTo(Math.max(...voted.map((r) => Math.max(p95(r.soft), p95(r.cert)))) * 1.03, 250),
  };
}

/** The per-round vote box charts */
export const BOX_KINDS = ['proposal', 'soft', 'cert'] as const;
export type BoxKind = (typeof BOX_KINDS)[number];
/** Zero of a box chart: the round's first vote of any kind, or the first vote of the chart's own kind */
export type BoxAxis = 'clock' | 'first';
export const BOX_ROUNDS = 45;

export interface BoxSlot {
  round: number;
  votes: number;
  /** p5, p25, median, p75, p95 in ms on the chosen zero */
  q: [number, number, number, number, number];
}

/** The newest `rounds` rounds that have vote timing for a kind, oldest first. */
export function boxSlots(blocks: BlockStat[], kind: BoxKind, axis: BoxAxis, rounds = BOX_ROUNDS): BoxSlot[] {
  const out: BoxSlot[] = [];
  for (let i = blocks.length - 1; i >= 0 && out.length < rounds; i--) {
    const box: VoteBox | undefined = blocks[i]!.voteBox?.[kind];
    if (!box) continue;
    const [votes, first, ...q] = box;
    const zero = axis === 'first' ? first : 0;
    out.push({ round: blocks[i]!.round, votes, q: q.map((ms) => ms - zero) as BoxSlot['q'] });
  }
  return out.reverse();
}

/** Share of the nodes (0..1) that have arrived `ms` after the first; `sorted` is ascending. */
export function shareAt(sorted: number[], ms: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length ? lo / sorted.length : 0;
}

/** Transaction kinds shown in the stacked chart, bottom to top. Colors: styles/stats.css --c1..--c5 */
export const TX_KINDS = ['pay', 'axfer', 'appl', 'other', 'inner'] as const;
export const TX_LABELS: Record<(typeof TX_KINDS)[number], string> = {
  pay: 'payment',
  axfer: 'asset transfer',
  appl: 'app call',
  other: 'other',
  inner: 'inner',
};

/** Split a block's transactions into the chart's five kinds. */
export function txParts(b: BlockStat): number[] {
  const pay = b.types.pay ?? 0;
  const axfer = b.types.axfer ?? 0;
  const appl = b.types.appl ?? 0;
  const other = Math.max(0, b.top - pay - axfer - appl);
  const inner = Math.max(0, b.txns - b.top);
  return [pay, axfer, appl, other, inner];
}

/**
 * TPS at every block: growth of the header transaction counter `tc` over the
 * `window` blocks before it, divided by the header time `ts` they span.
 */
export function tpsSeries(blocks: BlockStat[], window = 10): number[] {
  return blocks.map((b, i) => {
    const a = blocks[Math.max(0, i - window)]!;
    const dt = b.ts - a.ts;
    return dt > 0 ? (b.tc - a.tc) / dt : 0;
  });
}

/** Mean seconds per block over the `window` blocks before each block. */
export function blockTimeSeries(blocks: BlockStat[], window = 10): number[] {
  return blocks.map((b, i) => {
    const a = blocks[Math.max(0, i - window)]!;
    const n = b.round - a.round;
    return n > 0 ? (b.ts - a.ts) / n : 0;
  });
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export interface Summary {
  tps: number;
  tpsPeak: number;
  blockTime: number;
  txnsPerBlock: number;
  txnsWindow: number;
  bytes: number;
  votes: number;
  payout: number;
  p50: number;
  p90: number;
  /** avmonitor only: ms from a round's first vote to the median soft / cert vote */
  softMs: number;
  certMs: number;
  spanMin: number;
}

export function summarize(blocks: BlockStat[]): Summary {
  const tps = tpsSeries(blocks);
  const recent = blocks.slice(-20);
  const timed = blocks.filter((b) => b.p50 !== undefined).slice(-20);
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  return {
    tps: tps[tps.length - 1] ?? 0,
    tpsPeak: Math.max(0, ...tps.slice(10)),
    blockTime:
      first && last && last.round > first.round ? (last.ts - first.ts) / (last.round - first.round) : 0,
    txnsPerBlock: mean(recent.map((b) => b.txns)),
    txnsWindow: blocks.reduce((s, b) => s + b.txns, 0),
    bytes: mean(recent.map((b) => b.bytes)),
    votes: mean(recent.map((b) => b.votes)),
    payout: mean(recent.map((b) => b.payout)) / 1e6,
    p50: mean(timed.map((b) => b.p50!)),
    p90: mean(timed.map((b) => b.p90!)),
    softMs: mean(timed.filter((b) => b.softMs !== undefined).map((b) => b.softMs!)),
    certMs: mean(timed.filter((b) => b.certMs !== undefined).map((b) => b.certMs!)),
    spanMin: first && last ? (last.ts - first.ts) / 60 : 0,
  };
}

export interface ProposerRow {
  address: string;
  blocks: number;
  share: number;
  payout: number;
}

export function topProposers(blocks: BlockStat[], n = 6): ProposerRow[] {
  const by = new Map<string, ProposerRow>();
  for (const b of blocks) {
    if (!b.proposer) continue;
    const row = by.get(b.proposer) ?? { address: b.proposer, blocks: 0, share: 0, payout: 0 };
    row.blocks++;
    row.payout += b.payout / 1e6;
    by.set(b.proposer, row);
  }
  const rows = [...by.values()].sort((a, b) => b.blocks - a.blocks).slice(0, n);
  for (const r of rows) r.share = blocks.length ? r.blocks / blocks.length : 0;
  return rows;
}

export interface Fleet {
  relays: number;
  relaysOk: number;
  archivers: number;
  archiversOk: number;
  offline: number;
  behind: number;
  v6: number;
  v6Ok: number;
  countries: number;
  rtt: number;
}

const OK = new Set(['synced', 'lagging']);

export function fleet(nodes: NodeState[]): Fleet {
  const relays = nodes.filter((n) => n.type === 'relay');
  const archivers = nodes.filter((n) => n.type === 'archiver');
  const rtts = nodes
    .filter((n) => n.rtt > 0 && n.status !== 'offline')
    .map((n) => n.rtt)
    .sort((a, b) => a - b);
  return {
    relays: relays.length,
    relaysOk: relays.filter((n) => OK.has(n.status)).length,
    archivers: archivers.length,
    archiversOk: archivers.filter((n) => OK.has(n.status)).length,
    offline: nodes.filter((n) => n.status === 'offline').length,
    behind: nodes.filter((n) => n.status === 'behind').length,
    v6: nodes.filter((n) => n.ip6).length,
    v6Ok: nodes.filter((n) => n.v6 === 'ok').length,
    countries: new Set(nodes.map((n) => n.countryCode).filter(Boolean)).size,
    rtt: rtts[Math.floor(rtts.length / 2)] ?? 0,
  };
}

export const fmt = {
  int: (n: number) => Math.round(n).toLocaleString('en-US'),
  num: (n: number, d = 1) =>
    n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
  addr: (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'),
  kb: (bytes: number) => `${(bytes / 1024).toFixed(0)}`,
};
