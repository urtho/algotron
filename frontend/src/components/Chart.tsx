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

interface Frame {
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

function axis(f: Frame, max: number, unit: (v: number) => string, left: string, right: string) {
  const { ctx } = f;
  ctx.font = FONT;
  ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 2; i++) {
    const v = (max * i) / 2;
    const y = Math.round(f.y1 - ((f.y1 - f.y0) * i) / 2) + 0.5;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(f.x0, y);
    ctx.lineTo(f.x1, y);
    ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.fillText(unit(v), f.x0 - 6, y);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(left, f.x0, f.h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(right, f.x1, f.h - 3);
}

/**
 * Canvas with device-pixel scaling, redraw on resize, and a hover layer:
 * `locate` maps a pointer x to the tooltip for the nearest mark.
 */
function Canvas(props: {
  draw: (f: Frame, hoverX: number | null) => void;
  locate: (f: Omit<Frame, 'ctx'>, px: number) => Tip | null;
  deps: unknown[];
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

  const frame = { w: size.w, h: size.h, x0: PAD.l, x1: size.w - PAD.r, y0: PAD.t, y1: size.h - PAD.b };

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

/** One or two lines over the same rounds. The first series gets a 10% wash and an end label. */
export function LineChart(props: {
  rounds: number[];
  series: Series[];
  unit: (v: number) => string;
  left: string;
  fill?: boolean;
}) {
  const { rounds, series, unit } = props;
  const n = rounds.length;
  const max = niceMax(
    Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== undefined))),
  );
  const xAt = (f: Omit<Frame, 'ctx'>, i: number) => f.x0 + (n > 1 ? ((f.x1 - f.x0) * i) / (n - 1) : 0);
  const yAt = (f: Omit<Frame, 'ctx'>, v: number) => f.y1 - ((f.y1 - f.y0) * v) / max;

  return (
    <Canvas
      deps={[rounds[n - 1], n, series.map((s) => s.values[n - 1]).join()]}
      draw={(f, hoverX) => {
        const { ctx } = f;
        axis(f, max, unit, props.left, 'now');
        const ends: { y: number; s: Series; v: number }[] = [];
        series.forEach((s, si) => {
          const pts: [number, number][] = [];
          s.values.forEach((v, i) => {
            if (v !== undefined) pts.push([xAt(f, i), yAt(f, v)]);
          });
          if (pts.length < 2) return;
          ctx.beginPath();
          pts.forEach(([x, y], i) => {
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          });
          ctx.strokeStyle = s.color;
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.stroke();
          if (props.fill && si === 0) {
            ctx.lineTo(pts[pts.length - 1]![0], f.y1);
            ctx.lineTo(pts[0]![0], f.y1);
            ctx.closePath();
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = s.color;
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          const [ex, ey] = pts[pts.length - 1]!;
          ctx.beginPath();
          ctx.arc(ex, ey, 6, 0, Math.PI * 2);
          ctx.fillStyle = INK.surface;
          ctx.fill();
          ctx.beginPath();
          ctx.arc(ex, ey, 4, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
          const last = s.values.findLast((v) => v !== undefined);
          if (last !== undefined) ends.push({ y: ey, s, v: last });
        });
        // end labels in text ink; if two would collide, push them apart
        ends.sort((a, b) => a.y - b.y);
        if (ends.length === 2 && ends[1]!.y - ends[0]!.y < 11) {
          const mid = (ends[0]!.y + ends[1]!.y) / 2;
          ends[0]!.y = mid - 6;
          ends[1]!.y = mid + 6;
        }
        ctx.font = FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = INK.text;
        for (const e of ends) ctx.fillText(unit(e.v), f.x1 + 9, e.y);
        ctx.textBaseline = 'alphabetic';
        if (hoverX !== null) {
          ctx.strokeStyle = INK.muted;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(hoverX) + 0.5, f.y0);
          ctx.lineTo(Math.round(hoverX) + 0.5, f.y1);
          ctx.stroke();
        }
      }}
      locate={(f, px) => {
        if (n < 2 || px < f.x0 - 4 || px > f.x1 + 4) return null;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - f.x0) / (f.x1 - f.x0)) * (n - 1))));
        return {
          x: xAt(f, i),
          title: `#${rounds[i]!.toLocaleString('en-US')}`,
          rows: series
            .filter((s) => s.values[i] !== undefined)
            .map((s) => ({ color: s.color, label: s.name, value: unit(s.values[i]!) })),
        };
      }}
    />
  );
}

/** Stacked columns, one per block. */
export function StackChart(props: {
  rounds: number[];
  parts: number[][];
  names: string[];
  colors: string[];
  left: string;
}) {
  const { rounds, parts, colors, names } = props;
  const n = rounds.length;
  const totals = parts.map((p) => p.reduce((s, v) => s + v, 0));
  const max = niceMax(Math.max(1, ...totals));
  const slot = (f: Omit<Frame, 'ctx'>) => (f.x1 - f.x0) / Math.max(1, n);

  return (
    <Canvas
      deps={[rounds[n - 1], n]}
      draw={(f, hoverX) => {
        const { ctx } = f;
        axis(f, max, (v) => String(Math.round(v)), props.left, 'now');
        const s = slot(f);
        const bw = Math.max(1, Math.min(24, s - 2)); // 2px surface gap between columns
        parts.forEach((p, i) => {
          const x = f.x0 + s * i + (s - bw) / 2;
          let y = f.y1;
          const hot = hoverX !== null && Math.abs(hoverX - (x + bw / 2)) < s / 2;
          ctx.globalAlpha = hoverX === null || hot ? 1 : 0.45;
          p.forEach((v, k) => {
            if (v <= 0) return;
            const h = ((f.y1 - f.y0) * v) / max;
            ctx.fillStyle = colors[k]!;
            // 1px surface gap between segments (2px would swallow one-transaction segments)
            ctx.fillRect(x, y - h, bw, Math.max(1, h - 1));
            y -= h;
          });
        });
        ctx.globalAlpha = 1;
      }}
      locate={(f, px) => {
        if (n === 0 || px < f.x0 || px > f.x1) return null;
        const s = slot(f);
        const i = Math.max(0, Math.min(n - 1, Math.floor((px - f.x0) / s)));
        return {
          x: f.x0 + s * i + s / 2,
          title: `#${rounds[i]!.toLocaleString('en-US')} · ${totals[i]} txns`,
          rows: parts[i]!.map((v, k) => ({ color: colors[k], label: names[k]!, value: String(v) })).filter(
            (r) => r.value !== '0',
          ),
        };
      }}
    />
  );
}
