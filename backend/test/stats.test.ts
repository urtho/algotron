import { describe, expect, test } from 'bun:test';
import { mapper, type Plot } from '../../frontend/src/components/VoteCurves.tsx';
import { band, findNode, parseQuery, tenureText } from '../../frontend/src/rank.ts';
import {
  boxSlots,
  curveScale,
  reachedAt,
  shareAt,
  summarize,
  topProposers,
  tpsSeries,
  txParts,
  waveCurves,
} from '../../frontend/src/stats.ts';
import type { BlockStat } from '../../shared/types.ts';
import { RankStore } from '../src/rank.ts';

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

test('waveCurves puts each kind on the round clock and leaves a missing kind empty', () => {
  const wave = {
    round: 7,
    origin: 'a',
    delays: { a: 0, b: 40, c: 12 },
    soft: { a: 3, b: 0 },
    zero: { block: 5, soft: 2500, cert: 0 },
    accounts: { block: [0, 90], soft: [0, 100, 200, 400], cert: [0, 50] },
    accountsZero: { block: 0, soft: 2400, cert: 2600 },
    source: 'avmonitor' as const,
  };
  expect(waveCurves(wave)).toEqual({ round: 7, block: [5, 17, 45], soft: [2500, 2503], cert: [] });
  expect(waveCurves(wave, 'address')).toEqual({
    round: 7,
    block: [0, 90],
    soft: [2400, 2500, 2600, 2800],
    cert: [2600, 2650],
  });
  // a polled round has no clock and no votes: its block counts from zero
  const polled = { round: 8, origin: 'a', delays: { a: 0, b: 40 }, source: 'poll' as const };
  expect(waveCurves(polled)).toEqual({ round: 8, block: [0, 40], soft: [], cert: [] });
  expect(waveCurves(polled, 'address').block).toEqual([]);
});

test('curveScale fits the proposal in a third and the votes in two thirds', () => {
  const round = { round: 1, block: [10, 60, 110], soft: [2500, 2600, 2900], cert: [2600, 2700, 3100] };
  // proposal spans 100 ms, votes 600 ms from the first soft vote: 1.5 x 600 wins over 3 x 100
  expect(curveScale([round])).toEqual({ split: true, zoom: 1050, round: 3250 });
  // without votes there is one axis and nothing to settle onto
  expect(curveScale([{ round: 2, block: [0, 40, 80], soft: [], cert: [] }])).toEqual({
    split: false,
    zoom: 100,
    round: 100,
  });
});

test('reachedAt finds when a curve crosses a share', () => {
  expect(reachedAt([10, 20, 30, 40], 0.75)).toBe(30);
  expect(reachedAt([10, 20, 30, 40], 0.76)).toBe(40);
  expect(reachedAt([10], 0.5)).toBe(10);
  expect(reachedAt([], 0.5)).toBeUndefined();
});

test('shareAt counts the nodes that have arrived by a moment', () => {
  const sorted = [0, 12, 40, 40];
  expect(shareAt(sorted, -1)).toBe(0);
  expect(shareAt(sorted, 0)).toBe(0.25);
  expect(shareAt(sorted, 39.9)).toBe(0.5);
  expect(shareAt(sorted, 40)).toBe(1);
  expect(shareAt([], 10)).toBe(0);
});

test('boxSlots takes the newest rounds with vote timing, on either zero', () => {
  const blocks = [
    block(0, { voteBox: { soft: [300, 2400, 2410, 2450, 2500, 2600, 2800] } }),
    block(1),
    block(2, {
      voteBox: {
        soft: [310, 2500, 2510, 2550, 2600, 2700, 2900],
        cert: [200, 2600, 2610, 2620, 2640, 2700, 2900],
      },
    }),
  ];
  expect(boxSlots(blocks, 'soft', 'clock')).toEqual([
    { round: 100, votes: 300, q: [2410, 2450, 2500, 2600, 2800] },
    { round: 102, votes: 310, q: [2510, 2550, 2600, 2700, 2900] },
  ]);
  expect(boxSlots(blocks, 'soft', 'first', 1)).toEqual([
    { round: 102, votes: 310, q: [10, 50, 100, 200, 400] },
  ]);
  expect(boxSlots(blocks, 'proposal', 'clock')).toEqual([]);
});

describe('arrival curve fences', () => {
  const plot: Plot = { x0: 38, x1: 1238, y0: 30, y1: 200, sy: () => 0 };
  const scale = { split: true, zoom: 1200, round: 3500 };
  // a proposal with a late tail: two relays far beyond the third the proposal is drawn on
  const round = { round: 1, block: [0, 20, 60, 520, 608], soft: [2600, 2700], cert: [2750, 2850] };
  const brk = plot.x0 + (plot.x1 - plot.x0) / 3;

  test('the proposal never shows past the break while there is one', () => {
    for (let settle = 0; settle < 1; settle += 0.01) {
      const map = mapper(plot, scale, round, settle);
      const [left, right] = map.fence('block');
      expect(left).toBe(plot.x0);
      expect(right).toBeLessThan(brk);
    }
  });

  test('settled, the whole proposal is inside the plot', () => {
    const map = mapper(plot, scale, round, 1);
    expect(map.fence('block')).toEqual([plot.x0, plot.x1]);
    expect(map.x('block', 608)).toBeLessThan(brk);
  });

  test('without votes there is one axis and no break', () => {
    const map = mapper(plot, { split: false, zoom: 700, round: 700 }, { ...round, soft: [], cert: [] }, 0);
    expect(map.fence('block')).toEqual([plot.x0, plot.x1]);
  });
});

describe('validator ranking', () => {
  const season = {
    wk: '2026-11-09',
    computed: '2026-11-13T12:59:03Z',
    final: false,
    nodes: [
      { id: '0123456789ab', alias: 'Otter', league: 'B', home: 1, over: 0, tenure: 400, c: {} },
      { id: 'ffffffffffff', league: 'D', home: 0, over: 1, tenure: 30, c: {} },
    ],
  };

  test('a GUID, its last 12 characters and an alias all find the node', () => {
    expect(parseQuery(' ABCDEF01-2345-6789-abcd-0123456789AB ')).toEqual({ id: '0123456789ab' });
    expect(parseQuery('0123456789AB')).toEqual({ id: '0123456789ab' });
    expect(parseQuery('@otter')).toEqual({ alias: 'otter' });
    expect(parseQuery(':: Otter')).toEqual({ alias: 'otter' });
    expect(parseQuery('  ')).toEqual({});
    expect(findNode(season, parseQuery('abcdef01-2345-6789-abcd-0123456789ab'))?.alias).toBe('Otter');
    expect(findNode(season, parseQuery('@OTTER'))?.id).toBe('0123456789ab');
    expect(findNode(season, parseQuery('nobody'))).toBeUndefined();
  });

  test('bands and tenure', () => {
    expect([band(1, 50), band(5, 50), band(12, 50), band(25, 50), band(26, 50)]).toEqual([1, 1, 2, 3, 4]);
    expect(tenureText(30)).toBe('30d');
    expect(tenureText(400)).toBe('1y 35d');
  });

  test('the store takes a version 1 snapshot and refuses anything else', async () => {
    const store = new RankStore('secret');
    const body = JSON.stringify({ v: 1, leagues: [], categories: [], seasons: [season] });
    const post = (auth: string, text: string) =>
      store.ingest(
        new Request('http://x/api/rank/ingest', {
          method: 'POST',
          headers: { authorization: auth },
          body: text,
        }),
      );
    expect((await post('Bearer wrong!', body)).status).toBe(401);
    expect((await post('Bearer secret', '{"v":2}')).status).toBe(400);
    expect(store.latest(new Request('http://x/')).status).toBe(503);
    expect((await post('Bearer secret', body)).status).toBe(200);
    const got = store.latest(new Request('http://x/'));
    expect(await got.text()).toBe(body);
    const etag = got.headers.get('etag')!;
    expect(store.latest(new Request('http://x/', { headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await new RankStore('').ingest(new Request('http://x/', { method: 'POST', body }))).status).toBe(
      404,
    );
  });
});
