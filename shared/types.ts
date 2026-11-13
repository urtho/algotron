/** Wire types shared by the backend and the frontend. */

export type NodeType = 'relay' | 'archiver';

/**
 * synced   lag <= 1 round
 * lagging  lag 2..3
 * behind   lag > 3 (answers, but is not keeping up)
 * offline  no HTTP answer from where the backend runs (see `err`)
 * unknown  not probed yet
 */
export type NodeStatus = 'unknown' | 'synced' | 'lagging' | 'behind' | 'offline';

export interface NodeState {
  id: string;
  type: NodeType;
  /** First label of the SRV hostname, e.g. "r-x1" */
  label: string;
  host: string;
  port: number;
  /** Address that is polled (IPv4 when the host has one) */
  ip: string;
  /** Second address family, checked on a slow timer */
  ip6?: string;
  v6?: 'ok' | 'fail';
  lat: number;
  lng: number;
  country: string;
  countryCode: string;
  city: string;
  /** Hosting network, e.g. "OVH" */
  net: string;
  status: NodeStatus;
  lastBlock: number;
  /** Smoothed HTTP round trip, ms */
  rtt: number;
  /** Smoothed delay between the first node showing a block and this one, ms */
  prop: number;
  /** avmonitor only: smoothed median soft / cert vote delivery, ms after the fastest relay */
  soft?: number;
  cert?: number;
  /** Blocks this node was the first to show */
  firsts: number;
  /** Why the node is offline: "timeout", "refused", "http 503" ... */
  err?: string;
}

/** Per-block figures, decoded from the block a node serves. */
export interface BlockStat {
  round: number;
  /** Header `ts`, unix seconds */
  ts: number;
  /** Header `tc`, the chain-wide transaction counter after this block */
  tc: number;
  /** tc minus the previous block's tc: every transaction, inner ones included */
  txns: number;
  /** Top-level transactions in the payset */
  top: number;
  /** Top-level transactions by type (pay, axfer, appl ...) */
  types: Record<string, number>;
  /** Encoded block + certificate size, bytes */
  bytes: number;
  proposer: string;
  /** Header `fc`, fees collected, microAlgos */
  fees: number;
  /** Header `pp`, proposer payout, microAlgos */
  payout: number;
  /** Votes in the certificate */
  votes: number;
  proto: string;
  /** Backend clock when the first node showed the block; 0 for backfilled blocks */
  seenAt: number;
  /** Node that showed it first */
  first?: string;
  /** Observed propagation across nodes, ms (set once the round is closed) */
  p50?: number;
  p90?: number;
  /** Nodes that had the block when the round closed */
  reach?: number;
  /** avmonitor only: ms from the round's first vote to the median relay's median soft / cert vote */
  softMs?: number;
  certMs?: number;
  /** avmonitor only: when this round's votes of each kind first reached any relay, over the voting accounts */
  voteBox?: { proposal?: VoteBox; soft?: VoteBox; cert?: VoteBox };
}

/**
 * Votes of one kind in one round: how many, then when they first reached any relay, in ms after the
 * round's first vote of any kind: [votes, earliest, p5, p25, median, p75, p95]. For proposals a vote is a proposer.
 */
export type VoteBox = [number, number, number, number, number, number, number];

/**
 * How one finished round's block reached the nodes: the first node and every
 * other node's delay after it. From avmonitor (winning proposal vote per
 * relay, a few ms resolution) or from polling (when each node first served
 * the block, about 100 ms resolution).
 */
export interface Wave {
  round: number;
  /** Node that had it first */
  origin: string;
  /** ms after the origin, by node id; the origin is 0 */
  delays: Record<string, number>;
  /** avmonitor only: each relay's median soft / cert vote delivery, ms after the fastest relay, by node id */
  soft?: Record<string, number>;
  cert?: Record<string, number>;
  /**
   * avmonitor only: one entry per voting account (for `block`, per proposer), ms from the first vote of
   * that kind reaching any relay to this account's vote reaching any relay, ascending
   */
  accounts?: { block: number[]; soft: number[]; cert: number[] };
  /**
   * avmonitor only: where the zero of each list above sits on the round's own clock, ms after the round's
   * first vote of any kind. `zero` goes with `delays`, `soft` and `cert`; `accountsZero` with `accounts`.
   */
  zero?: { block: number; soft: number; cert: number };
  accountsZero?: { block: number; soft: number; cert: number };
  source: 'poll' | 'avmonitor';
}

export interface AppConfig {
  version: string;
  networkId: string;
  networkLabel: string;
  explorer: string;
  pollMs: number;
  /** Where propagation figures come from: block-endpoint polling, or avmonitor's gossip vote timing */
  propSource: 'poll' | 'avmonitor';
}

export interface LogLine {
  message: string;
  level: 'info' | 'warn' | 'error';
  ts: number;
}

export type ServerMessage =
  | {
      type: 'hello';
      config: AppConfig;
      boot: string[];
      ready: boolean;
      nodes: NodeState[];
      blocks: BlockStat[];
      tip: number;
      logs: LogLine[];
      wave?: Wave;
    }
  | { type: 'boot'; line: string }
  | { type: 'ready' }
  /** Batched node changes, at most one per tick */
  | {
      type: 'nodes';
      add?: NodeState[];
      patch?: Record<string, Partial<NodeState>>;
      remove?: string[];
      tip?: number;
    }
  | { type: 'wave'; wave: Wave }
  | { type: 'block'; block: BlockStat }
  | { type: 'block_patch'; round: number; patch: Partial<BlockStat> }
  | ({ type: 'log' } & LogLine);

/**
 * Validator ranking, as the valrank publisher sends it: one snapshot for everybody. A client finds its own node in
 * it locally, so no request ever names a node.
 */
export interface RankSnapshot {
  v: 1;
  leagues: { id: string; name: string; min: number; max: number | null }[];
  categories: { id: string; name: string; shows: 'rank' | 'ms' | 'days' | 'hours' }[];
  /** Oldest first; the last one is the running season */
  seasons: RankSeason[];
}

export interface RankSeason {
  /** Monday the season starts on, UTC, YYYY-MM-DD */
  wk: string;
  computed: string;
  final: boolean;
  nodes: RankNode[];
}

/** [rank in league, nodes ranked in league, medal 0-3, home badge, OS badge, value or null] */
export type RankCell = [number, number, number, number, number, number | null];

export interface RankNode {
  /** Last 12 characters of the node's telemetry GUID */
  id: string;
  /** Set when the node's telemetry name starts with @ */
  alias?: string;
  league: string;
  home: number;
  /** More than 4 voting accounts: ranked, no medals or badges */
  over: number;
  /** Only on nodes that hold an OS badge */
  os?: string;
  /** Days since the node first sent telemetry */
  tenure: number;
  c: Record<string, RankCell>;
}
