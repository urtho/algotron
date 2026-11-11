/**
 * Development stand-in for an avmonitor v2 server, for use until the real one exists.
 * It takes the relay list and the tip from a running Algotron and sends made-up but
 * plausible vote timings in the real wire format (docs/WS-PROTOCOL-V2.md in avmonitor).
 *
 *   bun backend/test/avmock.ts [algotron-url] [port]
 *   AVMONITOR_URL=ws://127.0.0.1:3099 bun dev
 */
import type { NodeState } from '../../shared/types.ts';
import { type AvRound, encodeRound, KIND, NONE } from '../src/avmonitor.ts';

const algotron = process.argv[2] ?? 'http://127.0.0.1:3001';
const port = Number(process.argv[3] ?? 3099);
const DELAY_ROUNDS = 2;
const TOPIC = 'rounds';

interface Relay {
  id: number;
  host: string;
  ip: string;
  lat: number;
  lon: number;
  cc: string;
  up: boolean;
  rtt_ms: number;
  mon: number;
}

let relays: Relay[] = [];
let sent = 0;
const voters = Array.from(
  { length: 360 },
  (_, i) => [i, `V${String(i).padStart(3, '0')}:MOCK`] as [number, string],
);
const jitter = (ms: number) => Math.max(0, Math.round(ms * (0.7 + Math.random() * 0.6)));

async function state(): Promise<{ tip: number; nodes: NodeState[] } | null> {
  try {
    return (await (await fetch(`${algotron}/api/state`)).json()) as { tip: number; nodes: NodeState[] };
  } catch {
    return null;
  }
}

function frame(round: number): Uint8Array {
  const n = relays.length;
  // a relay's usual delay grows with its distance from the monitor: 5..80 ms
  const base = relays.map((r) => 5 + Math.min(75, r.rtt_ms / 4));
  const section = (kind: number, count: number, start: number) => {
    const first = Array.from({ length: count }, (_, i) => start + i * 2);
    const matrix = new Uint16Array(count * n);
    const summary = new Uint16Array(n * 4);
    for (let c = 0; c < n; c++) {
      const col: number[] = [];
      for (let i = 0; i < count; i++) {
        const d = Math.random() < 0.03 ? NONE : jitter(base[c]!);
        matrix[i * n + c] = d;
        if (d !== NONE) col.push(first[i]! + d);
      }
      col.sort((a, b) => a - b);
      summary.set(
        col.length
          ? [col.length, col[0]!, col[col.length >> 1]!, col[Math.floor(col.length * 0.9)]!]
          : [0, NONE, NONE, NONE],
        c * 4,
      );
    }
    return {
      kind,
      period: 0,
      voters: Uint16Array.from({ length: count }, (_, i) => (i * 7 + round) % voters.length),
      first: Uint16Array.from(first),
      summary,
      matrix,
    };
  };
  const proposal = section(KIND.proposal, 20, 0);
  const r: AvRound = {
    level: 1,
    flags: 1,
    round,
    t0Us: Date.now() * 1000,
    winner: proposal.voters[0]!,
    relays: relays.map((x) => ({ id: x.id, owd: Math.round(x.rtt_ms * 5), err: 8, monitor: 0, flags: 3 })),
    sections: [proposal, section(KIND.soft, 335, 250), section(KIND.cert, 205, 900)],
  };
  // the winner reaches every relay
  for (let c = 0; c < n; c++) proposal.matrix[c] = jitter(base[c]!);
  return encodeRound(r);
}

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/v2/stream' && srv.upgrade(req)) return;
    if (url.pathname === '/v2/voters') return Response.json({ epoch: 'mock', voters });
    return new Response('avmonitor mock: /v2/stream', { status: 404 });
  },
  websocket: {
    perMessageDeflate: true,
    open(ws) {
      ws.send(
        JSON.stringify({
          t: 'hello',
          v: 2,
          epoch: 'mock',
          net: 'mainnet',
          level: 'full',
          delay_rounds: DELAY_ROUNDS,
          time_us: Date.now() * 1000,
          monitors: [{ id: 0, name: 'mock' }],
        }),
      );
      ws.send(JSON.stringify({ t: 'relays', full: true, relays }));
      ws.send(JSON.stringify({ t: 'voters', full: true, voters }));
      ws.subscribe(TOPIC);
    },
    message() {},
  },
});

setInterval(async () => {
  const s = await state();
  if (!s) return;
  if (relays.length === 0) {
    // one avmonitor relay per endpoint: a dual-stack host gets two ids
    relays = s.nodes
      .filter((x) => x.type === 'relay')
      .flatMap((x) => [x.ip, x.ip6].filter((ip): ip is string => !!ip).map((ip) => ({ x, ip })))
      .map(({ x, ip }, id) => ({
        id,
        host: x.host,
        ip,
        lat: x.lat,
        lon: x.lng,
        cc: x.countryCode,
        up: true,
        rtt_ms: x.rtt || 100,
        mon: 0,
      }));
    server.publish(TOPIC, JSON.stringify({ t: 'relays', full: true, relays }));
    console.log(`[avmock] ${relays.length} relay endpoints from ${algotron}`);
  }
  const round = s.tip - DELAY_ROUNDS;
  if (round <= sent || relays.length === 0) return;
  sent = round;
  server.publish(TOPIC, frame(round), true);
}, 300);

console.log(`[avmock] ws://127.0.0.1:${port}/v2/stream`);
