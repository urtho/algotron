import { useEffect, useRef, useState } from 'react';
import type { BlockStat } from '../../../shared/types.ts';
import { fmt, TX_KINDS, TX_LABELS, txParts } from '../stats.ts';

const SLOT = 22;
const BAR = 18;
const INK = { text: '#9fe8d2', muted: '#3f8573', grid: '#0a3040', hi: '#e6fff7' };

/**
 * Blocks as slabs that slide in from the right. Height is the transaction
 * count on a square-root scale (a burst of 1,000 must not flatten a block of 20),
 * bands are the transaction kinds.
 */
export function BlockRiver(props: {
  blocks: BlockStat[];
  colors: string[];
  explorer: string;
  labels: Record<string, string>;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef(props);
  data.current = props;
  const slide = useRef({ round: 0, at: 0 });
  const hoverX = useRef<number | null>(null);
  const [tip, setTip] = useState<{ x: number; b: BlockStat } | null>(null);

  const newest = props.blocks[props.blocks.length - 1]?.round ?? 0;
  if (newest !== slide.current.round) slide.current = { round: newest, at: performance.now() };

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const el = wrap.current;
      const c = canvas.current;
      if (!el || !c) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);

      const { blocks, colors } = data.current;
      const base = h - 16;
      const top = 16;
      const count = Math.ceil(w / SLOT) + 1;
      const shown = blocks.slice(-count);
      const max = Math.max(50, ...shown.map((b) => b.txns));
      // ease the newest slab in from one slot to the right
      const k = Math.min(1, (performance.now() - slide.current.at) / 500);
      const offset = (1 - k) ** 3 * SLOT;

      g.strokeStyle = INK.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, base + 0.5);
      g.lineTo(w, base + 0.5);
      g.stroke();

      g.font = "9px 'Share Tech Mono', monospace";
      g.textAlign = 'center';
      shown.forEach((b, i) => {
        const x = w - 8 - (shown.length - i) * SLOT + offset;
        const parts = txParts(b);
        const H = Math.max(2, Math.sqrt(b.txns / max) * (base - top - 10));
        const hot = hoverX.current !== null && Math.abs(hoverX.current - (x + BAR / 2)) <= SLOT / 2;
        g.globalAlpha = hoverX.current === null || hot ? 1 : 0.45;
        let y = base;
        parts.forEach((v, kind) => {
          if (v <= 0) return;
          const hh = (v / b.txns) * H;
          g.fillStyle = colors[kind]!;
          g.fillRect(x, y - hh, BAR, Math.max(1, hh - 1));
          y -= hh;
        });
        g.globalAlpha = 1;
        const last = i === shown.length - 1;
        if (last || b.txns >= max * 0.5) {
          g.fillStyle = last ? INK.hi : INK.text;
          g.fillText(String(b.txns), x + BAR / 2, base - H - 4);
        }
        if (last || (b.round % 10 === 0 && shown.length - 1 - i > 2)) {
          g.fillStyle = INK.muted;
          g.fillText(`#${String(b.round).slice(-4)}`, x + BAR / 2, h - 4);
        }
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  const locate = (px: number) => {
    const w = wrap.current?.clientWidth ?? 0;
    const shown = props.blocks.slice(-(Math.ceil(w / SLOT) + 1));
    const i = shown.length - Math.ceil((w - 8 - px) / SLOT);
    const b = shown[i];
    hoverX.current = b ? px : null;
    setTip(b ? { x: px, b } : null);
  };

  const b = tip?.b;
  return (
    <div className="river">
      <header className="chart-head">
        <span className="panel-title">BLOCK RIVER</span>
        <span className="chart-note">height = transactions (√ scale)</span>
        <span className="chart-legend">
          {TX_KINDS.map((kind, i) => (
            <span key={kind} className="chart-legend-item">
              <span className="swatch" style={{ background: props.colors[i] }} />
              {TX_LABELS[kind]}
            </span>
          ))}
        </span>
      </header>
      <div
        className="river-body"
        ref={wrap}
        onPointerMove={(e) => locate(e.clientX - e.currentTarget.getBoundingClientRect().left)}
        onPointerLeave={() => {
          hoverX.current = null;
          setTip(null);
        }}
        onClick={() => b && window.open(`${props.explorer}/block/${b.round}`, '_blank', 'noreferrer')}
      >
        <canvas ref={canvas} />
        {tip && b && (
          <div
            className="chart-tip"
            style={
              tip.x > 260 ? { right: (wrap.current?.clientWidth ?? 0) - tip.x + 14 } : { left: tip.x + 14 }
            }
          >
            <div className="chart-tip-title">
              #{b.round.toLocaleString('en-US')} · {b.txns} txns · {fmt.kb(b.bytes)} KB
            </div>
            {txParts(b).map((v, i) =>
              v > 0 ? (
                <div key={TX_KINDS[i]} className="chart-tip-row">
                  <span className="swatch" style={{ background: props.colors[i] }} />
                  <span className="chart-tip-label">{TX_LABELS[TX_KINDS[i]!]}</span>
                  <span className="chart-tip-value">{v}</span>
                </div>
              ) : null,
            )}
            <div className="chart-tip-row">
              <span className="chart-tip-label">proposer {fmt.addr(b.proposer)}</span>
            </div>
            {b.first && (
              <div className="chart-tip-row">
                <span className="chart-tip-label">
                  first on {props.labels[b.first] ?? '?'}
                  {b.p50 !== undefined ? ` · median +${b.p50} ms` : ''}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
