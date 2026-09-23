// Renders docs/og-card.html to PNG social cards (1280x640 for GitHub, 1200x630 for Open Graph).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChromiumDriver } from '../src/core/cdp/chromium.ts';
import { PageSession } from '../src/core/cdp/page.ts';

const driver = await ChromiumDriver.launch({ headless: true, profileDir: mkdtempSync(join(tmpdir(), 'jevog-')) });
try {
  const tab = await driver.openTab('about:blank');
  const page = await PageSession.open(driver, tab.id);
  for (const [w, h, file] of [[1280, 640, 'social-preview.png'], [1200, 630, 'og.png']] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await page.navigate(pathToFileURL(resolve('docs/og-card.html')).href);
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(resolve('docs/assets', file), await page.screenshot({ x: 0, y: 0, w, h }));
    console.log(`docs/assets/${file}`);
  }
} finally {
  await driver.close({ force: true });
}
