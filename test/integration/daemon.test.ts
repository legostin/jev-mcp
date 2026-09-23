import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

const home = mkdtempSync(join(tmpdir(), 'jevd-'));
process.env.JEV_HOME = home;
process.env.JEV_HEADLESS = '1';
process.env.JEV_FAKE = '1';

const { startDaemon } = await import('../../src/daemon/main.ts');
const { connectDaemon } = await import('../../src/daemon/client.ts');
const { acquireLock } = await import('../../src/daemon/lifecycle.ts');
const { socketPath, lockFile } = await import('../../src/core/util/paths.ts');

let fixtures: FixtureServer;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let client: Awaited<ReturnType<typeof connectDaemon>>;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  daemon = await startDaemon({ logToStderr: true });
  client = await connectDaemon();
  await client.call('session.hello', { client: 'test' });
}, 60_000);

afterAll(async () => {
  client?.close();
  await daemon?.close();
  await fixtures?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('daemon', () => {
  it('listens on an owner-only socket', () => {
    expect(statSync(socketPath()).mode & 0o777).toBe(0o600);
  });

  it('opens a tab and observes it', async () => {
    const opened = await client.call('tabs.open', { url: fixtures.url('counter.html') });
    expect(opened.tab).toMatch(/^t\d+$/);
    expect(opened.overview).toContain('Increment');
    const obs = await client.call('page.observe', { view: 'full' });
    expect(obs.text).toMatch(/e\d+ button "Increment"/);
    const tabs = await client.call('tabs.list');
    expect(tabs.tabs.find((t: any) => t.id === opened.tab)?.current).toBe(true);
  });

  it('acts by ref and reports the diff', async () => {
    const obs = await client.call('page.observe', { view: 'full' });
    const ref = obs.text.match(/(e\d+) button "Increment"/)[1];
    const res = await client.call('page.act', { action: 'click', ref });
    expect(res.ok).toBe(true);
    const typed = await client.call('page.act', { action: 'type', intent: 'the name input', value: 'Ann' });
    expect(typed.ok).toBe(true);
    expect(typed.diff).toContain('value="Ann"');
  });

  it('reports occlusion instead of clicking through overlays', async () => {
    await client.call('tabs.open', { url: fixtures.url('modal.html') });
    const obs = await client.call('page.observe', { view: 'full' });
    const ref = obs.text.match(/(e\d+) button "Shop now"/)[1];
    const res = await client.call('page.act', { action: 'click', ref });
    expect(res).toMatchObject({ ok: false, reason: 'occluded' });
    expect(res.hint).toMatch(/overlay/);
  });

  it('updates settings and never returns raw keys', async () => {
    await client.call('settings.set', { path: 'providers.openrouter.apiKey', value: 'sk-or-v1-0123456789abcdef0123' });
    const got = await client.call('settings.get', { path: 'providers.openrouter' });
    expect(got.value.apiKey).toBe('sk-or-…0123');
    const bad = await client.call('settings.set', { path: 'confidence.preset', value: 'reckless' }).catch((e: Error) => e);
    expect(bad).toBeInstanceOf(Error);
    await client.call('settings.set', { path: 'confidence.preset', value: 'autonomous' });
    expect((await client.call('settings.get', { path: 'confidence.preset' })).value).toBe('autonomous');
  });

  it('refuses a second daemon while one is alive', () => {
    writeFileSync(lockFile(), String(process.ppid));
    expect(() => acquireLock()).toThrow(/already running/);
    writeFileSync(lockFile(), String(process.pid));
  });
});
