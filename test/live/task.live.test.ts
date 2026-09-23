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

  async function runToEnd(taskId: string, answer: (q: any) => any, maxQuestions = 4) {
    const questions: any[] = [];
    for (;;) {
      const r = await client.call('task.wait', { task_id: taskId, until: 'question', timeout_ms: 120_000 }, { timeoutMs: 130_000 });
      if (r.timeout) throw new Error(`timeout; status ${JSON.stringify(r.status)}`);
      if (r.event.type === 'done') return { result: r.event.payload, questions };
      const q = r.event.payload;
      questions.push(q);
      console.log('QUESTION', JSON.stringify({ kind: q.kind, summary: q.summary, candidates: q.decision?.candidates?.slice(0, 3) }));
      if (questions.length > maxQuestions) { await client.call('task.control', { task_id: taskId, action: 'cancel' }); throw new Error('too many questions'); }
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
    result: { schema: { price: 'money', airline: 'string', depart: 'time', url: 'url' }, select: 'min(price)' },
  });
  const pickTop = (q: any) => (q.decision?.candidates?.[0] ? { type: 'pick', ref: q.decision.candidates[0].ref } : { type: 'continue' });
  const templates = async (taskId: string) => {
    const trace = await client.call('task.trace', { task_id: taskId });
    return trace.steps.flatMap((s: any) => s.calls.map((c: any) => c.template)) as string[];
  };

  it('finds the cheapest October flight Almaty → Antalya', async () => {
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
    const { result, questions } = await runToEnd(created.task_id, (q) => (q.decision?.candidates?.[0] ? { type: 'pick', ref: q.decision.candidates[0].ref } : { type: 'continue' }));
    const trace = await client.call('task.trace', { task_id: created.task_id });
    for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome} ${s.notes?.note ?? ''} [${s.calls.map((c: any) => c.template).join(', ')}]`);
    console.log('RESULT', JSON.stringify({ selected: result.result?.selected, count: result.result?.items_count, stats: result.stats, warnings: result.warnings }));
    expect(result.status).toBe('done');
    expect(result.result.selected.price.amount).toBe(38900);
    expect(result.result.items_count).toBeGreaterThanOrEqual(10);
    expect(questions.length).toBeLessThanOrEqual(2);
  }, 300_000);

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
    const memory = used.filter((t) => t === 'ground.memory_confirm').length;
    const full = used.filter((t) => t === 'ground.element').length;
    console.log(`second run: ${memory} memory confirmations, ${full} full groundings, ${used.length} calls`);
    expect(memory).toBeGreaterThanOrEqual(3);
  }, 300_000);
});
