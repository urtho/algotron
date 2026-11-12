import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Ink and chrome for canvas drawing; kept in step with styles/app.css */
const INK = { text: '#9fe8d2', muted: '#3f8573', grid: '#0a3040', surface: '#00060f' };
const FONT = "10px 'Share Tech Mono', monospace";
const PAD = { l: 34, r: 46, t: 10, b: 16 };

export interface Tip {
  x: number;
  title: string;
  rows: { color?: string; label: string; value: string }[];
}

export interface Frame {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
  /** plot area */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A "nice" axis maximum: 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

/**
 * Canvas with device-pixel scaling, redraw on resize, and a hover layer:
 * `locate` maps a pointer x to the tooltip for the nearest mark.
 */
export function Canvas(props: {
  draw: (f: Frame, hoverX: number | null) => void;
  locate: (f: Omit<Frame, 'ctx'>, px: number) => Tip | null;
  deps: unknown[];
  /** Right padding; the default leaves room for end labels */
  padRight?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame = {
    w: size.w,
    h: size.h,
    x0: PAD.l,
    x1: size.w - (props.padRight ?? PAD.r),
    y0: PAD.t,
    y1: size.h - PAD.b,
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw is driven by the caller's deps
  useEffect(() => {
    const c = canvas.current;
    if (!c || size.w < 40 || size.h < 40) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    props.draw({ ctx, ...frame }, tip?.x ?? null);
  }, [size.w, size.h, tip?.x, ...props.deps]);

  return (
    <div
      className="chart-canvas"
      ref={wrap}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setTip(props.locate(frame, e.clientX - rect.left));
      }}
      onPointerLeave={() => setTip(null)}
    >
      <canvas ref={canvas} />
      {tip && (
        <div
          className="chart-tip"
          style={tip.x > size.w / 2 ? { right: size.w - tip.x + 10 } : { left: tip.x + 10 }}
        >
          <div className="chart-tip-title">{tip.title}</div>
          {tip.rows.map((r) => (
            <div key={r.label} className="chart-tip-row">
              {r.color && <span className="swatch" style={{ background: r.color }} />}
              <span className="chart-tip-label">{r.label}</span>
              <span className="chart-tip-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface Series {
  name: string;
  color: string;
  values: (number | undefined)[];
}

/** Panel frame shared by every chart: title, optional legend, headline value. */
export function ChartPanel(props: {
  title: string;
  note?: string;
  legend?: { name: string; color: string }[];
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="chart-panel">
      <header className="chart-head">
        <span className="panel-title">{props.title}</span>
        {props.note && <span className="chart-note">{props.note}</span>}
        {props.legend && (
          <span className="chart-legend">
            {props.legend.map((l) => (
              <span key={l.name} className="chart-legend-item">
                <span className="swatch" style={{ background: l.color }} />
                {l.name}
              </span>
            ))}
          </span>
        )}
        {props.value !== undefined && <span className="chart-value">{props.value}</span>}
      </header>
      {props.children}
    </section>
  );
}

type Plot = Omit<Frame, 'ctx'>;

/** A horizontal grid line across the plot with its value on the left. */
function level(f: Frame, y: number, label: string) {
  const { ctx } = f;
  const yy = Math.round(y) + 0.5;
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(f.x0, yy);
  ctx.lineTo(f.x1, yy);
  ctx.stroke();
  ctx.font = FONT;
  ctx.fillStyle = INK.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, f.x0 - 6, yy);
}

/** Small caption inside a sub-plot, and the time span under the whole plot. */
function caption(f: Frame, text: string, y: number) {
  f.ctx.font = FONT;
  f.ctx.fillStyle = INK.muted;
  f.ctx.textAlign = 'left';
  f.ctx.textBaseline = 'alphabetic';
  f.ctx.fillText(text, f.x0 + 4, y);
}
function span(f: Frame, left: string) {
  f.ctx.font = FONT;
  f.ctx.fillStyle = INK.muted;
  f.ctx.textBaseline = 'alphabetic';
  f.ctx.textAlign = 'left';
  f.ctx.fillText(left, f.x0, f.h - 3);
  f.ctx.textAlign = 'right';
  f.ctx.fillText('now', f.x1, f.h - 3);
}

/** A 2px line through the defined points; returns its last point. */
function line(f: Frame, pts: [number, number][], color: string): [number, number] | undefined {
  if (pts.length < 2) return undefined;
  const { ctx } = f;
  ctx.beginPath();
  pts.forEach(([x, y], i) => {
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  return pts[pts.length - 1];
}

/** The emphasized end of a line, ringed in the surface color, with its value beside it. */
function endMark(f: Frame, x: number, y: number, color: string, label: string, labelY = y) {
  const { ctx } = f;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = INK.surface;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK.text;
  ctx.fillText(label, f.x1 + 9, labelY);
}

function crosshair(f: Frame, hoverX: number | null) {
  if (hoverX === null) return;
  f.ctx.strokeStyle = INK.muted;
  f.ctx.lineWidth = 1;
  f.ctx.beginPath();
  f.ctx.moveTo(Math.round(hoverX) + 0.5, f.y0);
  f.ctx.lineTo(Math.round(hoverX) + 0.5, f.y1);
  f.ctx.stroke();
}

/**
 * Throughput and what it is made of, in one plot over the same rounds. TPS is a line rising from the
 * bottom edge (scale on the left); each block's transactions hang from the top edge as a stacked column
 * (scale on the right, zero at the top). Each scale spans the full height, so the two cross when both
 * are high: the opposite baselines keep them apart the rest of the time.
 */
export function FlowChart(props: {
  rounds: number[];
  tps: number[];
  parts: number[][];
  names: string[];
  colors: string[];
  lineColor: string;
  left: string;
}) {
  const { rounds, tps, parts, colors, names } = props;
  const n = rounds.length;
  const totals = parts.map((p) => p.reduce((s, v) => s + v, 0));
  const tpsMax = niceMax(Math.max(0, ...tps));
  const txMax = niceMax(Math.max(1, ...totals));
  const geo = (f: Plot) => {
    const slot = (f.x1 - f.x0) / Math.max(1, n);
    return { slot, cx: (i: number) => f.x0 + slot * (i + 0.5) };
  };

  return (
    <Canvas
      deps={[rounds[n - 1], n, tps[n - 1]]}
      draw={(f, hoverX) => {
        const { ctx } = f;
        const g = geo(f);
        const height = f.y1 - f.y0;
        level(f, f.y0, fmt1(tpsMax));
        level(f, f.y1, '0');
        // the transactions' scale reads on the right, upside down
        ctx.textAlign = 'left';
        ctx.fillText('0', f.x1 + 6, Math.round(f.y0) + 0.5);
        ctx.fillText(String(Math.round(txMax)), f.x1 + 6, Math.round(f.y1) + 0.5);
        span(f, props.left);

        const hot = hoverX === null ? -1 : Math.max(0, Math.min(n - 1, Math.floor((hoverX - f.x0) / g.slot)));
        const bw = Math.max(1, Math.min(18, g.slot - (g.slot > 3 ? 2 : 1)));
        parts.forEach((p, i) => {
          let y = f.y0 + 1;
          ctx.globalAlpha = hot === -1 || hot === i ? 1 : 0.45;
          p.forEach((v, k) => {
            if (v <= 0) return;
            const h = (height * v) / txMax;
            ctx.fillStyle = colors[k]!;
            // 1px surface gap between segments (2px would swallow one-transaction segments)
            ctx.fillRect(g.cx(i) - bw / 2, y, bw, Math.max(1, h - 1));
            y += h;
          });
        });
        ctx.globalAlpha = 1;

        const pts = tps.map((v, i): [number, number] => [g.cx(i), f.y1 - (height * v) / tpsMax]);
        const end = line(f, pts, props.lineColor);
        if (end) {
          ctx.lineTo(end[0], f.y1);
          ctx.lineTo(pts[0]![0], f.y1);
          ctx.closePath();
          ctx.globalAlpha = 0.1;
          ctx.fillStyle = props.lineColor;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(end[0], end[1], 6, 0, Math.PI * 2);
          ctx.fillStyle = INK.surface;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(end[0], end[1], 4, 0, Math.PI * 2);
          ctx.fillStyle = props.lineColor;
          ctx.fill();
        }

        caption(f, '▲ TPS', f.y1 - 5);
        // the columns start at the top edge: their caption gets a patch of surface to stay readable over them
        const text = 'TXNS PER BLOCK ▼';
        ctx.font = FONT;
        const tw = ctx.measureText(text).width;
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = INK.surface;
        ctx.fillRect(f.x1 - tw - 8, f.y0 + 2, tw + 8, 13);
        ctx.globalAlpha = 1;
        ctx.fillStyle = INK.muted;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, f.x1 - 4, f.y0 + 12);
        crosshair(f, hot >= 0 ? g.cx(hot) : null);
      }}
      locate={(f, px) => {
        if (n === 0 || px < f.x0 || px > f.x1) return null;
        const g = geo(f);
        const i = Math.max(0, Math.min(n - 1, Math.floor((px - f.x0) / g.slot)));
        return {
          x: g.cx(i),
          title: `#${rounds[i]!.toLocaleString('en-US')} · ${totals[i]} txns`,
          rows: [
            { color: props.lineColor, label: 'TPS', value: fmt1(tps[i] ?? 0) },
            ...parts[i]!.map((v, k) => ({ color: colors[k], label: names[k]!, value: String(v) })).filter(
              (r) => r.value !== '0',
            ),
          ],
        };
      }}
    />
  );
}

const fmt1 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 });

/** A zoomed value range: it does not start at zero, so a nearly flat series shows its movement. */
function zoomRange(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => s >= (hi - lo) / 2) ?? 100;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  return [a, b > a ? b : a + step];
}

/**
 * Two plots over the same rounds, one above the other, each with its own scale. The upper one is zoomed
 * to the range its series actually moves in (labelled at both ends); the lower one starts at zero.
 */
export function SplitChart(props: {
  rounds: number[];
  top: Series;
  topUnit: (v: number) => string;
  topLabel: string;
  bottom: Series[];
  bottomUnit: (v: number) => string;
  bottomLabel: string;
  left: string;
}) {
  const { rounds, top, bottom } = props;
  const n = rounds.length;
  const defined = (s: Series) => s.values.filter((v): v is number => v !== undefined);
  const [lo, hi] = zoomRange(defined(top));
  const max = niceMax(Math.max(0, ...bottom.flatMap(defined)));
  const geo = (f: Plot) => {
    const gap = 18;
    const split = Math.round(f.y0 + (f.y1 - f.y0 - gap) * 0.42);
    return {
      split,
      low0: split + gap,
      x: (i: number) => f.x0 + (n > 1 ? ((f.x1 - f.x0) * i) / (n - 1) : 0),
      yTop: (v: number) => split - ((split - f.y0) * (v - lo)) / (hi - lo),
      yLow: (v: number) => f.y1 - ((f.y1 - split - gap) * v) / max,
    };
  };
  const points = (s: Series, x: (i: number) => number, y: (v: number) => number) => {
    const pts: [number, number][] = [];
    s.values.forEach((v, i) => {
      if (v !== undefined) pts.push([x(i), y(v)]);
    });
    return pts;
  };

  return (
    <Canvas
      deps={[rounds[n - 1], n, top.values[n - 1], bottom.map((s) => s.values[n - 1]).join()]}
      draw={(f, hoverX) => {
        const g = geo(f);
        level(f, f.y0, props.topUnit(hi));
        level(f, g.split, props.topUnit(lo));
        level(f, g.low0, props.bottomUnit(max));
        level(f, f.y1, '0');
        // both captions sit in the gap between the two plots, clear of the lines
        caption(f, `▲ ${props.topLabel}   ▼ ${props.bottomLabel}`, g.split + 12);
        span(f, props.left);

        const topEnd = line(f, points(top, g.x, g.yTop), top.color);
        const topLast = defined(top).at(-1);
        if (topEnd && topLast !== undefined)
          endMark(f, topEnd[0], topEnd[1], top.color, props.topUnit(topLast));

        const ends = bottom.flatMap((s) => {
          const end = line(f, points(s, g.x, g.yLow), s.color);
          const last = defined(s).at(-1);
          return end && last !== undefined ? [{ end, s, last, y: end[1] }] : [];
        });
        // end labels in text ink; if two would collide, push them apart
        ends.sort((a, b) => a.y - b.y);
        if (ends.length === 2 && ends[1]!.y - ends[0]!.y < 11) {
          const mid = (ends[0]!.y + ends[1]!.y) / 2;
          ends[0]!.y = mid - 6;
          ends[1]!.y = mid + 6;
        }
        for (const e of ends) endMark(f, e.end[0], e.end[1], e.s.color, props.bottomUnit(e.last), e.y);
        crosshair(f, hoverX);
      }}
      locate={(f, px) => {
        if (n < 2 || px < f.x0 - 4 || px > f.x1 + 4) return null;
        const g = geo(f);
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - f.x0) / (f.x1 - f.x0)) * (n - 1))));
        const row = (s: Series, unit: (v: number) => string) =>
          s.values[i] === undefined ? [] : [{ color: s.color, label: s.name, value: unit(s.values[i]!) }];
        return {
          x: g.x(i),
          title: `#${rounds[i]!.toLocaleString('en-US')}`,
          rows: [...row(top, props.topUnit), ...bottom.flatMap((s) => row(s, props.bottomUnit))],
        };
      }}
    />
  );
}
