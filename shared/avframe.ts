/**
 * ROUND frame of the avmonitor WebSocket protocol v2: decoder and encoder, shared by the backend (the feed
 * behind the dashboard) and the browser (a visitor's own votes, see frontend/src/avstream.ts).
 * Spec: avmonitor repo, docs/WS-PROTOCOL-V2.md, frozen 2026-11-12. Frames are little-endian; unknown section
 * kinds are skipped, as the spec requires.
 */

export const NONE = 0xffff;
export const KIND = { proposal: 0, soft: 1, cert: 2 } as const;
const HEADER = 32;
const RELAY_ROW = 8;
const SECTION_HEADER = 8;

export interface AvRelayCol {
  id: number;
  /** One-way delay already subtracted, 0.1 ms; NONE = times are uncorrected */
  owd: number;
  /** Uncertainty of the correction, ± 0.1 ms; NONE = unknown */
  err: number;
  monitor: number;
  /** bit 0: connected for the whole round; bit 1: delay from websocket ping */
  flags: number;
}

export interface AvSection {
  kind: number;
  period: number;
  /** Voter ids, sorted by `first` */
  voters: Uint16Array;
  /** ms from t0 to the vote's earliest arrival at any relay */
  first: Uint16Array;
  /** Per relay column: count, d_first, d_p50, d_p90 (ms from t0; NONE when count is 0) */
  summary: Uint16Array;
  /** level full only: voter × relay, ms from first[i]; NONE = never delivered */
  matrix?: Uint16Array;
}

export interface AvRound {
  level: number;
  /** bit 0: winner known; bit 1: partial round */
  flags: number;
  round: number;
  t0Us: number;
  /** Voter id of the winning proposer, NONE if unknown */
  winner: number;
  relays: AvRelayCol[];
  sections: AvSection[];
}

export function decodeRound(buf: Uint8Array): AvRound {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < HEADER) throw new Error('avmonitor: frame shorter than its header');
  if (v.getUint8(0) !== 1) throw new Error(`avmonitor: unknown frame type ${v.getUint8(0)}`);
  if (v.getUint8(1) !== 2) throw new Error(`avmonitor: unsupported frame version ${v.getUint8(1)}`);
  const level = v.getUint8(2);
  const nRelays = v.getUint16(22, true);
  const nSections = v.getUint8(24);

  let p = HEADER;
  const need = (n: number) => {
    if (p + n > buf.length) throw new Error('avmonitor: truncated frame');
  };
  need(nRelays * RELAY_ROW);
  const relays: AvRelayCol[] = [];
  for (let c = 0; c < nRelays; c++, p += RELAY_ROW) {
    relays.push({
      id: v.getUint16(p, true),
      owd: v.getUint16(p + 2, true),
      err: v.getUint16(p + 4, true),
      monitor: v.getUint8(p + 6),
      flags: v.getUint8(p + 7),
    });
  }

  const u16s = (at: number, n: number) => {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = v.getUint16(at + i * 2, true);
    return out;
  };

  const sections: AvSection[] = [];
  for (let s = 0; s < nSections; s++) {
    need(SECTION_HEADER);
    const kind = v.getUint8(p);
    const period = v.getUint8(p + 1);
    const nVoters = v.getUint16(p + 2, true);
    const bodyLen = v.getUint32(p + 4, true);
    p += SECTION_HEADER;
    need(bodyLen);
    const body = p;
    p += bodyLen; // always advance by body_len, so unknown kinds and later additions are skipped
    if (kind > KIND.cert) continue;
    const base = nVoters * 4 + nRelays * 8;
    if (bodyLen < base) throw new Error(`avmonitor: section ${kind} body too short`);
    const hasMatrix = level === 1 && bodyLen >= base + nVoters * nRelays * 2;
    sections.push({
      kind,
      period,
      voters: u16s(body, nVoters),
      first: u16s(body + nVoters * 2, nVoters),
      summary: u16s(body + nVoters * 4, nRelays * 4),
      matrix: hasMatrix ? u16s(body + base, nVoters * nRelays) : undefined,
    });
  }

  return {
    level,
    flags: v.getUint8(3),
    round: Number(v.getBigUint64(4, true)),
    t0Us: Number(v.getBigInt64(12, true)),
    winner: v.getUint16(20, true),
    relays,
    sections,
  };
}

/** Inverse of decodeRound. Used by the tests and the development mock server. */
export function encodeRound(r: AvRound): Uint8Array {
  const n = r.relays.length;
  const bodies = r.sections.map((s) => s.voters.length * 4 + n * 8 + (s.matrix ? s.matrix.length * 2 : 0));
  const size = HEADER + n * RELAY_ROW + bodies.reduce((a, b) => a + SECTION_HEADER + b, 0);
  const buf = new Uint8Array(size);
  const v = new DataView(buf.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, 2);
  v.setUint8(2, r.level);
  v.setUint8(3, r.flags);
  v.setBigUint64(4, BigInt(r.round), true);
  v.setBigInt64(12, BigInt(r.t0Us), true);
  v.setUint16(20, r.winner, true);
  v.setUint16(22, n, true);
  v.setUint8(24, r.sections.length);
  let p = HEADER;
  for (const c of r.relays) {
    v.setUint16(p, c.id, true);
    v.setUint16(p + 2, c.owd, true);
    v.setUint16(p + 4, c.err, true);
    v.setUint8(p + 6, c.monitor);
    v.setUint8(p + 7, c.flags);
    p += RELAY_ROW;
  }
  r.sections.forEach((s, i) => {
    v.setUint8(p, s.kind);
    v.setUint8(p + 1, s.period);
    v.setUint16(p + 2, s.voters.length, true);
    v.setUint32(p + 4, bodies[i]!, true);
    p += SECTION_HEADER;
    for (const part of [s.voters, s.first, s.summary, s.matrix]) {
      if (!part) continue;
      for (const x of part) {
        v.setUint16(p, x, true);
        p += 2;
      }
    }
  });
  return buf;
}
