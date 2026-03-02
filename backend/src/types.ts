export type NodeType = 'relay' | 'archiver';
export type NodeStatus = 'unknown' | 'offline' | 'synced' | 'lagging' | 'orange';

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface NodeInfo {
  id: string;
  type: NodeType;
  /** First subdomain part of the SRV hostname, e.g. "r1" */
  label: string;
  host: string;
  port: number;
  ip: string;
  lat: number;
  lng: number;
  country: string;
  countryCode: string;
  city: string;
}

export interface NodeState extends NodeInfo {
  status: NodeStatus;
  lastBlock: number;
  firstBlock: number;
  checkingBoot: boolean;
}

export type ServerMessage =
  | { type: 'boot_log'; message: string; ts: number }
  | { type: 'boot_complete' }
  | { type: 'node_discovered'; node: NodeState }
  | { type: 'node_update'; id: string; patch: Partial<NodeState> }
  | { type: 'tip_update'; tip: number }
  | { type: 'log'; message: string; level: 'info' | 'warn' | 'error'; ts: number };
