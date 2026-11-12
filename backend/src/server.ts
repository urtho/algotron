import index from '../../frontend/index.html';
import type { ServerMessage } from '../../shared/types.ts';
import { AvClient } from './avmonitor.ts';
import { AVMONITOR_URL, appConfig, HOST, PORT, REDISCOVER_MS } from './config.ts';
import { discover } from './discovery.ts';
import { Monitor } from './monitor.ts';

const TOPIC = 'feed';
const dev = process.env.NODE_ENV !== 'production';

let clients = 0;
const monitor = new Monitor((msg: ServerMessage) => {
  server.publish(TOPIC, JSON.stringify(msg));
});

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
        return Response.json(
          {
            ok,
            tip: monitor.tip,
            nodes: nodes.length,
            synced: nodes.filter((n) => n.status === 'synced').length,
            offline: nodes.filter((n) => n.status === 'offline').length,
            blocks: monitor.blocks.length,
            clients,
          },
          { status: ok || nodes.length === 0 ? 200 : 503 },
        );
      },
      '/api/state': () => Response.json(monitor.hello()),
      '/ws': (req, srv) => (srv.upgrade(req) ? undefined : new Response('WebSocket only', { status: 426 })),
    },
    fetch: () => new Response('Not found', { status: 404 }),
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
let host = HOST;
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
