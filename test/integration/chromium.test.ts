import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromiumDriver } from '../../src/core/cdp/chromium.ts';

const profile = mkdtempSync(join(tmpdir(), 'jevchrome-'));
let driver: ChromiumDriver | null = null;

afterAll(async () => {
  await driver?.close({ force: true });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('ChromiumDriver', () => {
  it('launches headless Chrome, opens and attaches to a tab', async () => {
    driver = await ChromiumDriver.launch({ headless: true, profileDir: profile });
    const tab = await driver.openTab('data:text/html,<title>hello-jev</title><p>x</p>');
    const { conn, sessionId } = await driver.attach(tab.id);
    await new Promise((r) => setTimeout(r, 300));
    const res = await conn.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sessionId);
    expect(res.result.value).toBe('hello-jev');
    const tabs = await driver.listTabs();
    expect(tabs.some((t) => t.id === tab.id)).toBe(true);
    await driver.closeTab(tab.id);
    expect((await driver.listTabs()).some((t) => t.id === tab.id)).toBe(false);
  });

  it('re-attaches to a running browser with the same profile', async () => {
    const second = await ChromiumDriver.launch({ headless: true, profileDir: profile });
    expect(second.connected).toBe(true);
    await second.close({ force: false });
  });
});
