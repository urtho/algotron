import { useEffect, useRef } from 'react';
import type { BlockStat } from '../../../shared/types.ts';
import { fmt, type ProposerRow } from '../stats.ts';

const TICKS = 36;

/**
 * Recent proposers as ticks on a ring (tick length = blocks proposed in the
 * window). The proposer of the newest block is highlighted and pings. It sits
 * in the globe's top right corner.
 */
export function ProposerRing(props: { rows: ProposerRow[]; newest?: BlockStat; color: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const data = useRef(props);
  data.current = props;
  const ping = useRef({ round: 0, at: 0 });
  if (props.newest && props.newest.round !== ping.current.round)
    ping.current = { round: props.newest.round, at: performance.now() };

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const { rows, newest, color } = data.current;
      const cx = w / 2;
      const cy = h / 2;
      const maxLen = Math.min(w, h) * 0.13;
      const R = Math.min(w, h) / 2 - maxLen - 6;
      if (R < 20) return;
      const most = Math.max(1, ...rows.map((r) => r.blocks));

      g.strokeStyle = '#0a3040';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.stroke();

      const age = (performance.now() - ping.current.at) / 1400;
      rows.forEach((row, i) => {
        const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
        const on = row.address === newest?.proposer;
        const len = 3 + (row.blocks / most) * maxLen;
        g.strokeStyle = on ? '#e6fff7' : color;
        g.lineWidth = on ? 4 : 2;
        g.lineCap = 'round';
        g.globalAlpha = on ? 1 : 0.8;
        g.beginPath();
        g.moveTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
        g.lineTo(cx + (R + len) * Math.cos(a), cy + (R + len) * Math.sin(a));
        g.stroke();
        if (on && age < 1) {
          g.globalAlpha = 1 - age;
          g.lineWidth = 1.5;
          g.beginPath();
          g.arc(cx + R * Math.cos(a), cy + R * Math.sin(a), 4 + age * 18, 0, Math.PI * 2);
          g.stroke();
        }
        g.globalAlpha = 1;
      });

      g.textAlign = 'center';
      g.font = "9px 'Share Tech Mono', monospace";
      g.fillStyle = '#3f8573';
      g.fillText('PROPOSER', cx, cy - R * 0.3);
      g.font = `600 ${Math.max(12, Math.min(20, R * 0.3))}px Oxanium, 'Share Tech Mono', monospace`;
      g.fillStyle = '#e6fff7';
      g.fillText(newest ? newest.proposer.slice(0, 6) : '—', cx, cy + 4);
      g.font = "10px 'Share Tech Mono', monospace";
      g.fillStyle = '#9fe8d2';
      if (newest) g.fillText(`${fmt.num(newest.payout / 1e6, 2)} ALGO`, cx, cy + R * 0.38);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="proposers">
      <canvas ref={canvas} className="proposer-ring" />
    </div>
  );
}
