export type NodeType = 'relay' | 'archiver';
export type NodeStatus = 'unknown' | 'offline' | 'synced' | 'lagging' | 'orange';

export interface NodeState {
  id: string;
  type: NodeType;
  label: string;
  host: string;
  port: number;
  ip: string;
  lat: number;
  lng: number;
  country: string;
  countryCode: string;
  city: string;
  status: NodeStatus;
  lastBlock: number;
  firstBlock: number;
  checkingBoot: boolean;
}

export interface LogEntry {
  id: number;
  ts: number;
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type AppPhase = 'connecting' | 'booting' | 'running';

export interface AppState {
  phase: AppPhase;
  bootLogs: string[];
  nodes: Record<string, NodeState>;
  tipBlock: number;
  logs: LogEntry[];
}

// ─── WebSocket messages ───────────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'boot_log'; message: string; ts: number }
  | { type: 'boot_complete' }
  | { type: 'node_discovered'; node: NodeState }
  | { type: 'node_update'; id: string; patch: Partial<NodeState> }
  | { type: 'tip_update'; tip: number }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error'; ts: number };

export type AppAction =
  | { type: 'WS_OPEN' }
  | { type: 'WS_CLOSE' }
  | { type: 'SERVER_MSG'; msg: ServerMessage };
