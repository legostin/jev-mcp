import { CdpDispatcher, CdpError, type CdpConnection } from './connection.ts';

const COMMAND_TIMEOUT_MS = 30_000;

/** CDP over a DevTools WebSocket using Node's built-in WebSocket client. */
export class WsCdpConnection implements CdpConnection {
  private ws: WebSocket;
  private d = new CdpDispatcher();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      try { this.d.handleMessage(JSON.parse(String(ev.data))); } catch { /* ignore malformed frames */ }
    });
    ws.addEventListener('close', () => this.d.shutdown('websocket closed'));
    ws.addEventListener('error', () => this.d.shutdown('websocket error'));
  }

  static connect(url: string, timeoutMs = 10_000): Promise<WsCdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); reject(new Error(`CDP connect timeout: ${url}`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new WsCdpConnection(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`CDP connect failed: ${url}`)); }, { once: true });
    });
  }

  get closed(): boolean { return this.d.closed; }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.d.closed) return Promise.reject(new CdpError(method, 'connection closed'));
    const { id, promise } = this.d.allocate(method);
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    const timer = setTimeout(() => this.d.fail(id, new CdpError(method, `timed out after ${COMMAND_TIMEOUT_MS}ms`)), COMMAND_TIMEOUT_MS);
    return promise.finally(() => clearTimeout(timer)) as Promise<T>;
  }

  on(listener: (method: string, params: any, sessionId?: string) => void): () => void { return this.d.on(listener); }
  onClose(listener: (reason: string) => void): () => void { return this.d.onClose(listener); }

  async close(): Promise<void> {
    if (this.d.closed) return;
    this.ws.close();
    this.d.shutdown('closed by client');
  }
}
