import type { NodeState, NodeStatus, ServerMessage } from './types.js';
import { checkBlockExists, discoverNode } from './nodeChecker.js';
import type { Session } from './session.js';

const POLL_INTERVAL_MS = 1_000;

/**
 * Singleton that owns all node state, tip tracking, and polling timers.
 * All connected sessions share this state — each node is polled exactly once
 * regardless of how many clients are connected.
 */
class NodeMonitor {
  private nodes = new Map<string, NodeState>();
  /** "ip:port" keys for deduplication across sessions */
  private nodeKeys = new Set<string>();
  private tipBlock = 0;
  private stallRounds = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private clients = new Set<Session>();

  // ─── client registration ──────────────────────────────────────────────────

  addClient(session: Session): void {
    this.clients.add(session);
    this.sendSnapshot(session);
  }

  removeClient(session: Session): void {
    this.clients.delete(session);
  }

  private sendSnapshot(session: Session): void {
    for (const node of this.nodes.values()) {
      session.send({ type: 'node_discovered', node });
    }
    if (this.tipBlock > 0) {
      session.send({ type: 'tip_update', tip: this.tipBlock });
    }
  }

  // ─── broadcasting ─────────────────────────────────────────────────────────

  broadcast(msg: ServerMessage): void {
    for (const session of this.clients) {
      session.send(msg);
    }
  }

  broadcastLog(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.broadcast({ type: 'log', message, level, ts: Date.now() });
  }

  // ─── node merging ─────────────────────────────────────────────────────────

  /**
   * Add any nodes from `candidates` not already tracked.
   * Boots archivers first (to establish tip), then relays.
   * Fire-and-forget — returns immediately.
   */
  mergeNodes(candidates: NodeState[]): void {
    const newNodes: NodeState[] = [];

    for (const candidate of candidates) {
      const key = `${candidate.ip}:${candidate.port}`;
      if (this.nodeKeys.has(key)) continue;
      this.nodeKeys.add(key);
      this.nodes.set(candidate.id, candidate);
      this.broadcast({ type: 'node_discovered', node: candidate });
      newNodes.push(candidate);
    }

    if (newNodes.length === 0) return;

    void (async () => {
      const archivers = newNodes.filter(n => n.type === 'archiver');
      const relays    = newNodes.filter(n => n.type === 'relay');
      await Promise.allSettled(archivers.map(n => this.bootNode(n)));
      await Promise.allSettled(relays.map(n => this.bootNode(n)));
      this.broadcastLog('[MONITOR] All initial node discoveries completed', 'info');
    })();
  }

  // ─── tip tracking ─────────────────────────────────────────────────────────

  private updateTip(block: number): boolean {
    if (block > this.tipBlock) {
      this.tipBlock = block;
      this.broadcast({ type: 'tip_update', tip: block });
      this.recomputeStatuses();
      return true;
    }
    return false;
  }

  getTip(): number {
    return this.tipBlock;
  }

  // ─── node lifecycle ───────────────────────────────────────────────────────

  private async bootNode(node: NodeState): Promise<void> {
    const result = await discoverNode(
      node.ip,
      node.port,
      () => this.tipBlock,
      node.type === 'archiver',
    );

    if (!result) {
      this.patchNode(node.id, { status: 'offline', checkingBoot: false });
      this.broadcastLog(
        `[${node.type.toUpperCase()}] ${node.label} (${node.ip}) offline during boot`,
        'warn',
      );
      this.startPolling(node.id);
      return;
    }

    this.patchNode(node.id, {
      firstBlock: result.firstBlock,
      lastBlock: result.lastBlock,
      checkingBoot: false,
    });

    this.updateTip(result.lastBlock);
    this.broadcastLog(
      `[${node.type.toUpperCase()}] ${node.label} → last block ${result.lastBlock.toLocaleString()}`,
      'info',
    );

    this.startPolling(node.id);
  }

  private startPolling(nodeId: string): void {
    const timer = setInterval(async () => {
      const node = this.nodes.get(nodeId);
      if (!node) {
        clearInterval(timer);
        this.timers.delete(nodeId);
        return;
      }

      const nextBlock = node.lastBlock + 1;
      const exists = await checkBlockExists(node.ip, node.port, nextBlock);

      if (exists) {
        this.stallRounds.set(nodeId, 0);
        this.patchNode(nodeId, { lastBlock: nextBlock });
        this.updateTip(nextBlock) &&
          this.broadcastLog(
            `[${node.type.toUpperCase()}] ${node.label} → block ${nextBlock.toLocaleString()}`,
            'info',
          );
      } else {
        const stall = (this.stallRounds.get(nodeId) ?? 0) + 1;
        this.stallRounds.set(nodeId, stall);
        if (stall > 10) {
          if (node.status !== 'offline') {
            this.broadcastLog(
              `[${node.type.toUpperCase()}] ${node.label} stalled — marking offline`,
              'warn',
            );
          }
          this.patchNode(nodeId, { status: 'offline' });
        }
      }

      // If lagging more than 2 blocks, probe tip-1 and jump ahead if present
      const lag = this.tipBlock - node.lastBlock;
      if (lag > 2 && this.tipBlock > 0) {
        const tipMinus1 = this.tipBlock - 1;
        if (tipMinus1 > node.lastBlock) {
          const tipExists = await checkBlockExists(node.ip, node.port, tipMinus1);
          if (tipExists) {
            this.stallRounds.set(nodeId, 0);
            this.patchNode(nodeId, { lastBlock: tipMinus1 });
            this.broadcastLog(
              `[${node.type.toUpperCase()}] ${node.label} jumped to block ${tipMinus1.toLocaleString()} (lag was ${lag})`,
              'info',
            );
            return;
          }
        }
      }
    }, POLL_INTERVAL_MS);

    this.timers.set(nodeId, timer);
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private patchNode(id: string, patch: Partial<NodeState>): void {
    const node = this.nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);

    if (!('status' in patch)) {
      node.status = this.computeStatus(node);
    }

    this.broadcast({
      type: 'node_update',
      id,
      patch: { ...patch, status: node.status },
    });
  }

  private recomputeStatuses(): void {
    for (const [id, node] of this.nodes) {
      const newStatus = this.computeStatus(node);
      if (newStatus !== node.status) {
        node.status = newStatus;
        this.broadcast({ type: 'node_update', id, patch: { status: newStatus } });
      }
    }
  }

  private computeStatus(node: NodeState): NodeStatus {
    if (node.checkingBoot) return 'unknown';
    if (this.tipBlock === 0) return 'unknown';

    const lag = this.tipBlock - node.lastBlock;
    if (lag <= 1) return 'synced';
    if (lag <= 3) return 'lagging';
    if (node.status === 'offline') return 'offline';
    return 'orange';
  }
}

export const nodeMonitor = new NodeMonitor();
