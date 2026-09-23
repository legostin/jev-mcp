import { connectDaemon, type DaemonClient } from '../daemon/client.ts';
import { logger } from '../core/util/log.ts';

const log = logger('mcp');

/** Daemon connection that survives daemon restarts and keeps the same session id (task ownership). */
export class DaemonBridge {
  private client: DaemonClient | null = null;
  private connecting: Promise<DaemonClient> | null = null;
  sessionId: string | null = null;
  clientName = 'mcp';
  private eventFns = new Set<(method: string, params: any) => void>();

  async get(): Promise<DaemonClient> {
    if (this.client && !this.client.closed) return this.client;
    this.connecting ??= (async () => {
      const c = await connectDaemon({ autostart: true });
      const hello = await c.call<{ sessionId: string }>('session.hello', { client: this.clientName, pid: process.pid, sessionId: this.sessionId ?? undefined });
      this.sessionId = hello.sessionId;
      c.onEvent((m, p) => { for (const fn of this.eventFns) fn(m, p); });
      c.onClose(() => { log.warn('daemon connection closed'); this.client = null; });
      this.client = c;
      return c;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async call<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    const c = await this.get();
    return c.call<T>(method, params, opts);
  }

  onEvent(fn: (method: string, params: any) => void): () => void {
    this.eventFns.add(fn);
    return () => this.eventFns.delete(fn);
  }

  close(): void { this.client?.close(); }
}
