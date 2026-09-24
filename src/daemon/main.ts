import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RpcServer, type Connection } from './rpc.ts';
import { acquireLock, clearEndpoint, IdleTimer, writeEndpoint, type Endpoint } from './lifecycle.ts';
import { BrowserManager } from './browsers.ts';
import { registerPageApi, type DaemonContext } from './api.ts';
import { loadConfig } from '../core/config/store.ts';
import type { Config } from '../core/config/schema.ts';
import { createJevClient } from '../core/jev/client.ts';
import { createHeuristicClient } from '../core/jev/heuristic.ts';
import { TraceStore } from '../core/trace/store.ts';
import { socketPath, logFile } from '../core/util/paths.ts';
import { configureLog, logger } from '../core/util/log.ts';
import { newId } from '../core/util/ids.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { privacyFilter } from '../core/safety/privacy.ts';
import { codeFingerprint, toolsFingerprint } from '../mcp/fingerprint.ts';

const log = logger('daemon');

export const VERSION: string = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')).version;

export interface DaemonHandle {
  ctx: DaemonContext;
  rpc: RpcServer;
  close(): Promise<void>;
  endpoint: Endpoint;
  /** Hooks for later stages (tasks, extension bridge, HTTP UI). */
  onClose(fn: () => Promise<void> | void): void;
  busy: Array<() => boolean>;
}

export interface Session { id: string; client: string; pid?: number; createdAt: number; connected: boolean }

export async function startDaemon(opts: {
  logToStderr?: boolean;
  /** A standalone daemon restarts itself on new code when nothing is running (never set in-process, e.g. tests). */
  reloadOnChange?: boolean;
} = {}): Promise<DaemonHandle> {
  if (!opts.logToStderr) configureLog({ file: logFile() });
  const release = acquireLock();
  let cfg: Config = loadConfig();
  const jev = process.env.JEV_FAKE === '1' ? createHeuristicClient() : createJevClient(() => cfg);
  const trace = TraceStore.open();
  const browsers = new BrowserManager(() => cfg);
  const rpc = new RpcServer();
  const sessions = new Map<string, Session>();
  const closers: Array<() => Promise<void> | void> = [];
  const busy: Array<() => boolean> = [];

  const ctx: DaemonContext = {
    getConfig: () => cfg,
    setConfig: (next) => { cfg = next; },
    jev, trace, browsers, version: VERSION, startedAt: Date.now(),
    sessionOf: (conn: Connection) => {
      if (conn.sessionId) return conn.sessionId;
      // Clients that skip session.hello get a per-connection session.
      const id = newId('s');
      sessions.set(id, { id, client: conn.client, createdAt: Date.now(), connected: true });
      conn.sessionId = id;
      return id;
    },
    extras: { sessions: () => sessions.size },
    secrets: [],
  };
  rpc.transform = (_method, result) => privacyFilter(result, { secrets: ctx.secrets.flatMap((f) => f()), cards: cfg.privacy.maskCards });

  rpc.register('session.hello', (p: { client?: string; pid?: number; sessionId?: string; protocol?: number }, conn) => {
    // A client reconnecting after a daemon restart keeps its session: tasks it started stay its own.
    const id = p.sessionId && p.sessionId.length <= 64 ? p.sessionId : newId('s');
    sessions.set(id, { id, client: p.client ?? 'unknown', pid: p.pid, createdAt: sessions.get(id)?.createdAt ?? Date.now(), connected: true });
    conn.sessionId = id;
    conn.client = p.client ?? 'unknown';
    // What the agent should see now (tool list and instructions of this code): an MCP server started earlier compares.
    return { sessionId: id, version: VERSION, protocol: PROTOCOL_VERSION, tools: toolsFingerprint(), startedAt: ctx.startedAt, outputTokens: cfg.privacy.outputTokens };
  });
  registerPageApi(rpc, ctx);

  const idle = new IdleTimer(Number(process.env.JEV_IDLE_MINUTES ?? 30), () => rpc.connections.size > 0 || busy.some((b) => b()), () => {
    log.info('idle, shutting down');
    void handle.close().then(() => process.exit(0));
  });
  rpc.onActivity = () => idle.poke();
  rpc.onDisconnect = (conn) => {
    if (conn.sessionId && sessions.has(conn.sessionId)) sessions.get(conn.sessionId)!.connected = false;
    idle.poke();
  };

  const path = socketPath();
  await rpc.listen(path);
  const endpoint: Endpoint = { pid: process.pid, socket: path, httpPort: null, httpToken: null, extensionPort: null, version: VERSION, startedAt: Date.now() };
  writeEndpoint(endpoint);
  idle.poke();
  const pruneTimer = setInterval(() => {
    try { trace.prune({ retentionDays: cfg.trace.retentionDays, maxMb: cfg.trace.maxMb }); } catch (e) { log.warn('prune failed', e); }
  }, 3_600_000);
  pruneTimer.unref();
  log.info(`daemon ${VERSION} listening on ${path} (pid ${process.pid})`);

  let closing: Promise<void> | null = null;
  const handle: DaemonHandle = {
    ctx, rpc, endpoint, busy,
    onClose: (fn) => { closers.push(fn); },
    close: () => {
      closing ??= (async () => {
        idle.stop();
        clearInterval(pruneTimer);
        for (const fn of closers.reverse()) { try { await fn(); } catch (e) { log.warn('close hook failed', e); } }
        await rpc.close();
        await browsers.shutdown();
        trace.close();
        clearEndpoint();
        release();
        log.info('daemon stopped');
      })();
      return closing;
    },
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void handle.close().then(() => process.exit(0)); });
  if (opts.reloadOnChange) {
    // New code on disk (an update, a rebuild): restart when idle; the next client call starts the new daemon, and
    // interrupted tasks are restored there.
    const started = codeFingerprint();
    const reload = setInterval(() => {
      if (busy.some((b) => b()) || rpc.inFlight > 0) return;
      let now: string;
      try { now = codeFingerprint(); } catch { return; }
      if (now === started) return;
      clearInterval(reload);
      log.info('the code changed on disk; restarting to load it');
      void handle.close().then(() => process.exit(0));
    }, Number(process.env.JEV_RELOAD_CHECK_MS ?? 30_000));
    reload.unref();
  }
  rpc.register('daemon.stop', () => { setTimeout(() => { void handle.close().then(() => process.exit(0)); }, 50); return { stopping: true }; });
  return handle;
}
