import { connectDaemon, type DaemonClient } from '../daemon/client.ts';
import { PROTOCOL_VERSION } from '../daemon/protocol.ts';
import { logger } from '../core/util/log.ts';

interface Hello { sessionId: string; version?: string; protocol?: number; tools?: string; startedAt?: number; outputTokens?: number }

/**
 * Whether this MCP server and the daemon agree: the same protocol, and the same tools the agent was given. When
 * they differ, the side started earlier runs older code and says what to restart.
 */
export function compatNotice(hello: Hello, own: { tools: string; startedAt: number }): string | null {
  if (hello.protocol === undefined) {
    return 'jev-browser: the jev daemon runs an older version. Run `jev stop` in a terminal; it restarts on the next call.';
  }
  if (hello.protocol === PROTOCOL_VERSION && (!hello.tools || hello.tools === own.tools)) return null;
  if ((hello.startedAt ?? 0) < own.startedAt) {
    return 'jev-browser: the jev daemon runs older code than this MCP server. It restarts by itself when no task is running; run `jev stop` to restart it now.';
  }
  return 'jev-browser was updated and its tools changed: restart the MCP server to load them (in Claude Code: /mcp, then reconnect jev-browser). Until then some tool arguments may be ignored or rejected.';
}

const log = logger('mcp');

/** Daemon connection that survives daemon restarts and keeps the same session id (task ownership). */
export class DaemonBridge {
  private client: DaemonClient | null = null;
  private connecting: Promise<DaemonClient> | null = null;
  sessionId: string | null = null;
  clientName = 'mcp';
  private eventFns = new Set<(method: string, params: any) => void>();
  /** What this MCP server registered at start, to compare with the daemon's. */
  own: { tools: string; startedAt: number } | null = null;
  /** Set when this server and the daemon disagree: appended to every tool result. */
  notice: string | null = null;
  /** Token budget of one tool output (the daemon's privacy.outputTokens). */
  outputTokens: number | undefined;

  async get(): Promise<DaemonClient> {
    if (this.client && !this.client.closed) return this.client;
    this.connecting ??= (async () => {
      const c = await connectDaemon({ autostart: true });
      const hello = await c.call<Hello>('session.hello', { client: this.clientName, pid: process.pid, sessionId: this.sessionId ?? undefined, protocol: PROTOCOL_VERSION });
      this.sessionId = hello.sessionId;
      this.outputTokens = hello.outputTokens;
      if (this.own) {
        this.notice = compatNotice(hello, this.own);
        if (this.notice) log.warn(this.notice);
      }
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
