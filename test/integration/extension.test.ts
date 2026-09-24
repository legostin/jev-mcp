import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

function findCft(): string | null {
  const base = join(homedir(), '.cache', 'jev-browser', 'cft', 'chrome');
  if (!existsSync(base)) return null;
  for (const v of readdirSync(base)) {
    const mac = join(base, v, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    const macx = join(base, v, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    const linux = join(base, v, 'chrome-linux64', 'chrome');
    for (const p of [mac, macx, linux]) if (existsSync(p)) return p;
  }
  return null;
}
const cft = findCft();
const extDir = resolve('dist/extension');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v as T; if (Date.now() > end) throw new Error('timeout'); await sleep(150); }
}

describe.skipIf(!cft || !existsSync(join(extDir, 'worker.js')))('Chrome extension driver', () => {
  const home = mkdtempSync(join(tmpdir(), 'jevx-'));
  let fixtures: FixtureServer;
  let daemon: any;
  let client: any;
  let chrome: any;
  let panel: { eval: (expr: string) => Promise<any> };

  beforeAll(async () => {
    process.env.JEV_HOME = home;
    process.env.JEV_FAKE = '1';
    process.env.JEV_HTTP_PORT = '0';
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ trace: { screenshots: false } }));
    const { startDaemon } = await import('../../src/daemon/main.ts');
    const { registerStage2 } = await import('../../src/daemon/extend.ts');
    const { connectDaemon } = await import('../../src/daemon/client.ts');
    const { ChromiumDriver } = await import('../../src/core/cdp/chromium.ts');
    fixtures = await startFixtureServer();
    daemon = await startDaemon({ logToStderr: true });
    const stage = await registerStage2(daemon, { httpPort: 0 });
    const port = stage.http.port;
    process.env.JEV_TEST_EXT_PORT = String(port);
    client = await connectDaemon();
    await client.call('session.hello', { client: 'ext-test' });
    chrome = await ChromiumDriver.launch({
      headless: true, executable: cft, profileDir: join(home, 'cft-profile'),
      extraArgs: [`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`],
    });
    // Drive the side panel page like a user would.
    const conn = (chrome as any).conn;
    const { targetId } = await conn.send('Target.createTarget', { url: 'chrome-extension://ggdonbkfnfociekejpgdbkagbelpoceb/sidepanel.html' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    panel = {
      eval: async (expression: string) => (await conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value,
    };
    await until(() => panel.eval('typeof chrome !== "undefined" && !!chrome.runtime?.id'));
    await panel.eval(`chrome.runtime.sendMessage({ type: 'setPort', port: ${port} })`);
    await until(async () => (await panel.eval(`new Promise(r => chrome.runtime.sendMessage({type:'getStatus'}, r))`))?.status === 'unpaired');
    const { code } = await client.call('ext.pairingCode');
    await panel.eval(`chrome.runtime.sendMessage({ type: 'pair', code: '${code}' })`);
    await until(async () => (await client.call('daemon.info')).extensionConnected);
  }, 180_000);

  afterAll(async () => {
    // Chrome first and each step on its own: a failed setup or a hanging daemon must not leave the browser running.
    await chrome?.close({ force: true }).catch(() => {});
    try { client?.close(); } catch { /* already closed */ }
    await daemon?.close().catch(() => {});
    await fixtures?.close().catch(() => {});
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('pairs with a one-time code', async () => {
    // The daemon may see the connection a moment before the extension updates its own status.
    const status = await until(async () => {
      const st = await panel.eval(`new Promise(r => chrome.runtime.sendMessage({type:'getStatus'}, r))`);
      return st?.status === 'connected' ? st : null;
    });
    expect(status.status).toBe('connected');
  });

  it('opens tabs and acts through chrome.debugger', async () => {
    const opened = await client.call('tabs.open', { url: fixtures.url('counter.html'), driver: 'extension' });
    expect(opened.driver).toBe('extension');
    const obs = await client.call('page.observe', { tab: opened.tab, view: 'full' });
    const ref = obs.text.match(/(e\d+) button "Increment"/)[1];
    const act = await client.call('page.act', { tab: opened.tab, action: 'click', ref });
    expect(act.ok).toBe(true);
    const typed = await client.call('page.act', { tab: opened.tab, action: 'type', intent: 'the name input', value: 'Kim' });
    expect(typed.diff).toContain('value="Kim"');
  });

  it('sees into cross-origin iframes via child sessions', async () => {
    const opened = await client.call('tabs.open', { url: fixtures.url('iframe-outer.html'), driver: 'extension' });
    const obs = await until(async () => {
      const o = await client.call('page.observe', { tab: opened.tab, view: 'full' });
      return /Cardholder name/.test(o.text) ? o : null;
    });
    expect(obs.text).toContain('Cardholder name');
  });

  it('pauses extension tasks while the extension is disconnected and resumes after', async () => {
    const opened = await client.call('tabs.open', { url: fixtures.url('login.html'), driver: 'extension' });
    const created = await client.call('task.create', { goal: 'Sign in', tab: opened.tab, params: { email: { value: 'a@b.co', about: 'account email' } }, policy: { confidence: { act: 1, escalate: 1 } } });
    await client.call('task.wait', { task_id: created.task_id, until: 'question', timeout_ms: 30_000 });
    await panel.eval(`chrome.runtime.sendMessage({ type: 'setPort', port: 1 })`);
    const paused = await until(async () => { const s = await client.call('task.status', { task_id: created.task_id }); return s.state === 'paused' ? s : null; });
    expect(paused.reason).toBe('extension disconnected');
    await panel.eval(`chrome.runtime.sendMessage({ type: 'setPort', port: ${process.env.JEV_TEST_EXT_PORT} })`);
    await until(async () => (await client.call('daemon.info')).extensionConnected);
    const resumed = await until(async () => { const s = await client.call('task.status', { task_id: created.task_id }); return s.state !== 'paused' ? s : null; });
    expect(['awaiting_input', 'running']).toContain(resumed.state);
    await client.call('task.control', { task_id: created.task_id, action: 'cancel' });
  });
});
