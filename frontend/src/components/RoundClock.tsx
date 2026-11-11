import { useEffect, useRef } from 'react';

/** Bar that fills from one block to the next; the fill is driven outside React. */
export function RoundClock({ tipAt, blockTime }: { tipAt: number; blockTime: number }) {
  const bar = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!tipAt) return;
      const age = (Date.now() - tipAt) / 1000;
      const expect = blockTime > 0 ? blockTime : 2.8;
      if (bar.current) {
        bar.current.style.width = `${Math.min(100, (age / expect) * 100)}%`;
        bar.current.dataset.late = age > expect * 2 ? '1' : '0';
      }
      if (label.current) label.current.textContent = `${age.toFixed(1)} s`;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [tipAt, blockTime]);

  return (
    <span className="round-clock" title="Time since the last block">
      <span className="round-clock-track">
        <span ref={bar} className="round-clock-fill" />
      </span>
      <span ref={label} className="round-clock-age" />
    </span>
  );
}
