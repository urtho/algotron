import { argon2id } from 'hash-wasm';
import type { RankOwn } from '../../shared/types.ts';

/**
 * Proof that a visitor runs a node, without naming an account. The ranking publishes a node's ID (the last 12
 * characters of its telemetry GUID) and, under `own`, a public key. The matching private key comes out of the
 * GUID's first 8 characters by a slow hash, so whoever knows those 8 characters can derive it and sign with it,
 * and anyone can check the signature against the ranking. Everything here runs on the device: the 8 characters
 * and the key are never part of a request.
 *
 * What it shows is knowledge of the GUID, no more: relays a node connects to receive the GUID as well.
 */

const FIRST8 = /^[0-9a-f]{8}$/;
const GUID = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-([0-9a-f]{12})$/;
const ID = /^[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A snapshot cannot ask a device for more work than this */
const MAX_MEM_KIB = 256 * 1024;
const MAX_PASSES = 8;
export const MAX_SAYS = 140;

const b64 = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * What a visitor typed as proof: the 8 characters, or the whole GUID of this node. `wrong` is set when a whole
 * GUID was given and it is another node's.
 */
export function parseFirst8(input: string, id: string): { first8?: string; wrong?: boolean } {
  const text = input.trim().toLowerCase();
  if (FIRST8.test(text)) return { first8: text };
  const guid = GUID.exec(text);
  if (!guid) return {};
  return guid[2] === id ? { first8: guid[1] } : { wrong: true };
}

export interface OwnKey {
  /** Public key, base64url: equals the ranking's `own.keys[id]` when the 8 characters were right */
  pub: string;
  sign(text: string): Promise<string>;
}

/** PKCS #8 wrapping of a 32-byte Ed25519 seed */
const PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/** The key of node `id` from the GUID's first 8 characters. Slow on purpose: about a second on a phone. */
export async function deriveKey(
  first8: string,
  id: string,
  own: Pick<RankOwn, 'mem' | 'passes'>,
): Promise<OwnKey> {
  if (!FIRST8.test(first8) || !ID.test(id)) throw new Error('not 8 hex characters and a node ID');
  if (!(own.mem > 0 && own.mem <= MAX_MEM_KIB && own.passes > 0 && own.passes <= MAX_PASSES))
    throw new Error('the ranking asks for a hash this page refuses to run');
  const seed = await argon2id({
    password: first8,
    salt: `algotron-own-v1:${id}`,
    parallelism: 1,
    iterations: own.passes,
    memorySize: own.mem,
    hashLength: 32,
    outputType: 'binary',
  });
  const der = new Uint8Array(PKCS8.length + 32);
  der.set(PKCS8);
  der.set(seed, PKCS8.length);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
  const pub = (await crypto.subtle.exportKey('jwk', key)).x;
  if (!pub) throw new Error('this browser gave no public key');
  return {
    pub,
    sign: async (text) => b64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, utf8(text)))),
  };
}

/** A signed line from a node's owner: node ID, what it says, the UTC day it was signed, the signature */
export interface Statement {
  n: string;
  s: string;
  d: string;
  g: string;
}

/** One line, no control characters, at most MAX_SAYS characters */
export const cleanSays = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
    .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
    .trim()
    .slice(0, MAX_SAYS);

/** The exact text that is signed */
export const statementText = (st: Pick<Statement, 'n' | 's' | 'd'>) =>
  `algotron-own v1\nnode ${st.n}\nsays ${st.s}\ndate ${st.d}`;

export async function signStatement(
  key: OwnKey,
  id: string,
  says: string,
  now = new Date(),
): Promise<Statement> {
  const st = { n: id, s: cleanSays(says), d: now.toISOString().slice(0, 10) };
  if (!st.s) throw new Error('nothing to sign');
  return { ...st, g: await key.sign(statementText(st)) };
}

/** True when `st` carries a valid signature of the key the ranking lists for its node */
export async function verifyStatement(st: Statement, pub: string): Promise<boolean> {
  try {
    const raw = unb64(pub);
    const sig = unb64(st.g);
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, utf8(statementText(st)));
  } catch {
    return false;
  }
}

/** A statement as the tail of a link: it travels in the fragment, which browsers do not send to the server */
export const encodeStatement = (st: Statement) =>
  b64(utf8(JSON.stringify({ n: st.n, s: st.s, d: st.d, g: st.g })));

export function decodeStatement(text: string): Statement | undefined {
  try {
    if (text.length > 1200 || !B64URL.test(text)) return undefined;
    const v = JSON.parse(new TextDecoder().decode(unb64(text))) as Partial<Statement>;
    if (typeof v.n !== 'string' || !ID.test(v.n)) return undefined;
    if (typeof v.s !== 'string' || !v.s || v.s !== cleanSays(v.s)) return undefined;
    if (typeof v.d !== 'string' || !DATE.test(v.d)) return undefined;
    if (typeof v.g !== 'string' || !B64URL.test(v.g) || v.g.length !== 86) return undefined;
    return { n: v.n, s: v.s, d: v.d, g: v.g };
  } catch {
    return undefined;
  }
}

export const VERIFY_HASH = '#verify/';
export const statementLink = (st: Statement, origin = location.origin) =>
  `${origin}/${VERIFY_HASH}${encodeStatement(st)}`;
/** The statement a page address carries, if it is a verify link */
export const statementFromHash = (hash: string) =>
  hash.startsWith(VERIFY_HASH) ? decodeStatement(hash.slice(VERIFY_HASH.length)) : undefined;
