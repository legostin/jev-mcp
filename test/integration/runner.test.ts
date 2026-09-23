import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHarness, type Harness } from './harness.ts';
import { observePage } from '../../src/core/perception/model.ts';
import { Task, type TabPort, type Model } from '../../src/core/runner/task.ts';
import { taskSpecSchema } from '../../src/core/runner/types.ts';
import { TraceStore } from '../../src/core/trace/store.ts';
import { parseConfig } from '../../src/core/config/store.ts';
import { createScriptedClient } from '../../src/core/jev/fake.ts';
import type { PageSession } from '../../src/core/cdp/page.ts';
import type { Answer, EvaluateRequest, JevClient } from '../../src/core/jev/types.ts';

let h: Harness;
let dir: string;
let trace: TraceStore;
beforeAll(async () => { h = await startHarness(); dir = mkdtempSync(join(tmpdir(), 'jevr-')); trace = TraceStore.open(join(dir, 'db.sqlite'), join(dir, 'blobs')); });
afterAll(async () => { trace.close(); await h.close(); rmSync(dir, { recursive: true, force: true }); });

function port(page: PageSession): TabPort {
  let model: Model | undefined;
  return {
    tabId: 't1',
    page: async () => page,
    observe: async (o) => { if (o?.settle !== false) await page.waitForSettle(); model = await observePage(page, model); return model; },
    lastModel: () => model,
    release: () => {},
  };
}

interface Script {
  pageKind: (req: EvaluateRequest) => string;
  /** [intent target pattern, element description pattern, confidence] */
  targets: Array<[RegExp, RegExp, number?]>;
  /** [intent target pattern, [element pattern, probability][]]: a spread answer (checked before `targets`). */
  ranks?: Array<[RegExp, Array<[RegExp, number]>]>;
  goalReached?: (req: EvaluateRequest) => number;
  actionClass?: string;
  /** Fixed answers for noul questions by id (e.g. `same`). */
  nouls?: Record<string, number>;
}

/** Scripted JEV: answers by question id with deterministic rules; records every request. */
function scripted(s: Script): JevClient & { requests: EvaluateRequest[] } {
  return createScriptedClient((req) => {
    const state = req.state as any;
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (id === 'page_kind') {
        const kind = s.pageKind(req);
        out[id] = { type: 'choice', choice: kind, probabilities: { [kind]: 0.97, other: 0.03 }, confidence: 0.95 };
      } else if (id === 'pick' && q.type === 'choice') {
        const target = String(state.intent?.target ?? JSON.stringify(state.params ?? {}));
        const pool = { ...(state.page?.elements ?? {}), ...(state.candidates ?? {}), ...(state.options ?? {}) } as Record<string, string>;
        const keys = Object.keys(q.criteria).filter((k) => k !== 'none');
        const rank = s.ranks?.find(([t]) => t.test(target));
        if (rank) {
          const probs: Record<string, number> = {};
          let used = 0;
          for (const k of keys) {
            const m = rank[1].find(([re]) => re.test((pool[k] ?? '').split('\n')[0]));
            if (m) { probs[k] = m[1]; used += m[1]; }
          }
          if (!used) {
            out[id] = { type: 'choice', choice: 'none', probabilities: { none: 0.9, ...Object.fromEntries(keys.map((k) => [k, 0.1 / keys.length])) }, confidence: 0.9 };
            continue;
          }
          const rest = keys.filter((k) => !(k in probs));
          const share = (1 - used) / (rest.length + 1);
          for (const k of rest) probs[k] = share;
          probs.none = share;
          const [best, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
          out[id] = { type: 'choice', choice: best, probabilities: probs, confidence: p };
          continue;
        }
        const rule = s.targets.find(([t]) => t.test(target));
        const hit = rule ? keys.find((k) => rule[2] !== undefined || true ? rule[1].test(pool[k] ?? '') : false) : undefined;
        const conf = rule?.[2] ?? 0.95;
        if (hit) {
          const others = keys.filter((k) => k !== hit);
          const rest = (1 - conf) / Math.max(1, others.length + 1);
          out[id] = { type: 'choice', choice: hit, probabilities: { [hit]: conf, ...Object.fromEntries(others.map((k) => [k, rest])), none: rest }, confidence: conf };
        } else {
          out[id] = { type: 'choice', choice: 'none', probabilities: { none: 0.9, ...Object.fromEntries(keys.map((k) => [k, 0.1 / keys.length])) }, confidence: 0.9 };
        }
      } else if (id === 'action_class') {
        const c = s.actionClass ?? 'search_submit';
        out[id] = { type: 'choice', choice: c, probabilities: { [c]: 1 }, confidence: 1 };
      } else if (q.type === 'choice') {
        const k = Object.keys(q.criteria)[0];
        out[id] = { type: 'choice', choice: k, probabilities: { [k]: 1 }, confidence: 1 };
      } else if (q.type === 'noul') {
        let v = 0.05;
        if (id === 'exists' || id.startsWith('fit_') || id === 'effect' || id === 'same') v = 0.95;
        if (id === 'goal_reached') v = s.goalReached?.(req) ?? 0.05;
        if (s.nouls?.[id] !== undefined) v = s.nouls[id];
        out[id] = { type: 'noul', noul: v };
      }
    }
    return out;
  });
}

function makeTask(spec: unknown, page: PageSession, jev: JevClient) {
  return new Task(taskSpecSchema.parse(spec), {
    sessionId: 's1', getConfig: () => parseConfig({ trace: { screenshots: false } }), jev, trace, port: port(page),
  });
}

describe('Task runner (scripted JEV, real browser)', () => {
  it('fills a login form with a secret password that JEV never sees', async () => {
    const page = await h.open('login.html');
    const jev = scripted({
      pageKind: () => 'login',
      targets: [[/email/i, /Email address/], [/password/i, /Password/], [/submit/i, /Sign in/]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Welcome back') ? 0.95 : 0.05),
    });
    const task = makeTask({
      goal: 'Sign in to the site', params: { email: { value: 'ann@example.com', about: 'account email' }, password: { value: 'Hunter2-secret', about: 'account password', secret: true } },
    }, page, jev);
    const questions: any[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    expect(await page.evaluate('document.getElementById("password").value')).toBe('Hunter2-secret');
    expect(await page.evaluate('document.getElementById("msg").textContent')).toBe('Welcome back');
    expect(JSON.stringify(jev.requests)).not.toContain('Hunter2-secret');
    const stored = JSON.stringify([trace.getTask(task.id), trace.getSteps(task.id), trace.getJevCalls({ taskId: task.id })]);
    expect(stored).not.toContain('Hunter2-secret');
    for (const f of readdirSync(join(dir, 'blobs')).flatMap((d) => readdirSync(join(dir, 'blobs', d)).map((x) => join(dir, 'blobs', d, x)))) {
      expect(readFileSync(f).toString('latin1')).not.toContain('Hunter2-secret');
    }
  });

  it('escalates an uncertain grounding with candidates and resumes on pick', async () => {
    const page = await h.open('login.html');
    const jev = scripted({
      pageKind: () => 'login',
      targets: [[/email/i, /Email address/, 0.3], [/password/i, /Password/], [/submit/i, /Sign in/]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Welcome back') ? 0.95 : 0.05),
    });
    const task = makeTask({
      goal: 'Sign in', params: { email: { value: 'bob@example.com', about: 'account email' }, password: { value: 'pw12345', secret: true } },
      policy: { confidence: { trial: { enabled: false } } },
    }, page, jev);
    const questions: any[] = [];
    task.on('escalation', (q) => {
      questions.push(q);
      const pick = q.decision?.candidates?.find((c: any) => /Email address/.test(c.desc));
      setTimeout(() => task.answer(q.question_id, pick ? { type: 'pick', ref: pick.ref } : { type: 'abort' }), 10);
    });
    await task.start();
    expect(questions[0]).toMatchObject({ kind: 'ground' });
    expect(questions[0].decision.candidates.length).toBeGreaterThan(0);
    expect(task.state).toBe('done');
    expect(await page.evaluate('document.getElementById("email").value')).toBe('bob@example.com');
  });

  it('tries a low-confidence leader for a reversible step instead of asking', async () => {
    const page = await h.open('login.html');
    const jev = scripted({
      pageKind: () => 'login',
      targets: [[/email/i, /Email address/, 0.3], [/password/i, /Password/], [/submit/i, /Sign in/]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Welcome back') ? 0.95 : 0.05),
    });
    const task = makeTask({ goal: 'Sign in', params: { email: { value: 'bob@example.com', about: 'account email' }, password: { value: 'pw12345', secret: true } } }, page, jev);
    const questions: any[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    expect(await page.evaluate('document.getElementById("email").value')).toBe('bob@example.com');
  });

  it('rolls back a failed trial and tries the next candidate', async () => {
    const page = await h.open('filters.html');
    const jev = scripted({
      pageKind: () => 'search_form',
      targets: [],
      // The city opener leads for the brand, the Toyota chip is second: the city list lacks Toyota, so the trial fails.
      ranks: [[/car brand/i, [[/"Город"/, 0.35], [/"Toyota"/, 0.3]]]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Выбрано: Toyota') ? 0.95 : 0.05),
    });
    const task = makeTask({ goal: 'Show Toyota cars', params: { brand: { value: 'Toyota', about: 'car brand' } } }, page, jev);
    const questions: any[] = [];
    const steps: string[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    task.on('step', (st) => steps.push(st.note));
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    expect(steps.some((n) => /Город.*rolled back/.test(n))).toBe(true);
    expect(await page.evaluate('document.querySelector(".popup") === null')).toBe(true);
    expect(await page.evaluate('[...document.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent).join()')).toBe('Toyota');
  });

  it('counts a filter link that navigates to the value as setting it', async () => {
    const page = await h.open('filters.html');
    const jev = scripted({
      pageKind: () => 'search_form',
      targets: [],
      ranks: [[/car model/i, [[/link "Toyota Camry"/, 0.9]]]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Выбрано: Toyota, Camry') ? 0.95 : 0.05),
      // JEV does not take "Toyota Camry" for the value itself: the navigation has to show it.
      nouls: { same: 0.1 },
    });
    const task = makeTask({ goal: 'Show Toyota Camry cars', params: { model: { value: 'Camry', about: 'car model' } } }, page, jev);
    const questions: any[] = [];
    const steps: string[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    task.on('step', (st) => steps.push(st.note));
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    expect(steps.some((n) => /followed .*Toyota Camry.*now shows "Camry"/.test(n))).toBe(true);
    expect(await page.evaluate('location.search')).toContain('model=Camry');
  });

  it('presses a value button whose label is the value in another language', async () => {
    const page = await h.open('filters.html');
    const jev = scripted({
      pageKind: () => 'search_form',
      targets: [],
      ranks: [[/city/i, [[/button "Павлодар"/, 0.9]]]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Выбрано: Павлодар') ? 0.95 : 0.05),
    });
    const task = makeTask({ goal: 'Show cars in Pavlodar', params: { city: { value: 'Pavlodar', about: 'city where the car is sold' } } }, page, jev);
    const questions: any[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    expect(jev.requests.some((r) => 'same' in r.questions)).toBe(true);
    expect(await page.evaluate('[...document.querySelectorAll("button[aria-pressed=true]")].map((b) => b.textContent).join()')).toBe('Павлодар');
  });

  it('searches first when a filter exists only next to the results', async () => {
    const page = await h.open('filters.html');
    const jev = scripted({
      pageKind: (req) => (JSON.stringify(req.state).includes('Результаты поиска') ? 'results_list' : 'search_form'),
      targets: [[/submit/i, /Показать/]],
      ranks: [[/car brand/i, [[/button "Toyota"/, 0.9]]], [/condition/i, [[/button "Новые"/, 0.9]]]],
      goalReached: (req) => (JSON.stringify(req.state).includes('Состояние: Новые') ? 0.95 : 0.05),
    });
    const task = makeTask({
      goal: 'Show new Toyota cars', params: { brand: { value: 'Toyota', about: 'car brand' }, condition: { value: 'Новые', about: 'item condition' } },
    }, page, jev);
    const questions: any[] = [];
    const steps: string[] = [];
    task.on('escalation', (q) => { questions.push(q); task.answer(q.question_id, { type: 'abort' }); });
    task.on('step', (st) => steps.push(`${st.subintent}: ${st.note}`));
    await task.start();
    expect(questions).toEqual([]);
    expect(task.state).toBe('done');
    const order = steps.map((x) => x.split(':')[0]);
    expect(order.indexOf('submit')).toBeGreaterThan(-1);
    expect(order.indexOf('submit')).toBeLessThan(order.lastIndexOf('fill_param(condition)'));
    expect(order).not.toContain('reveal(condition)');
    expect(await page.evaluate('location.search')).toContain('condition=new');
  });

  it('asks for confirmation before an irreversible click even when JEV calls it harmless', async () => {
    const page = await h.open('checkout.html?price=41230');
    const jev = scripted({
      pageKind: () => 'search_form',
      targets: [[/first name|given/i, /Имя/], [/last name|family/i, /Фамилия/], [/submit/i, /Оплатить/]],
      actionClass: 'navigation',
    });
    const task = makeTask({ goal: 'Fill in the passenger and continue', params: { first: { value: 'ANNA', about: 'first name' }, last: { value: 'LEE', about: 'last name' } } }, page, jev);
    const questions: any[] = [];
    task.on('escalation', (q) => { questions.push(q); setTimeout(() => task.answer(q.question_id, { type: 'abort' }), 10); });
    await task.start();
    expect(questions[0]).toMatchObject({ kind: 'risk_confirm' });
    expect(questions[0].summary).toMatch(/Оплатить/);
    expect(task.state).toBe('cancelled');
    expect(await page.evaluate('document.getElementById("done").textContent')).toBe('');
  });
});
