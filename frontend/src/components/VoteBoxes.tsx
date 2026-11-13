import { useMemo, useState } from 'react';
import type { BlockStat } from '../../../shared/types.ts';
import type { MyMark, MyRound } from '../avstream.ts';
import { BOX_KINDS, type BoxAxis, type BoxKind, boxSlots, fmt } from '../stats.ts';
import { Canvas, ChartPanel, type Frame, MINE, mineDot } from './Chart.tsx';

/** Ink and chrome for canvas drawing; kept in step with Chart.tsx and styles/app.css */
const INK = { text: '#9fe8d2', hi: '#e6fff7', muted: '#3f8573', grid: '#0a3040', surface: '#00060f' };
const FONT = "10px 'Share Tech Mono', monospace";
/** Height of the vote-count strip under the boxes, and the gap that separates the two plots */
const STRIP = 26;
const GAP = 18;

const TITLES: Record<BoxKind, string> = { proposal: 'PROPOSALS', soft: 'SOFT VOTES', cert: 'CERT VOTES' };
const UNITS: Record<BoxKind, string> = { proposal: 'proposers', soft: 'votes', cert: 'votes' };
const AXES: { axis: BoxAxis; label: string; title: string }[] = [
  { axis: 'clock', label: 'ROUND CLOCK', title: "ms after the round's first vote of any kind" },
  { axis: 'first', label: 'FROM FIRST', title: 'ms after the first vote of this kind' },
];
const AXIS_KEY = 'algotron.boxes.axis';

function savedAxis(): BoxAxis {
  try {
    return localStorage.getItem(AXIS_KEY) === 'first' ? 'first' : 'clock';
  } catch {
    return 'clock';
  }
}

/** A step of 1, 2, 2.5 or 5 times a power of ten that splits `span` into about three. */
function niceStep(span: number): number {
  const raw = Math.max(span, 1) / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
}

/**
 * One kind's last rounds: a box per round (whisker 5–95%, box 25–75%, tick at the median) of when its votes
 * first reached any relay, and under it a strip counting the votes. The strip is its own plot, from zero.
 *
 * `mine`: the visitor's own proposals by round, drawn as a dot on the round's box at the moment the proposal
 * first reached a relay, with a ring when it won the round. A dot above the scale sits on its top edge.
 */
function BoxChart(props: {
  blocks: BlockStat[];
  kind: BoxKind;
  axis: BoxAxis;
  color: string;
  mine?: Map<number, MyMark[]>;
}) {
  const { kind, axis, color, mine } = props;
  const slots = boxSlots(props.blocks, kind, axis);
  const n = slots.length;
  const last = slots[n - 1];
  const own = slots.map((s) => mine?.get(s.round) ?? []);
  const ownKey = own.map((list, i) => (list.length ? `${slots[i]!.round}:${list.length}` : '')).join('');

  // a round with a late straggler must not flatten the rest: the scale follows the bulk, the clip cuts the tail
  const tops = slots.map((s) => s.q[4]).sort((a, b) => a - b);
  const lo = Math.min(...slots.map((s) => s.q[0]));
  const hi = tops[Math.min(n - 1, Math.floor(n * 0.95))] ?? 1;
  const step = niceStep(hi - lo);
  const yLo = n ? Math.floor(lo / step) * step : 0;
  const yHi = Math.max(yLo + step, Math.ceil(hi / step) * step);
  const most = Math.max(1, ...slots.map((s) => s.votes));
  const countMax = niceStep(most * 3);

  const geometry = (f: Omit<Frame, 'ctx'>) => {
    const stripY0 = f.y1 - STRIP;
    const plotY1 = stripY0 - GAP;
    const slot = (f.x1 - f.x0) / Math.max(1, n);
    return {
      stripY0,
      plotY1,
      slot,
      cx: (i: number) => f.x0 + slot * (i + 0.5),
      sy: (ms: number) => plotY1 - ((ms - yLo) / (yHi - yLo)) * (plotY1 - f.y0),
      at: (px: number) => Math.max(0, Math.min(n - 1, Math.floor((px - f.x0) / slot))),
    };
  };

  return (
    <Canvas
      padRight={10}
      deps={[kind, axis, last?.round, n, last?.q[2], ownKey]}
      draw={(f, hoverX) => {
        const { ctx } = f;
        const g = geometry(f);
        if (g.plotY1 - f.y0 < 20) return;
        ctx.font = FONT;
        ctx.lineWidth = 1;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        if (n === 0) {
          ctx.textAlign = 'center';
          ctx.fillStyle = INK.muted;
          ctx.fillText('NO VOTE TIMING YET', (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
          return;
        }
        for (let ms = yLo; ms <= yHi + 1e-6; ms += step) {
          const y = Math.round(g.sy(ms)) + 0.5;
          ctx.strokeStyle = INK.grid;
          ctx.beginPath();
          ctx.moveTo(f.x0, y);
          ctx.lineTo(f.x1, y);
          ctx.stroke();
          ctx.fillStyle = INK.muted;
          ctx.fillText(fmt.int(ms), f.x0 - 6, y);
        }

        const hot = hoverX === null ? -1 : g.at(hoverX);
        const lit = (i: number) => (hot === -1 || hot === i ? 1 : 0.45);
        const bw = Math.max(2, Math.min(11, g.slot - 2));
        ctx.save();
        ctx.beginPath();
        ctx.rect(f.x0, f.y0 - 4, f.x1 - f.x0, g.plotY1 - f.y0 + 8);
        ctx.clip();
        slots.forEach((s, i) => {
          const x = g.cx(i);
          const top = g.sy(s.q[3]);
          const height = Math.max(2, g.sy(s.q[1]) - top);
          ctx.globalAlpha = lit(i);
          ctx.strokeStyle = color;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, g.sy(s.q[4]));
          ctx.lineTo(Math.round(x) + 0.5, g.sy(s.q[0]));
          ctx.stroke();
          ctx.fillStyle = INK.surface;
          ctx.fillRect(x - bw / 2, top, bw, height);
          ctx.globalAlpha = lit(i) * 0.55;
          ctx.fillStyle = color;
          ctx.fillRect(x - bw / 2, top, bw, height);
          ctx.globalAlpha = lit(i);
          ctx.fillStyle = INK.hi;
          ctx.fillRect(x - bw / 2, Math.round(g.sy(s.q[2])) - 1, bw, 2);
        });
        ctx.restore();
        slots.forEach((s, i) => {
          ctx.globalAlpha = lit(i);
          for (const m of own[i]!) {
            const y = Math.max(f.y0, Math.min(g.plotY1, g.sy(m.ms - s.zero)));
            mineDot(ctx, g.cx(i), y, m.win, 3);
          }
        });
        ctx.globalAlpha = 1;

        ctx.strokeStyle = INK.grid;
        for (const y of [g.stripY0, f.y1]) {
          ctx.beginPath();
          ctx.moveTo(f.x0, Math.round(y) + 0.5);
          ctx.lineTo(f.x1, Math.round(y) + 0.5);
          ctx.stroke();
        }
        ctx.fillStyle = INK.muted;
        ctx.fillText(fmt.int(countMax), f.x0 - 6, g.stripY0 + 1);
        ctx.fillText('0', f.x0 - 6, f.y1);
        slots.forEach((s, i) => {
          const height = (s.votes / countMax) * STRIP;
          ctx.globalAlpha = lit(i) * 0.8;
          ctx.fillStyle = color;
          ctx.fillRect(g.cx(i) - bw / 2, f.y1 - height, bw, height);
        });
        ctx.globalAlpha = 1;

        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(`#${fmt.int(slots[0]!.round)}`, f.x0, f.h - 3);
        ctx.textAlign = 'right';
        ctx.fillText('now', f.x1, f.h - 3);
      }}
      locate={(f, px) => {
        if (n === 0 || px < f.x0 || px > f.x1) return null;
        const g = geometry(f);
        const i = g.at(px);
        const s = slots[i]!;
        const ms = (v: number) => `${fmt.int(v)} ms`;
        return {
          x: g.cx(i),
          title: `#${fmt.int(s.round)} · ${fmt.int(s.votes)} ${UNITS[kind]}`,
          rows: [
            { label: '95%', value: ms(s.q[4]) },
            { label: '75%', value: ms(s.q[3]) },
            { color, label: 'median', value: ms(s.q[2]) },
            { label: '25%', value: ms(s.q[1]) },
            { label: '5%', value: ms(s.q[0]) },
            ...own[i]!.map((m, k) => ({
              color: MINE,
              label: own[i]!.length > 1 ? `yours ${k + 1}` : 'yours',
              value: `${ms(m.ms - s.zero)}${m.win ? ' · won' : ''}`,
            })),
          ],
        };
      }}
    />
  );
}

/**
 * Three panels for the bottom row: proposals, soft votes and cert votes over the last BOX_ROUNDS rounds.
 * One switch, repeated in each head, sets the zero for all three. avmonitor only.
 * The proposals panel marks the visitor's own proposals (`mine`, by round).
 */
export function VoteBoxes(props: { blocks: BlockStat[]; colors: string[]; mine?: Map<number, MyRound> }) {
  const { blocks, colors } = props;
  const [axis, setAxis] = useState<BoxAxis>(savedAxis);
  const proposals = useMemo(() => {
    const by = new Map<number, MyMark[]>();
    for (const [round, m] of props.mine ?? []) if (m.block.length) by.set(round, m.block);
    return by;
  }, [props.mine]);
  const pick = (a: BoxAxis) => {
    setAxis(a);
    try {
      localStorage.setItem(AXIS_KEY, a);
    } catch {
      // the choice then lasts for this visit only
    }
  };

  return (
    <>
      {BOX_KINDS.map((kind, i) => {
        const newest = boxSlots(blocks, kind, axis, 1)[0];
        return (
          <ChartPanel
            key={kind}
            title={TITLES[kind]}
            note={newest ? `${fmt.int(newest.q[2])} ms · ${fmt.int(newest.votes)} ${UNITS[kind]}` : undefined}
            value={
              <span className="seg">
                {AXES.map((a) => (
                  <button
                    key={a.axis}
                    type="button"
                    title={a.title}
                    className={`seg-item${a.axis === axis ? ' seg-item--on' : ''}`}
                    aria-pressed={a.axis === axis}
                    onClick={() => pick(a.axis)}
                  >
                    {a.label}
                  </button>
                ))}
              </span>
            }
          >
            <BoxChart
              blocks={blocks}
              kind={kind}
              axis={axis}
              color={colors[i]!}
              mine={kind === 'proposal' ? proposals : undefined}
            />
          </ChartPanel>
        );
      })}
    </>
  );
}
