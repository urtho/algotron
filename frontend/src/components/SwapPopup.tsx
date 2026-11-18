import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSwap } from '../../../shared/types.ts';
import { board } from '../swap/board.ts';
import { drawDiscs, fmt } from '../swap/discs.ts';
import '../styles/swap.css';

/**
 * A routed swap pops up over the dashboard as its circuit board (identity discs): 3 s of animation, a short rest,
 * then it closes by itself. Swaps that arrive meanwhile wait in a short queue; the oldest are dropped when it is
 * full. Click or Esc closes it; the switch in the corner turns the pop-ups off for this browser.
 */

const PLAY_MS = 3000;
const REST_MS = 2600;
const QUEUE = 3;
const KEY = 'algotron.swaps';

const readOn = () => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SwapPopup({ swap }: { swap?: LiveSwap }) {
  const [on, setOn] = useState(readOn);
  const [shown, setShown] = useState<LiveSwap | null>(null);
  const queue = useRef<LiveSwap[]>([]);
  const svg = useRef<SVGSVGElement>(null);

  const next = useCallback(() => {
    setShown(document.hidden ? null : (queue.current.shift() ?? null));
  }, []);

  // a new swap from the feed (every message is a new object)
  useEffect(() => {
    if (!swap || !on || document.hidden) return;
    queue.current.push(swap);
    if (queue.current.length > QUEUE) queue.current.splice(0, queue.current.length - QUEUE);
    setShown((cur) => cur ?? queue.current.shift() ?? null);
  }, [swap, on]);

  // play the one on screen, then the next
  useEffect(() => {
    if (!shown) return;
    const B = board(shown);
    const start = performance.now();
    const still = reduced();
    let raf = 0;
    const frame = (now: number) => {
      const el = now - start;
      if (svg.current)
        svg.current.innerHTML = drawDiscs(B, still ? 1.2 : el / PLAY_MS, still ? 0 : now / 1000);
      if (el < PLAY_MS + REST_MS) raf = requestAnimationFrame(frame);
      else next();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [shown, next]);

  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && next();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [shown, next]);

  const toggle = () => {
    const v = !on;
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? 'on' : 'off');
    } catch {
      // the switch still holds for this visit
    }
    if (!v) {
      queue.current = [];
      setShown(null);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`swp-switch ${on ? 'on' : ''}`}
        onClick={toggle}
        title="Show every routed mainnet swap as it happens"
      >
        SWAPS {on ? 'ON' : 'OFF'}
      </button>
      {shown && (
        <div className="swp-back" onClick={next} role="presentation">
          <div className="swp-panel" role="dialog" aria-label={`Swap via ${shown.router}`}>
            <header className="swp-head">
              <span className="swp-router">{shown.router.toUpperCase()}</span>
              <span>
                {fmt(shown.inAmt)} {shown.inSym} → {fmt(shown.outAmt)} {shown.outSym}
              </span>
              <span className="swp-usd">
                ${shown.usd >= 100 ? Math.round(shown.usd).toLocaleString('en-US') : shown.usd.toFixed(2)}
              </span>
              <a
                className="swp-tx"
                href={`https://allo.info/tx/${shown.txid}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                round {shown.round.toLocaleString('en-US')} ↗
              </a>
            </header>
            <svg ref={svg} viewBox="0 0 1600 900" className="swp-svg" aria-hidden="true" />
          </div>
        </div>
      )}
    </>
  );
}
