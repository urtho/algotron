import { expect, test } from 'bun:test';
import {
  shareAt,
  summarize,
  topProposers,
  tpsSeries,
  txParts,
  waveCurves,
} from '../../frontend/src/stats.ts';
import type { BlockStat } from '../../shared/types.ts';

const block = (i: number, over: Partial<BlockStat> = {}): BlockStat => ({
  round: 100 + i,
  ts: 1000 + i * 3,
  tc: 5000 + i * 30,
  txns: 30,
  top: 20,
  types: { pay: 5, axfer: 10, appl: 4, keyreg: 1 },
  bytes: 70_000,
  proposer: i % 3 === 0 ? 'AAA' : 'BBB',
  fees: 20_000,
  payout: 8_000_000,
  votes: 120,
  proto: 'x',
  seenAt: 0,
  ...over,
});

test('txParts splits top-level kinds and inner transactions', () => {
  expect(txParts(block(0))).toEqual([5, 10, 4, 1, 10]);
});

test('tpsSeries is 10 tps for 30 transactions every 3 seconds', () => {
  const s = tpsSeries(Array.from({ length: 30 }, (_, i) => block(i)));
  expect(s[0]).toBe(0);
  expect(s.at(-1)).toBeCloseTo(10, 5);
});

test('summarize and topProposers', () => {
  const blocks = Array.from({ length: 30 }, (_, i) => block(i, i > 20 ? { p50: 400, p90: 900 } : {}));
  const s = summarize(blocks);
  expect(s.blockTime).toBeCloseTo(3, 5);
  expect(s.txnsPerBlock).toBe(30);
  expect(s.p50).toBe(400);
  expect(s.payout).toBe(8);
  const top = topProposers(blocks, 2);
  expect(top.map((r) => [r.address, r.blocks])).toEqual([
    ['BBB', 20],
    ['AAA', 10],
  ]);
});

test('waveCurves sorts each kind and leaves a missing kind empty', () => {
  const c = waveCurves({
    round: 7,
    origin: 'a',
    delays: { a: 0, b: 40, c: 12 },
    soft: { a: 3, b: 0 },
    source: 'avmonitor',
  });
  expect(c).toEqual({ round: 7, block: [0, 12, 40], soft: [0, 3], cert: [] });
});

test('shareAt counts the nodes that have arrived by a moment', () => {
  const sorted = [0, 12, 40, 40];
  expect(shareAt(sorted, -1)).toBe(0);
  expect(shareAt(sorted, 0)).toBe(0.25);
  expect(shareAt(sorted, 39.9)).toBe(0.5);
  expect(shareAt(sorted, 40)).toBe(1);
  expect(shareAt([], 10)).toBe(0);
});
