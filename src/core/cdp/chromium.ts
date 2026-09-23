import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WsCdpConnection } from './ws-connection.ts';
import type { BrowserDriver, TabInfo } from './driver.ts';
import { logger } from '../util/log.ts';

const log = logger('chromium');

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
];
const LINUX_CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const list = process.platform === 'darwin' ? MAC_CANDIDATES : LINUX_CANDIDATES;
  return list.find((p) => existsSync(p)) ?? null;
}

export interface ChromiumOptions {
  headless: boolean;
  executable?: string | null;
  profileDir: string;
  extraArgs?: string[];
}

function readActivePort(profileDir: string): { port: number; path: string } | null {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
  if (!port || !path) return null;
  return { port: Number(port), path };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chrome launched (or re-attached) by jev with its own profile, driven over the browser CDP endpoint. */
export class ChromiumDriver implements BrowserDriver {
  readonly kind = 'chromium' as const;
  private conn: WsCdpConnection;
  private proc: ChildProcess | null;
  private headless: boolean;
  private disconnectListeners = new Set<() => void>();
  private sessions = new Map<string, string>(); // targetId -> sessionId

  private constructor(conn: WsCdpConnection, proc: ChildProcess | null, headless: boolean) {
    this.conn = conn;
    this.proc = proc;
    this.headless = headless;
    conn.onClose(() => { for (const l of [...this.disconnectListeners]) l(); });
    conn.on((method, params) => {
      if (method === 'Target.detachedFromTarget') {
        for (const [t, s] of this.sessions) if (s === params.sessionId) this.sessions.delete(t);
      }
    });
  }

  /** Reuses a jev Chrome that is still running with this profile, otherwise launches one. */
  static async launch(opts: ChromiumOptions): Promise<ChromiumDriver> {
    mkdirSync(opts.profileDir, { recursive: true });
    const existing = readActivePort(opts.profileDir);
    if (existing) {
      try {
        const conn = await WsCdpConnection.connect(`ws://127.0.0.1:${existing.port}${existing.path}`, 1500);
        log.info(`re-attached to running Chrome on port ${existing.port}`);
        return new ChromiumDriver(conn, null, opts.headless);
      } catch {
        rmSync(join(opts.profileDir, 'DevToolsActivePort'), { force: true });
      }
    }
    const exe = opts.executable || findChrome();
    if (!exe) throw new Error('Chrome was not found. Install Google Chrome or set driver.chromium.executable.');
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${opts.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      ...(opts.headless ? ['--headless', '--window-size=1366,900'] : ['--window-size=1366,900']),
      ...(opts.extraArgs ?? []),
      'about:blank',
    ];
    const proc = spawn(exe, args, { stdio: 'ignore', detached: !opts.headless });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    if (!opts.headless) proc.unref();
    const started = Date.now();
    while (Date.now() - started < 20_000) {
      const ap = readActivePort(opts.profileDir);
      if (ap) {
        const conn = await WsCdpConnection.connect(`ws://127.0.0.1:${ap.port}${ap.path}`);
        log.info(`launched Chrome (${opts.headless ? 'headless' : 'headful'}) on port ${ap.port}`);
        return new ChromiumDriver(conn, proc, opts.headless);
      }
      if (exited) throw new Error('Chrome exited during startup. Is another Chrome using the jev profile directory?');
      await sleep(100);
    }
    proc.kill();
    throw new Error('Timed out waiting for Chrome to expose its DevTools endpoint');
  }

  get connected(): boolean { return !this.conn.closed; }

  async listTabs(): Promise<TabInfo[]> {
    const { targetInfos } = await this.conn.send<{ targetInfos: any[] }>('Target.getTargets');
    return targetInfos
      .filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'))
      .map((t) => ({ id: t.targetId, url: t.url, title: t.title, driver: 'chromium' as const }));
  }

  async openTab(url = 'about:blank'): Promise<TabInfo> {
    const { targetId } = await this.conn.send<{ targetId: string }>('Target.createTarget', { url });
    return { id: targetId, url, title: '', driver: 'chromium' };
  }

  async closeTab(tabId: string): Promise<void> {
    this.sessions.delete(tabId);
    await this.conn.send('Target.closeTarget', { targetId: tabId });
  }

  async activateTab(tabId: string): Promise<void> {
    await this.conn.send('Target.activateTarget', { targetId: tabId });
  }

  async attach(tabId: string): Promise<{ conn: WsCdpConnection; sessionId: string }> {
    const known = this.sessions.get(tabId);
    if (known) return { conn: this.conn, sessionId: known };
    const { sessionId } = await this.conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId: tabId, flatten: true });
    this.sessions.set(tabId, sessionId);
    return { conn: this.conn, sessionId };
  }

  async detach(tabId: string): Promise<void> {
    const sessionId = this.sessions.get(tabId);
    if (!sessionId) return;
    this.sessions.delete(tabId);
    await this.conn.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Headless browsers are closed; a headful window is left for the user and re-attached next time. */
  async close(opts: { force?: boolean } = {}): Promise<void> {
    if (this.headless || opts.force) {
      const proc = this.proc;
      const exited = proc && proc.exitCode === null
        ? new Promise<void>((r) => proc.once('exit', () => r()))
        : Promise.resolve();
      await this.conn.send('Browser.close').catch(() => {});
      await Promise.race([exited, sleep(5000)]);
      if (proc && proc.exitCode === null) proc.kill('SIGKILL');
    }
    await this.conn.close();
  }
}
