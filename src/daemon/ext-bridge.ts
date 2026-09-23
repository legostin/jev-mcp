import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CdpDispatcher, CdpError, type CdpConnection } from '../core/cdp/connection.ts';
import type { BrowserDriver, TabInfo } from '../core/cdp/driver.ts';
import type { DaemonToExt, ExtCallMethod, ExtTab, ExtToDaemon } from './ext-protocol.ts';
import { dataDir } from '../core/util/paths.ts';
import { randomToken } from '../core/util/ids.ts';
import { logger } from '../core/util/log.ts';

const log = logger('ext');
const CALL_TIMEOUT_MS = 30_000;
const PAIRING_MINUTES = 10;

const tokensFile = () => join(dataDir(), 'ext-tokens.json');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** CDP connection scoped to one Chrome tab, relayed through the extension's chrome.debugger. */
class ExtTabConnection implements CdpConnection {
  readonly d = new CdpDispatcher();
  private readonly bridge: ExtensionBridge;
  private readonly tabId: number;
  constructor(bridge: ExtensionBridge, tabId: number) {
    this.bridge = bridge;
    this.tabId = tabId;
  }
  get closed(): boolean { return this.d.closed; }
  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.d.closed) throw new CdpError(method, 'tab connection closed');
    try {
      return await this.bridge.call('send', { tabId: this.tabId, sessionId, method, params }) as T;
    } catch (e) {
      throw new CdpError(method, (e as Error).message);
    }
  }
  on(listener: (method: string, params: any, sessionId?: string) => void): () => void { return this.d.on(listener); }
  onClose(listener: (reason: string) => void): () => void { return this.d.onClose(listener); }
  async close(): Promise<void> { this.d.shutdown('closed by client'); }
}

/** BrowserDriver over the extension: tab ids are Chrome tab ids as strings. */
class ExtensionDriver implements BrowserDriver {
  readonly kind = 'extension' as const;
  private readonly bridge: ExtensionBridge;
  readonly tabs = new Map<number, ExtTabConnection>();
  private disconnectListeners = new Set<() => void>();
  readonly createdListeners = new Set<(tab: { id: string; openerId?: string; url: string }) => void>();
  constructor(bridge: ExtensionBridge) { this.bridge = bridge; }
  get connected(): boolean { return this.bridge.connected; }
  get interactive(): boolean { return true; }
  onTabCreated(listener: (tab: { id: string; openerId?: string; url: string }) => void): () => void {
    this.createdListeners.add(listener);
    return () => this.createdListeners.delete(listener);
  }
  private info(t: ExtTab): TabInfo { return { id: String(t.tabId), url: t.url, title: t.title, driver: 'extension' }; }
  async listTabs(): Promise<TabInfo[]> { return ((await this.bridge.call('listTabs', {})) as ExtTab[]).map((t) => this.info(t)); }
  async openTab(url?: string): Promise<TabInfo> { return this.info(await this.bridge.call('openTab', { url }) as ExtTab); }
  async closeTab(tabId: string): Promise<void> { await this.bridge.call('closeTab', { tabId: Number(tabId) }); }
  async activateTab(tabId: string): Promise<void> { await this.bridge.call('activateTab', { tabId: Number(tabId) }); }
  async attach(tabId: string): Promise<{ conn: CdpConnection; sessionId?: string }> {
    const id = Number(tabId);
    const existing = this.tabs.get(id);
    if (existing && !existing.closed) return { conn: existing };
    await this.bridge.call('attach', { tabId: id });
    const conn = new ExtTabConnection(this.bridge, id);
    this.tabs.set(id, conn);
    return { conn };
  }
  async detach(tabId: string): Promise<void> {
    const id = Number(tabId);
    this.tabs.get(id)?.d.shutdown('detached');
    this.tabs.delete(id);
    await this.bridge.call('detach', { tabId: id }).catch(() => {});
  }
  async close(): Promise<void> {}
  onDisconnect(listener: () => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
  disconnected(): void {
    for (const c of this.tabs.values()) c.d.shutdown('extension disconnected');
    this.tabs.clear();
    for (const l of [...this.disconnectListeners]) l();
  }
}

/**
 * The daemon end of the Chrome extension: WebSocket on /ext (Origin + pairing token checked), a request/response
 * channel for tab and CDP operations, event fan-out to per-tab connections, and the side-panel UI relay.
 */
export class ExtensionBridge {
  private wss = new WebSocketServer({ noServer: true });
  private socket: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pairing: { code: string; expires: number } | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  readonly driver: ExtensionDriver;
  private readonly allowedIds: () => string[];
  onConnected: () => void = () => {};
  onDisconnected: () => void = () => {};
  onUiRequest: (method: string, params: unknown) => Promise<unknown> = async () => { throw new Error('not available'); };
  extensionVersion: string | null = null;

  constructor(allowedIds: () => string[]) {
    this.allowedIds = allowedIds;
    this.driver = new ExtensionDriver(this);
  }

  get connected(): boolean { return !!this.socket && this.socket.readyState === 1; }

  newPairingCode(): { code: string; validMinutes: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = { code, expires: Date.now() + PAIRING_MINUTES * 60_000 };
    return { code, validMinutes: PAIRING_MINUTES };
  }

  private tokens(): string[] {
    if (!existsSync(tokensFile())) return [];
    try { return JSON.parse(readFileSync(tokensFile(), 'utf8')); } catch { return []; }
  }

  private addToken(token: string): void {
    const list = this.tokens();
    list.push(sha(token));
    writeFileSync(tokensFile(), JSON.stringify(list.slice(-10)), { mode: 0o600 });
  }

  /** Called by the HTTP server for upgrade requests on /ext. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = String(req.headers.origin ?? '');
    const m = origin.match(/^chrome-extension:\/\/([a-p]{32})$/);
    const allowed = this.allowedIds();
    if (!m || (allowed.length > 0 && !allowed.includes(m[1]))) {
      log.warn(`rejected extension connection from origin "${origin}"`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private out(ws: WebSocket, msg: DaemonToExt): void { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  private accept(ws: WebSocket): void {
    let authed = false;
    ws.on('message', (data) => {
      let msg: ExtToDaemon;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!authed) {
        if (msg.type === 'hello') {
          this.extensionVersion = msg.version;
          if (msg.token && this.tokens().includes(sha(msg.token))) { authed = true; this.promote(ws); this.out(ws, { type: 'welcome', paired: true, version: msg.version }); }
          else this.out(ws, { type: 'welcome', paired: false, version: msg.version });
        } else if (msg.type === 'pair') {
          if (this.pairing && this.pairing.expires > Date.now() && msg.code === this.pairing.code) {
            this.pairing = null;
            const token = randomToken();
            this.addToken(token);
            authed = true;
            this.promote(ws);
            this.out(ws, { type: 'paired', token });
            log.info('extension paired');
          } else this.out(ws, { type: 'pair_failed', reason: 'Wrong or expired code. Run "jev pair" for a new one.' });
        }
        return;
      }
      this.onMessage(ws, msg);
    });
    ws.on('close', () => {
      if (this.socket === ws) this.demote();
    });
    ws.on('error', () => {});
  }

  private promote(ws: WebSocket): void {
    if (this.socket && this.socket !== ws) this.socket.close();
    this.socket = ws;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.out(ws, { type: 'ping' }), 20_000);
    this.pingTimer.unref();
    log.info('extension connected');
    this.onConnected();
  }

  private demote(): void {
    this.socket = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('extension disconnected')); }
    this.pending.clear();
    log.warn('extension disconnected');
    this.driver.disconnected();
    this.onDisconnected();
  }

  private onMessage(ws: WebSocket, msg: ExtToDaemon): void {
    switch (msg.type) {
      case 'reply': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
        return;
      }
      case 'event': {
        const conn = this.driver.tabs.get(msg.tabId);
        conn?.d.handleMessage({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
        return;
      }
      case 'detached': {
        const conn = this.driver.tabs.get(msg.tabId);
        if (conn) {
          conn.d.handleMessage({ method: 'Inspector.detached', params: { reason: msg.reason } });
          conn.d.shutdown(msg.reason === 'tab closed' ? 'tab closed' : `detached: ${msg.reason}`);
          this.driver.tabs.delete(msg.tabId);
        }
        return;
      }
      case 'tab_created': {
        for (const l of [...this.driver.createdListeners]) l({ id: String(msg.tabId), openerId: msg.openerTabId !== undefined ? String(msg.openerTabId) : undefined, url: msg.url });
        return;
      }
      case 'ui': {
        this.onUiRequest(msg.method, msg.params)
          .then((result) => this.out(ws, { type: 'ui_reply', id: msg.id, result }))
          .catch((e) => this.out(ws, { type: 'ui_reply', id: msg.id, error: (e as Error).message }));
        return;
      }
      default: return;
    }
  }

  call(method: ExtCallMethod, params: unknown): Promise<unknown> {
    const ws = this.socket;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('The jev extension is not connected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`extension call ${method} timed out`)); }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.out(ws, { type: 'call', id, method, params });
    });
  }

  push(event: unknown): void {
    if (this.socket) this.out(this.socket, { type: 'push', event });
  }

  close(): void {
    this.socket?.close();
    this.wss.close();
  }
}
