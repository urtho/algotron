import type { Board, Flow } from './board.ts';

/**
 * The identity-disc treatment of a swap board, drawn as one SVG string per frame (viewBox 1600 × 900).
 * p is the progress of the 3 s animation: 0-18 % the input charges, 18-78 % the value moves column by column,
 * 78-100 % it lands; above 1 the board rests. t is the wall clock in seconds, for the spinning rings.
 */

const CY = '#00e5ff';
const OR = '#ff9a1a';
const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
export const fmt = (x: number) =>
  x >= 1e6
    ? `${(x / 1e6).toFixed(2)}M`
    : x >= 1e4
      ? `${(x / 1e3).toFixed(1)}K`
      : x >= 100
        ? x.toFixed(0)
        : x >= 1
          ? x.toFixed(2)
          : x > 0
            ? x.toPrecision(3)
            : '0';
const pct = (x: number) => (x >= 0.095 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);
const venuesOf = (f: Flow) => [...f.venues.entries()].sort((a, b) => b[1] - a[1]).map((v) => v[0]);
const dexTag = (f: Flow) => {
  const v = venuesOf(f);
  return (v.length > 2 ? `${v.slice(0, 2).join('+')}…` : v.join('+')) + (f.pools > 1 ? ` ×${f.pools}` : '');
};

interface TextOpts {
  fill?: string;
  font?: string;
  size?: number;
  weight?: number;
  anchor?: string;
  ls?: number;
  op?: number;
  glow?: boolean;
}
const T = (x: number, y: number, t: string, o: TextOpts = {}) =>
  `<text x="${x}" y="${y}" fill="${o.fill ?? '#e6fff7'}" font-family="${o.font ?? "'Share Tech Mono', monospace"}" font-size="${o.size ?? 16}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? 'middle'}" letter-spacing="${o.ls ?? 1}" opacity="${o.op ?? 1}"${o.glow ? ' filter="url(#sg)"' : ''}>${esc(t)}</text>`;
const DEFS = `<defs><filter id="sg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><filter id="sg2" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="12" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;

export const counts = (B: Board) => {
  const n = B.swap.hops.length;
  return `${n} HOP${n === 1 ? '' : 'S'} · ${B.mids} VIA · ${B.dexes} DEX${B.dexes === 1 ? '' : 'ES'} · DEPTH ${B.depth}`;
};

interface Disc {
  cx: number;
  cy: number;
  r: number;
  pill: boolean;
  y0: number;
  y1: number;
}

export function drawDiscs(B: Board, p: number, t: number): string {
  const S = B.swap;
  const D = B.depth;
  let h = DEFS;
  const rBig = (y0: number, y1: number) => Math.max(90, Math.min(200, (y1 - y0) / 2 - 20));
  const ci = B.chips.get(S.inSym)!;
  const co = B.chips.get(S.outSym)!;
  const rin = rBig(ci.y0, ci.y1);
  const rout = rBig(co.y0, co.y1);
  const inX = 60 + rin;
  const outX = 1540 - rout;
  const a0 = inX + rin + 150;
  const a1 = outX - rout - 150;
  const CX = (d: number) =>
    d === 0 ? inX : d === D ? outX : D === 2 ? (a0 + a1) / 2 : a0 + ((a1 - a0) * (d - 1)) / (D - 2);
  const disc = new Map<string, Disc>();
  for (const [s, c] of B.chips) {
    const big = s === S.inSym || s === S.outSym;
    disc.set(s, {
      cx: CX(c.d),
      cy: c.cy,
      r: big ? (s === S.inSym ? rin : rout) : 38,
      pill: !big && c.y1 - c.y0 > 100,
      y0: c.y0 + 8,
      y1: c.y1 - 8,
    });
  }
  const rim = (s: string, y: number, side: number) => {
    const d = disc.get(s)!;
    if (d.pill) return d.cx + side * 38;
    const dy = Math.min(Math.abs(y - d.cy), d.r * 0.97);
    return d.cx + side * Math.sqrt(d.r * d.r - dy * dy);
  };
  const reached = (s: string) => s === S.inSym || p >= 0.18 + (0.6 * (B.chips.get(s)?.d ?? 0)) / D - 0.01;
  const tailY = Math.max(B.laneY(B.lanes.length - 1) + 130, 700);

  // tail bus
  if (B.tailHops) {
    const xa = disc.get(S.inSym)!.cx + 40;
    const xb = disc.get(S.outSym)!.cx - 40;
    h += `<line x1="${xa}" y1="${tailY}" x2="${xb}" y2="${tailY}" stroke="${CY}" stroke-width="1.5" stroke-dasharray="1 8" opacity=".6"/>`;
    const shown = B.tailAssets.slice(0, 10);
    shown.forEach((a, k) => {
      const x = xa + 120 + (k * (xb - xa - 240)) / Math.max(1, shown.length - 1);
      h += `<circle cx="${x}" cy="${tailY}" r="8" fill="none" stroke="#3aa9bf"/>${T(x, tailY + 26, a, { size: 11, fill: '#3f8fa0' })}`;
    });
    const tu = seg(p, 0.22, 0.78);
    const n = Math.max(2, Math.round(B.tailShare * 60));
    for (let k = 0; k < n; k++) {
      const f = tu * 1.3 - (k / n) * 0.3;
      if (f > 0 && f < 1)
        h += `<circle cx="${xa + (xb - xa) * f}" cy="${tailY}" r="3" fill="${CY}" filter="url(#sg)"/>`;
    }
    h += T(
      800,
      tailY + 40,
      `TAIL · +${B.tailHops} HOPS · ${B.tailAssets.length} ASSETS · ${pct(B.tailShare)} OF THE VALUE`,
      {
        size: 15,
        fill: '#4f9fae',
        ls: 2.5,
      },
    );
  }

  // lanes
  let outFill = B.tailShare * seg(p, 0.3, 0.8);
  for (const sg of B.segs) {
    const da = B.chips.get(sg.f.a)?.d ?? 0;
    const db = B.chips.get(sg.f.b)?.d ?? D;
    const u = ease(seg(p, 0.18 + (0.6 * da) / D, 0.18 + (0.6 * db) / D));
    const isOut = sg.f.b === S.outSym;
    const c = isOut ? OR : CY;
    const w = 3 + sg.f.share * 34;
    const xa = rim(sg.f.a, sg.y, 1);
    const xb = rim(sg.f.b, sg.y, -1);
    const n = Math.min(sg.f.pools, 5);
    const p0 = xa + (xb - xa) * 0.62;
    const pads = Array.from({ length: n }, (_, k) => p0 + (k - (n - 1) / 2) * 18);
    if (isOut) outFill += sg.f.share * u;
    h += `<line x1="${xa}" y1="${sg.y}" x2="${xb}" y2="${sg.y}" stroke="${c}" stroke-width="${w}" opacity=".16"/>`;
    if (u > 0) {
      const xh = xa + (xb - xa) * u;
      h += `<line x1="${xa}" y1="${sg.y}" x2="${xh}" y2="${sg.y}" stroke="${c}" stroke-width="${w * 0.7}" filter="url(#sg)" opacity="${p > 1.1 ? Math.max(0.35, 1 - (p - 1.1)) : 1}"/>`;
      if (u < 1) h += `<circle cx="${xh}" cy="${sg.y}" r="${4 + w * 0.35}" fill="#fff" filter="url(#sg2)"/>`;
    }
    for (const px of pads) {
      const at = (px - xa) / (xb - xa);
      const hit = u >= at;
      const flash = hit && u - at < 0.12;
      h += `<circle cx="${px}" cy="${sg.y}" r="${w / 2 + 8}" fill="none" stroke="${flash ? '#fff' : hit ? c : '#2a6a7a'}" stroke-width="${flash ? 3.5 : 2}"${flash ? ' filter="url(#sg)"' : ''}/>`;
    }
    h += T((xa + (pads[0] ?? xa)) / 2, sg.y - w / 2 - 12, pct(sg.f.share), {
      size: 22,
      font: 'Oxanium, sans-serif',
      weight: 700,
      fill: u > 0 ? '#fff' : '#4f8f9e',
      glow: u > 0,
    });
    h += T((pads[0] ?? xa) + (pads.length - 1) * 9, sg.y + w / 2 + 30, dexTag(sg.f), {
      size: 12,
      fill: '#6fd0e0',
      ls: 1.5,
    });
  }
  outFill = Math.min(1, outFill);

  // discs and pills
  for (const [s, d] of disc) {
    const isIn = s === S.inSym;
    const isOut = s === S.outSym;
    const col = isOut ? OR : CY;
    const on = reached(s);
    const glow = on ? ' filter="url(#sg)"' : '';
    if (d.pill) {
      h += `<rect x="${d.cx - 38}" y="${d.y0}" width="76" height="${d.y1 - d.y0}" rx="38" fill="#010f1a" stroke="${col}" stroke-width="2" opacity="${on ? 1 : 0.45}"${glow}/>`;
      const n = Math.floor((d.y1 - d.y0 - 40) / 16);
      for (let k = 0; k < n; k++) {
        const y = d.y0 + 20 + k * 16 + ((t * 40) % 16);
        if (y > d.y1 - 20) continue;
        h += `<rect x="${d.cx - 22}" y="${y}" width="44" height="7" rx="3" fill="${col}" opacity="${on ? 0.85 : 0.12}"${glow}/>`;
      }
      h += `<rect x="${d.cx - 30}" y="${d.cy - 13}" width="60" height="22" fill="#010f1a"/>`;
      h += T(d.cx, d.cy + 4, s, {
        size: s.length > 6 ? 11 : 13,
        font: 'Oxanium, sans-serif',
        weight: 700,
        fill: col,
        op: on ? 1 : 0.5,
      });
      continue;
    }
    const big = isIn || isOut;
    const fill = isIn ? 1 - seg(p, 0.18, 0.62) : isOut ? outFill : on ? 1 : 0;
    const segN = big ? 32 : 12;
    const rr = d.r * (big ? 0.84 : 0.78);
    const sw = big ? 11 : 6;
    h += `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="#010f1a" stroke="${col}" stroke-width="2" opacity="${on ? 1 : 0.45}"${glow}/>`;
    const rot = t * (big ? 0.25 : 1.2) * (isOut ? -1 : 1);
    for (let k = 0; k < segN; k++) {
      const q0 = (k / segN) * Math.PI * 2 - Math.PI / 2 + rot;
      const q1 = q0 + ((Math.PI * 2) / segN) * 0.68;
      const lit = k / segN < fill;
      h += `<path d="M${d.cx + rr * Math.cos(q0)},${d.cy + rr * Math.sin(q0)} A${rr},${rr} 0 0 1 ${d.cx + rr * Math.cos(q1)},${d.cy + rr * Math.sin(q1)}" stroke="${col}" stroke-width="${sw}" fill="none" opacity="${lit ? 1 : 0.13}"${lit ? ' filter="url(#sg)"' : ''}/>`;
    }
    h += `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r * 0.55}" fill="none" stroke="${col}" stroke-width="1" opacity=".45"/>`;
    h += T(d.cx, d.cy + (big ? 8 : 5), s, {
      size: big ? (s.length > 6 ? 20 : 26) : s.length > 6 ? 11 : 13,
      font: 'Oxanium, sans-serif',
      weight: 700,
      fill: col,
      op: on ? 1 : 0.5,
    });
    if (big)
      h += T(d.cx, d.cy + 34, fmt(isIn ? S.inAmt * (1 - seg(p, 0.18, 0.62)) : S.outAmt * outFill), {
        size: 15,
        fill: isIn ? '#bff8ff' : '#ffd08a',
      });
  }

  // landing ring
  const L = seg(p, 0.78, 1.15);
  if (L > 0 && L < 1) {
    const d = disc.get(S.outSym)!;
    h += `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r + L * 160}" fill="none" stroke="${OR}" stroke-width="3" opacity="${1 - L}" filter="url(#sg)"/>`;
  }
  h += T(disc.get(S.inSym)!.cx, 90, `${fmt(S.inAmt)} ${S.inSym}`, {
    size: 26,
    font: 'Oxanium, sans-serif',
    weight: 700,
    fill: '#bff8ff',
    glow: true,
  });
  h += T(disc.get(S.outSym)!.cx, 90, `${fmt(S.outAmt)} ${S.outSym}`, {
    size: 26,
    font: 'Oxanium, sans-serif',
    weight: 700,
    fill: '#ffd08a',
    glow: true,
    op: 0.35 + 0.65 * seg(p, 0.7, 0.95),
  });
  h += T(1580, 40, counts(B), { anchor: 'end', size: 16, fill: '#6fa898', ls: 2 });
  h += `<rect x="60" y="880" width="1480" height="3" fill="#0a3040"/><rect x="60" y="880" width="${1480 * clamp(p)}" height="3" fill="${CY}" filter="url(#sg)"/>`;
  return h;
}
