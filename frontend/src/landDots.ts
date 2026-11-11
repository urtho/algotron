/** Land as a field of evenly spaced points, from GeoJSON land polygons. */

type Ring = number[][];
interface Poly {
  rings: Ring[];
  box: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
}

interface Feature {
  geometry: { type: string; coordinates?: unknown };
}

function inRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polys(features: Feature[]): Poly[] {
  const out: Poly[] = [];
  const add = (rings: Ring[]) => {
    const outer = rings[0];
    if (!outer || outer.length < 3) return;
    let [a, b, c, d] = [180, 90, -180, -90];
    for (const [x, y] of outer as [number, number][]) {
      a = Math.min(a, x);
      b = Math.min(b, y);
      c = Math.max(c, x);
      d = Math.max(d, y);
    }
    out.push({ rings, box: [a, b, c, d] });
  };
  for (const f of features) {
    if (f.geometry.type === 'Polygon') add(f.geometry.coordinates as Ring[]);
    else if (f.geometry.type === 'MultiPolygon') for (const p of f.geometry.coordinates as Ring[][]) add(p);
  }
  return out;
}

export function isLand(ps: Poly[], lng: number, lat: number): boolean {
  for (const p of ps) {
    const [a, b, c, d] = p.box;
    if (lng < a || lng > c || lat < b || lat > d) continue;
    if (!inRing(lng, lat, p.rings[0]!)) continue;
    if (p.rings.slice(1).some((hole) => inRing(lng, lat, hole))) continue;
    return true;
  }
  return false;
}

/**
 * [lat, lng] of every grid point that falls on land. Rows are `step` degrees
 * apart and points in a row are spaced so the distance on the sphere is the
 * same at every latitude (fewer points per row toward the poles).
 */
export function landDots(features: Feature[], step = 1.5): [number, number][] {
  const ps = polys(features);
  const dots: [number, number][] = [];
  for (let lat = -88; lat <= 88; lat += step) {
    const n = Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / step));
    for (let i = 0; i < n; i++) {
      const lng = -180 + ((i + 0.5) * 360) / n;
      if (isLand(ps, lng, lat)) dots.push([lat, lng]);
    }
  }
  return dots;
}
