import { useSyncExternalStore } from 'react';
import { loadMine, saveMine } from './rank.ts';

/**
 * The visitor's own nodes and the voting addresses they gave for them. Both live on this device only
 * (localStorage) and are never part of a request: the ranking and the vote feed are the same for everybody,
 * and a visitor's nodes and votes are found in them here.
 */
export const ADDR_KEY = 'algotron.rank.addrs';
export const MAX_NODES = 8;
/** Per node. A node with more than 4 voting accounts takes no medals, but some run dozens */
export const MAX_ADDRS = 64;

const ADDRESS = /^[A-Z2-7]{58}$/;

/**
 * Addresses out of what a visitor pasted: separated by spaces, commas, semicolons or new lines, any case.
 * `bad` is what does not look like an address (58 characters of A-Z and 2-7); the checksum is not verified.
 */
export function parseAddresses(text: string): { ok: string[]; bad: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const word = raw.trim().toUpperCase();
    if (!word) continue;
    if (!ADDRESS.test(word)) bad.push(raw.trim());
    else if (!ok.includes(word)) ok.push(word);
  }
  return { ok, bad };
}

export interface Mine {
  /** Pinned node ids, newest first */
  ids: string[];
  /** Voting addresses by node id */
  addrs: Record<string, string[]>;
}

function loadAddrs(ids: string[]): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(ADDR_KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, string[]> = {};
    for (const id of ids) {
      const list = (v as Record<string, unknown>)[id];
      if (!Array.isArray(list)) continue;
      const ok = list.filter((a): a is string => typeof a === 'string' && ADDRESS.test(a));
      if (ok.length) out[id] = [...new Set(ok)].slice(0, MAX_ADDRS);
    }
    return out;
  } catch {
    return {};
  }
}

function load(): Mine {
  const ids = loadMine();
  return { ids, addrs: loadAddrs(ids) };
}

let state: Mine | undefined;
const watchers = new Set<() => void>();
const get = () => {
  state ??= load();
  return state;
};

function set(next: Mine): void {
  // addresses belong to a pinned node: forgetting the node forgets them
  const addrs: Record<string, string[]> = {};
  for (const id of next.ids) if (next.addrs[id]?.length) addrs[id] = next.addrs[id]!;
  state = { ids: next.ids, addrs };
  saveMine(state.ids);
  try {
    localStorage.setItem(ADDR_KEY, JSON.stringify(addrs));
  } catch {
    // the addresses then last for this visit only
  }
  for (const tell of watchers) tell();
}

export const mine = {
  pin(id: string): void {
    const s = get();
    set({ ...s, ids: [id, ...s.ids.filter((x) => x !== id)].slice(0, MAX_NODES) });
  },
  forget(id: string): void {
    const s = get();
    set({ ...s, ids: s.ids.filter((x) => x !== id) });
  },
  /** Returns how many of `list` were new */
  addAddresses(id: string, list: string[]): number {
    const s = get();
    const had = s.addrs[id] ?? [];
    const next = [...new Set([...had, ...list])].slice(0, MAX_ADDRS);
    set({ ...s, addrs: { ...s.addrs, [id]: next } });
    return next.length - had.length;
  },
  removeAddress(id: string, addr: string): void {
    const s = get();
    set({ ...s, addrs: { ...s.addrs, [id]: (s.addrs[id] ?? []).filter((a) => a !== addr) } });
  },
};

function subscribe(tell: () => void): () => void {
  watchers.add(tell);
  // another tab of this site changed the pins
  const other = (e: StorageEvent) => {
    if (e.key !== null && !e.key.startsWith('algotron.rank.')) return;
    state = load();
    tell();
  };
  addEventListener('storage', other);
  return () => {
    watchers.delete(tell);
    removeEventListener('storage', other);
  };
}

/** One copy for the whole page: the leagues edit it, the monitor marks the votes of the addresses in it. */
export function useMine(): Mine {
  return useSyncExternalStore(subscribe, get);
}

/** Every address of every pinned node, each once */
export const allAddresses = (m: Mine): string[] => [...new Set(m.ids.flatMap((id) => m.addrs[id] ?? []))];
