import type { LiveSwap } from '../../../shared/types.ts';

/**
 * A routed swap laid out as a circuit board. Hops are grouped into flows per asset pair; every flow gets the share
 * of the swap's value that passes through it. The widest input → output paths (at most 4, each at least 3 % of
 * the value) become lanes; a pair several lanes share is drawn once, and everything else rides one tail bus with a
 * counter. Columns are hop depth.
 */

export interface Flow {
  a: string;
  b: string;
  usd: number;
  pools: number;
  /** USD per venue */
  venues: Map<string, number>;
  share: number;
}
export interface Chip {
  sym: string;
  /** Column: hop depth, the output last */
  d: number;
  y0: number;
  y1: number;
  cy: number;
  share: number;
}
export interface Segment {
  f: Flow;
  /** Lanes that use this pair */
  rows: number[];
  y: number;
}
export interface Board {
  swap: LiveSwap;
  depth: number;
  lanes: { w: number; nodes: string[] }[];
  chips: Map<string, Chip>;
  segs: Segment[];
  laneY: (i: number) => number;
  tailHops: number;
  tailAssets: string[];
  tailShare: number;
  dexes: number;
  /** Assets between input and output */
  mids: number;
}

const MAX_LANES = 4;
const MIN_LANE = 0.03;

export function board(S: LiveSwap): Board {
  // flows per asset pair
  const flows = new Map<string, Flow>();
  for (const h of S.hops) {
    if (h.a === h.b) continue;
    const k = `${h.a}>${h.b}`;
    let f = flows.get(k);
    if (!f) {
      f = { a: h.a, b: h.b, usd: 0, pools: 0, venues: new Map(), share: 0 };
      flows.set(k, f);
    }
    f.usd += h.usd;
    f.pools++;
    f.venues.set(h.venue, (f.venues.get(h.venue) ?? 0) + h.usd);
  }
  if (!flows.size)
    flows.set(`${S.inSym}>${S.outSym}`, {
      a: S.inSym,
      b: S.outSym,
      usd: S.usd,
      pools: 1,
      venues: new Map([['DIRECT', S.usd]]),
      share: 1,
    });
  const F = [...flows.values()];

  // depth: longest hop path from the input (bounded, so a round trip cannot loop)
  const dep = new Map<string, number>([[S.inSym, 0]]);
  for (const f of F) {
    if (!dep.has(f.a)) dep.set(f.a, 0);
    if (!dep.has(f.b)) dep.set(f.b, 0);
  }
  for (let it = 0; it < dep.size + 1; it++) {
    let moved = false;
    for (const f of F) {
      if (f.b === S.inSym) continue;
      const d = (dep.get(f.a) ?? 0) + 1;
      if (d > (dep.get(f.b) ?? 0) && d <= dep.size) {
        dep.set(f.b, d);
        moved = true;
      }
    }
    if (!moved) break;
  }
  let maxMid = 0;
  for (const [s, d] of dep) if (s !== S.outSym) maxMid = Math.max(maxMid, d);
  const D = Math.max(1, maxMid + 1);
  dep.set(S.outSym, D);
  dep.set(S.inSym, 0);
  for (const [s, d] of dep) if (s !== S.inSym && s !== S.outSym) dep.set(s, Math.min(Math.max(1, d), D - 1));

  // value shares: the input is 1; every asset splits what reached it over its out-flows by USD
  const share = new Map<string, number>([[S.inSym, 1]]);
  const out = new Map<string, Flow[]>();
  for (const f of F) out.set(f.a, [...(out.get(f.a) ?? []), f]);
  for (const s of [...dep.keys()].sort((a, b) => (dep.get(a) ?? 0) - (dep.get(b) ?? 0))) {
    const fs = out.get(s) ?? [];
    const tot = fs.reduce((a, f) => a + f.usd, 0) || 1;
    for (const f of fs) {
      if (f.b === S.inSym) continue;
      f.share = ((share.get(s) ?? 0) * (f.usd || tot / fs.length)) / tot;
      share.set(f.b, (share.get(f.b) ?? 0) + f.share);
    }
  }

  // widest paths
  const left = new Map(F.map((f) => [f, f.share]));
  const order = [...dep.keys()].sort((a, b) => (dep.get(a) ?? 0) - (dep.get(b) ?? 0));
  const lanes: { w: number; path: Flow[]; nodes: string[] }[] = [];
  for (let i = 0; i < MAX_LANES; i++) {
    const best = new Map<string, { w: number; via: Flow | null }>([[S.inSym, { w: Infinity, via: null }]]);
    for (const s of order) {
      const b = best.get(s);
      if (!b) continue;
      for (const f of out.get(s) ?? []) {
        if (f.b === S.inSym || (dep.get(f.b) ?? 0) <= (dep.get(s) ?? 0)) continue;
        const w = Math.min(b.w, left.get(f) ?? 0);
        if (w > (best.get(f.b)?.w ?? 0)) best.set(f.b, { w, via: f });
      }
    }
    const end = best.get(S.outSym);
    if (!end || end.w < MIN_LANE) break;
    const path: Flow[] = [];
    let c = S.outSym;
    for (let guard = 0; c !== S.inSym && guard < 32; guard++) {
      const v = best.get(c)?.via;
      if (!v) break;
      path.unshift(v);
      c = v.a;
    }
    if (c !== S.inSym) break;
    for (const f of path) left.set(f, (left.get(f) ?? 0) - end.w);
    lanes.push({ w: end.w, path, nodes: [S.inSym, ...path.map((f) => f.b)] });
  }
  if (!lanes.length) {
    const f = [...F].sort((a, b) => b.share - a.share)[0]!;
    const direct: Flow =
      f.a === S.inSym && f.b === S.outSym ? f : { ...f, a: S.inSym, b: S.outSym, share: 1 };
    lanes.push({ w: 1, path: [direct], nodes: [S.inSym, S.outSym] });
  }
  lanes.sort((a, b) => (a.nodes.join('>') < b.nodes.join('>') ? -1 : 1));

  const R = lanes.length;
  const gap = R > 1 ? Math.min(130, 430 / (R - 1)) : 0;
  const top = 430 - (gap * (R - 1)) / 2;
  const laneY = (i: number) => top + i * gap;
  const rows = new Map<string, Set<number>>();
  lanes.forEach((l, i) => {
    for (const s of l.nodes) {
      const r = rows.get(s) ?? new Set();
      r.add(i);
      rows.set(s, r);
    }
  });
  const chips = new Map<string, Chip>();
  for (const [s, r] of rows) {
    const end = s === S.inSym || s === S.outSym;
    const rr = [...r];
    const y0 = end ? laneY(0) - 60 : laneY(Math.min(...rr)) - 34;
    const y1 = end ? laneY(R - 1) + 60 : laneY(Math.max(...rr)) + 34;
    chips.set(s, { sym: s, d: dep.get(s) ?? 0, y0, y1, cy: (y0 + y1) / 2, share: share.get(s) ?? 0 });
  }
  const segMap = new Map<string, Segment>();
  lanes.forEach((l, i) => {
    l.path.forEach((f) => {
      const k = `${f.a}>${f.b}`;
      const sg = segMap.get(k) ?? { f, rows: [], y: 0 };
      sg.rows.push(i);
      segMap.set(k, sg);
    });
  });
  const segs = [...segMap.values()].map((sg) => ({
    ...sg,
    y: sg.rows.reduce((a, r) => a + laneY(r), 0) / sg.rows.length,
  }));
  const tail = F.filter((f) => !segMap.has(`${f.a}>${f.b}`));
  return {
    swap: S,
    depth: D,
    lanes: lanes.map((l) => ({ w: l.w, nodes: l.nodes })),
    chips,
    segs,
    laneY,
    tailHops: tail.reduce((a, f) => a + f.pools, 0),
    tailAssets: [...new Set(tail.flatMap((f) => [f.a, f.b]))].filter((s) => !rows.has(s)),
    tailShare: Math.max(0, 1 - lanes.reduce((a, l) => a + l.w, 0)),
    dexes: new Set(S.hops.map((h) => h.venue)).size,
    mids: Math.max(0, dep.size - 2),
  };
}
