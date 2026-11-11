import { NETWORK_ID, REQUEST_TIMEOUT_MS } from './config.ts';

export function blockUrl(ip: string, port: number, round: number): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}/v1/${NETWORK_ID}/block/${round.toString(36)}`;
}

export interface ProbeResult {
  /** The node answered over HTTP at all */
  alive: boolean;
  /** 200: the node has the round that was asked for */
  has: boolean;
  /** X-Latest-Round from a 404: the node's newest round */
  latest?: number;
  rtt: number;
  err?: string;
}

function errName(e: unknown): string {
  const any = e as { name?: string; code?: string; message?: string };
  if (any?.name === 'TimeoutError') return 'timeout';
  const code = String(any?.code ?? any?.message ?? 'error');
  if (/REFUSED/i.test(code)) return 'refused';
  if (/UNREACH|NO_ROUTE|FailedToOpenSocket/i.test(code)) return 'unreachable';
  if (/RESET|CLOSED/i.test(code)) return 'reset';
  return code.slice(0, 24);
}

/**
 * One HEAD for a block. A node answers 200 when it has the round and 404 with
 * an `X-Latest-Round` header when it does not, so a single request for a
 * round in the future returns the node's height. No search is needed.
 */
export async function probe(ip: string, port: number, round: number): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(blockUrl(ip, port, round), {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const rtt = performance.now() - t0;
    if (res.status === 200) return { alive: true, has: true, rtt };
    if (res.status === 404) {
      const h = res.headers.get('x-latest-round');
      const latest = h ? Number(h) : Number.NaN;
      return { alive: true, has: false, latest: Number.isFinite(latest) ? latest : undefined, rtt };
    }
    return { alive: false, has: false, rtt, err: `http ${res.status}` };
  } catch (e) {
    return { alive: false, has: false, rtt: performance.now() - t0, err: errName(e) };
  }
}

export async function fetchBlock(ip: string, port: number, round: number): Promise<Uint8Array | null> {
  try {
    const res = await fetch(blockUrl(ip, port, round), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.status !== 200) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}
