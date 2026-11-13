import { describe, expect, test } from 'bun:test';
import { matchVoters, myRound } from '../../frontend/src/avstream.ts';
import { markShare } from '../../frontend/src/components/VoteCurves.tsx';
import { allAddresses, parseAddresses } from '../../frontend/src/mine.ts';
import { waveCurves } from '../../frontend/src/stats.ts';
import { type AvRound, decodeRound, encodeRound, KIND, NONE } from '../../shared/avframe.ts';
import { summarizeRound } from '../src/avmonitor.ts';

const u16 = (...xs: number[]) => Uint16Array.from(xs);
const addr = (head: string, tail: string) => head + 'A'.repeat(58 - head.length - tail.length) + tail;

const MINE = addr('FHHA', 'DCCY');
const OTHER = addr('MU33', 'DLPE');

describe('voting addresses a visitor gives for a pinned node', () => {
  test('are taken out of pasted text, any separators and case, each once', () => {
    const { ok, bad } = parseAddresses(
      `${MINE.toLowerCase()}, ${OTHER}\n${MINE}  not-an-address ${'A'.repeat(57)}`,
    );
    expect(ok).toEqual([MINE, OTHER]);
    expect(bad).toEqual(['not-an-address', 'A'.repeat(57)]);
    expect(parseAddresses('   ')).toEqual({ ok: [], bad: [] });
  });

  test('are pooled over the pinned nodes, and only over those', () => {
    const m = {
      ids: ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
      addrs: { aaaaaaaaaaaa: [MINE], bbbbbbbbbbbb: [MINE, OTHER], gone: ['X'] },
    };
    expect(allAddresses(m)).toEqual([MINE, OTHER]);
  });
});

describe("a visitor's votes in the public vote stream", () => {
  test('voters are matched by label: the first and the last characters of the address', () => {
    const labels: [number, string][] = [
      [5, 'FHHA:DCCY'],
      [9, 'MU33:DLPE'],
      [17, 'ZZZZ:ZZZZ'],
      // two voters that would share a label get longer ones
      [20, 'FHHAAA:AADCCY'],
      [21, 'broken'],
    ];
    expect([...matchVoters(labels, [MINE])]).toEqual([
      [5, MINE],
      [20, MINE],
    ]);
    expect(matchVoters(labels, []).size).toBe(0);
    expect(matchVoters(labels, [addr('FHHA', 'DCCZ')]).size).toBe(0);
  });

  /** Voter 17 wins; voter 9 has no soft time; a recovery period repeats voter 5 */
  const round: AvRound = {
    level: 0,
    flags: 1,
    round: 66700123,
    t0Us: 1794390000123456,
    winner: 17,
    relays: [{ id: 3, owd: 9, err: 4, monitor: 0, flags: 3 }],
    sections: [
      {
        kind: KIND.proposal,
        period: 0,
        voters: u16(5, 17, 9),
        first: u16(0, 3, 40),
        summary: u16(3, 0, 3, 40),
      },
      {
        kind: KIND.soft,
        period: 0,
        voters: u16(17, 5, 30, 9),
        first: u16(2490, 2500, 2510, NONE),
        summary: u16(3, 2490, 2500, 2510),
      },
      {
        kind: KIND.cert,
        period: 0,
        voters: u16(30, 5),
        first: u16(2640, 2700),
        summary: u16(2, 2640, 2700, 2700),
      },
      { kind: KIND.soft, period: 1, voters: u16(5), first: u16(9000), summary: u16(1, 9000, 9000, 9000) },
      { kind: 3, period: 0, voters: u16(5), first: u16(1), summary: u16(1, 1, 1, 1) },
    ],
  };

  test('each vote has its time on the round clock and its place among the votes of its kind', () => {
    const mine = new Map([
      [5, MINE],
      [9, OTHER],
    ]);
    expect(myRound(round, mine)).toEqual({
      round: 66700123,
      block: [
        { addr: MINE, ms: 0, place: 1, of: 3, win: false },
        { addr: OTHER, ms: 40, place: 3, of: 3, win: false },
      ],
      // voter 9's soft vote never reached a relay in time: no mark, and it does not count in the field
      soft: [{ addr: MINE, ms: 2500, place: 2, of: 3, win: false }],
      cert: [{ addr: MINE, ms: 2700, place: 2, of: 2, win: false }],
    });
  });

  test('a proposal that won the round is flagged, and only the proposal', () => {
    const m = myRound(round, new Map([[17, MINE]]));
    expect(m?.block).toEqual([{ addr: MINE, ms: 3, place: 2, of: 3, win: true }]);
    expect(m?.soft).toEqual([{ addr: MINE, ms: 2490, place: 1, of: 3, win: false }]);
  });

  test('a round without the visitor has no entry', () => {
    expect(myRound(round, new Map([[99, MINE]]))).toBeUndefined();
    expect(myRound(round, new Map())).toBeUndefined();
  });

  test('the summary level of the stream, as the browser reads it, carries all of it', () => {
    const wire = decodeRound(encodeRound(round));
    expect(wire.sections.every((s) => s.matrix === undefined)).toBe(true);
    expect(myRound(wire, new Map([[5, MINE]]))).toEqual(myRound(round, new Map([[5, MINE]])));
  });

  test("a mark sits on the dashboard's own curve: same time, same step", () => {
    // what the backend makes of the same round, and the curve the page draws from it
    const t = summarizeRound(round, new Map([[3, { id: 3, host: 'r', ip: '1.1.1.1' }]]));
    const curves = waveCurves(
      {
        round: t.round,
        origin: 'x',
        delays: {},
        accounts: { block: t.accounts.proposal, soft: t.accounts.soft, cert: t.accounts.cert },
        accountsZero: {
          block: t.accountsZero.proposal,
          soft: t.accountsZero.soft,
          cert: t.accountsZero.cert,
        },
        source: 'avmonitor',
      },
      'address',
    );
    const m = myRound(round, new Map([[5, MINE]]))!;
    for (const kind of ['block', 'soft', 'cert'] as const) {
      const mark = m[kind][0]!;
      expect(curves[kind]).toContain(mark.ms);
      expect(mark.of).toBe(curves[kind].length);
      expect(markShare(curves[kind], mark)).toBe((curves[kind].indexOf(mark.ms) + 1) / curves[kind].length);
    }
  });

  test('when the counts disagree, the time places the mark', () => {
    expect(markShare([0, 10, 20, 30], { ms: 20, place: 9, of: 50 })).toBe(0.75);
    expect(markShare([0, 10, 20, 30], { ms: 20, place: 3, of: 4 })).toBe(0.75);
  });
});
