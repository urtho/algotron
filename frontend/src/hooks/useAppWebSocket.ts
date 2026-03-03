import { useEffect, useReducer, useRef } from 'react';
import type { AppState, AppAction, ServerMessage, LogEntry } from '../types/index.js';

// ─── Reducer ──────────────────────────────────────────────────────────────────

let logSeq = 0;

function makeLog(message: string, level: LogEntry['level'], ts: number): LogEntry {
  return { id: logSeq++, message, level, ts };
}

const initialState: AppState = {
  phase: 'connecting',
  bootLogs: [],
  nodes: {},
  tipBlock: 0,
  logs: [],
};

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'WS_OPEN':
      return { ...state, phase: 'booting' };

    case 'WS_CLOSE':
      return { ...state, phase: 'connecting' };

    case 'SERVER_MSG': {
      const msg = action.msg;

      switch (msg.type) {
        case 'boot_log':
          return { ...state, bootLogs: [...state.bootLogs, msg.message] };

        case 'boot_complete':
          return { ...state, phase: 'running' };

        case 'node_discovered':
          return {
            ...state,
            nodes: { ...state.nodes, [msg.node.id]: msg.node },
          };

        case 'node_update': {
          const existing = state.nodes[msg.id];
          if (!existing) return state;
          return {
            ...state,
            nodes: {
              ...state.nodes,
              [msg.id]: { ...existing, ...msg.patch },
            },
          };
        }

        case 'tip_update':
          return { ...state, tipBlock: msg.tip };

        case 'log': {
          const entry = makeLog(msg.message, msg.level, msg.ts);
          // Keep last 500 log entries
          const logs = state.logs.length >= 500
            ? [...state.logs.slice(-499), entry]
            : [...state.logs, entry];
          return { ...state, logs };
        }

        default:
          return state;
      }
    }

    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

const WS_URL = import.meta.env.VITE_WS_URL as string | undefined
  ?? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
const RECONNECT_DELAY = 3_000;

export function useAppWebSocket(): AppState {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let mounted = true;

    function connect() {
      if (!mounted) return;

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mounted) return;
        dispatch({ type: 'WS_OPEN' });
      };

      ws.onmessage = (ev) => {
        if (!mounted) return;
        try {
          const msg = JSON.parse(ev.data as string) as ServerMessage;
          dispatch({ type: 'SERVER_MSG', msg });
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!mounted) return;
        dispatch({ type: 'WS_CLOSE' });
        reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      mounted = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, []);

  return state;
}
