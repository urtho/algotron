import { useEffect, useRef } from 'react';
import { NodeCard } from './NodeCard.js';
import type { NodeState } from '../types/index.js';

interface Props {
  nodes: NodeState[];
  tipBlock: number;
}

const STATUS_ORDER: Record<string, number> = {
  synced: 0, lagging: 1, orange: 2, offline: 3, unknown: 4,
};

const Z_SPACING  = 90;   // px between consecutive planes
const PLANE_SIZE = 20;   // 4 cols × 5 rows

export function NodeStack({ nodes, tipBlock }: Props) {
  const groupRef    = useRef<HTMLDivElement>(null);
  const frameRef    = useRef<number>(0);
  const rotYRef     = useRef(0);    // current Y angle (degrees)
  const rotXRef     = useRef(-8);   // current X angle; -8° = gentle "looking down" rest
  const velRef      = useRef(0);    // Y drag momentum
  const velXRef     = useRef(0);    // X drag momentum
  const dragRef     = useRef({ active: false, lastX: 0, lastY: 0 });
  const centerZRef  = useRef(0);
  const clockRef    = useRef(0);    // oscillation time accumulator (seconds)

  // Sort: archivers first, then relays; within each type by status priority
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'archiver' ? -1 : 1;
    return (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4);
  });

  // Split sorted nodes into planes of PLANE_SIZE
  const planes: NodeState[][] = [];
  for (let i = 0; i < sorted.length; i += PLANE_SIZE) {
    planes.push(sorted.slice(i, i + PLANE_SIZE));
  }
  if (planes.length === 0) planes.push([]); // keep at least one plane

  // Center Z so the middle plane is at Z=0 (normal perspective size)
  centerZRef.current = (planes.length - 1) * Z_SPACING / 2;

  // Animation loop — runs once on mount, reads refs on every frame
  useEffect(() => {
    let lastTime = performance.now();

    const tick = () => {
      frameRef.current = requestAnimationFrame(tick);
      const now = performance.now();
      const dt  = Math.min((now - lastTime) / 1000, 0.1);
      lastTime  = now;

      if (!dragRef.current.active) {
        // ── Y: sinusoidal oscillation ±35° ─────────────────────────────────
        velRef.current *= 0.92;
        if (Math.abs(velRef.current) < 0.01) velRef.current = 0;
        rotYRef.current += velRef.current;
        clockRef.current += dt;
        const targetY = Math.sin(clockRef.current * 0.22) * 35; // ~28 s period
        const blendY  = 1 - Math.min(Math.abs(velRef.current) / 0.5, 1);
        rotYRef.current += (targetY - rotYRef.current) * 0.02 * blendY;

        // ── X: return to resting tilt ──────────────────────────────────────
        velXRef.current *= 0.92;
        if (Math.abs(velXRef.current) < 0.01) velXRef.current = 0;
        rotXRef.current += velXRef.current;
        const blendX = 1 - Math.min(Math.abs(velXRef.current) / 0.5, 1);
        rotXRef.current += (-8 - rotXRef.current) * 0.025 * blendX;
        rotXRef.current  = Math.max(-55, Math.min(55, rotXRef.current));
      }

      if (groupRef.current) {
        groupRef.current.style.transform =
          `rotateX(${rotXRef.current}deg) rotateY(${rotYRef.current}deg)`;
      }
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
    velRef.current  = 0;
    velXRef.current = 0;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.lastX;
    const dy = e.clientY - dragRef.current.lastY;
    dragRef.current.lastX = e.clientX;
    dragRef.current.lastY = e.clientY;
    rotYRef.current += dx * 0.4;
    rotXRef.current  = Math.max(-55, Math.min(55, rotXRef.current - dy * 0.4));
    velRef.current   = dx * 0.4;
    velXRef.current  = -dy * 0.4;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current.active = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  };

  const relayCount    = nodes.filter(n => n.type === 'relay').length;
  const archiverCount = nodes.filter(n => n.type === 'archiver').length;

  return (
    <div className="node-stack-wrapper">
      <div className="node-stack-header">
        <span className="panel-title">NETWORK HEALTH MONITORS</span>
        <span className="node-stack-meta">
          <span className="relay-color">{relayCount}R</span>
          {' · '}
          <span className="archiver-color">{archiverCount}A</span>
          {planes.length > 1 && (
            <> · <span className="node-stack-plane-count">{planes.length} PLANES</span></>
          )}
        </span>
        <span className="node-grid-tip">
          TIP: <span className="tip-value">#{tipBlock.toLocaleString()}</span>
        </span>
      </div>

      <div
        className="node-stack-scene"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* group rotates in place; children translateZ to center the stack on Z=0 */}
        <div ref={groupRef} className="node-stack-group">
          {planes.map((plane, pi) => (
            <div
              key={pi}
              className="node-stack-plane"
              style={{
                // pi=0 is position:relative so it sizes the group;
                // subsequent planes are absolute, overlapping in 2D,
                // differentiated only by translateZ in 3D space.
                position: pi === 0 ? 'relative' : 'absolute',
                ...(pi > 0 ? { top: 0, left: 0 } : {}),
                transform: `translateZ(${centerZRef.current - pi * Z_SPACING}px)`,
              }}
            >
              {plane.map(node => (
                <NodeCard key={node.id} node={node} tipBlock={tipBlock} />
              ))}
            </div>
          ))}
        </div>
      </div>

      {nodes.length === 0 && (
        <div className="node-grid-empty">Discovering nodes<span className="ellipsis" /></div>
      )}
    </div>
  );
}
