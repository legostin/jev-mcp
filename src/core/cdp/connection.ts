/** A flat-session CDP connection: every command may target a child session by id. */
export interface CdpConnection {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(listener: (method: string, params: any, sessionId?: string) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): Promise<void>;
  readonly closed: boolean;
}

export class CdpError extends Error {
  readonly code?: number;
  readonly method: string;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
  }
}

/** Shared bookkeeping for request/response matching and event fan-out. */
export class CdpDispatcher {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Set<(method: string, params: any, sessionId?: string) => void>();
  private closeListeners = new Set<(reason: string) => void>();
  closed = false;

  allocate(method: string): { id: number; promise: Promise<any> } {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    return { id, promise };
  }

  handleMessage(msg: { id?: number; result?: any; error?: { message: string; code?: number }; method?: string; params?: any; sessionId?: string }): void {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.message, msg.error.code));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      for (const l of [...this.listeners]) {
        try { l(msg.method, msg.params ?? {}, msg.sessionId); } catch { /* listener errors are isolated */ }
      }
    }
  }

  fail(id: number, err: Error): void {
    const p = this.pending.get(id);
    if (p) { this.pending.delete(id); p.reject(err); }
  }

  on(listener: (method: string, params: any, sessionId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new CdpError(p.method, `connection closed (${reason})`));
    this.pending.clear();
    for (const l of [...this.closeListeners]) { try { l(reason); } catch { /* ignore */ } }
  }
}
