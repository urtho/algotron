import type { BlockStat, NodeState } from '../../shared/types.ts';

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
