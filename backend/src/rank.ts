/**
 * Validator ranking snapshot. The valrank publisher POSTs it (bearer RANK_TOKEN); every client GETs the same body
 * and looks its own node up locally, so the server never learns which node a visitor cares about.
 */
import { timingSafeEqual } from 'node:crypto';
import type { RankSnapshot } from '../../shared/types.ts';

const MAX_BYTES = 4 * 1024 * 1024;

export class RankStore {
  private body = '';
  private etag = '';
  /** When the snapshot on hand arrived, ms; 0 = none yet */
  at = 0;
  seasons: string[] = [];

  constructor(private token: string) {}

  /** Returns an error text, or nothing when the snapshot was taken. */
  set(text: string): string | undefined {
    if (text.length > MAX_BYTES) return 'too large';
    let snap: RankSnapshot;
    try {
      snap = JSON.parse(text) as RankSnapshot;
    } catch {
      return 'not JSON';
    }
    if (snap?.v !== 1 || !Array.isArray(snap.seasons) || snap.seasons.length === 0)
      return 'not a version 1 snapshot';
    if (!snap.seasons.every((s) => typeof s.wk === 'string' && Array.isArray(s.nodes)))
      return 'malformed season';
    this.body = text;
    this.etag = `"${Bun.hash(text).toString(36)}"`;
    this.at = Date.now();
    this.seasons = snap.seasons.map((s) => s.wk);
    return undefined;
  }

  async ingest(req: Request): Promise<Response> {
    // without a token the endpoint does not exist
    if (!this.token) return new Response('Not found', { status: 404 });
    const given = Buffer.from(req.headers.get('authorization') ?? '');
    const want = Buffer.from(`Bearer ${this.token}`);
    if (given.length !== want.length || !timingSafeEqual(given, want))
      return new Response('Unauthorized', { status: 401 });
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES)
      return new Response('too large', { status: 413 });
    const err = this.set(await req.text());
    return err ? new Response(err, { status: 400 }) : Response.json({ ok: true, seasons: this.seasons });
  }

  latest(req: Request): Response {
    if (!this.body) return Response.json({ error: 'no ranking snapshot yet' }, { status: 503 });
    const headers = {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      etag: this.etag,
    };
    if (req.headers.get('if-none-match') === this.etag) return new Response(null, { status: 304, headers });
    return new Response(this.body, { headers });
  }

  health() {
    return this.at ? { age_s: Math.round((Date.now() - this.at) / 1000), seasons: this.seasons } : null;
  }
}
