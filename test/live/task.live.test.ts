import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/core/config/store.ts';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

const live = process.env.JEV_LIVE === '1';
const realCfg = loadConfig();
const home = mkdtempSync(join(tmpdir(), 'jevlt-'));

describe.skipIf(!live)('JEV task end-to-end on the flights fixture', () => {
  let fixtures: FixtureServer;
  let daemon: any;
  let client: any;

  beforeAll(async () => {
    process.env.JEV_HOME = home;
    process.env.JEV_HEADLESS = '1';
    delete process.env.JEV_FAKE;
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ providers: realCfg.providers, provider: realCfg.provider, trace: { screenshots: false } }));
    const { startDaemon } = await import('../../src/daemon/main.ts');
    const { registerStage2 } = await import('../../src/daemon/extend.ts');
    const { connectDaemon } = await import('../../src/daemon/client.ts');
    fixtures = await startFixtureServer();
    daemon = await startDaemon({ logToStderr: true });
    await registerStage2(daemon);
    client = await connectDaemon();
    await client.call('session.hello', { client: 'live-test' });
  }, 60_000);

  afterAll(async () => {
    client?.close();
    await daemon?.close();
    await fixtures?.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function dumpTrace(taskId: string) {
    const trace = await client.call('task.trace', { task_id: taskId }).catch(() => null);
    for (const s of trace?.steps ?? []) {
      console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''} ${JSON.stringify(s.action ?? null)} ${s.url ?? ''}`);
      for (const c of s.calls ?? []) {
        if (/ground/.test(c.template)) console.log(`   ${c.template} ${JSON.stringify(c.answers?.pick ?? c.answers?.region ?? null).slice(0, 300)}`);
        if (c.template === 'assess') console.log(`   assess ${JSON.stringify(Object.fromEntries(Object.entries(c.answers ?? {}).map(([k, v]: [string, any]) => [k, v.noul ?? v.choice])))}`);
      }
    }
  }

  async function runToEnd(taskId: string, answer: (q: any) => any, maxQuestions = 4) {
    const questions: any[] = [];
    for (;;) {
      const r = await client.call('task.wait', { task_id: taskId, until: 'question', timeout_ms: 120_000 }, { timeoutMs: 130_000 });
      if (r.timeout) {
        await dumpTrace(taskId);
        throw new Error(`timeout; status ${JSON.stringify(r.status)}`);
      }
      if (r.event.type === 'done') return { result: r.event.payload, questions };
      const q = r.event.payload;
      questions.push(q);
      console.log('QUESTION', JSON.stringify({ kind: q.kind, summary: q.summary, candidates: q.decision?.candidates?.slice(0, 3) }));
      if (questions.length > maxQuestions) {
        await client.call('task.control', { task_id: taskId, action: 'cancel' });
        await dumpTrace(taskId);
        throw new Error('too many questions');
      }
      await client.call('task.answer', { question_id: q.question_id, answer: answer(q) });
    }
  }

  const spec = (url: string) => ({
    goal: 'Find the cheapest flight ticket from Almaty to Antalya departing in October 2026',
    site: url,
    params: {
      from: { value: 'Алматы', about: 'departure city' },
      to: { value: 'Анталия', about: 'destination city' },
      period: { value: { from: '2026-10-01', to: '2026-10-31' }, about: 'departure date' },
    },
    result: { schema: { price: 'money', airline: 'string', depart: 'time', url: 'url' }, select: 'min(price)', extract: 'code' },
  });
  const pickTop = (q: any) => (q.decision?.candidates?.[0] ? { type: 'pick', ref: q.decision.candidates[0].ref } : { type: 'continue' });
  const templates = async (taskId: string) => {
    const trace = await client.call('task.trace', { task_id: taskId });
    return trace.steps.flatMap((s: any) => s.calls.map((c: any) => c.template)) as string[];
  };

  let firstRunCalls = 0;

  it('finds the cheapest October flight Almaty → Antalya', async () => {
    const created = await client.call('task.create', {
      goal: 'Find the cheapest flight ticket from Almaty to Antalya departing in October 2026',
      site: fixtures.url('flights.html'),
      params: {
        from: { value: 'Алматы', about: 'departure city' },
        to: { value: 'Анталия', about: 'destination city' },
        period: { value: { from: '2026-10-01', to: '2026-10-31' }, about: 'departure date' },
      },
      result: { schema: { price: 'money', airline: 'string', depart: 'time', url: 'url' }, select: 'min(price)', extract: 'code' },
    });
    const { result, questions } = await runToEnd(created.task_id, (q) => (q.decision?.candidates?.[0] ? { type: 'pick', ref: q.decision.candidates[0].ref } : { type: 'continue' }));
    const trace = await client.call('task.trace', { task_id: created.task_id });
    for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''} [${s.calls.map((c: any) => c.template).join(', ')}]`);
    console.log('RESULT', JSON.stringify({ selected: result.result?.selected, count: result.result?.items_count, stats: result.stats, warnings: result.warnings }));
    expect(result.status).toBe('done');
    expect(result.result.selected.price.amount).toBe(38900);
    expect(result.result.items_count).toBeGreaterThanOrEqual(10);
    expect(questions.length).toBeLessThanOrEqual(2);
    firstRunCalls = (await templates(created.task_id)).length;
  }, 300_000);

  it('waits for late fares and confirms a picker that stays open for a return date', async () => {
    const created = await client.call('task.create', spec(fixtures.url('flights.html?oneway=1&lazy=1')));
    const { result, questions } = await runToEnd(created.task_id, pickTop);
    const trace = await client.call('task.trace', { task_id: created.task_id });
    const notes = trace.steps.map((s: any) => s.notes?.note ?? '').join(' | ');
    console.log(`picker run: ${notes}`);
    expect(result.status).toBe('done');
    // The cheapest day (the 14th) only gets its fare a moment after the calendar opens.
    expect(notes).toMatch(/picked 2026-10-14/);
    expect(notes).toMatch(/confirmed with "Выбрать в одну сторону"/);
    expect(result.result.selected.price.amount).toBe(38900);
    expect(questions).toHaveLength(0);
  }, 300_000);

  it.each([['', 'straight to payment'], ['?notice=1', 'through a price notice']])('opens the account from a page without a form and pays for an unpaid ad (%s: %s)', async (query) => {
    const created = await client.call('task.create', {
      goal: 'Pay for the publication of my car ad (Toyota Camry, 2015) that is already posted but unpaid: find it among my unpaid ads in the account and pay with the saved bank card',
      site: fixtures.url(`account.html${query}`),
      // Already signed in: the sign-in params are never needed on this path.
      params: { phone: { value: '7000000000', about: 'phone number used to sign in' }, password: { value: 'x', about: 'account password', secret: true } },
      hints: ['The ad already exists and waits for payment: do not post a new ad.', 'Pay with the saved bank card that is already linked to the account.'],
      policy: { fill_required: 'any', irreversible: 'ask' },
    });
    const { result, questions } = await runToEnd(created.task_id, (q) => (q.kind === 'risk_confirm' ? { type: 'continue' } : pickTop(q)), 6);
    const trace = await client.call('task.trace', { task_id: created.task_id });
    for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''}`);
    for (const q of questions) console.log(`question ${q.kind}: ${q.summary}`);
    for (const s of trace.steps) for (const c of s.calls ?? []) for (const [k, v] of Object.entries(c.answers ?? {})) if (/^(signed_in|goes_on|overlay_kind)/.test(k)) console.log(`ans ${s.idx} ${k} ${JSON.stringify((v as any).noul ?? (v as any).probabilities)}`);
    expect(result.status).toBe('done');
    const notes = trace.steps.map((s: any) => s.notes?.note ?? '').join(' | ');
    expect(notes).toMatch(/Сохранённая карта/);
    expect(notes).toMatch(/Оплатить 1 500/);
    expect(questions.every((q: any) => q.kind === 'risk_confirm')).toBe(true);
  }, 400_000);

  it('finds the way into an ad wizard from a search page, fills it with any values where allowed and pays', async () => {
    const created = await client.call('task.create', {
      goal: 'Post a new car ad with the given details (no photos), publish it and pay for it with the saved bank card',
      site: fixtures.url('filters.html'),
      params: {
        brand: { value: 'Toyota', about: 'car brand (make)' },
        model: { value: 'Camry', about: 'car model' },
        year: { value: '2015', about: 'year of manufacture' },
        city: { value: 'Алматы', about: 'city where the car is sold' },
        price: { value: '5000000', about: 'price in tenge' },
        mileage: { value: '100000', about: 'mileage in km' },
        description: { value: 'Тестовое описание', about: 'ad description text' },
      },
      hints: ['Do not upload any photos: skip the photo step.', 'Pay with the saved bank card.'],
      policy: { fill_required: 'any', irreversible: 'ask' },
    });
    // The agent confirms the publication and the payment, as the user asked for them.
    const { result, questions } = await runToEnd(created.task_id, (q) => (q.kind === 'risk_confirm' ? { type: 'continue' } : pickTop(q)), 6);
    const trace = await client.call('task.trace', { task_id: created.task_id });
    for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''}`);
    for (const q of questions) console.log(`question ${q.kind}: ${q.summary}`);
    if (process.env.JEV_TIMINGS) for (const s of trace.steps) console.log(`timing ${s.idx} ${s.subintent} ${JSON.stringify(s.timings)} ${(s.calls ?? []).map((c: any) => `${c.template}:${c.latencyMs ?? c.latency_ms ?? '?'}`).join(',')}`);
    expect(result.status).toBe('done');
    expect(trace.steps.map((s: any) => s.notes?.note ?? '').join(' | ')).toMatch(/goal reached/);
    // The payment dialog is part of the goal: never dismissed, the saved card is chosen, "Pay" is confirmed.
    expect(trace.steps.some((s: any) => /dismiss_overlay/.test(s.subintent))).toBe(false);
    expect(trace.steps.map((s: any) => s.notes?.note ?? '').join(' | ')).toMatch(/Сохранённая карта/);
    expect(questions.every((q: any) => q.kind === 'risk_confirm')).toBe(true);
  }, 400_000);

  it('follows results that open in a new tab', async () => {
    const created = await client.call('task.create', spec(fixtures.url('flights.html?newtab=1')));
    const { result } = await runToEnd(created.task_id, pickTop);
    const trace = await client.call('task.trace', { task_id: created.task_id });
    const notes = trace.steps.map((s: any) => s.notes?.note ?? '').join(' | ');
    console.log(`new-tab run: ${notes}`);
    expect(result.status).toBe('done');
    expect(result.result.selected.price.amount).toBe(38900);
    expect(notes).toMatch(/continued in the new tab/);
  }, 300_000);

  it('uses site memory on the second run', async () => {
    const created = await client.call('task.create', spec(fixtures.url('flights.html')));
    const { result } = await runToEnd(created.task_id, pickTop);
    expect(result.status).toBe('done');
    expect(result.result.selected.price.amount).toBe(38900);
    const used = await templates(created.task_id);
    const full = used.filter((t) => t === 'ground.element').length;
    console.log(`second run: ${full} full groundings, ${used.length} calls (first run ${firstRunCalls})`);
    // Remembered elements of reversible steps are tried directly: fewer JEV calls than the first run.
    expect(used.length).toBeLessThan(firstRunCalls);
  }, 300_000);

  const cars = (city: string, brand: string, model: string) => ({
    goal: `Find the cheapest ${brand} ${model} for sale in ${city}`,
    site: fixtures.url('filters.html'),
    params: {
      city: { value: city, about: 'city where the car is sold' },
      brand: { value: brand, about: 'car brand (make)' },
      model: { value: model, about: 'car model' },
    },
    // Default extract "agent": the task hands the sorted list over and the agent (here: the test) picks.
    result: { select: 'min(price)' },
  });
  const printSteps = async (taskId: string) => {
    const trace = await client.call('task.trace', { task_id: taskId });
    for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''} [${s.calls.map((c: any) => c.template).join(', ')}]`);
  };

  it('sets filter chips and sorts by price on a filters page without questions', async () => {
    const created = await client.call('task.create', cars('Павлодар', 'Toyota', 'Camry'));
    const { result, questions } = await runToEnd(created.task_id, pickTop);
    await printSteps(created.task_id);
    console.log('RESULT', JSON.stringify({ first: result.page?.items?.slice(0, 5), stats: result.stats }));
    expect(result.status).toBe('done');
    expect(result.page.sorted_by).toMatch(/lowest first/);
    const lines = result.page.items.map((it: any) => it.text) as string[];
    // Sorted by price: accessories first, then the cheapest car. Telling them apart is the agent's call.
    expect(lines.findIndex((t) => /Toyota Camry/.test(t) && /650 000/.test(t) && !/Коврики|Чехлы|Фара/.test(t))).toBeGreaterThanOrEqual(0);
    expect(lines.some((t) => /Коврики/.test(t))).toBe(true);
    expect(result.page.items.length).toBe(23);
    expect(questions).toHaveLength(0);
  }, 300_000);

  it('picks values that are only in dropdown lists', async () => {
    const created = await client.call('task.create', cars('Караганда', 'Lexus', 'RX 350'));
    const { result, questions } = await runToEnd(created.task_id, pickTop);
    await printSteps(created.task_id);
    console.log('RESULT', JSON.stringify({ first: result.page?.items?.slice(0, 5), stats: result.stats }));
    expect(result.status).toBe('done');
    expect(result.page.items.some((it: any) => /Lexus RX 350/.test(it.text) && /650 000/.test(it.text))).toBe(true);
    expect(questions).toHaveLength(0);
  }, 300_000);
});
