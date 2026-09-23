import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromiumDriver } from '../../src/core/cdp/chromium.ts';
import { PageSession } from '../../src/core/cdp/page.ts';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

export interface Harness {
  driver: ChromiumDriver;
  fixtures: FixtureServer;
  open(path: string, opts?: { cross?: boolean }): Promise<PageSession>;
  close(): Promise<void>;
}

/** Headless Chrome with its own temp profile plus the fixture server. */
export async function startHarness(): Promise<Harness> {
  const profile = mkdtempSync(join(tmpdir(), 'jevh-'));
  const driver = await ChromiumDriver.launch({ headless: true, profileDir: profile });
  const fixtures = await startFixtureServer();
  const pages: PageSession[] = [];
  return {
    driver,
    fixtures,
    async open(path, opts = {}) {
      const tab = await driver.openTab('about:blank');
      const page = await PageSession.open(driver, tab.id);
      pages.push(page);
      await page.navigate(opts.cross ? fixtures.crossUrl(path) : fixtures.url(path));
      await page.waitForSettle({ maxMs: 5000 });
      return page;
    },
    async close() {
      for (const p of pages) await p.close().catch(() => {});
      await driver.close({ force: true });
      await fixtures.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

export async function nodeId(page: PageSession, selector: string, sessionId = page.sessionId): Promise<number> {
  const { root } = await page.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 }, sessionId);
  const { nodeId } = await page.send<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId);
  if (!nodeId) throw new Error(`selector not found: ${selector}`);
  const { node } = await page.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId }, sessionId);
  return node.backendNodeId;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
