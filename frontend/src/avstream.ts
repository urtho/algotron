import { useEffect, useSyncExternalStore } from 'react';
import { type AvRound, decodeRound, KIND, NONE } from '../../shared/avframe.ts';
import type { CurveKind } from './stats.ts';

/**
 * A visitor's own votes, read in the browser from avmonitor's public v2 stream (`level=summary`, about 4.4 KB
 * a round): every round lists each voting account with the moment its proposal, soft and cert vote first
 * reached any relay, and names the winning proposer. The stream is the same for everybody, and the visitor's
 * accounts are found in it here, so no request ever says whose votes are wanted. The page opens it only while
 * the visitor has given voting addresses for a pinned node.
 *
 * A relay forwards a proposal only if it beats the best it has seen, so a losing proposal is in the stream
 * only when some relay passed it on.
 */

/** One vote of the visitor's, on the round's own clock */
export interface MyMark {
  addr: string;
  /** ms after the round's first vote of any kind: when this vote first reached any relay */
  ms: number;
  /** 1 = the first vote of its kind in the round to reach a relay, of `of` */
  place: number;
  of: number;
  /** A proposal that won the round */
  win: boolean;
}

export type MyRound = { round: number } & Record<CurveKind, MyMark[]>;

const CURVE_OF: Record<number, CurveKind> = {
  [KIND.proposal]: 'block',
  [KIND.soft]: 'soft',
  [KIND.cert]: 'cert',
};

/**
 * Voter ids that are the visitor's. The stream names a voter by a label, the first and the last characters of
 * its address (`ABCD:WXYZ`, longer when two voters would share one), unique among the voters it knows.
 */
export function matchVoters(labels: Iterable<[number, string]>, addrs: string[]): Map<number, string> {
  const out = new Map<number, string>();
  if (addrs.length === 0) return out;
  for (const [id, label] of labels) {
    const cut = label.indexOf(':');
    if (cut < 1) continue;
    const head = label.slice(0, cut);
    const tail = label.slice(cut + 1);
    const addr = addrs.find((a) => a.startsWith(head) && a.endsWith(tail));
    if (addr) out.set(id, addr);
  }
  return out;
}

/** The visitor's votes in one round; undefined when they have none in it. Only period 0 counts, as on the dashboard. */
export function myRound(
  r: Pick<AvRound, 'round' | 'winner' | 'sections'>,
  mine: Map<number, string>,
): MyRound | undefined {
  const out: MyRound = { round: r.round, block: [], soft: [], cert: [] };
  let any = false;
  if (mine.size === 0) return undefined;
  for (const s of r.sections) {
    const kind = CURVE_OF[s.kind];
    if (!kind || s.period !== 0) continue;
    let of = 0;
    for (const ms of s.first) if (ms !== NONE) of++;
    for (let i = 0; i < s.voters.length; i++) {
      const addr = mine.get(s.voters[i]!);
      const ms = s.first[i]!;
      if (!addr || ms === NONE) continue;
      // voters are sorted by `first`, and the ones without a time come last
      out[kind].push({ addr, ms, place: i + 1, of, win: kind === 'block' && s.voters[i] === r.winner });
      any = true;
    }
  }
  return any ? out : undefined;
}

export interface MyVotes {
  /** By round number: the rounds since the page opened (the newest KEEP) in which the visitor voted */
  rounds: Map<number, MyRound>;
  /** The stream is connected and has sent its voter list */
  live: boolean;
  /** Addresses of the visitor's that the stream knows as voters since it last restarted */
  seen: Set<string>;
}

/** Rounds kept: the proposals chart shows 45, the arrival curves 11 */
const KEEP = 64;
const EMPTY: MyVotes = { rounds: new Map(), live: false, seen: new Set() };

let snapshot: MyVotes = EMPTY;
const watchers = new Set<() => void>();
let base = '';
let addrs: string[] = [];
let sock: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retry = 1000;
let epoch = '';
let live = false;
const labels = new Map<number, string>();
let ids = new Map<number, string>();
let frames: AvRound[] = [];

function publish(): void {
  const rounds = new Map<number, MyRound>();
  for (const f of frames) {
    const m = myRound(f, ids);
    if (m) rounds.set(f.round, m);
  }
  snapshot = { rounds, live, seen: new Set(ids.values()) };
  for (const tell of watchers) tell();
}

function control(msg: { t?: string; [k: string]: unknown }): void {
  if (msg.t === 'hello') {
    // ids are valid for one run of the server only
    if (msg.epoch !== epoch) {
      labels.clear();
      ids = new Map();
      frames = [];
    }
    epoch = String(msg.epoch);
  } else if (msg.t === 'voters') {
    if (msg.full) labels.clear();
    for (const [id, label] of msg.voters as [number, string][]) labels.set(id, label);
    live = true;
    ids = matchVoters(labels, addrs);
    publish();
  }
}

function connect(): void {
  const ws = new WebSocket(`${base}/v2/stream?level=summary&fmt=bin`);
  ws.binaryType = 'arraybuffer';
  sock = ws;
  ws.onopen = () => {
    retry = 1000;
  };
  ws.onmessage = (ev) => {
    if (sock !== ws) return;
    try {
      if (typeof ev.data === 'string') return control(JSON.parse(ev.data));
      const round = decodeRound(new Uint8Array(ev.data as ArrayBuffer));
      const dropped = frames.length >= KEEP ? frames[0] : undefined;
      frames = [...frames, round].slice(-KEEP);
      // most rounds hold none of the visitor's votes: say so only when what is shown changes
      if (myRound(round, ids) || (dropped && snapshot.rounds.has(dropped.round))) publish();
    } catch (err) {
      console.warn(`[AVSTREAM] ${err instanceof Error ? err.message : err}`);
    }
  };
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = undefined;
    live = false;
    publish();
    timer = setTimeout(connect, retry);
    retry = Math.min(30_000, retry * 2);
  };
  ws.onerror = () => ws.close();
}

function stop(): void {
  clearTimeout(timer);
  const ws = sock;
  sock = undefined;
  ws?.close();
  live = false;
  epoch = '';
  labels.clear();
  frames = [];
  ids = new Map();
}

/** Sets what the page wants from the stream: nothing without a URL or without addresses. */
function want(url: string | undefined, list: string[]): void {
  const next = url && list.length ? url.replace(/\/$/, '') : '';
  addrs = list;
  if (next !== base) {
    stop();
    base = next;
    if (base) connect();
  } else {
    ids = matchVoters(labels, addrs);
  }
  publish();
}

const subscribe = (tell: () => void) => {
  watchers.add(tell);
  return () => {
    watchers.delete(tell);
  };
};

/** The visitor's votes as the page knows them now. Reading does not open the stream: see useMyVotesFeed. */
export function useMyVotes(): MyVotes {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** Keeps the stream open while there is a URL and at least one address. Called once, by the dashboard. */
export function useMyVotesFeed(url: string | undefined, list: string[]): void {
  const key = list.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is compared by content
  useEffect(() => want(url, list), [url, key]);
  useEffect(() => () => want(undefined, []), []);
}
