import type { NodeState, NodeType } from '../../shared/types.ts';
import { ARCHIVER_SRV, RELAY_SRV } from './config.ts';
import { type ResolvedHost, resolveSrvHosts } from './dns.ts';
import { geolocate } from './geoip.ts';
import type { Monitor } from './monitor.ts';

/** Read the SRV records, locate every address and hand the node list to the monitor. */
export async function discover(monitor: Monitor, first: boolean): Promise<void> {
  const say = (line: string) => (first ? monitor.boot(line) : console.log(line));

  say('[BOOT] Phase 1: DNS discovery');
  const sets: [NodeType, string][] = [];
  if (RELAY_SRV !== 'NONE') sets.push(['relay', RELAY_SRV]);
  if (ARCHIVER_SRV !== 'NONE') sets.push(['archiver', ARCHIVER_SRV]);

  let complete = true;
  const hosts: { type: NodeType; h: ResolvedHost }[] = [];
  await Promise.all(
    sets.map(async ([type, srv]) => {
      try {
        const found = await resolveSrvHosts(srv);
        const v6 = found.filter((h) => h.v6.length).length;
        say(`[DNS] ${srv} → ${found.length} ${type}s (${v6} with IPv6)`);
        for (const h of found) {
          if (h.v4.length || h.v6.length) hosts.push({ type, h });
          else say(`[DNS] ${h.host} has no address — skipped`);
        }
      } catch (err) {
        complete = false;
        say(`[DNS] ${srv} lookup failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  if (hosts.length === 0) {
    say('[BOOT] No nodes found. Trying again at the next discovery run.');
    return;
  }

  say(`[BOOT] Phase 2: locating ${hosts.length} hosts`);
  const primary = (h: ResolvedHost) => h.v4[0] ?? h.v6[0]!;
  const geo = await geolocate([...new Set(hosts.map(({ h }) => primary(h)))]);
  const countries = new Set([...geo.values()].map((g) => g.countryCode).filter(Boolean));
  say(`[GEO] ${countries.size} countries`);

  const nodes: NodeState[] = hosts.map(({ type, h }) => {
    const ip = primary(h);
    const g = geo.get(ip)!;
    return {
      id: `${type}-${h.host}:${h.port}`,
      type,
      label: h.host.split('.')[0]!,
      host: h.host,
      port: h.port,
      ip,
      ip6: h.v4.length ? h.v6[0] : undefined,
      ...g,
      status: 'unknown',
      lastBlock: 0,
      rtt: 0,
      prop: 0,
      firsts: 0,
    };
  });

  say(`[BOOT] Phase 3: monitoring ${nodes.length} nodes`);
  monitor.sync(nodes, complete);
  if (first) void monitor.checkV6();
}
