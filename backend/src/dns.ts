import { Resolver } from 'dns/promises';

const resolver = new Resolver();
resolver.setServers(['1.1.1.1', '1.0.0.1']);

const resolveSrv = resolver.resolveSrv.bind(resolver);
const resolve4 = resolver.resolve4.bind(resolver);
const resolve6 = resolver.resolve6.bind(resolver);
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
  console.log(`[DNS] Resolving SRV: ${srvName}`);

  let srvRecords: SrvRecord[];
  try {
    srvRecords = await resolveSrv(srvName) as SrvRecord[];
    console.log(`[DNS] SRV ${srvName} → ${srvRecords.length} records`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[DNS] SRV lookup failed for ${srvName}: ${msg}`);
    onError(`[DNS] SRV lookup failed for ${srvName}: ${msg}`);
    return [];
  }

  progress.total += srvRecords.length;

  const results: ResolvedNode[] = [];

  for (const record of srvRecords) {
    try {
      const [v4, v6] = await Promise.all([
        resolve4(record.name).catch(() => [] as string[]),
        resolve6(record.name).catch(() => [] as string[]),
      ]);
      const ips = [...v4, ...v6];
      if (ips.length > 0) {
        console.log(`[DNS] ${record.name}:${record.port} → ${ips.join(', ')}`);
      } else {
        console.warn(`[DNS] ${record.name}:${record.port} → no A/AAAA records`);
      }
      for (const ip of ips) {
        results.push({ host: record.name, port: record.port, ip });
      }
    } catch {
      console.warn(`[DNS] ${record.name}:${record.port} → resolve failed`);
    }
    progress.done++;
  }

  console.log(`[DNS] ${srvName} complete: ${results.length} endpoints resolved`);
  return results;
}
