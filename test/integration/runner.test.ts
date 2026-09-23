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
  goalReached?: (req: EvaluateRequest) => number;
  actionClass?: string;
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
        const rule = s.targets.find(([t]) => t.test(target));
        const keys = Object.keys(q.criteria).filter((k) => k !== 'none');
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
    const task = makeTask({ goal: 'Sign in', params: { email: { value: 'bob@example.com', about: 'account email' }, password: { value: 'pw12345', secret: true } } }, page, jev);
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
