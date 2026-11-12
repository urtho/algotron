import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeState, Wave } from '../../../shared/types.ts';
import { SOUND_LABELS, SOUNDS, type SoundName, SoundPlayer, soundRound } from '../sound.ts';
import type { WavePlan } from '../stats.ts';
import { NodeCard } from './NodeCard.tsx';

const SQ3 = Math.sqrt(3);
/** Troubled nodes sit at the end of the wall */
const TROUBLE: Record<NodeState['status'], number> = {
  synced: 0,
  lagging: 0,
  unknown: 0,
  behind: 1,
  offline: 2,
};
/** How often the order of the wall is recomputed. Reply times drift on every poll; hexes must not shuffle. */
const REORDER_MS = 60_000;

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
export function HexWall(props: {
  nodes: NodeState[];
  tipBlock: number;
  wave?: Wave;
  plan: WavePlan;
  /** Mean seconds per block: one bar of the rhythmic sounds */
  blockTime: number;
}) {
  const { nodes, tipBlock, wave, plan } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  // the wall as sound: off until someone picks one (a page may only make sound after a click)
  const player = useRef<SoundPlayer | null>(null);
  const [sound, setSound] = useState<SoundName | null>(null);
  const [volume, setVolume] = useState(0.7);
  const pick = (name: SoundName | null) => {
    player.current ??= new SoundPlayer();
    if (name) player.current.start(name);
    else player.current.stop();
    setSound(name);
  };
  useEffect(() => () => player.current?.stop(), []);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Rank by reply time, but only re-rank once a minute or when a node appears or leaves.
  const rank = useRef<{ at: number; ids: string; order: Map<string, number> }>({
    at: 0,
    ids: '',
    order: new Map(),
  });
  const ids = useMemo(
    () =>
      nodes
        .map((n) => n.id)
        .sort()
        .join('|'),
    [nodes],
  );
  const settled = nodes.some((n) => n.rtt > 0);
  if (ids !== rank.current.ids || (settled && Date.now() - rank.current.at > REORDER_MS)) {
    const byRtt = [...nodes].sort(
      (a, b) => (a.rtt || 9e9) - (b.rtt || 9e9) || a.label.localeCompare(b.label),
    );
    rank.current = { at: settled ? Date.now() : 0, ids, order: new Map(byRtt.map((n, i) => [n.id, i])) };
  }
  // Troubled nodes go to the end at once; everything else keeps its place until the next re-rank.
  const sorted = [...nodes].sort(
    (a, b) =>
      TROUBLE[a.status] - TROUBLE[b.status] || rank.current.order.get(a.id)! - rank.current.order.get(b.id)!,
  );

  // each finished round goes to the player at the moment its flashes start
  const latest = useRef({ nodes, plan, order: rank.current.order, blockTime: props.blockTime });
  latest.current = { nodes, plan, order: rank.current.order, blockTime: props.blockTime };
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once per round
  useEffect(() => {
    if (!wave || !player.current?.playing || document.hidden) return;
    const l = latest.current;
    player.current.feed(soundRound(wave, l.plan, l.nodes, l.order), l.blockTime);
  }, [wave?.round]);

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
          fastest reply first, re-ranked every minute · flash = block arrival
          {wave ? ` in round #${wave.round.toLocaleString('en-US')}` : ''}
          {plan.slow > 1 ? ` (slowed ${plan.slow}×)` : ''}
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
        <span className="hex-sound">
          <span className="seg">
            <button
              type="button"
              className={`seg-item${sound === null ? ' seg-item--on' : ''}`}
              aria-pressed={sound === null}
              onClick={() => pick(null)}
            >
              SOUND OFF
            </button>
            {SOUNDS.map((name) => (
              <button
                key={name}
                type="button"
                className={`seg-item${sound === name ? ' seg-item--on' : ''}`}
                aria-pressed={sound === name}
                onClick={() => pick(name)}
              >
                {SOUND_LABELS[name]}
              </button>
            ))}
          </span>
          {sound && (
            <input
              id="hex-sound-volume"
              className="hex-volume"
              type="range"
              min={0}
              max={100}
              value={Math.round(volume * 100)}
              aria-label="Sound volume"
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setVolume(v);
                player.current?.setVolume(v);
              }}
            />
          )}
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
                  {wave?.delays[n.id] !== undefined && (
                    <polygon
                      key={wave.round}
                      points={pts}
                      className="hex-flash"
                      style={{ animationDelay: `${Math.round(plan.at(wave.delays[n.id]!))}ms` }}
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
              {hovered.net} ·{' '}
              {hovered.prop
                ? `+${hovered.prop < 100 ? hovered.prop.toFixed(1) : Math.round(hovered.prop)} ms after first`
                : 'no delay data'}
              {hovered.soft !== undefined && ` · soft +${hovered.soft.toFixed(1)}`}
              {hovered.cert !== undefined && ` · cert +${hovered.cert.toFixed(1)}`} · first on{' '}
              {hovered.firsts} blocks
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
