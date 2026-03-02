import { resolveSrv, resolve4 } from 'dns/promises';
import type { SrvRecord } from './types.js';

export interface ResolvedNode {
  host: string;
  port: number;
  ip: string;
}

export interface DnsProgress {
  done: number;
  total: number;
}

/**
 * Resolve an SRV DNS record and for each resulting hostname
 * perform an A-record lookup, yielding all (host, port, ip) combinations.
 * Updates the shared progress object as records are resolved.
 */
export async function resolveSrvHosts(
  srvName: string,
  progress: DnsProgress,
  onError: (msg: string) => void
): Promise<ResolvedNode[]> {
  let srvRecords: SrvRecord[];
  try {
    srvRecords = await resolveSrv(srvName) as SrvRecord[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onError(`[DNS] SRV lookup failed for ${srvName}: ${msg}`);
    return [];
  }

  progress.total += srvRecords.length;

  const results: ResolvedNode[] = [];

  for (const record of srvRecords) {
    try {
      const ips = await resolve4(record.name);
      for (const ip of ips) {
        results.push({ host: record.name, port: record.port, ip });
      }
    } catch {
      // silently skip unresolvable A records
    }
    progress.done++;
  }

  return results;
}
