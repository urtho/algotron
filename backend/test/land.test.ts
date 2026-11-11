import { expect, test } from 'bun:test';
import land from '../../frontend/src/assets/land-110m.json';
import { landDots } from '../../frontend/src/landDots.ts';

test('land dots fall on continents, not oceans', () => {
  const dots = landDots(land.features, 3);
  const near = (lat: number, lng: number) =>
    dots.some(([a, b]) => Math.abs(a - lat) < 3 && Math.abs(b - lng) < 3);
  expect(near(52, 19)).toBe(true); // Poland
  expect(near(-25, 135)).toBe(true); // Australia
  expect(near(0, -30)).toBe(false); // mid Atlantic
  expect(near(-40, -120)).toBe(false); // south Pacific
  // land is about 29% of the sphere
  const share = dots.length / ((4 * Math.PI * (180 / Math.PI) ** 2) / 9);
  expect(share).toBeGreaterThan(0.24);
  expect(share).toBeLessThan(0.34);
});
