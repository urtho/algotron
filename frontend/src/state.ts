import { useEffect, useReducer } from 'react';
import type { AppConfig, BlockStat, LogLine, NodeState, ServerMessage } from '../../shared/types.ts';

export interface LogEntry extends LogLine {
  id: number;
}

export interface AppState {
  connected: boolean;
  /** The backend has a tip and its block history */
  ready: boolean;
  config: AppConfig;
  bootLines: string[];
  nodes: Record<string, NodeState>;
  blocks: BlockStat[];
  tip: number;
  /** Browser clock when the tip last moved */
  tipAt: number;
  logs: LogEntry[];
}

type Action = { type: 'open' } | { type: 'close' } | { type: 'msg'; msg: ServerMessage };

const MAX_BLOCKS = 400;
const MAX_LOGS = 300;
let logSeq = 0;
const entry = (l: LogLine): LogEntry => ({ id: logSeq++, message: l.message, level: l.level, ts: l.ts });

const initial: AppState = {
  connected: false,
  ready: false,
  config: {
    version: '',
    networkId: '',
    networkLabel: '',
    explorer: 'https://allo.info',
    pollMs: 500,
    propSource: 'poll',
  },
  bootLines: [],
  nodes: {},
  blocks: [],
  tip: 0,
  tipAt: 0,
  logs: [],
};

function insertBlock(blocks: BlockStat[], b: BlockStat): BlockStat[] {
  let i = blocks.length;
  while (i > 0 && blocks[i - 1]!.round > b.round) i--;
  if (blocks[i - 1]?.round === b.round) return blocks;
  const next = [...blocks.slice(0, i), b, ...blocks.slice(i)];
  return next.length > MAX_BLOCKS ? next.slice(next.length - MAX_BLOCKS) : next;
}

function reducer(state: AppState, action: Action): AppState {
  if (action.type === 'open') return { ...state, connected: true };
  if (action.type === 'close') return { ...state, connected: false };
  const msg = action.msg;
  switch (msg.type) {
    case 'hello':
      return {
        ...state,
        ready: msg.ready,
        config: msg.config,
        bootLines: msg.boot,
        nodes: Object.fromEntries(msg.nodes.map((n) => [n.id, n])),
        blocks: msg.blocks,
        tip: msg.tip,
        tipAt: Date.now(),
        logs: msg.logs.map(entry),
      };
    case 'boot':
      return { ...state, bootLines: [...state.bootLines, msg.line] };
    case 'ready':
      return { ...state, ready: true };
    case 'nodes': {
      const nodes = { ...state.nodes };
      for (const n of msg.add ?? []) nodes[n.id] = n;
      for (const [id, patch] of Object.entries(msg.patch ?? {})) {
        const have = nodes[id];
        if (have) nodes[id] = { ...have, ...patch };
      }
      for (const id of msg.remove ?? []) delete nodes[id];
      const moved = msg.tip !== undefined && msg.tip !== state.tip;
      return { ...state, nodes, tip: msg.tip ?? state.tip, tipAt: moved ? Date.now() : state.tipAt };
    }
    case 'block':
      return { ...state, blocks: insertBlock(state.blocks, msg.block) };
    case 'block_patch':
      return {
        ...state,
        blocks: state.blocks.map((b) => (b.round === msg.round ? { ...b, ...msg.patch } : b)),
      };
    case 'log': {
      const logs = [...state.logs, entry(msg)];
      return { ...state, logs: logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs };
    }
    default:
      return state;
  }
}

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

/** One WebSocket to the backend, reconnecting every 3 s while it is down. */
export function useFeed(): AppState {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let alive = true;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (!alive) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => alive && dispatch({ type: 'open' });
      ws.onmessage = (ev) => {
        if (!alive) return;
        try {
          dispatch({ type: 'msg', msg: JSON.parse(ev.data as string) as ServerMessage });
        } catch {
          // not ours
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        dispatch({ type: 'close' });
        timer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      alive = false;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return state;
}
