import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, sleep, type Harness } from '../integration/harness.ts';
import { observePage } from '../../src/core/perception/model.ts';
import { extractResults } from '../../src/core/extract/extract.ts';
import { createJevClient } from '../../src/core/jev/client.ts';
import { loadConfig } from '../../src/core/config/store.ts';
import { PRESETS } from '../../src/core/config/thresholds.ts';
import { flightsFor } from '../../fixtures/sites/server.ts';

const live = process.env.JEV_LIVE === '1';
let h: Harness;
const cfg = loadConfig();
const jev = createJevClient(() => cfg);

describe.skipIf(!live)('extraction with live JEV', () => {
  beforeAll(async () => { h = await startHarness(); }, 60_000);
  afterAll(async () => { await h?.close(); });

  it('maps schema fields and selects the cheapest ticket on the page', async () => {
    const page = await h.open('results.html?from=ALA&to=AYT&date=2026-10-14');
    await sleep(400);
    const model = await observePage(page);
    const out = await extractResults({ jev }, model, {
      schema: { price: 'money', airline: 'string', depart: 'time', duration: 'duration', url: 'url' }, select: 'min(price)',
    }, PRESETS.balanced, { goal: 'Find the cheapest flight from Almaty to Antalya in October', budgetTokens: 6000, refDate: { year: 2026, month: 9 } });
    expect(out).not.toBeNull();
    console.log(JSON.stringify({ mapping: out!.mapping, conf: out!.mappingConfidence, warnings: out!.warnings, selected: out!.selected }, null, 1));
    const expected = flightsFor('ALA', 'AYT', '2026-10-14').slice(0, 10);
    expect(out!.items).toHaveLength(10);
    const minPrice = Math.min(...expected.map((f) => f.price));
    expect((out!.selected!.price as { amount: number }).amount).toBe(minPrice);
    expect(out!.items.map((i) => (i.price as { amount: number }).amount)).toEqual(expected.map((f) => f.price));
    expect(out!.items.map((i) => i.airline)).toEqual(expected.map((f) => f.airline));
    expect(out!.items.map((i) => i.duration)).toEqual(expected.map((f) => f.durationMin));
    expect(String(out!.selected!.url)).toContain('checkout.html');
  });
});
