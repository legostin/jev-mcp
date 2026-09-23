import { describe, it, expect } from 'vitest';
import { createJevClient } from '../../src/core/jev/client.ts';
import { loadConfig } from '../../src/core/config/store.ts';

const live = process.env.JEV_LIVE === '1';

describe.skipIf(!live)('JEV live', () => {
  it('answers a choice and a noul', async () => {
    const cfg = loadConfig();
    const client = createJevClient(() => cfg);
    const res = await client.evaluate({
      state: { goal: 'Log in to the site', page: { elements: { e1: 'link "Pricing"', e2: 'button "Sign in"', e3: 'textbox "Search"' } } },
      questions: {
        next: { type: 'choice', instructions: 'Which element in `page.elements` should be clicked next to accomplish `goal`?', criteria: { e1: null, e2: null, e3: null, none: 'No listed element helps' } },
        pricing: { type: 'noul', instructions: 'Is `page.elements.e1` a link to pricing information?' },
      },
    });
    expect(res.model).toMatch(/jev/);
    expect(res.answers.next).toMatchObject({ type: 'choice', choice: 'e2' });
    expect(res.answers.pricing.type).toBe('noul');
    expect(res.usage.inputTokens).toBeGreaterThan(0);
  });
});
