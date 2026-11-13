import { useEffect, useState } from 'react';
import type { RankSnapshot } from '../../shared/types.ts';

const REFRESH_MS = 5 * 60_000;

// One copy of the ranking for the whole page: the dashboard's podium and the leagues view read the same snapshot.
let snap: RankSnapshot | null = null;
let error = '';
let started = false;
const watchers = new Set<() => void>();

async function load() {
  try {
    const res = await fetch('/api/rank/latest');
    if (!res.ok)
      throw new Error(res.status === 503 ? 'The ranking has not arrived yet.' : `HTTP ${res.status}`);
    snap = (await res.json()) as RankSnapshot;
    error = '';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  for (const tell of watchers) tell();
}

/**
 * The validator ranking snapshot, the same file for every visitor, reloaded every 5 minutes.
 * Nothing about the visitor's own node is ever part of the request.
 */
export function useRank(): { snap: RankSnapshot | null; error: string } {
  const [, bump] = useState(0);
  useEffect(() => {
    const tell = () => bump((n) => n + 1);
    watchers.add(tell);
    if (!started) {
      started = true;
      void load();
      setInterval(load, REFRESH_MS);
    }
    return () => {
      watchers.delete(tell);
    };
  }, []);
  return { snap, error };
}
