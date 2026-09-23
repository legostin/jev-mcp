// Runs the flights fixture task on live JEV in an isolated JEV_HOME, then captures debug UI screenshots.
// Usage: node scripts/demo-screenshots.ts [outDir]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/core/config/store.ts';

const out = resolve(process.argv[2] ?? 'docs/assets');
const real = loadConfig();
const home = mkdtempSync(join(tmpdir(), 'jevdemo-'));
process.env.JEV_HOME = home;
process.env.JEV_HEADLESS = '1';
process.env.JEV_HTTP_PORT = '0';
mkdirSync(join(home, 'config'), { recursive: true });
writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ provider: real.provider, providers: real.providers }));

const { startFixtureServer } = await import('../fixtures/sites/server.ts');
const { startDaemon } = await import('../src/daemon/main.ts');
const { registerStage2 } = await import('../src/daemon/extend.ts');
const { connectDaemon } = await import('../src/daemon/client.ts');
const { ChromiumDriver } = await import('../src/core/cdp/chromium.ts');
const { PageSession } = await import('../src/core/cdp/page.ts');

const fixtures = await startFixtureServer();
const daemon = await startDaemon({ logToStderr: true });
const stage = await registerStage2(daemon, { httpPort: 0 });
const client = await connectDaemon();
await client.call('session.hello', { client: 'demo' });
const created = await client.call('task.create', {
  goal: 'Find the cheapest flight ticket from Almaty to Antalya departing in October 2026',
  site: fixtures.url('flights.html'),
  params: {
    from: { value: 'Алматы', about: 'departure city' },
    to: { value: 'Анталия', about: 'destination city' },
    period: { value: { from: '2026-10-01', to: '2026-10-31' }, about: 'departure date' },
  },
  result: { schema: { price: 'money', airline: 'string', depart: 'time', url: 'url' }, select: 'min(price)' },
});
const done = await client.call('task.wait', { task_id: created.task_id, until: 'done', timeout_ms: 180_000 }, { timeoutMs: 200_000 });
console.log(JSON.stringify(done.event?.payload?.result ?? done, null, 1));
const tabs = await client.call('tabs.list');
const taskTab = tabs.tabs.find((t: any) => /results/.test(t.url))?.id ?? tabs.tabs[0]?.id;

const viewer = await ChromiumDriver.launch({ headless: true, profileDir: mkdtempSync(join(tmpdir(), 'jevview-')), extraArgs: ['--window-size=1440,1000', '--force-color-profile=srgb'] });
const tab = await viewer.openTab('about:blank');
const page = await PageSession.open(viewer, tab.id);
await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await page.navigate(stage.http.authUrl());
mkdirSync(out, { recursive: true });
const shots: Array<[string, string, number?]> = [
  ['ui-tasks.png', '#/'],
  ['ui-timeline.png', `#/task/${created.task_id}`, 1800],
  ['ui-inspector.png', `#/inspect/${taskTab}`],
  ['ui-calibration.png', '#/calibration'],
];
for (const [file, hash, height] of shots) {
  await page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await new Promise((r) => setTimeout(r, 1800));
  if (height) await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 2, mobile: false });
  writeFileSync(join(out, file), await page.screenshot());
  if (height) await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
  console.log(`saved ${file}`);
}
await viewer.close({ force: true });
client.close();
await daemon.close();
await fixtures.close();
rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
