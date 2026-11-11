import type { AppConfig } from '../../shared/types.ts';

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const RELAY_SRV = env.RELAY_SRV ?? '_algobootstrap._tcp.mainnet.algorand.net';
export const ARCHIVER_SRV = env.ARCHIVER_SRV ?? '_archive._tcp.mainnet.algorand.net';
export const NETWORK_ID = env.NETWORK_ID ?? 'mainnet-v1.0';
export const PORT = num(env.PORT, 3001);
export const HOST = env.HOST ?? '0.0.0.0';
/** Pause between two polls of one node */
export const POLL_MS = num(env.POLL_MS, 500);
/** Pause between polls while a block is due: this is the propagation resolution */
export const FAST_POLL_MS = num(env.FAST_POLL_MS, 100);
export const REQUEST_TIMEOUT_MS = num(env.REQUEST_TIMEOUT_MS, 5000);
/** How often the SRV records are read again */
export const REDISCOVER_MS = num(env.REDISCOVER_MIN, 15) * 60_000;
/** Blocks kept in memory and sent to a new client */
export const HISTORY_BLOCKS = num(env.HISTORY_BLOCKS, 400);
/** Blocks fetched at start to fill the charts */
export const BACKFILL_BLOCKS = num(env.BACKFILL_BLOCKS, 240);
/** avmonitor v2 base URL, e.g. ws://avmonitor.ts.v.nodely.io:8080. Unset: propagation comes from polling. */
export const AVMONITOR_URL = env.AVMONITOR_URL ?? '';
export const DNS_SERVERS = (env.DNS_SERVERS ?? '1.1.1.1,1.0.0.1').split(',').map((s) => s.trim());

export const appConfig: AppConfig = {
  version: '2.0',
  networkId: NETWORK_ID,
  // VITE_* names are still read so an existing .env keeps working
  networkLabel: env.NETWORK_LABEL ?? env.VITE_NETWORK_LABEL ?? 'ALGORAND MAINNET',
  explorer: (env.EXPLORER ?? env.VITE_EXPLORER ?? 'https://allo.info').replace(/\/$/, ''),
  pollMs: FAST_POLL_MS,
  propSource: AVMONITOR_URL ? 'avmonitor' : 'poll',
};
