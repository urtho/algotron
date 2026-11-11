import type { BlockStat } from '../../shared/types.ts';
import { encodeAddress } from './address.ts';
import { decode, type Msg } from './msgpack.ts';

type Obj = { [k: string]: Msg };
const obj = (v: Msg | undefined): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? v : {};
const num = (v: Msg | undefined) => (typeof v === 'number' ? v : 0);
const list = (v: Msg | undefined): Msg[] => (Array.isArray(v) ? v : []);

/** What one block gives us before it is compared with its parent. */
export type RawBlock = Omit<BlockStat, 'txns' | 'seenAt'>;

/**
 * Decode the body of GET /v1/{genesis}/block/{round}: msgpack {block, cert}.
 * Header fields used: rnd, ts, tc (transaction counter), prp (proposer),
 * fc (fees collected), pp (proposer payout), proto. Zero values are omitted
 * by the encoder, so every field may be missing.
 */
export function parseBlock(body: Uint8Array): RawBlock {
  const root = obj(decode(body));
  const block = obj(root.block);
  const cert = obj(root.cert);

  const txns = list(block.txns);
  const types: Record<string, number> = {};
  for (const t of txns) {
    const type = obj(obj(t).txn).type;
    const k = typeof type === 'string' ? type : 'other';
    types[k] = (types[k] ?? 0) + 1;
  }

  // prp exists since the payouts protocol; older blocks only name the proposer in the certificate
  const prp = block.prp instanceof Uint8Array ? block.prp : obj(cert.prop).oprop;

  return {
    round: num(block.rnd),
    ts: num(block.ts),
    tc: num(block.tc),
    top: txns.length,
    types,
    bytes: body.length,
    proposer: prp instanceof Uint8Array ? encodeAddress(prp) : '',
    fees: num(block.fc),
    payout: num(block.pp),
    votes: list(cert.vote).length,
    proto: typeof block.proto === 'string' ? block.proto.split('/').pop()!.slice(0, 12) : '',
  };
}

/**
 * Transactions per second over the newest `n` blocks: the growth of the
 * counter divided by the time between the first and the last block header.
 * Header times are whole seconds, so short windows are noisy; 10+ blocks is steady.
 */
export function tps(blocks: Pick<BlockStat, 'tc' | 'ts'>[], n = 10): number {
  if (blocks.length < 2) return 0;
  const last = blocks[blocks.length - 1]!;
  const first = blocks[Math.max(0, blocks.length - 1 - n)]!;
  const dt = last.ts - first.ts;
  return dt > 0 ? (last.tc - first.tc) / dt : 0;
}
