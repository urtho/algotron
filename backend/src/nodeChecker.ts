/**
 * Block discovery and health checking for Algorand relay / archiver nodes.
 *
 * Block numbers are encoded as base-36 strings in the HTTP path:
 *   GET/HEAD http://{ip}:{port}/v1/{networkd_id}/block/{block_base36}
 *
 * Archiver: has all blocks from 0 upward.
 * Relay:    has a sliding window of ~20 000 recent blocks.
 */

const NETWORK_ID = process.env.NETWORK_ID ?? "mainnet-v1.0"

// Rough estimate for Algorand tip when the server starts.
// Updated dynamically as we discover real block heights.
const ALGO_TIP_ESTIMATE = 48_000_000;

// Timeout for each individual HEAD request
const REQUEST_TIMEOUT_MS = 6_000;

function blockUrl(ip: string, port: number, block: number): string {
  const host = ip.includes(':') ? `[${ip}]` : ip;
  return `http://${host}:${port}/v1/${NETWORK_ID}/block/${block.toString(36)}`;
}

/**
 * Returns true when the node answers 200 for the given block number.
 */
export async function checkBlockExists(ip: string, port: number, block: number): Promise<boolean> {
  try {
    const res = await fetch(blockUrl(ip, port, block), {
      method: 'HEAD',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Returns true when the node is reachable — i.e. responds with 200 or 404.
 * A 404 means the node is alive but doesn't have that specific block.
 */
async function isNodeAlive(ip: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(blockUrl(ip, port, 0), {
      method: 'HEAD',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.status === 200 || res.status === 404;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CHECK] ${ip}:${port} unreachable: ${msg}`);
    return false;
  }
}

/**
 * Binary search: find the highest block number in [lo, hi] that exists.
 * Assumes blocks form a contiguous range up to some ceiling.
 *
 * At the end of each iteration, if the global tip (getTip()) has advanced
 * past lo, probes that block directly and short-circuits if present.
 */
export async function binarySearchLastBlock(
  ip: string,
  port: number,
  lo: number,
  hi: number,
  getTip?: () => number
): Promise<number> {
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const exists = await checkBlockExists(ip, port, mid);
    if (exists) {
      lo = mid;
    } else {
      hi = mid - 1;
    }

    if (getTip) {
      const tip = getTip();
      if (tip > lo && tip <= hi) {
        const tipExists = await checkBlockExists(ip, port, tip);
        if (tipExists) {
          lo = tip;
          const moreBlocks = await checkBlockExists(ip, port, tip+2);
          if (!moreBlocks) return lo;
          // do not break — node may have blocks beyond the global tip
        }
      }
    }
  }
  return lo;
}

export interface DiscoveryResult {
  firstBlock: number;
  lastBlock: number;
}

/**
 * Full boot-time discovery for a single node.
 * Returns the first+last block the node has, or null if unreachable.
 * The caller must supply isArchiver based on which SRV record the node came from.
 * getTip provides the live global chain tip for search short-circuiting.
 */
export async function discoverNode(
  ip: string,
  port: number,
  getTip: () => number,
  isArchiver: boolean
): Promise<DiscoveryResult | null> {

  if (isArchiver) {
    // Archiver: blocks 0..N — confirm it's alive then binary search the ceiling
    const alive = await isNodeAlive(ip, port);
    if (!alive) return null;
    const lastBlock = await binarySearchLastBlock(ip, port, 0, 100_000_000, getTip);
    return { firstBlock: 0, lastBlock };
  }

  // Relay: only recent blocks around the current tip
  const tip = getTip() > 0 ? getTip() : ALGO_TIP_ESTIMATE;
  const searchHi = tip + 10;

  // Confirm the relay is alive at all
  const aliveCheck = await isNodeAlive(ip, port);
  if (!aliveCheck) return null;

  const lastBlock = await binarySearchLastBlock(ip, port, Math.max(0, tip - 5_000), searchHi, getTip);

  return { firstBlock: 0, lastBlock };
}
