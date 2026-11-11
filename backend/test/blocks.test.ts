import { describe, expect, test } from 'bun:test';
import { encodeAddress } from '../src/address.ts';
import { parseBlock, tps } from '../src/blocks.ts';
import { decode } from '../src/msgpack.ts';

/** Tiny msgpack encoder for fixtures: maps, arrays, strings, bin, non-negative integers. */
function enc(v: unknown): number[] {
  if (typeof v === 'number') {
    if (v < 128) return [v];
    if (v < 2 ** 16) return [0xcd, v >> 8, v & 255];
    if (v < 2 ** 32) return [0xce, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const b = new DataView(new ArrayBuffer(8));
    b.setBigUint64(0, BigInt(v));
    return [0xcf, ...new Uint8Array(b.buffer)];
  }
  if (typeof v === 'string') {
    const b = [...new TextEncoder().encode(v)];
    return b.length < 32 ? [0xa0 | b.length, ...b] : [0xd9, b.length, ...b];
  }
  if (v instanceof Uint8Array) return [0xc4, v.length, ...v];
  if (Array.isArray(v))
    return [
      v.length < 16 ? 0x90 | v.length : 0xdc,
      ...(v.length < 16 ? [] : [v.length >> 8, v.length & 255]),
      ...v.flatMap(enc),
    ];
  const e = Object.entries(v as object);
  return [0x80 | e.length, ...e.flatMap(([k, x]) => [...enc(k), ...enc(x)])];
}
const pack = (v: unknown) => new Uint8Array(enc(v));

describe('msgpack', () => {
  test('round-trips the shapes a block uses', () => {
    const v = {
      rnd: 66865484,
      tc: 3767547943,
      big: 2 ** 40,
      s: 'mainnet-v1.0',
      b: new Uint8Array([1, 2, 3]),
      a: [1, 'x'],
    };
    expect(decode(pack(v))).toEqual(v);
  });
  test('rejects truncated input', () => {
    expect(() => decode(pack({ rnd: 66865484 }).subarray(0, 4))).toThrow('truncated');
  });
});

describe('address', () => {
  test('zero key is the well-known zero address', () => {
    expect(encodeAddress(new Uint8Array(32))).toBe(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
    );
  });
});

describe('parseBlock', () => {
  const body = pack({
    block: {
      rnd: 66865484,
      ts: 1794434076,
      tc: 3767547943,
      fc: 38001,
      pp: 8198062,
      prp: new Uint8Array(32),
      proto: 'https://github.com/algorandfoundation/specs/tree/abc',
      txns: [{ txn: { type: 'axfer' } }, { txn: { type: 'axfer' } }, { txn: { type: 'appl' } }],
    },
    cert: { vote: [{}, {}, {}, {}] },
  });

  test('reads the header counters and the payset', () => {
    const b = parseBlock(body);
    expect(b).toMatchObject({
      round: 66865484,
      ts: 1794434076,
      tc: 3767547943,
      top: 3,
      fees: 38001,
      payout: 8198062,
      votes: 4,
    });
    expect(b.types).toEqual({ axfer: 2, appl: 1 });
    expect(b.bytes).toBe(body.length);
    expect(b.proposer).toHaveLength(58);
  });

  test('an empty block has no txns field', () => {
    const b = parseBlock(pack({ block: { rnd: 5, ts: 10, tc: 7 }, cert: {} }));
    expect(b).toMatchObject({ round: 5, top: 0, votes: 0, proposer: '' });
  });
});

describe('tps', () => {
  test('counter growth over header time', () => {
    const blocks = Array.from({ length: 11 }, (_, i) => ({
      tc: 1000 + i * 28,
      ts: 100 + Math.floor(i * 2.8),
    }));
    expect(tps(blocks, 10)).toBeCloseTo(280 / 28, 5);
  });
  test('needs two blocks and a positive time span', () => {
    expect(tps([{ tc: 1, ts: 1 }])).toBe(0);
    expect(
      tps([
        { tc: 1, ts: 5 },
        { tc: 9, ts: 5 },
      ]),
    ).toBe(0);
  });
});
