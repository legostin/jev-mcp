// Live acceptance run on a real site in an isolated JEV_HOME. A naive "main agent" answers questions with the top
// candidate (or continue); everything is logged. Usage: node scripts/acceptance.ts [--headful] [--site url]
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config/store.ts';

const real = loadConfig();
const home = process.env.JEV_ACCEPT_HOME ?? mkdtempSync(join(tmpdir(), 'jevacc-'));
process.env.JEV_HOME = home;
process.env.JEV_HTTP_PORT = '0';
if (!process.argv.includes('--headful')) process.env.JEV_HEADLESS = '1';
mkdirSync(join(home, 'config'), { recursive: true });
writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ provider: real.provider, providers: real.providers, trace: { screenshots: true } }));
const siteArg = process.argv.indexOf('--site');
const site = siteArg > 0 ? process.argv[siteArg + 1] : '';
if (!site) { console.error('usage: node scripts/acceptance.ts --site <flight search url> [--headful]'); process.exit(2); }

const { startDaemon } = await import('../src/daemon/main.ts');
const { registerStage2 } = await import('../src/daemon/extend.ts');
const { connectDaemon } = await import('../src/daemon/client.ts');
const daemon = await startDaemon({ logToStderr: true });
const stage = await registerStage2(daemon, { httpPort: 0 });
console.log(`home ${home}\nui ${stage.http.authUrl()}`);
const client = await connectDaemon();
await client.call('session.hello', { client: 'acceptance' });
const created = await client.call('task.create', {
  goal: 'Find the cheapest flight ticket from Almaty to Antalya departing in October 2026 (one way, 1 adult, economy)',
  site,
  params: {
    from: { value: 'Алматы', about: 'departure city' },
    to: { value: 'Анталья', about: 'destination city' },
    period: { value: { from: '2026-10-01', to: '2026-10-31' }, about: 'departure date' },
  },
  result: { schema: { price: 'money', airline: 'string', depart: 'time', duration: 'duration', url: 'url' }, select: 'min(price)' },
  policy: { max_steps: 40, max_items: 60 },
}, { timeoutMs: 120_000 });
console.log(`task ${created.task_id}`);
let questions = 0;
for (;;) {
  const r = await client.call('task.wait', { task_id: created.task_id, until: 'question', timeout_ms: 300_000 }, { timeoutMs: 320_000 });
  if (r.timeout) { console.log('TIMEOUT', JSON.stringify(r.status)); break; }
  if (r.event.type === 'done') { console.log('RESULT', JSON.stringify(r.event.payload, null, 1)); break; }
  const q = r.event.payload;
  questions++;
  console.log(`QUESTION ${questions} [${q.kind}] ${q.summary}\n  ${(q.decision?.candidates ?? []).slice(0, 4).map((c: any) => `${c.ref} ${c.p.toFixed(2)} ${c.desc}`).join('\n  ')}`);
  if (questions > 6) { await client.call('task.control', { task_id: created.task_id, action: 'cancel' }); console.log('too many questions, cancelled'); break; }
  const top = q.decision?.candidates?.[0];
  const answer = top && top.p >= 0.25 ? { type: 'pick', ref: top.ref } : { type: 'continue' };
  await client.call('task.answer', { question_id: q.question_id, answer });
}
const trace = await client.call('task.trace', { task_id: created.task_id });
for (const s of trace.steps) console.log(`step ${s.idx} ${s.subintent} ${s.outcome}: ${s.notes?.note ?? ''} [${s.calls.map((c: any) => c.template).join(', ')}] ${s.url}`);
client.close();
await daemon.close();
