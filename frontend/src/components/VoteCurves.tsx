import { useEffect, useRef, useState } from 'react';
import type { Wave } from '../../../shared/types.ts';
import {
  CURVE_KINDS,
  CURVE_LABELS,
  type CurveMode,
  curvePlan,
  fmt,
  shareAt,
  type WaveCurves,
  type WavePlan,
  waveCurves,
} from '../stats.ts';
import { ChartPanel } from './Chart.tsx';

interface Props {
  /** Newest finished round, the one the globe replays */
  wave?: Wave;
  /** Series colors for proposal, soft vote and cert vote */
  colors: string[];
}

/** Ink and chrome for canvas drawing; kept in step with Chart.tsx and styles/app.css */
const INK = { text: '#9fe8d2', muted: '#3f8573', grid: '#0a3040', surface: '#00060f', head: '#00ccff' };
const FONT = "10px 'Share Tech Mono', monospace";
const PAD = { l: 34, r: 14, t: 12, b: 18 };
/** Earlier rounds kept as the faint sheaf behind the current one */
const SHEAF = 10;
const SHEAF_ALPHA = 0.17;

interface Scale {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** ms after the first node shown at the plot's right edge */
  win: number;
  sx: (ms: number) => number;
  sy: (share: number) => number;
}

function scaleOf(w: number, h: number, win: number): Scale {
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const y0 = PAD.t;
  const y1 = h - PAD.b;
  return {
    x0,
    x1,
    y0,
    y1,
    win,
    sx: (ms) => x0 + (ms / win) * (x1 - x0),
    sy: (share) => y1 - share * (y1 - y0),
  };
}

function tickStep(win: number, px: number): number {
  const target = win / Math.max(2, Math.floor(px / 64));
  return [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => s >= target) ?? 1000;
}

/** Below this many points a curve is drawn as steps: a slope between a handful of proposers would be made up */
const STEP_BELOW = 20;

/** Cumulative path, one point per node. The caller's clip cuts whatever lies past the window. */
function trace(ctx: CanvasRenderingContext2D, sorted: number[], s: Scale) {
  const n = sorted.length;
  ctx.beginPath();
  ctx.moveTo(s.sx(sorted[0]!), s.sy(0));
  for (let i = 0; i < n; i++) {
    if (n < STEP_BELOW) ctx.lineTo(s.sx(sorted[i]!), s.sy(i / n));
    ctx.lineTo(s.sx(sorted[i]!), s.sy((i + 1) / n));
  }
  ctx.lineTo(Math.max(s.x1, s.sx(sorted[n - 1]!)), s.sy(1));
}

function clip(ctx: CanvasRenderingContext2D, s: Scale, toX: number) {
  ctx.beginPath();
  ctx.rect(s.x0 - 3, s.y0 - 8, toX - s.x0 + 3, s.y1 - s.y0 + 16);
  ctx.clip();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = INK.surface;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

interface Scene {
  cur: WaveCurves;
  sheaf: WaveCurves[];
  plan: WavePlan;
  colors: string[];
  /** ms on the round's own clock the playhead has reached */
  t: number;
  sweeping: boolean;
  hoverX: number | null;
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, sc: Scene) {
  const s = scaleOf(w, h, sc.plan.max * 1.3);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  ctx.lineWidth = 1;

  ctx.textBaseline = 'alphabetic';
  const step = tickStep(s.win, s.x1 - s.x0);
  for (let ms = 0; ms <= s.win; ms += step) {
    const x = Math.round(s.sx(ms)) + 0.5;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(x, s.y0);
    ctx.lineTo(x, s.y1);
    ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.textAlign = ms === 0 ? 'left' : 'center';
    ctx.fillText(ms === 0 ? '0' : `+${ms}`, x, h - 4);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const level of [0, 0.5, 1]) {
    const y = Math.round(s.sy(level)) + 0.5;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(s.x0, y);
    ctx.lineTo(s.x1, y);
    ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.fillText(`${level * 100}%`, s.x0 - 6, y);
  }

  // earlier rounds, whole and faint, so an unusual round stands out from its own history
  ctx.save();
  clip(ctx, s, s.x1 + 1);
  ctx.globalAlpha = SHEAF_ALPHA;
  for (const past of sc.sheaf) {
    CURVE_KINDS.forEach((kind, i) => {
      if (past[kind].length < 2) return;
      ctx.strokeStyle = sc.colors[i]!;
      trace(ctx, past[kind], s);
      ctx.stroke();
    });
  }
  ctx.restore();

  // this round, drawn up to the playhead
  const headX = sc.sweeping ? s.sx(sc.t) : s.x1 + 1;
  ctx.save();
  clip(ctx, s, headX);
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  CURVE_KINDS.forEach((kind, i) => {
    if (sc.cur[kind].length < 2) return;
    ctx.strokeStyle = sc.colors[i]!;
    trace(ctx, sc.cur[kind], s);
    ctx.stroke();
  });
  ctx.restore();

  // a dot lands on the 50% line as each curve crosses it
  CURVE_KINDS.forEach((kind, i) => {
    const vals = sc.cur[kind];
    if (vals.length < 2) return;
    const median = vals[Math.ceil(vals.length / 2) - 1]!;
    if (sc.t >= median && median <= s.win) dot(ctx, s.sx(median), s.sy(0.5), sc.colors[i]!);
  });

  if (sc.hoverX !== null) {
    const x = Math.round(Math.max(s.x0, Math.min(s.x1, sc.hoverX))) + 0.5;
    ctx.strokeStyle = INK.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, s.y0);
    ctx.lineTo(x, s.y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (sc.sweeping) {
    ctx.strokeStyle = INK.head;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(headX, s.y0 - 4);
    ctx.lineTo(headX, s.y1);
    ctx.stroke();
  }
}

const MODES: { mode: CurveMode; label: string }[] = [
  { mode: 'node', label: 'BY NODE' },
  { mode: 'address', label: 'BY ADDRESS' },
];
const MODE_KEY = 'algotron.curves.mode';

function savedMode(): CurveMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'address' ? 'address' : 'node';
  } catch {
    return 'node';
  }
}

/** One finished round, ready to draw either way */
type Round = Record<CurveMode, WaveCurves>;

/**
 * Cumulative arrival of the newest finished round as three curves: the winning proposal, the soft vote and
 * the cert vote, over a sheaf of the rounds before it.
 *
 * By node, a step is a relay and the clock is the globe's (the same wavePlan), each kind counted from its
 * first relay. By address, a step is a voting account taken as if it were a node: when its vote first
 * reached any relay, counted from the first vote of that kind (for the proposal, one step per proposer).
 * That view has its own, slower clock. Votes exist only with the avmonitor feed.
 */
export function VoteCurves({ wave, colors }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [wanted, setWanted] = useState<CurveMode>(savedMode);
  const live = useRef<{ cur?: Round; sheaf: Round[]; born: number }>({ sheaf: [], born: 0 });

  // without account data (polled propagation) only the node view exists
  const mode: CurveMode = wave?.accounts ? wanted : 'node';
  const plan = curvePlan(wave, mode);
  const win = plan.max * 1.3;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new round: the one on screen joins the sheaf and the replay starts, in step with the globe's
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per round
  useEffect(() => {
    if (!wave) return;
    const l = live.current;
    if (l.cur && l.cur.node.round !== wave.round) l.sheaf = [...l.sheaf, l.cur].slice(-SHEAF);
    l.cur = { node: waveCurves(wave, 'node'), address: waveCurves(wave, 'address') };
    const still = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    l.born = still ? Number.NEGATIVE_INFINITY : performance.now();
  }, [wave?.round]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: redrawn per round, mode, size and hover; the sweep runs itself
  useEffect(() => {
    const c = canvas.current;
    const l = live.current;
    if (!c || !l.cur || size.w < 80 || size.h < 60) return;
    const cur = l.cur[mode];
    const sheaf = l.sheaf.map((r) => r[mode]);
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let raf = 0;
    const frame = (now: number) => {
      const t = (now - l.born) / plan.slow;
      const sweeping = t < win;
      paint(ctx, size.w, size.h, { cur, sheaf, plan, colors, t: Math.min(t, win), sweeping, hoverX });
      if (sweeping) raf = requestAnimationFrame(frame);
    };
    frame(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [wave?.round, mode, size.w, size.h, hoverX]);

  const cur = wave ? waveCurves(wave, mode) : undefined;
  const kinds = CURVE_KINDS.map((kind, i) => ({ kind, color: colors[i]! })).filter(
    (k) => cur && cur[k.kind].length >= 2,
  );
  const hoverMs =
    hoverX === null
      ? null
      : Math.max(0, Math.min(win, ((hoverX - PAD.l) / Math.max(1, size.w - PAD.l - PAD.r)) * win));
  const pick = (m: CurveMode) => {
    setWanted(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // the choice then lasts for this visit only
    }
  };
  const speed = plan.slow > 1 ? `slowed ${plan.slow}×` : 'real speed';

  return (
    <div className="curves">
      <ChartPanel
        title="ARRIVAL CURVES"
        note={
          mode === 'address'
            ? `accounts · ms after first vote · ${speed}`
            : wave?.source === 'avmonitor'
              ? 'relays · ms after first relay'
              : 'nodes · ms after first sighting'
        }
        legend={kinds.map((k) => ({ name: CURVE_LABELS[k.kind], color: k.color }))}
        value={
          wave?.accounts && (
            <span className="seg">
              {MODES.map((m) => (
                <button
                  key={m.mode}
                  type="button"
                  className={`seg-item${m.mode === mode ? ' seg-item--on' : ''}`}
                  aria-pressed={m.mode === mode}
                  onClick={() => pick(m.mode)}
                >
                  {m.label}
                </button>
              ))}
            </span>
          )
        }
      >
        <div
          className="chart-canvas"
          ref={wrap}
          onPointerMove={(e) => setHoverX(e.clientX - e.currentTarget.getBoundingClientRect().left)}
          onPointerLeave={() => setHoverX(null)}
        >
          <canvas ref={canvas} />
          {!cur && <div className="curves-empty">WAITING FOR THE FIRST FINISHED ROUND</div>}
          {cur && hoverX !== null && hoverMs !== null && (
            <div
              className="chart-tip"
              style={hoverX > size.w / 2 ? { right: size.w - hoverX + 10 } : { left: hoverX + 10 }}
            >
              <div className="chart-tip-title">
                #{fmt.int(cur.round)} · +{fmt.num(hoverMs, 1)} ms
              </div>
              {kinds.map((k) => (
                <div key={k.kind} className="chart-tip-row">
                  <span className="swatch" style={{ background: k.color }} />
                  <span className="chart-tip-label">{CURVE_LABELS[k.kind]}</span>
                  <span className="chart-tip-value">
                    {Math.round(shareAt(cur[k.kind], hoverMs) * 100)}% of {cur[k.kind].length}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </ChartPanel>
    </div>
  );
}
