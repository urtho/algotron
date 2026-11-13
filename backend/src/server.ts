import index from '../../frontend/index.html';
import type { ServerMessage } from '../../shared/types.ts';
import { AvClient } from './avmonitor.ts';
import { AVMONITOR_URL, appConfig, HOST, PORT, RANK_FILE, RANK_TOKEN, REDISCOVER_MS } from './config.ts';
import { discover } from './discovery.ts';
import { Monitor } from './monitor.ts';
import { RankStore } from './rank.ts';

const TOPIC = 'feed';
const dev = process.env.NODE_ENV !== 'production';

let clients = 0;
const rank = new RankStore(RANK_TOKEN);
if (RANK_FILE) {
  const err = rank.set(await Bun.file(RANK_FILE).text());
  if (err) console.warn(`[RANK] ${RANK_FILE}: ${err}`);
}
const monitor = new Monitor((msg: ServerMessage) => {
  server.publish(TOPIC, JSON.stringify(msg));
});

// one snapshot for everybody: nobody asks about a single node
const rankLatest = { GET: (req: Request) => rank.latest(req) };
const rankIngest = { POST: (req: Request) => rank.ingest(req) };

const serve = (hostname: string): Bun.Server<undefined> =>
  Bun.serve({
    hostname,
    port: PORT,
    development: dev ? { hmr: true, console: true } : false,
    routes: {
      '/': index,
      '/health': () => {
        const nodes = [...monitor.nodes.values()];
        const ok = monitor.tip > 0;
        const synced = nodes.filter((n) => n.status === 'synced').length;
        return Response.json(
          {
            ok,
            // a tip most nodes are not at is a wrong tip (Zabbix alerts on it); the status stays 200 so that
            // Coolify's container health check, which calls this path, does not make Traefik drop the site
            stuck: ok && synced < nodes.length / 4,
            tip: monitor.tip,
            nodes: nodes.length,
            synced,
            offline: nodes.filter((n) => n.status === 'offline').length,
            blocks: monitor.blocks.length,
            clients,
            rank: rank.health(),
          },
          { status: ok || nodes.length === 0 ? 200 : 503 },
        );
      },
      '/api/state': () => Response.json(monitor.hello()),
      '/api/rank/latest': rankLatest,
      '/api/rank/ingest': rankIngest,
      '/ws': (req, srv) => (srv.upgrade(req) ? undefined : new Response('WebSocket only', { status: 426 })),
    },
    // During a rolling update the new page can name a bundle that only the old container is asked for; that 404
    // must not stick in Cloudflare or the browser (the zone's 4 h browser TTL would otherwise be applied to it).
    fetch: () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }),
    websocket: {
      perMessageDeflate: true,
      idleTimeout: 120,
      open(ws) {
        clients++;
        ws.subscribe(TOPIC);
        ws.send(JSON.stringify(monitor.hello()));
      },
      close() {
        clients--;
      },
      message() {}, // the feed is one-way
    },
  });

// "::" listens on IPv4 and IPv6. Health checks that call "localhost" resolve it to ::1 first, so an
// IPv4-only listener fails them. Where the kernel has IPv6 switched off, fall back to IPv4.
// HOST=0.0.0.0 means "every interface", and platforms such as Coolify inject exactly that, overriding the
// image's own setting. "::" covers every IPv4 address as well, so it is used in its place.
let host = HOST === '0.0.0.0' ? '::' : HOST;
let server: Bun.Server<undefined>;
try {
  server = serve(host);
} catch (err) {
  if (host !== '::') throw err;
  host = '0.0.0.0';
  console.warn(`[SERVER] cannot listen on :: (${err instanceof Error ? err.message : err}) — using 0.0.0.0`);
  server = serve(host);
}

console.log(
  `[SERVER] Algotron ${appConfig.version} on http://${host.includes(':') ? `[${host}]` : host}:${PORT} (${appConfig.networkId})`,
);
monitor.boot(`[ALGOTRON] Algorand Network Discovery System v${appConfig.version}`);
monitor.boot('[ALGOTRON] ═══════════════════════════════════════');
await discover(monitor, true);
setInterval(() => void discover(monitor, false), REDISCOVER_MS);

if (AVMONITOR_URL) {
  monitor.boot(`[AVMON] vote timing from ${new URL(AVMONITOR_URL).host}`);
  new AvClient(AVMONITOR_URL, {
    onRound: (t) => monitor.applyAv(t),
    onState: (line, level) => monitor.log(line, level),
  }).start();
}
