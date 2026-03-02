import { WebSocket } from 'ws';
import type { ServerMessage } from './types.js';

/**
 * Per-WebSocket-connection session.
 * Thin messaging wrapper only — all node monitoring state lives in NodeMonitor.
 */
export class Session {
  private ws: WebSocket;
  readonly id: string;

  constructor(ws: WebSocket, id: string) {
    this.ws = ws;
    this.id = id;
  }

  send(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async bootLog(message: string): Promise<void> {
    this.send({ type: 'boot_log', message, ts: Date.now() });
    await new Promise<void>(r => setTimeout(r, 50));
  }

  log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.send({ type: 'log', message, level, ts: Date.now() });
  }

  // Polling timers are owned by NodeMonitor — nothing to clean up here.
  cleanup(): void {}
}
