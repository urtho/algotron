import { expect, test } from 'bun:test';
import { grid, reach, regionOf, soundRound, steps } from '../../frontend/src/sound.ts';
import { wavePlan } from '../../frontend/src/stats.ts';
import type { NodeState, Wave } from '../../shared/types.ts';

const node = (id: string, lat: number, lng: number): NodeState => ({
  id,
  type: 'relay',
  label: id,
  host: `${id}.example`,
  port: 4160,
  ip: '203.0.113.1',
  lat,
  lng,
  country: '',
  countryCode: '',
  city: '',
  net: '',
  status: 'synced',
  lastBlock: 1,
  rtt: 10,
  prop: 0,
  firsts: 0,
});

const nodes = [node('fra', 50, 9), node('nyc', 41, -74), node('sgp', 1, 104), node('gru', -23, -20)];
const wave: Wave = {
  round: 9,
  origin: 'nyc',
  delays: { nyc: 0, fra: 40, sgp: 200, gone: 10 },
  source: 'avmonitor',
};

test('regionOf splits the map into the four sections', () => {
  expect(nodes.map((n) => regionOf(n.lat, n.lng))).toEqual(['eu', 'na', 'as', 'other']);
});

test('soundRound takes the wall replay clock, the place on the wall and the map position', () => {
  const plan = wavePlan(wave);
  const order = new Map([
    ['fra', 0],
    ['nyc', 1],
    ['sgp', 2],
  ]);
  const r = soundRound(wave, plan, nodes, order);
  // a node that left the wall is skipped; the rest sound in the order the wall flashes them
  expect(r.hits.map((h) => h.region)).toEqual(['na', 'eu', 'as']);
  expect(r.hits.map((h) => h.rank)).toEqual([1, 0, 2]);
  expect(r.hits[0]!.at).toBe(0);
  expect(r.hits[1]!.at).toBeCloseTo(plan.at(40) / 1000);
  expect(r.hits[2]!.pan).toBeCloseTo(104 / 180);
  expect(r.origin).toBe('na');
  expect(r.nodes).toBe(4);
  // the replay clock stretches every round to the same length; the real spread travels beside it
  expect(r.spread).toBe(plan.max);
});

test('steps counts arrivals per sixteenth and reach finds when a share has the block', () => {
  const hit = (at: number, region: 'eu' | 'na') => ({ at, pan: 0, rank: 0, region });
  const hits = [hit(0, 'na'), hit(0.1, 'eu'), hit(1.4, 'eu'), hit(9, 'eu')];
  const counts = steps(hits, 2.8);
  expect(counts[0]).toBe(2);
  expect(counts[8]).toBe(1);
  // later than the bar: counted in its last step
  expect(counts[15]).toBe(1);
  expect(reach(hits, 0.5)).toBe(1.4);
  expect(reach(hits, 0.5, 'eu')).toBe(1.4);
  expect(reach(hits, 0.5, 'as')).toBeNull();
});

test('grid cuts a bar into any number of steps: arrivals, stereo place, leading region and share reached', () => {
  const hit = (at: number, pan: number, region: 'eu' | 'na' | 'as') => ({ at, pan, rank: 0, region });
  const round = {
    round: 1,
    hits: [hit(0, -0.4, 'na'), hit(0.05, 0.2, 'eu'), hit(0.1, 0.2, 'eu'), hit(1.4, 0.6, 'as')],
    origin: 'na' as const,
    nodes: 4,
    spread: 300,
  };
  const g = grid(round, 2.4, 24);
  expect(g.counts.length).toBe(24);
  expect(g.counts[0]).toBe(2);
  expect(g.counts[1]).toBe(1);
  expect(g.counts[14]).toBe(1);
  expect(g.most).toBe(2);
  expect(g.pans[0]).toBeCloseTo(-0.1);
  expect(g.lead[1]).toBe('eu');
  expect(g.lead[14]).toBe('as');
  expect(g.lead[2]).toBeUndefined();
  expect(g.share[0]).toBe(0.5);
  expect(g.share[13]).toBe(0.75);
  expect(g.share[23]).toBe(1);
  // no round at the bar line: nothing arrives and nothing is reached
  expect(grid(undefined, 2.4, 24).share[23]).toBe(0);
  expect(steps(round.hits, 2.4, 32)[18]).toBe(1);
});
