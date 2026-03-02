import { WebSocket } from 'ws';
import type { NodeState, NodeStatus, ServerMessage } from './types.js';
import { checkBlockExists, discoverNode } from './nodeChecker.js';

const POLL_INTERVAL_MS = 1_000;

/**
 * Per-WebSocket-connection session.
 * Owns all state and timers for one browser tab.
 */
export class Session {
  private ws: WebSocket;
  private nodes = new Map<string, NodeState>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  private tipBlock = 0;
  /** Consecutive poll rounds where a node's block did not advance */
  private stallRounds = new Map<string, number>();
  readonly id: string;

  constructor(ws: WebSocket, id: string) {
    this.ws = ws;
    this.id = id;
  }

  // ─── messaging ──────────────────────────────────────────────────────────────

  send(msg: ServerMessage) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async bootLog(message: string) {
    this.send({ type: 'boot_log', message, ts: Date.now() });
    await new Promise<void>(r => setTimeout(r, 50));
  }

  log(message: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.send({ type: 'log', message, level, ts: Date.now() });
  }

  // ─── tip tracking ───────────────────────────────────────────────────────────

  updateTip(block: number): boolean {
    if (block > this.tipBlock) {
      this.tipBlock = block;
      this.send({ type: 'tip_update', tip: block });
      this.recomputeStatuses();
      return true;
    }
    return false;
  }

  getTip(): number {
    return this.tipBlock;
  }

  // ─── node lifecycle ─────────────────────────────────────────────────────────

  /**
   * Boot-time discovery for a single node. Runs binary search, then starts
   * the 1-second polling loop.
   */
  async bootNode(node: NodeState) {
    this.nodes.set(node.id, node);
    this.send({ type: 'node_discovered', node });

    const result = await discoverNode(node.ip, node.port, () => this.tipBlock, node.type === 'archiver');

    if (!result) {
      this.patchNode(node.id, { status: 'offline', checkingBoot: false });
      this.log(`[${node.type.toUpperCase()}] ${node.label} (${node.ip}) offline during boot`, 'warn');
      return;
    }

    this.patchNode(node.id, {
      firstBlock: result.firstBlock,
      lastBlock: result.lastBlock,
      checkingBoot: false,
    });

    this.updateTip(result.lastBlock);
    this.log(
      `[${node.type.toUpperCase()}] ${node.label} → last block ${result.lastBlock.toLocaleString()}`,
      'info'
    );

    // Start 1-second block-polling
    this.startPolling(node.id);
  }

  /**
   * Poll for the next block every second.
   */
  private startPolling(nodeId: string) {
    const timer = setInterval(async () => {
      const node = this.nodes.get(nodeId);
      if (!node || this.ws.readyState !== WebSocket.OPEN) {
        clearInterval(timer);
        this.timers.delete(timer);
        return;
      }

      const nextBlock = node.lastBlock + 1;
      const exists = await checkBlockExists(node.ip, node.port, nextBlock);

      if (exists) {
        this.stallRounds.set(nodeId, 0);
        this.patchNode(nodeId, { lastBlock: nextBlock });
        this.updateTip(nextBlock) &&
        this.log(
          `[${node.type.toUpperCase()}] ${node.label} → block ${nextBlock.toLocaleString()}`,
          'info'
        );
      } else {
        // If lagging more than 2 blocks, probe tip-1 and jump ahead if present
        const lag = this.tipBlock - node.lastBlock;
        if (lag > 2 && this.tipBlock > 0) {
          const tipMinus1 = this.tipBlock - 1;
          if (tipMinus1 > node.lastBlock) {
            const tipExists = await checkBlockExists(node.ip, node.port, tipMinus1);
            if (tipExists) {
              this.stallRounds.set(nodeId, 0);
              this.patchNode(nodeId, { lastBlock: tipMinus1 });
              this.log(
                `[${node.type.toUpperCase()}] ${node.label} jumped to block ${tipMinus1.toLocaleString()} (lag was ${lag})`,
                'info'
              );
              return;
            }
          }
        }

        const stall = (this.stallRounds.get(nodeId) ?? 0) + 1;
        this.stallRounds.set(nodeId, stall);
        if (stall > 10) {
          this.patchNode(nodeId, { status: 'offline' });
          this.log(`[${node.type.toUpperCase()}] ${node.label} stalled — marking offline`, 'warn');
        }
      }
    }, POLL_INTERVAL_MS);

    this.timers.add(timer);
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  private patchNode(id: string, patch: Partial<NodeState>) {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);

    // Recompute status unless explicitly set in patch
    if (!('status' in patch)) {
      node.status = this.computeStatus(node);
    }

    this.send({ type: 'node_update', id, patch: { ...patch, status: node.status } });
  }

  private recomputeStatuses() {
    for (const [id, node] of this.nodes) {
      if (node.status === 'offline') continue;
      const newStatus = this.computeStatus(node);
      if (newStatus !== node.status) {
        node.status = newStatus;
        this.send({ type: 'node_update', id, patch: { status: newStatus } });
      }
    }
  }

  private computeStatus(node: NodeState): NodeStatus {
    if (node.checkingBoot) return 'unknown';
    if (node.status === 'offline') return 'offline';
    if (this.tipBlock === 0) return 'unknown';

    const lag = this.tipBlock - node.lastBlock;
    if (lag <= 1) return 'synced';   // ≤1 block behind → green
    if (lag <= 3) return 'lagging';  // 2–3 blocks behind → yellow
    return 'orange';                  // >3 blocks behind → orange
  }

  // ─── cleanup ────────────────────────────────────────────────────────────────

  cleanup() {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.nodes.clear();
    this.stallRounds.clear();
  }
}
