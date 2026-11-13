import { describe, expect, test } from 'bun:test';
import { argon2Sync, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  cleanSays,
  decodeStatement,
  deriveKey,
  encodeStatement,
  parseFirst8,
  signStatement,
  statementFromHash,
  statementLink,
  statementText,
  verifyStatement,
} from '../../frontend/src/own.ts';

// a made-up node: GUID 0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9
const ID = 'a4b3c2d1e0f9';
const FIRST8 = '0f1e2d3c';
// small on purpose: the tests run the hash a dozen times
const OWN = { mem: 1024, passes: 2 };

/** The publisher's side (deploy/valrank/publisher.ts): node:crypto instead of the browser's WebAssembly hash */
function publisherKey(first8: string, id: string, own: { mem: number; passes: number }): string {
  const seed = argon2Sync('argon2id', {
    message: Buffer.from(first8),
    nonce: Buffer.from(`algotron-own-v1:${id}`),
    parallelism: 1,
    tagLength: 32,
    memory: own.mem,
    passes: own.passes,
  });
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
}

describe('proving that one runs a node', () => {
  test('the device derives the key the publisher lists, at the production cost too', async () => {
    expect((await deriveKey(FIRST8, ID, OWN)).pub).toBe(publisherKey(FIRST8, ID, OWN));
    const prod = { mem: 131072, passes: 3 };
    expect((await deriveKey(FIRST8, ID, prod)).pub).toBe(publisherKey(FIRST8, ID, prod));
    // fixed vector: a change of the derivation would orphan every published key
    expect(publisherKey(FIRST8, ID, prod)).toBe('kgBFNbGoDW2V66SId70w17BPsdGQ5ejtvyOnRRO9ff0');
  });

  test('other characters, another node or another cost give another key', async () => {
    const right = (await deriveKey(FIRST8, ID, OWN)).pub;
    expect((await deriveKey('0f1e2d3d', ID, OWN)).pub).not.toBe(right);
    expect((await deriveKey(FIRST8, 'a4b3c2d1e0f8', OWN)).pub).not.toBe(right);
    expect((await deriveKey(FIRST8, ID, { mem: 1024, passes: 3 })).pub).not.toBe(right);
  });

  test('refuses what is not 8 hex characters, and a cost a snapshot should never ask for', async () => {
    await expect(deriveKey('0F1E2D3C', ID, OWN)).rejects.toThrow();
    await expect(deriveKey('0f1e2d3', ID, OWN)).rejects.toThrow();
    await expect(deriveKey(FIRST8, 'short', OWN)).rejects.toThrow();
    await expect(deriveKey(FIRST8, ID, { mem: 1024 * 1024, passes: 3 })).rejects.toThrow();
    await expect(deriveKey(FIRST8, ID, { mem: 1024, passes: 99 })).rejects.toThrow();
    await expect(deriveKey(FIRST8, ID, { mem: 0, passes: 3 })).rejects.toThrow();
  });

  test('takes the 8 characters alone or out of the whole GUID of this node', () => {
    expect(parseFirst8(' 0F1E2D3C ', ID)).toEqual({ first8: FIRST8 });
    expect(parseFirst8('0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9', ID)).toEqual({ first8: FIRST8 });
    expect(parseFirst8('0f1e2d3c-4b5a-4978-8695-ffffffffffff', ID)).toEqual({ wrong: true });
    expect(parseFirst8('0f1e2d3', ID)).toEqual({});
    expect(parseFirst8('@alias', ID)).toEqual({});
  });
});

describe('a signed statement', () => {
  const day = new Date('2026-11-13T22:10:00Z');

  test('verifies against the published key, and only as it was signed', async () => {
    const key = await deriveKey(FIRST8, ID, OWN);
    const st = await signStatement(key, ID, '  discord:example#1234\n ', day);
    expect(st).toMatchObject({ n: ID, s: 'discord:example#1234', d: '2026-11-13' });
    expect(statementText(st)).toBe(`algotron-own v1\nnode ${ID}\nsays discord:example#1234\ndate 2026-11-13`);
    const pub = publisherKey(FIRST8, ID, OWN);
    expect(await verifyStatement(st, pub)).toBe(true);
    expect(await verifyStatement({ ...st, s: 'discord:someone#1234' }, pub)).toBe(false);
    expect(await verifyStatement({ ...st, d: '2026-11-14' }, pub)).toBe(false);
    expect(await verifyStatement({ ...st, n: 'a4b3c2d1e0f8' }, pub)).toBe(false);
    // another node's key, and a key that is not one
    expect(await verifyStatement(st, publisherKey('0f1e2d3d', ID, OWN))).toBe(false);
    expect(await verifyStatement(st, 'not-a-key')).toBe(false);
    expect(await verifyStatement({ ...st, g: 'AAAA' }, pub)).toBe(false);
  });

  test('a wrong guess of the 8 characters cannot sign for the node', async () => {
    const guess = await deriveKey('0f1e2d3d', ID, OWN);
    const st = await signStatement(guess, ID, 'mine', day);
    expect(await verifyStatement(st, publisherKey(FIRST8, ID, OWN))).toBe(false);
  });

  test('is one line of at most 140 characters, and not empty', async () => {
    expect(cleanSays(' a\tb\r\n c\u0000d ')).toBe('a b c d');
    expect(cleanSays('x'.repeat(200))).toHaveLength(140);
    const key = await deriveKey(FIRST8, ID, OWN);
    await expect(signStatement(key, ID, ' \n ', day)).rejects.toThrow();
  });

  test('travels in a link fragment and comes back the same', async () => {
    const key = await deriveKey(FIRST8, ID, OWN);
    const st = await signStatement(key, ID, 'zażółć gęślą jaźń ✓', day);
    const link = statementLink(st, 'https://algotron.example');
    expect(link.startsWith('https://algotron.example/#verify/')).toBe(true);
    const back = statementFromHash(new URL(link).hash);
    expect(back).toEqual(st);
    expect(await verifyStatement(back!, key.pub)).toBe(true);
  });

  test('a link that is not a statement is refused', () => {
    const st = { n: ID, s: 'hello', d: '2026-11-13', g: 'A'.repeat(86) };
    expect(decodeStatement(encodeStatement(st))).toEqual(st);
    expect(decodeStatement(encodeStatement({ ...st, n: 'A4B3C2D1E0F9' }))).toBeUndefined();
    expect(decodeStatement(encodeStatement({ ...st, s: 'two\nlines' }))).toBeUndefined();
    expect(decodeStatement(encodeStatement({ ...st, s: 'x'.repeat(141) }))).toBeUndefined();
    expect(decodeStatement(encodeStatement({ ...st, d: 'today' }))).toBeUndefined();
    expect(decodeStatement(encodeStatement({ ...st, g: 'short' }))).toBeUndefined();
    expect(decodeStatement('not base64 !')).toBeUndefined();
    expect(decodeStatement('e30')).toBeUndefined();
    expect(statementFromHash('#leagues/a4b3c2d1e0f9')).toBeUndefined();
  });
});
