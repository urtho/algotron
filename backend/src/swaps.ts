/**
 * Live routed swaps. The swap feed publisher on etl POSTs them (bearer RANK_TOKEN, the same publisher token the
 * ranking uses) already spaced out in chain time; each one goes to every connected page at once.
 */
import { timingSafeEqual } from 'node:crypto';
import type { LiveHop, LiveSwap } from '../../shared/types.ts';

const MAX_BYTES = 256 * 1024;
const MAX_SWAPS = 50;
const MAX_HOPS = 120;
const KEEP = 20;

const str = (x: unknown, max = 64): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

function check(x: unknown): LiveSwap | undefined {
  const s = x as LiveSwap;
  if (
    !s ||
    !str(s.txid, 64) ||
    !num(s.round) ||
    !num(s.ts) ||
    !str(s.router) ||
    !str(s.inSym) ||
    !str(s.outSym)
  )
    return undefined;
  if (!num(s.inAmt) || !num(s.outAmt) || !num(s.usd) || !Array.isArray(s.hops) || s.hops.length > MAX_HOPS)
    return undefined;
  const hops: LiveHop[] = [];
  for (const h of s.hops as LiveHop[]) {
    if (!h || !str(h.a) || !str(h.b) || !num(h.usd) || !str(h.venue, 32)) return undefined;
    hops.push({ a: h.a, b: h.b, usd: h.usd, venue: h.venue });
  }
  return {
    txid: s.txid,
    round: s.round,
    ts: s.ts,
    router: s.router,
    inSym: s.inSym,
    outSym: s.outSym,
    inAmt: s.inAmt,
    outAmt: s.outAmt,
    usd: s.usd,
    hops,
  };
}

export class SwapStore {
  private recent: LiveSwap[] = [];
  /** When the newest swap arrived, ms; 0 = none yet */
  at = 0;
  count = 0;

  constructor(
    private token: string,
    private publish: (s: LiveSwap) => void,
  ) {}

  async ingest(req: Request): Promise<Response> {
    if (!this.token) return new Response('Not found', { status: 404 });
    const given = Buffer.from(req.headers.get('authorization') ?? '');
    const want = Buffer.from(`Bearer ${this.token}`);
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return new Response('Unauthorized', { status: 401 });
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES)
      return new Response('too large', { status: 413 });
    const text = await req.text();
    if (text.length > MAX_BYTES) return new Response('too large', { status: 413 });
    let body: { swaps?: unknown[] };
    try {
      body = JSON.parse(text);
    } catch {
      return new Response('not JSON', { status: 400 });
    }
    if (!Array.isArray(body.swaps) || body.swaps.length > MAX_SWAPS)
      return new Response('expected {swaps: [...]}', { status: 400 });
    const swaps = body.swaps.map(check);
    if (swaps.some((s) => !s)) return new Response('malformed swap', { status: 400 });
    for (const s of swaps as LiveSwap[]) {
      this.publish(s);
      this.recent.push(s);
    }
    if (this.recent.length > KEEP) this.recent = this.recent.slice(-KEEP);
    if (swaps.length) this.at = Date.now();
    this.count += swaps.length;
    return Response.json({ ok: true, taken: swaps.length });
  }

  latest(): Response {
    return Response.json({ swaps: this.recent }, { headers: { 'cache-control': 'no-store' } });
  }

  health() {
    return this.at ? { age_s: Math.round((Date.now() - this.at) / 1000), count: this.count } : null;
  }
}
