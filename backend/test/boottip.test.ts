import { expect, test } from 'bun:test';
import { bootTip } from '../src/monitor.ts';

test('a stuck relay that answers first does not set the tip', () => {
  // 2026-11-13: r-c7 answered first, 235,786 rounds behind, and pinned the tip until the next restart
  expect(bootTip([66_684_509, 66_920_295, 66_920_294])).toBe(66_920_295);
});

test('a far-future claim does not set the tip', () => {
  expect(bootTip([66_920_294, 2 ** 40, 66_920_295])).toBe(66_920_295);
});

test('healthy nodes a few rounds apart give the highest round', () => {
  expect(bootTip([66_920_293, 66_920_295, 66_920_294, 66_920_290])).toBe(66_920_295);
});

test('one or two nodes (a small dev setup) still give a tip', () => {
  expect(bootTip([])).toBe(0);
  expect(bootTip([42])).toBe(42);
  expect(bootTip([42, 44])).toBe(44);
});
