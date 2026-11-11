import { useCallback, useEffect, useRef, useState } from 'react';

/** Panels that take the stage in turn, and for how long (seconds). */
export const STAGES = [
  ['globe', 24],
  ['charts', 12],
  ['relays', 12],
  ['log', 10],
] as const;
export type Stage = (typeof STAGES)[number][0];

/** Enter wall mode after this long without pointer or keyboard input; `?idle=0` turns that off. */
const params = new URLSearchParams(location.search);
const IDLE_MS = Number(params.get('idle') ?? 300) * 1000;
/** Pointer jitter below this many pixels does not count as "someone is here" */
const MOVE_PX = 12;

/**
 * Wall mode for an unattended screen: on with the top-bar button, with
 * `#wall` in the address, or after IDLE_MS without input. Any real pointer
 * movement, click or key press returns to the normal dashboard.
 */
export function useWallMode(): { on: boolean; stage: Stage; toggle: () => void } {
  const [on, setOn] = useState(() => location.hash === '#wall');
  const [index, setIndex] = useState(0);
  const armedAt = useRef(0);

  const enter = useCallback(() => {
    armedAt.current = Date.now() + 1500; // the click that starts it must not end it
    setIndex(0);
    setOn(true);
  }, []);

  useEffect(() => {
    let idle: ReturnType<typeof setTimeout> | undefined;
    let origin: { x: number; y: number } | null = null;
    const rearm = () => {
      clearTimeout(idle);
      if (IDLE_MS > 0) idle = setTimeout(enter, IDLE_MS);
    };
    const leave = () => {
      rearm();
      if (Date.now() >= armedAt.current) setOn(false);
    };
    const move = (e: PointerEvent) => {
      origin ??= { x: e.clientX, y: e.clientY };
      if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < MOVE_PX) return;
      origin = { x: e.clientX, y: e.clientY };
      leave();
    };
    rearm();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', leave);
    window.addEventListener('keydown', leave);
    return () => {
      clearTimeout(idle);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', leave);
      window.removeEventListener('keydown', leave);
    };
  }, [enter]);

  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % STAGES.length), STAGES[index]![1] * 1000);
    return () => clearTimeout(t);
  }, [on, index]);

  return { on, stage: STAGES[index]![0], toggle: on ? () => setOn(false) : enter };
}
