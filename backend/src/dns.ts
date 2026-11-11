import { Resolver } from 'node:dns/promises';
import { DNS_SERVERS } from './config.ts';

const resolver = new Resolver();
resolver.setServers(DNS_SERVERS);

export interface ResolvedHost {
  host: string;
  port: number;
  v4: string[];
  v6: string[];
}

/** SRV lookup, then A and AAAA for every target, all in parallel. */
export async function resolveSrvHosts(srvName: string): Promise<ResolvedHost[]> {
  const records = await resolver.resolveSrv(srvName);
  const hosts = await Promise.all(
    records.map(async (rec) => {
      const [v4, v6] = await Promise.all([
        resolver.resolve4(rec.name).catch(() => [] as string[]),
        resolver.resolve6(rec.name).catch(() => [] as string[]),
      ]);
      return { host: rec.name, port: rec.port, v4, v6 };
    }),
  );
  return hosts;
}
