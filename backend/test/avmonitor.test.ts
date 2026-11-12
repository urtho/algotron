import { describe, expect, test } from 'bun:test';
import {
  type AvRelayInfo,
  type AvRound,
  decodeRound,
  encodeRound,
  KIND,
  NONE,
  summarizeRound,
} from '../src/avmonitor.ts';

const u16 = (...xs: number[]) => Uint16Array.from(xs);

/** Three relays, the last one not connected for the whole round; voter 17 wins. */
const frame: AvRound = {
  level: 1,
  flags: 1,
  round: 66700123,
  t0Us: 1794390000123456,
  winner: 17,
  relays: [
    { id: 3, owd: 9, err: 4, monitor: 0, flags: 3 },
    { id: 4, owd: 412, err: 20, monitor: 0, flags: 1 },
    { id: 9, owd: NONE, err: NONE, monitor: 0, flags: 0 },
  ],
  sections: [
    {
      kind: KIND.proposal,
      period: 0,
      voters: u16(5, 17),
      first: u16(0, 3),
      summary: u16(2, 0, 2, 4, 2, 6, 20, 30, 1, 40, 40, 40),
      matrix: u16(0, 6, NONE, 2, 31, 70),
    },
    {
      kind: KIND.soft,
      period: 0,
      voters: u16(5, 9),
      first: u16(212, 215),
      summary: u16(2, 214, 216, 219, 2, 230, 241, 250, 0, NONE, NONE, NONE),
      matrix: u16(2, 18, NONE, 4, 30, NONE),
    },
    {
      kind: KIND.cert,
      period: 0,
      voters: u16(9),
      first: u16(900),
      summary: u16(1, 905, 905, 905, 1, 950, 950, 950, 0, NONE, NONE, NONE),
      matrix: u16(5, 50, NONE),
    },
  ],
};

const dict = new Map<number, AvRelayInfo>([
  [3, { id: 3, host: 'r-a.example', ip: '203.0.113.7' }],
  [4, { id: 4, host: 'r-b.example', ip: '203.0.113.8' }],
  [9, { id: 9, host: 'r-c.example', ip: '203.0.113.9' }],
]);

describe('ROUND frame', () => {
  test('encode and decode agree, sizes follow the spec', () => {
    const buf = encodeRound(frame);
    // 32 header + 3×8 relays + 3 sections × 8 + bodies (2·4+24+12, 2·4+24+12, 1·4+24+6)
    expect(buf.length).toBe(32 + 24 + 24 + 44 + 44 + 34);
    expect(decodeRound(buf)).toEqual(frame);
  });

  test('summary level has no matrix', () => {
    const summary = {
      ...frame,
      level: 0,
      sections: frame.sections.map((s) => ({ ...s, matrix: undefined })),
    };
    const back = decodeRound(encodeRound(summary));
    expect(back.sections.every((s) => s.matrix === undefined)).toBe(true);
    expect(back.sections[1]!.summary).toEqual(frame.sections[1]!.summary);
  });

  test('an unknown section kind is skipped by its body length', () => {
    const withPayload = {
      ...frame,
      sections: [
        { kind: 3, period: 0, voters: u16(1), first: u16(7), summary: u16(...new Array(12).fill(1)) },
        ...frame.sections,
      ],
    };
    expect(decodeRound(encodeRound(withPayload)).sections.map((s) => s.kind)).toEqual([0, 1, 2]);
  });

  test('truncated and foreign frames are rejected', () => {
    const buf = encodeRound(frame);
    expect(() => decodeRound(buf.subarray(0, buf.length - 3))).toThrow('truncated');
    const other = buf.slice();
    other[1] = 3;
    expect(() => decodeRound(other)).toThrow('version');
  });
});

describe('summarizeRound', () => {
  test('block wave is the winner row; soft and cert are relative to the fastest relay', () => {
    const t = summarizeRound(decodeRound(encodeRound(frame)), dict);
    expect(t.round).toBe(66700123);
    expect(t.partial).toBe(false);
    // relay 9 was not connected for the whole round
    expect(t.relays.map((r) => r.relay.id)).toEqual([3, 4]);
    expect(t.relays[0]).toMatchObject({ proposal: 2, soft: 0, cert: 0, err: 0.4 });
    expect(t.relays[1]).toMatchObject({ proposal: 31, soft: 25, cert: 45, err: 2 });
    expect(t.softMs).toBe(241);
    expect(t.certMs).toBe(950);
    // one entry per voting account, counted from the first vote of its kind
    expect(t.accounts).toEqual({ proposal: [0, 3], soft: [0, 3], cert: [0] });
  });

  test('without a matrix the first proposal vote of any proposer stands in', () => {
    const summary = {
      ...frame,
      level: 0,
      sections: frame.sections.map((s) => ({ ...s, matrix: undefined })),
    };
    const t = summarizeRound(summary, dict);
    expect(t.relays.map((r) => r.proposal)).toEqual([0, 6]);
  });

  test('relays missing from the dictionary are left out', () => {
    const t = summarizeRound(frame, new Map([[4, dict.get(4)!]]));
    expect(t.relays.map((r) => r.relay.host)).toEqual(['r-b.example']);
  });
});
