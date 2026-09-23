import { ChromiumDriver } from '../core/cdp/chromium.ts';
import { PageSession } from '../core/cdp/page.ts';
import type { BrowserDriver, DriverKind } from '../core/cdp/driver.ts';
import { observePage, type ModelState } from '../core/perception/model.ts';
import type { PageModel } from '../core/perception/types.ts';
import type { Config } from '../core/config/schema.ts';
import { profileDir } from '../core/util/paths.ts';
import { logger } from '../core/util/log.ts';
import { RpcError, ERR } from './protocol.ts';

const log = logger('browsers');

export type Model = PageModel & ModelState;

export interface TabHandle {
  id: string;
  driver: DriverKind;
  targetId: string;
  url: string;
  title: string;
  page: PageSession | null;
  model?: Model;
  prevModel?: Model;
  /** Task that currently owns this tab. */
  lease?: string;
}

/** Owns the drivers and a registry of tabs with short, stable ids (t1, t2, …). */
export class BrowserManager {
  private chromium: ChromiumDriver | null = null;
  private chromiumStarting: Promise<ChromiumDriver> | null = null;
  private extensionDriver: BrowserDriver | null = null;
  private tabs = new Map<string, TabHandle>();
  private byTarget = new Map<string, string>();
  private current = new Map<string, string>();
  private seq = 0;
  private popups: Array<{ tabId: string; openerTab: string; at: number }> = [];
  private hooked = new WeakSet<BrowserDriver>();
  private readonly getConfig: () => Config;
  onTabClosed: (tab: TabHandle) => void = () => {};

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig;
  }

  setExtensionDriver(driver: BrowserDriver | null): void {
    this.extensionDriver = driver;
    if (!driver) {
      for (const t of this.tabs.values()) if (t.driver === 'extension') { t.page = null; }
    }
  }

  get extensionConnected(): boolean { return !!this.extensionDriver?.connected; }
  get chromiumRunning(): boolean { return !!this.chromium?.connected; }

  async chromiumDriver(): Promise<ChromiumDriver> {
    if (this.chromium?.connected) return this.chromium;
    if (!this.chromiumStarting) {
      const c = this.getConfig().driver.chromium;
      this.chromiumStarting = ChromiumDriver.launch({
        headless: process.env.JEV_HEADLESS === '1' || c.headless,
        executable: c.executable,
        profileDir: c.profileDir ?? profileDir(),
      }).then((d) => {
        this.chromium = d;
        d.onDisconnect(() => {
          log.warn('chromium disconnected');
          for (const t of [...this.tabs.values()]) if (t.driver === 'chromium') this.forget(t);
          this.chromium = null;
        });
        return d;
      }).finally(() => { this.chromiumStarting = null; });
    }
    return this.chromiumStarting;
  }

  async driver(kind: DriverKind | 'auto' = this.getConfig().driver.default): Promise<BrowserDriver> {
    let d: BrowserDriver;
    if (kind === 'extension' || (kind === 'auto' && this.extensionConnected)) {
      if (this.extensionDriver?.connected) d = this.extensionDriver;
      else if (kind === 'extension') throw new RpcError(ERR.browser, 'The jev Chrome extension is not connected. Load it and pair it (jev pair), or use driver "chromium".');
      else d = await this.chromiumDriver();
    } else d = await this.chromiumDriver();
    this.hookPopups(d);
    return d;
  }

  /** Remembers tabs opened by known tabs (results that open in a new tab, window.open, target=_blank). */
  private hookPopups(d: BrowserDriver): void {
    if (this.hooked.has(d) || !d.onTabCreated) return;
    this.hooked.add(d);
    d.onTabCreated((info) => {
      if (!info.openerId) return;
      const opener = this.byTarget.get(`${d.kind}:${info.openerId}`);
      if (!opener) return;
      const t = this.register(d.kind, info.id, info.url, '');
      this.popups.push({ tabId: t.id, openerTab: opener, at: Date.now() });
      this.popups = this.popups.filter((p) => Date.now() - p.at < 600_000);
    });
  }

  /** Tabs opened by `tabId` since `since`. */
  popupsOf(tabId: string, since: number): TabHandle[] {
    return this.popups.filter((p) => p.openerTab === tabId && p.at >= since && this.tabs.has(p.tabId)).map((p) => this.tabs.get(p.tabId)!);
  }

  interactive(id: string): boolean {
    const t = this.get(id);
    const d = t.driver === 'extension' ? this.extensionDriver : this.chromium;
    return d?.interactive ?? true;
  }

  private register(driver: DriverKind, targetId: string, url: string, title: string): TabHandle {
    const key = `${driver}:${targetId}`;
    const existing = this.byTarget.get(key);
    if (existing) {
      const t = this.tabs.get(existing)!;
      t.url = url || t.url;
      t.title = title || t.title;
      return t;
    }
    const t: TabHandle = { id: `t${++this.seq}`, driver, targetId, url, title, page: null };
    this.tabs.set(t.id, t);
    this.byTarget.set(key, t.id);
    return t;
  }

  private forget(t: TabHandle): void {
    this.tabs.delete(t.id);
    this.byTarget.delete(`${t.driver}:${t.targetId}`);
    for (const [s, id] of this.current) if (id === t.id) this.current.delete(s);
    this.onTabClosed(t);
  }

  async listTabs(): Promise<TabHandle[]> {
    const drivers: BrowserDriver[] = [];
    if (this.chromium?.connected) drivers.push(this.chromium);
    if (this.extensionDriver?.connected) drivers.push(this.extensionDriver);
    const seen = new Set<string>();
    for (const d of drivers) {
      for (const info of await d.listTabs().catch(() => [])) {
        const t = this.register(d.kind, info.id, info.url, info.title);
        seen.add(t.id);
      }
    }
    for (const t of [...this.tabs.values()]) {
      if (!seen.has(t.id) && drivers.some((d) => d.kind === t.driver)) this.forget(t);
    }
    return [...this.tabs.values()];
  }

  async openTab(url: string | undefined, kind?: DriverKind | 'auto'): Promise<TabHandle> {
    const d = await this.driver(kind);
    const info = await d.openTab('about:blank');
    const t = this.register(d.kind, info.id, url ?? 'about:blank', '');
    if (url && url !== 'about:blank') {
      const page = await this.page(t.id);
      await page.navigate(url);
      await page.waitForSettle({ maxMs: this.getConfig().limits.settleMaxMs });
    }
    return t;
  }

  async closeTab(id: string): Promise<void> {
    const t = this.get(id);
    await t.page?.close().catch(() => {});
    const d = await this.driver(t.driver);
    await d.closeTab(t.targetId).catch(() => {});
    this.forget(t);
  }

  get(id: string): TabHandle {
    const t = this.tabs.get(id);
    if (!t) throw new RpcError(ERR.notFound, `Unknown tab ${id}. Use jev_tabs to list tabs.`);
    return t;
  }

  /** Attached page session for a tab (attaches lazily, re-attaches after a disconnect). */
  async page(id: string): Promise<PageSession> {
    const t = this.get(id);
    if (t.page && !t.page.closed) return t.page;
    const d = await this.driver(t.driver);
    const page = await PageSession.open(d, t.targetId);
    page.on('closed', ({ reason }) => {
      log.info(`tab ${t.id} page session closed: ${reason}`);
      if (t.page === page) t.page = null;
      if (reason === 'tab closed') this.forget(t);
    });
    page.on('navigated', ({ url }) => { t.url = url; });
    t.page = page;
    return page;
  }

  /** Drops the tab's CDP session and attaches a fresh one (recovery from a stuck connection). */
  async reattach(id: string): Promise<void> {
    const t = this.get(id);
    const old = t.page;
    t.page = null;
    await old?.close().catch(() => {});
    await this.page(id);
  }

  setCurrent(sessionId: string, tabId: string): void { this.current.set(sessionId, tabId); }

  /** The tab a session is working with: explicit id, the session's current tab, or a new tab. */
  async resolve(sessionId: string, tabId?: string, opts: { create?: boolean } = { create: true }): Promise<TabHandle> {
    if (tabId) { const t = this.get(tabId); this.current.set(sessionId, t.id); return t; }
    const cur = this.current.get(sessionId);
    if (cur && this.tabs.has(cur)) return this.tabs.get(cur)!;
    if (!opts.create) throw new RpcError(ERR.notFound, 'No current tab. Open one with jev_tabs (action "open").');
    const t = await this.openTab(undefined);
    this.current.set(sessionId, t.id);
    return t;
  }

  /** Fresh page model for a tab; keeps the previous one for diffs and stable refs. */
  async observe(id: string, opts: { settle?: boolean } = {}): Promise<Model> {
    const t = this.get(id);
    const page = await this.page(id);
    if (opts.settle !== false) await page.waitForSettle({ maxMs: this.getConfig().limits.settleMaxMs });
    const model = await observePage(page, t.model);
    t.prevModel = t.model;
    t.model = model;
    t.url = model.url;
    t.title = model.title;
    return model;
  }

  async shutdown(): Promise<void> {
    for (const t of this.tabs.values()) await t.page?.close().catch(() => {});
    await this.chromium?.close().catch(() => {});
  }
}
