import { describe, it, expect } from 'vitest';
import { buildState, publicParams } from '../../src/core/questions/state.ts';
import { gateChoice, gateNoul, margin } from '../../src/core/decide/gating.ts';
import { groundByIntent } from '../../src/core/questions/templates/ground.ts';
import { createScriptedClient, noulAnswer } from '../../src/core/jev/fake.ts';
import { resolveThresholds, PRESETS } from '../../src/core/config/thresholds.ts';
import { estimateTokens } from '../../src/core/util/tokens.ts';
import type { ElementNode, PageModel } from '../../src/core/perception/types.ts';
import type { Answer, ChoiceAnswer } from '../../src/core/jev/types.ts';

function el(ref: string, name: string, kind: ElementNode['kind'] = 'textbox', regionId = 'r1'): ElementNode {
  return {
    ref, sig: ref, kind, role: '', tag: 'input', name, nameSource: 'label', states: {}, interactive: true, visible: true,
    inViewport: true, occluded: false, rect: { x: 0, y: 0, w: 10, h: 10 }, regionId, backendNodeId: 1, attrs: {}, order: Number(ref.slice(1)),
  };
}
function model(els: ElementNode[], regions = ['r1']): PageModel {
  return {
    url: 'http://x/', title: 't', lang: 'en', viewport: { w: 1000, h: 800 }, scroll: { y: 0, maxY: 0 },
    elements: new Map(els.map((e) => [e.ref, e])),
    regions: [{ id: 'r0', sig: 'page', kind: 'page', label: '', refs: [], rect: { x: 0, y: 0, w: 1, h: 1 }, blocking: false },
      ...regions.map((id) => ({ id, sig: id, kind: 'form' as const, label: id, parentId: 'r0', refs: els.filter((e) => e.regionId === id).map((e) => e.ref), rect: { x: 0, y: 0, w: 1, h: 1 }, blocking: false }))],
    signature: 's', capturedAt: 0, captureMs: 0,
  };
}
const choice = (probabilities: Record<string, number>, confidence: number): ChoiceAnswer => {
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { type: 'choice', choice: top, probabilities, confidence };
};

describe('state builder', () => {
  it('masks secrets and trims page elements to the budget', () => {
    expect(publicParams({ pw: { value: 'hunter2', secret: true, about: 'password' } })).toEqual({ pw: { about: 'password', value: '[secret]' } });
    const elements = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`e${i}`, `button "Button number ${i} with a long label"`]));
    const state = buildState({ goal: 'g', params: { pw: { value: 'hunter2', secret: true } }, page: { url: 'u', elements } }, 1500);
    expect(JSON.stringify(state)).not.toContain('hunter2');
    expect(estimateTokens(state)).toBeLessThanOrEqual(1500);
    expect(Object.keys((state as any).page.elements)[0]).toBe('e0');
  });
});

describe('gating', () => {
  const th = PRESETS.balanced.ground.choice;
  it('acts at the threshold, escalates below escalate, otherwise uncertain', () => {
    expect(gateChoice(choice({ a: 0.9, b: 0.1 }, 0.85), th)).toBe('act');
    expect(gateChoice(choice({ a: 0.6, b: 0.4 }, 0.54), th)).toBe('escalate');
    expect(gateChoice(choice({ a: 0.7, b: 0.3 }, 0.7), th)).toBe('uncertain');
  });
  it('escalate:0 never escalates on confidence; margin can block acting', () => {
    const t = resolveThresholds({ task: { escalate: 0 } }).ground.choice;
    expect(gateChoice(choice({ a: 0.5, b: 0.5 }, 0.01), t)).toBe('uncertain');
    const m = resolveThresholds({ task: { preset: 'cautious' } }).ground.choice;
    expect(gateChoice(choice({ a: 0.6, b: 0.4 }, 0.95), m)).toBe('uncertain');
    expect(margin(choice({ a: 0.6, b: 0.4 }, 0.9))).toBeCloseTo(0.2);
  });
  it('noul bands', () => {
    const n = PRESETS.balanced.ground.noul;
    expect(gateNoul(0.8, n)).toBe('yes');
    expect(gateNoul(0.2, n)).toBe('no');
    expect(gateNoul(0.5, n)).toBe('unsure');
  });
});

describe('groundByIntent', () => {
  const th = PRESETS.balanced;
  const gctx = { budgetTokens: 6000 };

  it('acts directly on a confident pick', async () => {
    const jev = createScriptedClient(() => ({ pick: choice({ e1: 0.95, e2: 0.05, none: 0 }, 0.93), exists: noulAnswer(0.97) }));
    const res = await groundByIntent({ jev }, model([el('e1', 'From'), el('e2', 'To')]), { target: 'departure city input' }, th, gctx);
    expect(res).toMatchObject({ ref: 'e1', decision: 'act', stage: 'direct' });
    expect(jev.requests).toHaveLength(1);
    const q = jev.requests[0].questions.pick as any;
    expect(Object.keys(q.criteria)).toEqual(['e1', 'e2', 'none']);
  });

  it('reports absence when the exists noul is low', async () => {
    const jev = createScriptedClient(() => ({ pick: choice({ e1: 0.5, e2: 0.5, none: 0 }, 0.2), exists: noulAnswer(0.05) }));
    const res = await groundByIntent({ jev }, model([el('e1', 'From'), el('e2', 'To')]), { target: 'coupon code' }, th, gctx);
    expect(res).toMatchObject({ ref: null, decision: 'none' });
  });

  it('reranks mid-confidence picks and acts when both looks agree', async () => {
    const jev = createScriptedClient((req, n) => (n === 1
      ? { pick: choice({ e1: 0.6, e2: 0.35, none: 0.05 }, 0.6), exists: noulAnswer(0.9) }
      : { pick: choice({ e1: 0.7, e2: 0.3, none: 0 }, 0.7) }) as Record<string, Answer>);
    const res = await groundByIntent({ jev }, model([el('e1', 'City'), el('e2', 'City')]), { target: 'departure city' }, th, gctx);
    expect(res).toMatchObject({ ref: 'e1', decision: 'act', stage: 'rerank' });
    expect(jev.requests[1].state).toHaveProperty('candidates.e1');
    expect(Object.keys(jev.requests[1].questions)).toEqual(['pick']);
  });

  it('escalates a near tie when the step does not allow trials', async () => {
    const jev = createScriptedClient((req, n) => (n === 1
      ? { pick: choice({ e1: 0.55, e2: 0.45, none: 0 }, 0.6), exists: noulAnswer(0.9) }
      : { pick: choice({ e1: 0.4, e2: 0.6, none: 0 }, 0.6) }) as Record<string, Answer>);
    const res = await groundByIntent({ jev }, model([el('e1', 'City'), el('e2', 'City')]), { target: 'departure city' }, th, gctx);
    expect(res.decision).toBe('escalate');
    expect(res.ranked.map((c) => c.ref)).toEqual(['e2', 'e1']);
  });

  it('fuses both looks instead of letting the second overwrite the first', async () => {
    const jev = createScriptedClient((req, n) => (n === 1
      ? { pick: choice({ e1: 0.55, e2: 0.05, none: 0.4 }, 0.53), exists: noulAnswer(0.6) }
      : { pick: choice({ e1: 0.24, e2: 0.49, none: 0.27 }, 0.23) }) as Record<string, Answer>);
    const res = await groundByIntent({ jev }, model([el('e1', 'Павлодар', 'button'), el('e2', 'Где искать', 'button')]), { target: 'city', trial: true }, th, gctx);
    expect(res.ranked[0].ref).toBe('e1');
    expect(res).toMatchObject({ ref: 'e1', decision: 'try' });
  });

  it('does not try below the floor or when trials are off', async () => {
    const answers = (req: unknown, n: number) => (n === 1
      ? { pick: choice({ e1: 0.2, e2: 0.2, e3: 0.2, none: 0.4 }, 0.2), exists: noulAnswer(0.6) }
      : { pick: choice({ e1: 0.3, e2: 0.25, e3: 0.25, none: 0.2 }, 0.1) }) as Record<string, Answer>;
    const els = [el('e1', 'A', 'button'), el('e2', 'B', 'button'), el('e3', 'C', 'button')];
    const low = await groundByIntent({ jev: createScriptedClient(answers) }, model(els), { target: 'x', trial: true }, resolveThresholds({ task: { trial: { floor: 0.4 } } }), gctx);
    expect(low.decision).toBe('escalate');
    const off = await groundByIntent({ jev: createScriptedClient(answers) }, model(els), { target: 'x', trial: true }, resolveThresholds({ task: { preset: 'cautious' } }), gctx);
    expect(off.decision).toBe('escalate');
  });

  it('skips excluded signatures and puts the step card into the state', async () => {
    const jev = createScriptedClient(() => ({ pick: choice({ e2: 0.95, none: 0.05 }, 0.93), exists: noulAnswer(0.97) }));
    const res = await groundByIntent({ jev }, model([el('e1', 'A'), el('e2', 'B')]), { target: 'x', exclude: ['e1'] }, th,
      { ...gctx, step: { kind: 'fill_param', do: 'set the model to "Camry"', param: { key: 'model', about: 'model', value: 'Camry' } } });
    expect(Object.keys((jev.requests[0].questions.pick as any).criteria)).toEqual(['e2', 'none']);
    expect((jev.requests[0].state as any).step).toEqual({ do: 'set the model to "Camry"', about: 'model', value: 'Camry' });
    expect(res.ref).toBe('e2');
  });

  it('narrows large pages by region first', async () => {
    const els = [
      ...Array.from({ length: 50 }, (_, i) => el(`e${i + 1}`, `Link ${i}`, 'link', 'r1')),
      ...Array.from({ length: 30 }, (_, i) => el(`e${i + 51}`, `Field ${i}`, 'textbox', 'r2')),
    ];
    const jev = createScriptedClient((req, n) => {
      if (n === 1) return { region: choice({ r1: 0.02, r2: 0.97, none: 0.01 }, 0.95) } as Record<string, Answer>;
      const refs = Object.keys((req.questions.pick as any).criteria);
      expect(refs.every((r) => r === 'none' || Number(r.slice(1)) > 50)).toBe(true);
      return { pick: choice({ e60: 0.97, none: 0.03 }, 0.95), exists: noulAnswer(0.95) } as Record<string, Answer>;
    });
    const res = await groundByIntent({ jev }, model(els, ['r1', 'r2']), { target: 'field 9' }, th, gctx);
    expect(res).toMatchObject({ ref: 'e60', stage: 'region', decision: 'act' });
  });
});

describe('value labels in grounding', () => {
  it('acts without a second look when the uncertain leader shows exactly the value', async () => {
    const jev = createScriptedClient(() => ({ pick: choice({ e1: 0.7, e2: 0.2, none: 0.1 }, 0.7), exists: noulAnswer(0.9), fallback: choice({ e2: 0.9, none: 0.1 }, 0.9), fallback_exists: noulAnswer(0.9) }));
    const res = await groundByIntent({ jev }, model([el('e1', 'Toyota (1 234)', 'button'), el('e2', 'Марка', 'button')]),
      { target: 'the control that sets the brand to "Toyota"', value: 'Toyota', fallback: 'brand field' }, PRESETS.balanced, { budgetTokens: 6000 });
    expect(res).toMatchObject({ ref: 'e1', decision: 'act', stage: 'direct' });
    expect(jev.requests).toHaveLength(1);
  });
});

describe('param candidates', () => {
  it('admit links only when they show the value', async () => {
    const { candidateElements } = await import('../../src/core/questions/templates/ground.ts');
    const els = [el('e1', 'Toyota Camry', 'link'), el('e2', 'Новости', 'link'), el('e3', 'Модель', 'button')];
    const refs = candidateElements(model(els), { target: 'x', kinds: ['button'], value: 'Camry', valueKinds: ['link'] }).map((e) => e.ref);
    expect(refs).toEqual(['e1', 'e3']);
  });
});
