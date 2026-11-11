import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeState } from '../../../shared/types.ts';
import { NodeCard } from './NodeCard.tsx';

const SQ3 = Math.sqrt(3);
const RANK: Record<NodeState['status'], number> = {
  synced: 0,
  lagging: 1,
  unknown: 2,
  behind: 3,
  offline: 4,
};

/** Largest hex radius that fits `n` pointy-top hexes in w × h, and the column count that goes with it. */
function layout(n: number, w: number, h: number) {
  for (let r = 60; r >= 8; r -= 1) {
    const cols = Math.floor((w - (SQ3 * r) / 2) / (SQ3 * r));
    if (cols < 1) continue;
    const rows = Math.ceil(n / cols);
    if (rows * 1.5 * r + 0.5 * r <= h) return { r, cols };
  }
  return { r: 8, cols: Math.max(1, Math.floor(w / (SQ3 * 8))) };
}

const hexPoints = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, k) => {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(' ');

/**
 * One hex per node. Healthy nodes are ordered by reply time (fastest first),
 * troubled ones sit at the end. With every new block each hex flashes after
 * its usual propagation delay, so the wall ripples in the order blocks spread.
 */
export function HexWall({ nodes, tipBlock, round }: { nodes: NodeState[]; tipBlock: number; round: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sorted = useMemo(
    () =>
      [...nodes].sort(
        (a, b) =>
          RANK[a.status] - RANK[b.status] ||
          (a.rtt || 9e9) - (b.rtt || 9e9) ||
          a.label.localeCompare(b.label),
      ),
    [nodes],
  );

  const pad = 10;
  const { r, cols } = layout(sorted.length, size.w - pad * 2, size.h - pad * 2);
  const rows = Math.ceil(sorted.length / cols);
  const gridW = cols * SQ3 * r + (rows > 1 ? (SQ3 * r) / 2 : 0);
  const x0 = (size.w - gridW) / 2 + (SQ3 * r) / 2;
  const y0 = (size.h - (rows * 1.5 * r + 0.5 * r)) / 2 + r;
  const hovered = hover && nodes.find((n) => n.id === hover.id);
  const relays = nodes.filter((n) => n.type === 'relay').length;

  return (
    <div className="hexwall">
      <header className="chart-head">
        <span className="panel-title">NETWORK HEALTH MONITORS</span>
        <span className="chart-note">
          fastest reply first · flash = usual delay after a block is first seen
        </span>
        <span className="chart-legend">
          <span className="chart-legend-item">
            <span className="hex-key hex-key--relay" />
            {relays} relays
          </span>
          <span className="chart-legend-item">
            <span className="hex-key hex-key--archiver" />
            {nodes.length - relays} archivers
          </span>
        </span>
      </header>
      <div className="hexwall-body" ref={wrap} onPointerLeave={() => setHover(null)}>
        {size.w > 0 && (
          <svg width={size.w} height={size.h} role="img" aria-label="Relay and archiver status wall">
            {sorted.map((n, i) => {
              const row = Math.floor(i / cols);
              const cx = x0 + (i % cols) * SQ3 * r + (row % 2 ? (SQ3 * r) / 2 : 0);
              const cy = y0 + row * 1.5 * r;
              const pts = hexPoints(cx, cy, r - 2);
              const lag = tipBlock - n.lastBlock;
              const line2 =
                n.status === 'offline'
                  ? (n.err ?? 'no answer')
                  : n.status === 'behind'
                    ? `-${lag.toLocaleString('en-US')}`
                    : n.rtt
                      ? `${Math.round(n.rtt)} ms`
                      : '';
              return (
                <g
                  key={n.id}
                  className={`hex hex--${n.status} hex--${n.type}`}
                  onPointerEnter={() => setHover({ id: n.id, x: cx, y: cy })}
                >
                  <polygon points={pts} className="hex-cell" />
                  {n.status === 'synced' && n.prop > 0 && (
                    <polygon
                      key={round}
                      points={pts}
                      className="hex-flash"
                      style={{ animationDelay: `${Math.min(3000, Math.round(n.prop))}ms` }}
                    />
                  )}
                  {r >= 17 && (
                    <text
                      x={cx}
                      y={cy - (r >= 24 ? 2 : -3)}
                      className="hex-label"
                      style={{ fontSize: Math.min(13, r * 0.42) }}
                    >
                      {n.label}
                    </text>
                  )}
                  {r >= 24 && (
                    <text
                      x={cx}
                      y={cy + r * 0.42}
                      className="hex-sub"
                      style={{ fontSize: Math.min(10, r * 0.32) }}
                    >
                      {line2}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hovered && hover && (
          <div
            className="hex-detail"
            style={{
              top: Math.max(4, Math.min(size.h - 78, hover.y - 36)),
              ...(hover.x > size.w / 2 ? { right: size.w - hover.x + r } : { left: hover.x + r }),
            }}
          >
            <NodeCard node={hovered} tipBlock={tipBlock} />
            <div className="hex-detail-more">
              {hovered.net} · {hovered.prop ? `+${Math.round(hovered.prop)} ms after first` : 'no delay data'}{' '}
              · first on {hovered.firsts} blocks
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
