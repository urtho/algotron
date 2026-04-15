import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { randomUUID } from 'crypto';
import { resolveSrvHosts } from './dns.js';
import type { DnsProgress, ResolvedNode } from './dns.js';
import { geolocateIPs } from './geoip.js';
import { Session } from './session.js';
import { nodeMonitor } from './nodeMonitor.js';
import type { NodeState } from './types.js';

const PORT = 3001;

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Simple health check endpoint
app.get('/health', (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);

// ─── WebSocket server ────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  const sessionId = randomUUID();
  const session = new Session(ws, sessionId);

  console.log(`[WS] New session: ${sessionId}`);

  ws.on('close', () => {
    console.log(`[WS] Session closed: ${sessionId}`);
    nodeMonitor.removeClient(session);
    session.cleanup();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Session error ${sessionId}:`, err.message);
    nodeMonitor.removeClient(session);
    session.cleanup();
  });

  // Start the boot sequence asynchronously
  void runBoot(session);
});

// ─── Boot sequence ───────────────────────────────────────────────────────────

const RELAY_SRV = process.env.RELAY_SRV ?? '_algobootstrap._tcp.mainnet.algorand.net';
const ARCHIVER_SRV = process.env.ARCHIVER_SRV ?? '_archive._tcp.mainnet.algorand.net';

async function runBoot(session: Session) {
  await session.bootLog('[ALGOTRON] Algorand Network Discovery System v1.0');
  await session.bootLog('[ALGOTRON] ═══════════════════════════════════════');
  await session.bootLog('');

  // ── DNS resolution ────────────────────────────────────────────────────────

  const skipRelays = RELAY_SRV === 'NONE';

  await session.bootLog('[BOOT] Phase 1: DNS discovery');
  await session.bootLog(`[BOOT] Relay SRV:    ${skipRelays ? 'NONE (skipped)' : RELAY_SRV}`);
  await session.bootLog(`[BOOT] Archiver SRV: ${ARCHIVER_SRV}`);
  await session.bootLog('');

  const progress: DnsProgress = { done: 0, total: 0 };

  const progressInterval = setInterval(async () => {
    if (progress.total > 0) {
      const pct = Math.round((progress.done / progress.total) * 100);
      await session.bootLog(`[BOOT] Discovery: ${pct}% (${progress.done}/${progress.total} hosts resolved)`);
    } else {
      await session.bootLog('[BOOT] Querying SRV records...');
    }
  }, 1000);

  const [relayNodes, archiverNodes] = await Promise.all([
    skipRelays
      ? Promise.resolve([] as ResolvedNode[])
      : resolveSrvHosts(RELAY_SRV, progress, (msg) => void session.bootLog(msg)),
    resolveSrvHosts(ARCHIVER_SRV, progress, (msg) => void session.bootLog(msg)),
  ]);

  clearInterval(progressInterval);
  await session.bootLog(`[BOOT] Discovery: 100% — ${relayNodes.length} relays, ${archiverNodes.length} archivers`);

  await session.bootLog('');
  if (!skipRelays) await session.bootLog(`[BOOT] Relays found:    ${relayNodes.length}`);
  await session.bootLog(`[BOOT] Archivers found: ${archiverNodes.length}`);

  if (relayNodes.length === 0 && archiverNodes.length === 0) {
    await session.bootLog('[BOOT] ERROR: No nodes discovered. Aborting.');
    await new Promise<void>(r => setTimeout(r, 1000));
    session.send({ type: 'boot_complete' });
    return;
  }

  // ── Geolocation ───────────────────────────────────────────────────────────

  await session.bootLog('');
  await session.bootLog('[BOOT] Phase 2: IP Geolocation');
  const allIPs = [...new Set([
    ...relayNodes.map(n => n.ip),
    ...archiverNodes.map(n => n.ip),
  ])];

  await session.bootLog(`[GEO] Geolocating ${allIPs.length} unique IPs via ip-api.com ...`);
  const geoMap = await geolocateIPs(allIPs);

  // ── Build NodeState objects ───────────────────────────────────────────────

  const nodeStates: NodeState[] = [];

  const EMPTY_GEO = { lat: 0, lng: 0, country: '', countryCode: '', city: '' };

  for (const n of relayNodes) {
    const geo = geoMap.get(n.ip) ?? EMPTY_GEO;
    nodeStates.push({
      id: `relay-${n.ip}:${n.port}`,
      type: 'relay',
      label: n.host.split('.')[0],
      host: n.host,
      port: n.port,
      ip: n.ip,
      lat: geo.lat,
      lng: geo.lng,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      status: 'unknown',
      lastBlock: 0,
      firstBlock: 0,
      checkingBoot: true,
    });
  }

  for (const n of archiverNodes) {
    const geo = geoMap.get(n.ip) ?? EMPTY_GEO;
    nodeStates.push({
      id: `archiver-${n.ip}:${n.port}`,
      type: 'archiver',
      label: n.host.split('.')[0],
      host: n.host,
      port: n.port,
      ip: n.ip,
      lat: geo.lat,
      lng: geo.lng,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      status: 'unknown',
      lastBlock: 0,
      firstBlock: 0,
      checkingBoot: true,
    });
  }

  await session.bootLog('');
  await session.bootLog(`[BOOT] Phase 3: Node monitoring — ${nodeStates.length} nodes`);
  await session.bootLog('[BOOT] Boot complete. Launching dashboard...');
  await session.bootLog('');
  await new Promise<void>(r => setTimeout(r, 1000));

  // Signal frontend to switch to dashboard
  session.send({ type: 'boot_complete' });

  // Register with shared monitor (sends snapshot of already-known nodes to this client)
  nodeMonitor.addClient(session);

  // Merge newly-discovered nodes into shared monitoring pool
  nodeMonitor.mergeNodes(nodeStates);
}

// ─── Start server ─────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[SERVER] Algotron backend listening on http://localhost:${PORT}`);
  console.log(`[SERVER] WebSocket available at ws://localhost:${PORT}/ws`);
});
