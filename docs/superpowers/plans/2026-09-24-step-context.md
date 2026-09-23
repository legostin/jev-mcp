# Step Context, Pass Fusion and Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JEV gets questions about the current step with its value, grounding passes are fused instead of overwritten, and reversible steps act on low-confidence leaders with verification and rollback instead of asking the agent.

**Architecture:** A new `step.ts` module builds step cards, value-aware intents and scoped hints. `groundByIntent` fuses pass 1 and pass 2 (pure `fuse()`), returns `decision: 'try'` with a ranked list when the step allows trials, and uses compact candidate cards with the visual row. The runner executes trials, verifies the effect per step type, rolls back via a pure `rollbackPlan()`, excludes rejected element signatures and escalates after `trial.tries` failures.

**Tech Stack:** Node 24 (native TS type stripping, erasable syntax only: no enums, no parameter properties), vitest, zod 4, node:sqlite.

## Global Constraints

- Code, comments and UI strings in English.
- Secrets never reach JEV: step cards mask secret values as `[secret]`; secret params never use trials.
- Irreversible actions keep the safety gate; `submit` never uses trials.
- Presets: cautious trial off; balanced `{ enabled: true, floor: 0.25, tries: 2 }`; autonomous `{ enabled: true, floor: 0.15, tries: 3 }`.
- Every layer (global, domain, task, live) can override `confidence.trial`.

---

### Task 1: Step cards, value-aware intents, scoped hints

**Files:**
- Create: `src/core/questions/step.ts`
- Modify: `src/core/questions/state.ts` (StateParts.step), `src/core/questions/templates/ground.ts` (Intent fields only)
- Test: `test/core/step.test.ts`

**Interfaces:**
- Produces:
  - `interface StepCard { kind: string; do: string; param?: { key: string; about: string; value: Json } }`
  - `interface Hint { text: string; source: 'task' | 'answer' | 'site'; step?: string; key?: string; about?: string }`
  - `aboutOf(key: string, p: ParamSpec): string`
  - `paramCard(kind: string, key: string, p: ParamSpec, doText?: string): StepCard`
  - `stepCard(kind: string, doText: string): StepCard`
  - `paramIntent(key: string, p: ParamSpec): Intent`
  - `hintsFor(hints: Hint[], card?: StepCard): string[]`
  - `Intent.trial?: boolean`, `Intent.exclude?: string[]` (element signatures)
  - `StateParts.step?: StepCard` rendered as `state.step = { do, about?, value? }`

- [ ] **Step 1: Write failing tests** (`test/core/step.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { paramCard, paramIntent, hintsFor, type Hint } from '../../src/core/questions/step.ts';
import { buildState } from '../../src/core/questions/state.ts';

describe('step cards and intents', () => {
  it('puts the value into the fill_param target', () => {
    const i = paramIntent('model', { value: 'Camry', about: 'car model' });
    expect(i.target).toContain('car model to "Camry"');
    expect(i.trial).toBe(true);
  });
  it('never exposes secrets and never trials them', () => {
    const i = paramIntent('pw', { value: 'hunter2', about: 'password', secret: true });
    expect(i.target).not.toContain('hunter2');
    expect(i.trial).toBe(false);
    const s = buildState({ step: paramCard('fill_param', 'pw', { value: 'hunter2', about: 'password', secret: true }) }, 2000);
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect((s as any).step.value).toBe('[secret]');
  });
  it('booleans target the checkbox', () => {
    expect(paramIntent('used', { value: true, about: 'used cars only' }).kinds).toEqual(['checkbox', 'radio', 'button', 'clickable']);
  });
});

describe('hint scoping', () => {
  const hints: Hint[] = [
    { text: 'Prefer direct flights', source: 'task' },
    { text: 'Body type sits in advanced search', source: 'answer', step: 'fill_param', key: 'body', about: 'car body type' },
    { text: 'None of these is the body type field. The body type filter (Кузов) is inside advanced search.', source: 'site' },
    { text: 'Departure is the left field', source: 'site', key: 'from', about: 'departure city' },
  ];
  it('keeps task hints and hints about the same param only', () => {
    const model = paramCard('fill_param', 'model', { value: 'Camry', about: 'car model' });
    expect(hintsFor(hints, model)).toEqual(['Prefer direct flights']);
    const body = paramCard('fill_param', 'body_type', { value: 'кроссовер', about: 'body type' });
    expect(hintsFor(hints, body)).toEqual(hints.slice(0, 3).map((h) => h.text));
    const to = paramCard('fill_param', 'to', { value: 'Анталия', about: 'destination city' });
    expect(hintsFor(hints, to)).toEqual(['Prefer direct flights']);
  });
  it('page-level questions get every hint', () => {
    expect(hintsFor(hints)).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/core/step.test.ts` — expected FAIL (module missing).

- [ ] **Step 3: Implement `src/core/questions/step.ts`**

```ts
import type { Json } from '../jev/types.ts';
import type { Intent } from './templates/ground.ts';
import { SECRET_PLACEHOLDER, type ParamSpec, type ParamValue } from './state.ts';
import { tokens } from './lexical.ts';

/** What the current step does, as JEV sees it. Questions about one step get this instead of every param. */
export interface StepCard { kind: string; do: string; param?: { key: string; about: string; value: Json } }

/** A hint with the place it applies to: task hints go everywhere, others only to steps about the same thing. */
export interface Hint { text: string; source: 'task' | 'answer' | 'site'; step?: string; key?: string; about?: string }

export const aboutOf = (key: string, p: ParamSpec): string => p.about ?? key.replace(/[_-]+/g, ' ');

export function valueText(v: ParamValue): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return `${v.from}..${v.to}`;
  return String(v);
}

export function paramCard(kind: string, key: string, p: ParamSpec, doText?: string): StepCard {
  const about = aboutOf(key, p);
  const value: Json = p.secret ? SECRET_PLACEHOLDER : (p.value as Json);
  const text = doText ?? (p.secret ? `enter the ${about}`
    : typeof p.value === 'boolean' ? `${p.value ? 'turn on' : 'turn off'} "${about}"`
    : `set the ${about} to "${valueText(p.value)}"`);
  return { kind, do: text, param: { key, about, value } };
}

export const stepCard = (kind: string, doText: string): StepCard => ({ kind, do: doText });

/** Grounding intent for filling a param: the value is part of the question (a button showing it counts). */
export function paramIntent(key: string, p: ParamSpec): Intent {
  const about = aboutOf(key, p);
  if (typeof p.value === 'boolean') return { target: `the checkbox or switch for "${about}"`, action: 'check', kinds: ['checkbox', 'radio', 'button', 'clickable'], trial: true };
  if (p.secret) return { target: `the input field for the ${about}`, action: 'type', kinds: ['textbox', 'combobox'], trial: false };
  return {
    target: `the control that sets the ${about} to "${valueText(p.value)}": an option or button showing this value, or the field where it is typed or chosen`,
    kinds: ['textbox', 'combobox', 'select', 'clickable', 'button'], trial: true,
  };
}

// Distinctive words only: short words ("car", "to") are shared by unrelated params.
const words = (s: string): string[] => tokens(s).filter((t) => t.length >= 4);
const near = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

function containment(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  return small.filter((x) => big.some((y) => near(x, y))).length / small.length;
}

/** Hints for a step's questions. Without a card (page-level questions) every hint applies. */
export function hintsFor(hints: Hint[], card?: StepCard): string[] {
  if (!card) return hints.map((h) => h.text);
  const cardWords = words(`${card.param?.key ?? ''} ${card.param?.about ?? ''}`);
  const valueWords = words(`${card.param?.key ?? ''} ${card.param?.about ?? ''} ${typeof card.param?.value === 'string' ? card.param.value : ''}`);
  return hints.filter((h) => {
    if (h.source === 'task') return true;
    if (h.key && card.param && h.key === card.param.key) return true;
    if (h.about) return !!card.param && containment(words(h.about), cardWords) >= 0.67;
    if (h.step) return h.step === card.kind && !card.param;
    return containment(words(h.text), valueWords) > 0 && words(h.text).some((w) => valueWords.some((v) => near(w, v)));
  }).map((h) => h.text);
}
```

In `state.ts`: add `step?: StepCard` to `StateParts` (import type from `./step.ts`) and in `build()` after goal:

```ts
if (p.step) {
  const st: Record<string, Json> = { do: p.step.do };
  if (p.step.param) { st.about = p.step.param.about; st.value = p.step.param.value; }
  s.step = st;
}
```

In `ground.ts` `Intent`: add `trial?: boolean` (reversible step: act on a leader below `act` and verify) and `exclude?: string[]` (signatures of elements already tried and rolled back).

- [ ] **Step 4: Run** `npx vitest run test/core/step.test.ts` — expected PASS. Fix the hint expectations if the containment rule needs tuning, keeping the three scenarios.

- [ ] **Step 5: Commit** `feat(questions): step cards, value-aware param intents, scoped hints`

---

### Task 2: Trial settings in the confidence layers

**Files:**
- Modify: `src/core/config/schema.ts`, `src/core/config/thresholds.ts`
- Test: `test/core/config.test.ts`

**Interfaces:**
- Produces: `interface TrialSettings { enabled: boolean; floor: number; tries: number }`; `Thresholds` = `Record<DecisionKind, KindThresholds> & { trial: TrialSettings }`; `confidenceSchema.trial`.

- [ ] **Step 1: Failing test** (append to `test/core/config.test.ts`)

```ts
it('trial settings come from presets and layers', () => {
  expect(resolveThresholds({}).trial).toEqual({ enabled: true, floor: 0.25, tries: 2 });
  expect(resolveThresholds({ task: { preset: 'cautious' } }).trial.enabled).toBe(false);
  expect(resolveThresholds({ domain: { trial: { floor: 0.1 } }, live: { trial: { tries: 4 } } }).trial).toEqual({ enabled: true, floor: 0.1, tries: 4 });
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Schema: `trial: z.object({ enabled: z.boolean().optional(), floor: unit.optional(), tries: z.number().int().min(1).max(5).optional() }).optional()` inside `confidenceSchema`. Thresholds: `uniform(choice, noul, trial)` sets `out.trial = { ...trial }`; presets per Global Constraints (cautious floor 0.5, tries 1, enabled false); `applyLayer` merges `layer.trial` fields when defined.
- [ ] **Step 4: Run** config tests — PASS; run `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(config): trial settings in every confidence layer`

---

### Task 3: Candidate cards with the visual row

**Files:**
- Modify: `src/core/perception/render.ts`, `src/core/perception/elements.ts` (aria-pressed → selected)
- Test: `test/core/perception-unit.test.ts`

**Interfaces:**
- Produces: `renderCandidate(model: PageModel, ref: string): string`; `rowOf(model: PageModel, ref: string, max?: number): string[]`.

- [ ] **Step 1: Failing test**

```ts
it('candidate cards show the visual row and drop layout noise', () => {
  const mk = (ref: string, name: string, x: number) => ({ ref, sig: ref, kind: 'button', role: 'button', tag: 'button', name, nameSource: 'content', states: {}, interactive: true, visible: true, inViewport: true, occluded: false, rect: { x, y: 100, w: 80, h: 40 }, regionId: 'r1', backendNodeId: 1, attrs: { class: 'filter-button' }, order: x } as any);
  const els = [mk('e1', 'Модель', 0), mk('e2', 'Camry', 100), mk('e3', 'RAV4', 200), { ...mk('e4', 'Цена', 0), rect: { x: 0, y: 300, w: 80, h: 40 } }];
  const model: any = { url: 'http://x/', title: 't', elements: new Map(els.map((e) => [e.ref, e])), regions: [{ id: 'r0', kind: 'page', label: '', refs: [] }, { id: 'r1', kind: 'form', label: 'Поиск', parentId: 'r0', refs: els.map((e) => e.ref) }] };
  const card = renderCandidate(model, 'e2');
  expect(card).toContain('row: Модель | [Camry] | RAV4');
  expect(card).not.toContain('rect:');
  expect(card).not.toContain('class=');
  expect(card).not.toContain('Цена');
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** in `render.ts`:

```ts
/** Visible elements of the same region whose vertical centre falls inside the element's height, left to right. */
export function rowOf(model: PageModel, ref: string, max = 10): string[] {
  const e = model.elements.get(ref);
  const region = e && model.regions.find((r) => r.id === e.regionId);
  if (!e || !region) return [];
  const cy = e.rect.y + e.rect.h / 2;
  const row = region.refs.map((r) => model.elements.get(r)).filter((x): x is ElementNode => !!x && x.visible && !!(x.name || x.text)
    && Math.abs(x.rect.y + x.rect.h / 2 - cy) <= Math.max(e.rect.h / 2, 8))
    .sort((a, b) => a.rect.x - b.rect.x);
  const i = row.findIndex((x) => x.ref === ref);
  const start = Math.max(0, Math.min(i - Math.floor(max / 2), row.length - max));
  return row.slice(start, start + max).map((x) => (x.ref === ref ? `[${q(x.name || x.text || '', 40)}]` : q(x.name || x.text || '', 40)).replace(/^"|"$/g, '').replace(/^\["(.*)"\]$/, '[$1]'));
}

/** A candidate as JEV sees it on a second look: the element, where it sits, and the row it belongs to. */
export function renderCandidate(model: PageModel, ref: string): string {
  const e = model.elements.get(ref);
  if (!e) return `Unknown element ${ref}`;
  const chain: string[] = [];
  for (let r = model.regions.find((x) => x.id === e.regionId); r && r.kind !== 'page'; r = model.regions.find((x) => x.id === r!.parentId)) {
    chain.push(`${r.id} ${r.kind}${r.label ? ` ${q(r.label, 40)}` : ''}`);
  }
  const lines = [`${e.ref} ${describeElement(e, { pageUrl: model.url })}`];
  if (chain.length) lines.push(`in: ${chain.join(' < ')}`);
  if (e.text && e.text !== e.name) lines.push(`text: ${q(e.text, 160)}`);
  if (e.options?.length) lines.push(`options: ${e.options.slice(0, 20).map((o) => `${o.selected ? '*' : ''}${q(o.label, 30)}`).join(', ')}`);
  const row = rowOf(model, ref);
  if (row.length > 1) lines.push(`row: ${row.join(' | ')}`);
  return lines.join('\n');
}
```

In `elements.ts` `states()`: `if (bool(p.selected) || bool(p.pressed) || a['aria-selected'] === 'true' || a['aria-pressed'] === 'true') st.selected = true;`

- [ ] **Step 4: Run** perception unit tests — PASS.
- [ ] **Step 5: Commit** `feat(perception): compact candidate cards with the visual row; aria-pressed counts as selected`

---

### Task 4: Pass fusion and the `try` decision

**Files:**
- Create: `src/core/decide/fuse.ts`
- Modify: `src/core/questions/templates/ground.ts`
- Test: `test/core/questions.test.ts`

**Interfaces:**
- Consumes: `StepCard` (Task 1), `Thresholds.trial` (Task 2), `renderCandidate` (Task 3).
- Produces: `fuse(p1, p2, keys): Record<string, number>`; `GroundContext.step?: StepCard`; `GroundResult.decision: 'act' | 'try' | 'escalate' | 'none'`; `GroundResult.ranked: GroundCandidate[]`.

- [ ] **Step 1: Failing tests** (replace the two rerank tests, add trial tests)

```ts
it('fuses both looks instead of letting the second overwrite the first', async () => {
  const jev = createScriptedClient((req, n) => (n === 1
    ? { pick: choice({ e1: 0.55, e2: 0.05, none: 0.4 }, 0.53), exists: noulAnswer(0.6) }
    : { pick: choice({ e1: 0.24, e2: 0.49, none: 0.27 }, 0.23) }) as Record<string, Answer>);
  const res = await groundByIntent({ jev }, model([el('e1', 'Павлодар', 'button'), el('e2', 'Где искать', 'button')]), { target: 'city', trial: true }, th, gctx);
  expect(res.ranked[0].ref).toBe('e1');
  expect(res.decision).toBe('try');
});
it('acts when both looks agree above the escalate bar', async () => {
  const jev = createScriptedClient((req, n) => (n === 1
    ? { pick: choice({ e1: 0.6, e2: 0.35, none: 0.05 }, 0.6), exists: noulAnswer(0.9) }
    : { pick: choice({ e1: 0.7, e2: 0.3, none: 0 }, 0.7) }) as Record<string, Answer>);
  const res = await groundByIntent({ jev }, model([el('e1', 'City'), el('e2', 'City')]), { target: 'departure city' }, th, gctx);
  expect(res).toMatchObject({ ref: 'e1', decision: 'act', stage: 'rerank' });
  expect(jev.requests[1].state).toHaveProperty('candidates.e1');
});
it('escalates a near tie when the step does not allow trials', async () => {
  const jev = createScriptedClient((req, n) => (n === 1
    ? { pick: choice({ e1: 0.55, e2: 0.45, none: 0 }, 0.6), exists: noulAnswer(0.9) }
    : { pick: choice({ e1: 0.4, e2: 0.6, none: 0 }, 0.6) }) as Record<string, Answer>);
  const res = await groundByIntent({ jev }, model([el('e1', 'City'), el('e2', 'City')]), { target: 'departure city' }, th, gctx);
  expect(res.decision).toBe('escalate');
});
it('skips excluded signatures and puts the step card into the state', async () => {
  const jev = createScriptedClient(() => ({ pick: choice({ e2: 0.95, none: 0.05 }, 0.93), exists: noulAnswer(0.97) }));
  const res = await groundByIntent({ jev }, model([el('e1', 'A'), el('e2', 'B')]), { target: 'x', exclude: ['e1'] }, th,
    { ...gctx, step: { kind: 'fill_param', do: 'set the model to "Camry"', param: { key: 'model', about: 'model', value: 'Camry' } } });
  expect(Object.keys((jev.requests[0].questions.pick as any).criteria)).toEqual(['e2', 'none']);
  expect((jev.requests[0].state as any).step).toEqual({ do: 'set the model to "Camry"', about: 'model', value: 'Camry' });
  expect(res.ref).toBe('e2');
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** `fuse.ts`:

```ts
/** Averages two looks over the same options after renormalising each to them: a second look adds evidence, it does not overwrite. */
export function fuse(p1: Record<string, number>, p2: Record<string, number>, keys: string[]): Record<string, number> {
  const norm = (p: Record<string, number>) => {
    const s = keys.reduce((a, k) => a + (p[k] ?? 0), 0);
    return Object.fromEntries(keys.map((k) => [k, s > 0 ? (p[k] ?? 0) / s : 1 / keys.length]));
  };
  const a = norm(p1);
  const b = norm(p2);
  return Object.fromEntries(keys.map((k) => [k, (a[k] + b[k]) / 2]));
}
```

In `ground.ts`:
- `GroundContext` gains `step?: StepCard`; all `buildState` calls pass `step: gctx.step`.
- `candidateElements` skips `intent.exclude?.includes(e.sig)`.
- `GroundResult` gains `ranked` and the `'try'` decision; every return sets `ranked` (pass-1 candidates when no rerank).
- Single-candidate branch: `renderCandidate` instead of `renderElement`; if the verdict would escalate but `intent.trial && th.trial.enabled && pick.probabilities[only] >= th.trial.floor && verdict !== 'no'` → `'try'`.
- Multi-candidate rerank: only the `pick` choice (no `fit_*` nouls), `renderCandidate` details, then:

```ts
const keys = [...top.map((c) => c.ref), 'none'];
const fused = fuse(pick.probabilities, rrPick.probabilities, keys);
const ranked = top.map((c) => ({ ...c, p: fused[c.ref] })).sort((a, b) => b.p - a.p);
const lead = ranked[0];
const second = Math.max(ranked[1]?.p ?? 0, fused.none);
const result = { ...base, confidence: lead.p, candidates: ranked, ranked, stage: 'rerank' as const, callIds, costUsd: cost };
if (fused.none >= lead.p) return { ...result, ref: null, decision: gateNoul(exists, th.ground.noul) === 'no' ? 'none' : 'escalate' };
const agree = pick.choice === lead.ref && rrPick.choice === lead.ref;
const marginOk = th.ground.choice.margin === null || lead.p - second >= th.ground.choice.margin;
if (marginOk && (lead.p >= th.ground.choice.act || (agree && lead.p >= th.ground.choice.escalate))) return { ...result, ref: lead.ref, decision: 'act' };
if (intent.trial && th.trial.enabled && lead.p >= th.trial.floor) return { ...result, ref: lead.ref, decision: 'try' };
return { ...result, ref: lead.ref, decision: 'escalate' };
```

- [ ] **Step 4: Run** `npx vitest run test/core` and `npx tsc --noEmit -p .` — PASS. (`find.ts` and `api.ts` treat `'try'` like `'act'` for ranking; they only read `candidates`/`ref`.)
- [ ] **Step 5: Commit** `feat(ground): fuse passes, try decision for reversible steps, step card in state`

---

### Task 5: Rollback plan

**Files:**
- Create: `src/core/runner/rollback.ts`
- Test: `test/core/rollback.test.ts`

**Interfaces:**
- Produces: `type RollbackAction = 'back' | 'escape' | 'restore' | 'reclick'`; `rollbackPlan(before: PageModel, now: PageModel, el: ElementNode): RollbackAction[]`; `hadEffect(before: PageModel, now: PageModel, el: ElementNode): boolean`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { rollbackPlan, hadEffect } from '../../src/core/runner/rollback.ts';
const el = (states = {}, value?: string, kind = 'button') => ({ ref: 'e1', sig: 's1', kind, states, value, rect: { x: 0, y: 0, w: 10, h: 10 } } as any);
const page = (url: string, els: any[], layers: string[] = []) => ({ url, elements: new Map(els.map((e) => [e.ref, e])), regions: layers.map((s, i) => ({ id: `r${i + 1}`, sig: s, kind: 'popup', refs: [] })), signature: `${url}|${JSON.stringify(els.map((e) => [e.states, e.value]))}|${layers.join()}` } as any);

describe('rollback', () => {
  it('goes back after a navigation', () => {
    expect(rollbackPlan(page('http://a/1', [el()]), page('http://a/2', [el()]), el())).toEqual(['back']);
  });
  it('closes a new layer, restores a value, re-clicks a toggle', () => {
    expect(rollbackPlan(page('u', [el()]), page('u', [el()], ['p1']), el())).toEqual(['escape']);
    expect(rollbackPlan(page('u', [el({}, '', 'textbox')]), page('u', [el({}, 'Camry', 'textbox')]), el({}, '', 'textbox'))).toEqual(['restore']);
    expect(rollbackPlan(page('u', [el({ selected: false })]), page('u', [el({ selected: true })]), el({ selected: false }))).toEqual(['reclick']);
  });
  it('detects an effect', () => {
    expect(hadEffect(page('u', [el()]), page('u', [el()]), el())).toBe(false);
    expect(hadEffect(page('u', [el()]), page('u', [el({ selected: true })]), el())).toBe(true);
  });
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

```ts
import type { ElementNode, PageModel } from '../perception/types.ts';

export type RollbackAction = 'back' | 'escape' | 'restore' | 'reclick';

const LAYERS = new Set(['popup', 'overlay', 'dialog']);
const layerSigs = (m: PageModel) => new Set(m.regions.filter((r) => LAYERS.has(r.kind)).map((r) => r.sig));
const toggled = (a: ElementNode, b: ElementNode) => !!a.states.checked !== !!b.states.checked || !!a.states.selected !== !!b.states.selected;

/** Undo steps for a trial that did not work, most disruptive first; recompute after each (Escape may undo a toggle). */
export function rollbackPlan(before: PageModel, now: PageModel, el: ElementNode): RollbackAction[] {
  if (now.url !== before.url) return ['back'];
  const plan: RollbackAction[] = [];
  const had = layerSigs(before);
  if ([...layerSigs(now)].some((s) => !had.has(s))) plan.push('escape');
  const cur = now.elements.get(el.ref);
  if (cur && (el.kind === 'textbox' || el.kind === 'combobox') && (cur.value ?? '') !== (el.value ?? '')) plan.push('restore');
  else if (cur && toggled(el, cur)) plan.push('reclick');
  return plan;
}

/** Did the action change anything visible: URL, the element's state, or the page structure? */
export function hadEffect(before: PageModel, now: PageModel, el: ElementNode): boolean {
  if (now.url !== before.url || now.signature !== before.signature) return true;
  const cur = now.elements.get(el.ref);
  return !!cur && (toggled(el, cur) || (cur.value ?? '') !== (el.value ?? '') || !!cur.states.expanded !== !!el.states.expanded);
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(runner): rollback plan and effect check for trials`

---

### Task 6: Runner — scoped hints, step cards, trials, memory

**Files:**
- Modify: `src/core/runner/task.ts`, `src/core/memory/store.ts`, `src/core/jev/heuristic.ts`, `src/daemon/api.ts` (memory hint listing if typed)
- Test: `test/integration/runner.test.ts`, `test/core/trace.test.ts` (memory hints)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `MemoryStore.addHint(domain, text, bind?: { step?: string; key?: string; about?: string })`, `MemoryStore.hints(domain): Hint[]`.

- [ ] **Step 1: Failing runner tests**
  - Existing "escalates an uncertain grounding" test: add `policy: { confidence: { trial: { enabled: false } } }` so it still covers escalation.
  - New: "tries a low-confidence leader and continues without asking" (login fixture, email target at 0.3 → fused leader e(email) ≥ 0.25 → typed, no questions).
  - New: "rolls back a failed trial and tries the next candidate" on the new `filters.html` fixture: scripted JEV ranks the brand opener "Марка" first (0.35) and "Toyota" second (0.3) for `brand = Toyota`; the "Марка" popup in the fixture lacks Toyota? No — use a fixture popup where the option list does not contain the value, so the trial fails and the runner presses Escape and picks "Toyota". Assert: no questions, brand chip `aria-pressed="true"`, a step note contains `rolled back`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**
  - `hints: Hint[]`; spec/update hints → `source: 'task'`; site hints from `memory.hints(host)`; answers to `ground` escalations bind to `lastSub` (`step`, `key`, `about`), other answers → `task`; domain-scoped answers stored with the binding.
  - `card(sub)`: fill_param/pick_suggestion/pick_date/reveal → `paramCard`; reveal text `find where the {about} can be set`; apply_sort `sort the results {order}`; submit `submit the search form`; dismiss_overlay `close the {kind} overlay`.
  - `ground()`: passes `{ goal, step: card, hints: hintsFor(this.hints, card), budgetTokens }`; `intent.exclude = rejected sigs`; when rejected ≥ `th.trial.tries` → `intent.trial = false`; memory hit on a trial step → return `{ el, trial: true }` without JEV; otherwise memory confirm with the step card, accepted unless the noul says no; `'try'` → `{ el: ranked[0], trial: true }`; escalation summary lists tried elements.
  - `trialFailed(sub, el, before, why)`: executes `rollbackPlan` (recomputed after each action, max 3), records the signature in `rejected`, labels the grounding calls false, resets `sortTried`/`revealTried` for that step, sets `trialRolledBack` so the loop guard does not count the attempt, returns `retry`.
  - Executors: fill_param (boolean state check; select without a matching option; chip without effect; trigger without options or without a matching option; text that the field does not hold) → `trialFailed` when `g.trial`; pick_date opener without calendar; reveal without ≥ 2 new controls or URL change; apply_sort without effect; dismiss_overlay still visible; calendar nav without month change. Reset `rejected` for a step on success.
  - `step()`: when `trialRolledBack` is set after execute, undo the loop-guard increment for this key.
  - `heuristic.ts`: focus text includes `JSON.stringify(s.step ?? {})`.
  - `MemoryStore`: `site_hints` gains `step`, `key`, `about` columns (added with `ALTER TABLE` when missing).
- [ ] **Step 4: Run** `npx vitest run` — PASS; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(runner): step cards and scoped hints in questions; trials with verification and rollback`

---

### Task 7: Fixture, evals, live checks, docs

**Files:**
- Create: `fixtures/sites/filters.html`
- Modify: `evals/run.ts`, `evals/cases/grounding.json`, `test/live/task.live.test.ts`, `README.md`, `skills/jev-browser/SKILL.md`, `src/mcp/main.ts` (INSTRUCTIONS: trials), `docs/index.html` only if it lists features.

- [ ] **Step 1:** `filters.html` — a car-marketplace-like search: rows of `button.filter-button` (`Где искать | Алматы | Астана | Павлодар | ещё`; `Марка | Toyota | Hyundai | Kia | ещё`; `Модель | Camry | RAV4 | Corolla | ещё` shown after a brand is pressed), openers show a popup list with a search box; pressed chips get `aria-pressed="true"`; price inputs `от/до`; submit `Показать N объявлений` renders an in-page result list (price, year, link) with a sort control `Сортировать по: дате объявления` (menu: `цене, сначала дешевые`).
- [ ] **Step 2:** evals: cases may carry `param: { key, about, value }` instead of `target`; the intent comes from `paramIntent`. Add filters cases (city/brand/model chips, model before brand = opener, price textbox), flights textbox cases with values. Run `JEV_LIVE=1 node evals/run.ts`; accuracy must not drop below the previous report and new cases pass. Compare the long target wording with the short one (`the control that sets the {about} to "{value}"`) and keep the better.
- [ ] **Step 3:** live e2e on `filters.html`: Camry in Павлодар, `select: min(price)`, zero questions.
- [ ] **Step 4:** docs: README and SKILL.md describe trials (`confidence.trial`), scoped hints and what the agent sees in a ground question after tries.
- [ ] **Step 5: Commit** `test(evals): step cases on a filter fixture; docs for trials`

---

### Task 8: Real-site validation

- [ ] Well-known international services: a marketplace (filters, sort by price), code search (sort by stars), a store with filter links.
- [ ] Keep test fixtures and docs free of references to specific third-party services.
- [ ] Record questions, steps, time, cost; fix what breaks; push.
