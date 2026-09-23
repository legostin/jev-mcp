// Decision-quality evals: grounding accuracy and calibration on the fixture sites against live JEV.
// Usage: JEV_LIVE=1 node evals/run.ts [--no-record] [--preset balanced]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startHarness } from '../test/integration/harness.ts';
import { observePage } from '../src/core/perception/model.ts';
import { groundByIntent } from '../src/core/questions/templates/ground.ts';
import { createJevClient } from '../src/core/jev/client.ts';
import { loadConfig } from '../src/core/config/store.ts';
import { PRESETS } from '../src/core/config/thresholds.ts';
import { TraceStore } from '../src/core/trace/store.ts';
import { calibrationFromCalls } from '../src/core/trace/calibration.ts';
import type { PageSession } from '../src/core/cdp/page.ts';
import type { PresetName } from '../src/core/config/schema.ts';

interface Setup { fixture: string; wait?: number; steps: { click: string }[] }
interface Case { setup: string; target: string; kinds?: any[]; expect: string | null }

const dir = fileURLToPath(new URL('.', import.meta.url));
const { setups, cases } = JSON.parse(readFileSync(`${dir}cases/grounding.json`, 'utf8')) as { setups: Record<string, Setup>; cases: Case[] };
const record = !process.argv.includes('--no-record');
const presetArg = process.argv.indexOf('--preset');
const preset = (presetArg > 0 ? process.argv[presetArg + 1] : 'balanced') as PresetName;
const th = PRESETS[preset];
const cfg = loadConfig();
const jev = createJevClient(() => cfg);
const trace = record ? TraceStore.open() : undefined;
const h = await startHarness();
const pages = new Map<string, PageSession>();
const rows: Array<{ c: Case; got: string | null; decision: string; confidence: number; exists: number; ok: boolean; callIds: string[]; ms: number }> = [];

try {
  for (const c of cases) {
    let page = pages.get(c.setup);
    if (!page) {
      const s = setups[c.setup];
      page = await h.open(s.fixture);
      if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
      for (const step of s.steps) {
        const m = await observePage(page);
        const el = [...m.elements.values()].find((e) => e.name === step.click);
        if (!el) throw new Error(`setup ${c.setup}: no element "${step.click}"`);
        await page.click(el.backendNodeId, { sessionId: el.frameSessionId });
        await page.waitForSettle();
      }
      pages.set(c.setup, page);
    }
    const model = await observePage(page);
    const started = Date.now();
    const res = await groundByIntent({ jev, trace }, model, { target: c.target, kinds: c.kinds }, th, { budgetTokens: cfg.limits.stateTokenTarget });
    const got = res.ref ? model.elements.get(res.ref)?.name ?? null : null;
    const ok = c.expect === null ? res.decision === 'none' || !res.ref : got === c.expect;
    for (const id of res.callIds) trace?.labelCall(id, ok, 'eval');
    rows.push({ c, got, decision: res.decision, confidence: res.confidence, exists: res.exists, ok, callIds: res.callIds, ms: Date.now() - started });
    console.log(`${ok ? '✓' : '✗'} [${c.setup}] ${c.target} → ${got ?? '(none)'} (${res.decision}, conf ${res.confidence.toFixed(2)}, exists ${res.exists.toFixed(2)}, ${res.stage})${ok ? '' : `  expected ${c.expect ?? '(none)'}`}`);
  }
} finally {
  await h.close();
}

const acted = rows.filter((r) => r.decision === 'act');
const actedOk = acted.filter((r) => r.ok);
const summary = {
  preset, cases: rows.length,
  accuracy: rows.filter((r) => r.ok).length / rows.length,
  actedShare: acted.length / rows.length,
  accuracyWhenActed: acted.length ? actedOk.length / acted.length : null,
  escalated: rows.filter((r) => r.decision === 'escalate').length,
  medianMs: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  calibration: trace ? calibrationFromCalls(trace.getJevCalls({ template: 'ground.element', limit: 100_000 }).filter((c) => rows.some((r) => r.callIds.includes(c.id))))
    .map((r) => ({ template: r.template, n: r.n, ece: r.ece, recommend: r.recommend })) : null,
};
console.log('\n' + JSON.stringify(summary, null, 2));
writeFileSync(`${dir}last-report.json`, JSON.stringify({ summary, rows: rows.map((r) => ({ ...r, c: undefined, ...r.c })) }, null, 2));
trace?.close();
