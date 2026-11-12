import { useEffect, useRef, useState } from 'react';
import type { Wave } from '../../../shared/types.ts';
import {
  CURVE_KINDS,
  CURVE_LABELS,
  type CurveKind,
  type CurveMode,
  type CurveScale,
  curveScale,
  fmt,
  QUORUM,
  reachedAt,
  shareAt,
  type WaveCurves,
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
const INK = { text: '#9fe8d2', dim: '#62ab95', muted: '#3f8573', grid: '#0a3040', head: '#00ccff' };
const FONT = "10px 'Share Tech Mono', monospace";
const PAD = { l: 38, r: 14, t: 30, b: 20 };
/** Earlier rounds kept as the faint history on the round's clock */
const SHEAF = 10;
/**
 * A round is drawn zoomed, settles onto the round's clock and is held until the next one arrives, about
 * 2.8 s later. That is this chart's own pace: at the globe's slowdown a round would not fit in a round.
 */
const DRAW_MS = 1900;
const SETTLE_MS = 500;
/** Below this many points a curve is drawn as steps: a slope between a handful of proposers would be made up */
const STEP_BELOW = 20;
/** Gap that keeps the proposal off the break between the two zoomed axes, px */
const FENCE = 8;

const MODES: { mode: CurveMode; label: string }[] = [
  { mode: 'relay', label: 'BY RELAY' },
  { mode: 'address', label: 'BY ADDRESS' },
];
const MODE_KEY = 'algotron.curves.mode';

function savedMode(): CurveMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'address' ? 'address' : 'relay';
  } catch {
    return 'relay';
  }
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

interface Plot {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  sy: (share: number) => number;
}

/** Each kind's zero while zoomed: the proposal's first arrival, and the first soft vote for both votes. */
const zeros = (c: WaveCurves): Record<CurveKind, number> => {
  const soft = c.soft[0] ?? c.cert[0] ?? 0;
  return { block: c.block[0] ?? 0, soft, cert: soft };
};

/**
 * x of a moment for one round. Zoomed (settle 0) the proposal counts from the left edge and the votes from
 * a third of the width, both at the zoom scale; settled (1) everything sits on the round's clock.
 */
function mapper(p: Plot, scale: CurveScale, c: WaveCurves, settle: number) {
  const w = p.x1 - p.x0;
  const zero = zeros(c);
  const m = scale.split ? settle : 1;
  return {
    zero,
    x: (kind: CurveKind, ms: number) => {
      const zoomed =
        kind === 'block'
          ? p.x0 + ((ms - zero.block) / scale.zoom) * w
          : p.x0 + w / 3 + ((ms - zero.soft) / scale.zoom) * w;
      const round = p.x0 + (ms / scale.round) * w;
      return zoomed + (round - zoomed) * m;
    },
    /** While zoomed a curve stays inside its own axis; the fence opens as the axes merge. */
    fence: (kind: CurveKind): [number, number] =>
      kind === 'block'
        ? [p.x0, p.x0 + w / 3 - FENCE + ((w * 2) / 3 + FENCE) * m]
        : [p.x0 + (w / 3) * (1 - m), p.x1],
  };
}

interface Scene {
  cur: WaveCurves;
  sheaf: WaveCurves[];
  scale: CurveScale;
  colors: string[];
  /** ms of the round drawn so far, counted from each zoomed axis's zero */
  tau: number;
  /** 0 zoomed .. 1 on the round's clock */
  settle: number;
  drawing: boolean;
  hoverX: number | null;
}

function curves(
  ctx: CanvasRenderingContext2D,
  p: Plot,
  sc: Scene,
  c: WaveCurves,
  settle: number,
  tau: number,
) {
  const map = mapper(p, sc.scale, c, settle);
  CURVE_KINDS.forEach((kind, i) => {
    const vals = c[kind];
    const n = vals.length;
    if (n < 2) return;
    const [left, right] = map.fence(kind);
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 2, p.y0 - 6, right - left + 4, p.y1 - p.y0 + 12);
    ctx.clip();
    ctx.strokeStyle = sc.colors[i]!;
    ctx.beginPath();
    ctx.moveTo(map.x(kind, vals[0]!), p.sy(0));
    for (let k = 0; k < n && vals[k]! - map.zero[kind] <= tau; k++) {
      const x = map.x(kind, vals[k]!);
      if (n < STEP_BELOW) ctx.lineTo(x, p.sy(k / n));
      ctx.lineTo(x, p.sy((k + 1) / n));
    }
    ctx.stroke();
    ctx.restore();
  });
}

function tick(
  ctx: CanvasRenderingContext2D,
  p: Plot,
  x: number,
  text: string,
  textY: number,
  alpha: number,
  align: CanvasTextAlign,
) {
  const xx = Math.round(x) + 0.5;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = INK.grid;
  ctx.beginPath();
  ctx.moveTo(xx, p.y0);
  ctx.lineTo(xx, p.y1);
  ctx.stroke();
  ctx.fillStyle = INK.muted;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, xx, textY);
  ctx.globalAlpha = 1;
}

function paint(ctx: CanvasRenderingContext2D, w: number, h: number, sc: Scene) {
  const p: Plot = { x0: PAD.l, x1: w - PAD.r, y0: PAD.t, y1: h - PAD.b, sy: () => 0 };
  p.sy = (share) => p.y1 - share * (p.y1 - p.y0);
  const plotW = p.x1 - p.x0;
  const { scale } = sc;
  const settle = scale.split ? sc.settle : 1;
  const zoomAlpha = 1 - settle;
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  ctx.lineWidth = 1;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const share of [0, 0.5, 1]) {
    const y = Math.round(p.sy(share)) + 0.5;
    ctx.strokeStyle = INK.grid;
    ctx.beginPath();
    ctx.moveTo(p.x0, y);
    ctx.lineTo(p.x1, y);
    ctx.stroke();
    ctx.fillStyle = INK.muted;
    ctx.fillText(`${share * 100}%`, p.x0 - 6, y);
  }

  // the round's clock is always there, under the plot; it comes forward as the round settles
  const roundStep = [10, 20, 50, 100, 250, 500, 1000].find((s) => scale.round / s <= 9) ?? 1000;
  for (let ms = 0; ms <= scale.round; ms += roundStep) {
    const text = ms === 0 ? '0 ms' : fmt.int(ms);
    const x = p.x0 + (ms / scale.round) * plotW;
    tick(ctx, p, x, text, h - 5, 0.45 + 0.55 * settle, ms ? 'center' : 'left');
  }

  // the two zoomed axes, same scale, read along the top while a round is drawn
  const zero = zeros(sc.cur);
  if (zoomAlpha > 0.01) {
    const step = [10, 25, 50, 100, 150, 200, 250, 500].find((s) => scale.zoom / 3 / s <= 3.2) ?? 500;
    for (let ms = 0; ms < scale.zoom / 3 - step * 0.3; ms += step) {
      const x = p.x0 + (ms / scale.zoom) * plotW;
      tick(ctx, p, x, ms ? `+${ms}` : '0', p.y0 + 12, zoomAlpha, ms ? 'center' : 'left');
    }
    for (let ms = 0; ms <= (scale.zoom * 2) / 3; ms += step) {
      const x = p.x0 + plotW / 3 + (ms / scale.zoom) * plotW;
      tick(ctx, p, x, ms ? `+${ms}` : '0', p.y0 + 12, zoomAlpha, ms ? 'center' : 'left');
    }
    ctx.globalAlpha = zoomAlpha;
    const bx = Math.round(p.x0 + plotW / 3 - FENCE / 2) + 0.5;
    ctx.strokeStyle = INK.muted;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(bx, p.y0 - 4);
    ctx.lineTo(bx, p.y1 + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK.dim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('PROPOSAL · MS AFTER ITS FIRST', p.x0 + 4, p.y0 - 8);
    ctx.fillText(
      `SOFT + CERT · MS AFTER THE FIRST SOFT VOTE, ${fmt.int(zero.soft)} MS INTO THE ROUND`,
      p.x0 + plotW / 3 + 4,
      p.y0 - 8,
    );
    ctx.globalAlpha = 1;
  }
  if (settle > 0.01) {
    ctx.globalAlpha = settle;
    ctx.fillStyle = INK.dim;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(
      scale.split ? "WHOLE ROUND · MS AFTER THE ROUND'S FIRST VOTE" : 'MS AFTER THE FIRST SIGHTING',
      p.x0 + 4,
      p.y0 - 8,
    );
    ctx.globalAlpha = 1;
  }

  // earlier rounds stay put on the round's clock, so the one being drawn drops in among them
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.2;
  for (const past of sc.sheaf) curves(ctx, p, sc, past, 1, Number.POSITIVE_INFINITY);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  curves(ctx, p, sc, sc.cur, settle, sc.tau);

  // where an equal-weight network would have enough soft and cert votes
  const map = mapper(p, scale, sc.cur, settle);
  CURVE_KINDS.forEach((kind, i) => {
    const share = QUORUM[kind];
    const at = share === undefined ? undefined : reachedAt(sc.cur[kind], share);
    if (share === undefined || at === undefined || sc.cur[kind].length < 2) return;
    if (at - map.zero[kind] > sc.tau) return;
    const x = Math.round(map.x(kind, at)) + 0.5;
    if (x > p.x1) return;
    ctx.strokeStyle = sc.colors[i]!;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, p.y0);
    ctx.lineTo(x, p.y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = INK.text;
    ctx.textBaseline = 'alphabetic';
    // the two thresholds sit close together: soft reads to the left of its line, cert to the right
    ctx.textAlign = kind === 'soft' ? 'right' : 'left';
    const text = `${CURVE_LABELS[kind].split(' ')[0]} ${Math.round(share * 100)}% · ${fmt.int(at)} ms`;
    ctx.fillText(text, x + (kind === 'soft' ? -5 : 5), p.sy(0.12) + (kind === 'soft' ? 0 : 13));
  });

  if (sc.hoverX !== null && !sc.drawing && settle === 1) {
    const x = Math.round(Math.max(p.x0, Math.min(p.x1, sc.hoverX))) + 0.5;
    ctx.strokeStyle = INK.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, p.y0);
    ctx.lineTo(x, p.y1);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (sc.drawing) {
    ctx.strokeStyle = INK.head;
    ctx.lineWidth = 1.5;
    const lead = (sc.tau / scale.zoom) * plotW;
    const xs = [scale.split ? p.x0 + plotW / 3 + lead : p.x0 + lead];
    if (scale.split && sc.tau < scale.zoom / 3 - (FENCE / plotW) * scale.zoom) xs.push(p.x0 + lead);
    for (const x of xs) {
      ctx.beginPath();
      ctx.moveTo(x, p.y0 - 4);
      ctx.lineTo(x, p.y1);
      ctx.stroke();
    }
  }
}

/** One finished round, ready to draw either way */
type Round = Record<CurveMode, WaveCurves>;

/**
 * Cumulative arrival of the newest finished round as three curves: the winning proposal, the soft vote and
 * the cert vote, on the round's own clock (ms after the round's first vote), over the rounds before it.
 *
 * A round first draws zoomed on two axes of one scale: the proposal from the left edge, soft and cert from
 * a third of the width, counted from the first soft vote so the cert vote keeps its true distance. Then it
 * settles onto the whole-round axis, where the earlier rounds already are. Dashed lines mark where the soft
 * and cert curves cross their consensus threshold share.
 *
 * By relay, a step is a relay. By address, a step is a voting account taken as if it were a node: when its
 * vote first reached any relay (for the proposal, one step per proposer). Votes exist only with avmonitor.
 */
export function VoteCurves({ wave, colors }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [wanted, setWanted] = useState<CurveMode>(savedMode);
  const [settled, setSettled] = useState(false);
  const live = useRef<{ cur?: Round; sheaf: Round[]; born: number }>({ sheaf: [], born: 0 });

  // without account data (polled propagation) only the relay view exists
  const mode: CurveMode = wave?.accounts ? wanted : 'relay';

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A new round: the one on screen joins the history and the new one starts drawing
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per round
  useEffect(() => {
    if (!wave) return;
    const l = live.current;
    if (l.cur && l.cur.relay.round !== wave.round) l.sheaf = [...l.sheaf, l.cur].slice(-SHEAF);
    l.cur = { relay: waveCurves(wave, 'relay'), address: waveCurves(wave, 'address') };
    const still = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    l.born = still ? Number.NEGATIVE_INFINITY : performance.now();
  }, [wave?.round]);

  const cur = wave ? waveCurves(wave, mode) : undefined;

  // biome-ignore lint/correctness/useExhaustiveDependencies: redrawn per round, mode, size and hover; the animation runs itself
  useEffect(() => {
    const c = canvas.current;
    const l = live.current;
    if (!c || !cur || size.w < 120 || size.h < 70) return;
    const sheaf = l.sheaf.map((r) => r[mode]).filter((r) => r.round !== cur.round);
    // axes that fit this round and the ones behind it, so they hold still from round to round
    const scale = curveScale([cur, ...sheaf]);
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the votes' axis is the wider one: it sets how much of the round has to be drawn
    const tauMax = scale.split ? (scale.zoom * 2) / 3 : scale.zoom;
    let raf = 0;
    const frame = (now: number) => {
      const el = now - l.born;
      const drawing = el < DRAW_MS;
      const moving = el < DRAW_MS + SETTLE_MS;
      paint(ctx, size.w, size.h, {
        cur,
        sheaf,
        scale,
        colors,
        tau: drawing ? (el / DRAW_MS) * tauMax : Number.POSITIVE_INFINITY,
        settle: drawing ? 0 : moving ? ease((el - DRAW_MS) / SETTLE_MS) : 1,
        drawing,
        hoverX,
      });
      setSettled(!moving);
      if (moving) raf = requestAnimationFrame(frame);
    };
    frame(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [wave?.round, mode, size.w, size.h, hoverX]);

  const kinds = CURVE_KINDS.map((kind, i) => ({ kind, color: colors[i]! })).filter(
    (k) => cur && cur[k.kind].length >= 2,
  );
  // the readout is on the round's clock, so it waits until the round has settled onto it
  const span = cur
    ? curveScale([cur, ...live.current.sheaf.map((r) => r[mode]).filter((r) => r.round !== cur.round)]).round
    : 0;
  const hoverMs =
    hoverX === null || !cur || !settled
      ? null
      : Math.max(0, Math.min(span, ((hoverX - PAD.l) / Math.max(1, size.w - PAD.l - PAD.r)) * span));
  const pick = (m: CurveMode) => {
    setWanted(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // the choice then lasts for this visit only
    }
  };

  return (
    <div className="curves">
      <ChartPanel
        title="ARRIVAL CURVES"
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
                #{fmt.int(cur.round)} · {fmt.int(hoverMs)} ms into the round
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
