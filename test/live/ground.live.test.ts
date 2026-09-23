import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, sleep, type Harness } from '../integration/harness.ts';
import { observePage } from '../../src/core/perception/model.ts';
import { groundByIntent } from '../../src/core/questions/templates/ground.ts';
import { createJevClient } from '../../src/core/jev/client.ts';
import { loadConfig } from '../../src/core/config/store.ts';
import { PRESETS } from '../../src/core/config/thresholds.ts';
import type { PageModel } from '../../src/core/perception/types.ts';

const live = process.env.JEV_LIVE === '1';
let h: Harness;
let model: PageModel;
const cfg = loadConfig();
const jev = createJevClient(() => cfg);

describe.skipIf(!live)('grounding with live JEV on the flights fixture', () => {
  beforeAll(async () => {
    h = await startHarness();
    const page = await h.open('flights.html');
    await sleep(500);
    model = await observePage(page);
  }, 60_000);
  afterAll(async () => { await h?.close(); });

  const cases: Array<[string, string, Parameters<typeof groundByIntent>[2]['kinds']?]> = [
    ['the input for the departure city', 'Откуда', ['textbox', 'combobox']],
    ['the input for the destination city', 'Куда', ['textbox', 'combobox']],
    ['the control that opens the departure date picker', 'Когда Дата'],
    ['the button that starts the flight search', 'Найти билеты'],
    ['the button that accepts all cookies', 'Принять все'],
  ];
  for (const [target, expected, kinds] of cases) {
    it(`finds ${target}`, async () => {
      const res = await groundByIntent({ jev }, model, { target, kinds }, PRESETS.balanced, {
        goal: 'Find the cheapest flight from Almaty to Antalya in October', budgetTokens: 6000,
      });
      const el = res.ref ? model.elements.get(res.ref)! : null;
      console.log(`${target}: ${res.decision} ${res.ref} "${el?.name}" conf=${res.confidence.toFixed(2)} exists=${res.exists.toFixed(2)} stage=${res.stage}`);
      expect(el?.name).toBe(expected);
      expect(res.decision).toBe('act');
    });
  }

  it('says the target is absent when it is', async () => {
    const res = await groundByIntent({ jev }, model, { target: 'the input for a promo code' }, PRESETS.balanced, { budgetTokens: 6000 });
    console.log(`promo code: ${res.decision} ${res.ref} exists=${res.exists.toFixed(2)}`);
    expect(res.decision === 'none' || res.exists < 0.5).toBe(true);
  });
});
