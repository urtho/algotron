import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveSwap } from '../../../shared/types.ts';
import { board } from '../swap/board.ts';
import { drawDiscs, fmt } from '../swap/discs.ts';
import '../styles/swap.css';

/**
 * A routed swap pops up over the dashboard as its circuit board (identity discs): 1 s of the board at rest, 6 s of
 * animation, 3 s holding the result, then it closes by itself. Swaps that arrive meanwhile wait; the next one shown
 * is the waiting swap with the most hops, and when too many wait the ones with the fewest hops are dropped.
 * Click or Esc closes it; the switch in the corner turns the pop-ups off for this browser.
 */

const LEAD_MS = 1000;
const PLAY_MS = 6000;
const REST_MS = 3000;
const QUEUE = 5;
const KEY = 'algotron.swaps';

const readOn = () => {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
};
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Take the waiting swap with the most hops (the newest of equals) */
function takeWidest(q: LiveSwap[]): LiveSwap | null {
  if (!q.length) return null;
  let best = 0;
  q.forEach((s, i) => {
    if (s.hops.length >= (q[best]?.hops.length ?? 0)) best = i;
  });
  return q.splice(best, 1)[0] ?? null;
}

export function SwapPopup({ swaps, seq }: { swaps: LiveSwap[]; seq: number }) {
  const [on, setOn] = useState(readOn);
  const [shown, setShown] = useState<LiveSwap | null>(null);
  const queue = useRef<LiveSwap[]>([]);
  const seen = useRef(seq);
  const svg = useRef<SVGSVGElement>(null);

  const next = useCallback(() => {
    setShown(document.hidden ? null : takeWidest(queue.current));
  }, []);

  // new swaps from the feed: several can land in one render, so take every one not seen yet
  useEffect(() => {
    const fresh = swaps.slice(Math.max(0, swaps.length - (seq - seen.current)));
    seen.current = seq;
    if (!fresh.length || !on || document.hidden) return;
    const q = queue.current;
    q.push(...fresh);
    // too many waiting: drop the narrowest (the oldest of equals)
    while (q.length > QUEUE) {
      let worst = 0;
      q.forEach((s, i) => {
        if (s.hops.length < (q[worst]?.hops.length ?? 0)) worst = i;
      });
      q.splice(worst, 1);
    }
    setShown((cur) => cur ?? takeWidest(q));
  }, [seq, swaps, on]);

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
        svg.current.innerHTML = drawDiscs(
          B,
          still ? 1.2 : Math.max(0, el - LEAD_MS) / PLAY_MS,
          still ? 0 : now / 1000,
        );
      if (el < LEAD_MS + PLAY_MS + REST_MS) raf = requestAnimationFrame(frame);
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
