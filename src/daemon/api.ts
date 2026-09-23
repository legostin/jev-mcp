import type { RpcServer, Connection } from './rpc.ts';
import { RpcError, ERR } from './protocol.ts';
import type { BrowserManager, Model, TabHandle } from './browsers.ts';
import type { Config } from '../core/config/schema.ts';
import { getPath, redactConfig, saveConfig, setPath, resolveApiKey, maskKey } from '../core/config/store.ts';
import { resolveThresholds, type Thresholds } from '../core/config/thresholds.ts';
import type { JevClient, Question, Json } from '../core/jev/types.ts';
import { playgroundUrl } from '../core/jev/playground.ts';
import type { TraceStore } from '../core/trace/store.ts';
import { diffModels } from '../core/perception/diff.ts';
import {
  describeElement, elementLines, regionLines, renderDiff, renderElement, renderOverview, renderRegion,
} from '../core/perception/render.ts';
import type { ElementKind, ElementNode } from '../core/perception/types.ts';
import { groundByIntent, type Intent } from '../core/questions/templates/ground.ts';
import { findElements } from '../core/questions/templates/find.ts';
import { buildState } from '../core/questions/state.ts';
import { runQuestions } from '../core/questions/run.ts';
import { ActionError } from '../core/cdp/page.ts';
import { deterministicRisk } from '../core/safety/rules.ts';
import { findChrome } from '../core/cdp/chromium.ts';

export interface DaemonContext {
  getConfig(): Config;
  setConfig(cfg: Config): void;
  jev: JevClient;
  trace: TraceStore;
  browsers: BrowserManager;
  version: string;
  startedAt: number;
  sessionOf(conn: Connection): string;
  extras: Record<string, () => unknown>;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function thresholdsFor(cfg: Config, url: string, task?: Config['confidence'], live?: Config['confidence']): Thresholds {
  const host = hostOf(url);
  const domainEntry = Object.entries(cfg.domains).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1];
  return resolveThresholds({ global: cfg.confidence, domain: domainEntry?.confidence, task, live });
}

const ACTION_KINDS: Record<string, ElementKind[] | undefined> = {
  type: ['textbox', 'combobox'],
  select: ['select', 'combobox', 'button', 'clickable'],
  check: ['checkbox', 'radio'],
  uncheck: ['checkbox'],
  upload: ['file', 'button', 'clickable'],
};

type ActAction = 'click' | 'type' | 'select' | 'check' | 'uncheck' | 'press' | 'scroll' | 'hover' | 'navigate' | 'back' | 'wait' | 'upload' | 'focus';

export interface ActParams {
  tab?: string;
  action: ActAction;
  ref?: string;
  intent?: string;
  value?: string | number | boolean | string[];
  options?: { mode?: 'insert' | 'keys'; clear?: boolean; force?: boolean; submit?: boolean };
}

function elementOr404(model: Model, ref: string): ElementNode {
  const el = model.elements.get(ref);
  if (!el) throw new RpcError(ERR.notFound, `Element ${ref} is not on the current page. Observe again (refs of removed elements disappear).`);
  return el;
}

/** Page-level RPC methods: observe, find, ask, act, screenshot, tabs, settings, doctor. */
export function registerPageApi(rpc: RpcServer, ctx: DaemonContext): void {
  const session = (conn: Connection) => ctx.sessionOf(conn);

  async function tabFor(conn: Connection, tab?: string): Promise<TabHandle> {
    return ctx.browsers.resolve(session(conn), tab);
  }

  async function freshModel(t: TabHandle): Promise<Model> {
    return ctx.browsers.observe(t.id);
  }

  rpc.register('tabs.list', async (_p, conn) => {
    const tabs = await ctx.browsers.listTabs();
    const cur = await ctx.browsers.resolve(session(conn), undefined, { create: false }).catch(() => null);
    return {
      tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, driver: t.driver, task: t.lease ?? null, current: t.id === cur?.id })),
      extensionConnected: ctx.browsers.extensionConnected,
    };
  });

  rpc.register('tabs.open', async (p: { url?: string; driver?: 'auto' | 'chromium' | 'extension' }, conn) => {
    const t = await ctx.browsers.openTab(p.url, p.driver);
    ctx.browsers.setCurrent(session(conn), t.id);
    const model = await freshModel(t);
    return { tab: t.id, driver: t.driver, url: model.url, title: model.title, overview: renderOverview(model, 1200) };
  });

  rpc.register('tabs.close', async (p: { tab: string }) => {
    await ctx.browsers.closeTab(p.tab);
    return { closed: p.tab };
  });

  rpc.register('tabs.select', async (p: { tab: string }, conn) => {
    const t = ctx.browsers.get(p.tab);
    ctx.browsers.setCurrent(session(conn), t.id);
    const d = await ctx.browsers.driver(t.driver);
    await d.activateTab(t.targetId).catch(() => {});
    return { tab: t.id, url: t.url, title: t.title };
  });

  rpc.register('page.observe', async (p: { tab?: string; view?: string; target?: string; budget?: number }, conn) => {
    const t = await tabFor(conn, p.tab);
    const model = await freshModel(t);
    const budget = p.budget ?? 2000;
    let text: string;
    switch (p.view ?? 'overview') {
      case 'overview': text = renderOverview(model, budget); break;
      case 'region':
        if (!p.target) throw new RpcError(ERR.invalidParams, 'view "region" needs target (a region id such as r3)');
        text = renderRegion(model, p.target, budget); break;
      case 'element':
        if (!p.target) throw new RpcError(ERR.invalidParams, 'view "element" needs target (an element ref such as e12)');
        text = renderElement(model, p.target); break;
      case 'diff': text = renderDiff(diffModels(t.prevModel, model), model); break;
      case 'full': text = renderRegion(model, 'r0', budget); break;
      default: throw new RpcError(ERR.invalidParams, `Unknown view ${p.view}. Use overview, region, element, diff or full.`);
    }
    return { tab: t.id, url: model.url, title: model.title, text, captureMs: model.captureMs, elements: model.elements.size };
  });

  rpc.register('page.find', async (p: { tab?: string; query: string; k?: number; kinds?: ElementKind[]; region?: string }, conn) => {
    if (!p.query) throw new RpcError(ERR.invalidParams, 'query is required');
    const t = await tabFor(conn, p.tab);
    const model = await freshModel(t);
    const cfg = ctx.getConfig();
    const res = await findElements({ jev: ctx.jev, trace: ctx.trace }, model, p.query, thresholdsFor(cfg, model.url), {
      budgetTokens: cfg.limits.stateTokenTarget,
    }, { k: p.k, kinds: p.kinds, regionId: p.region });
    return { tab: t.id, ...res };
  });

  rpc.register('page.ask', async (p: { tab?: string; questions: Record<string, Question>; region?: string; context?: string }, conn) => {
    if (!p.questions || typeof p.questions !== 'object' || !Object.keys(p.questions).length) {
      throw new RpcError(ERR.invalidParams, 'questions must be a non-empty map of JEV questions');
    }
    const t = await tabFor(conn, p.tab);
    const model = await freshModel(t);
    const cfg = ctx.getConfig();
    let refs: string[];
    if (p.region) {
      const ids = new Set([p.region]);
      for (const r of model.regions) if (r.parentId && ids.has(r.parentId)) ids.add(r.id);
      refs = [...model.elements.values()].filter((e) => ids.has(e.regionId) && e.visible).map((e) => e.ref);
    } else {
      refs = [...model.elements.values()].filter((e) => e.visible && e.inViewport).map((e) => e.ref);
    }
    const state = buildState({
      page: { url: model.url, title: model.title, regions: regionLines(model), elements: elementLines(model, refs.slice(0, 250)) },
      extra: p.context ? { context: p.context } : undefined,
    }, cfg.limits.stateTokenTarget * 2);
    const res = await runQuestions({ jev: ctx.jev, trace: ctx.trace }, { template: 'agent.ask', state, questions: p.questions });
    return { tab: t.id, answers: res.answers, model: res.model, costUsd: res.costUsd, callId: res.callId, playground: playgroundUrl(state, p.questions) };
  });

  rpc.register('page.act', async (p: ActParams, conn) => act(ctx, await tabFor(conn, p.tab), p));

  rpc.register('page.screenshot', async (p: { tab?: string; ref?: string }, conn) => {
    const t = await tabFor(conn, p.tab);
    const page = await ctx.browsers.page(t.id);
    let clip: { x: number; y: number; w: number; h: number } | undefined;
    if (p.ref) {
      const model = t.model ?? await freshModel(t);
      const el = elementOr404(model, p.ref);
      await page.scrollIntoView(el.backendNodeId, el.frameSessionId);
      const fresh = await freshModel(t);
      const r = elementOr404(fresh, p.ref).rect;
      clip = { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), w: r.w + 16, h: r.h + 16 };
    }
    const png = await page.screenshot(clip);
    return { tab: t.id, mimeType: 'image/png', data: png.toString('base64') };
  });

  rpc.register('settings.get', async (p: { path?: string }) => {
    const red = redactConfig(ctx.getConfig());
    return { path: p.path ?? '', value: p.path ? getPath(red, p.path) ?? null : red };
  });

  rpc.register('settings.set', async (p: { path: string; value: unknown }) => {
    if (!p.path) throw new RpcError(ERR.invalidParams, 'path is required');
    let next: Config;
    try { next = setPath(ctx.getConfig(), p.path, p.value); } catch (e) {
      throw new RpcError(ERR.invalidParams, (e as Error).message);
    }
    saveConfig(next);
    ctx.setConfig(next);
    return { path: p.path, value: getPath(redactConfig(next), p.path) ?? null };
  });

  rpc.register('doctor', async () => doctor(ctx));

  rpc.register('daemon.info', async () => ({
    pid: process.pid, version: ctx.version, uptimeS: Math.round((Date.now() - ctx.startedAt) / 1000),
    extensionConnected: ctx.browsers.extensionConnected, chromiumRunning: ctx.browsers.chromiumRunning,
    ...Object.fromEntries(Object.entries(ctx.extras).map(([k, f]) => [k, f()])),
  }));
}

async function resolveTarget(ctx: DaemonContext, t: TabHandle, p: ActParams): Promise<{ el: ElementNode; model: Model } | { decision: unknown }> {
  let model = t.model ?? await ctx.browsers.observe(t.id);
  if (p.ref) {
    if (!model.elements.has(p.ref)) model = await ctx.browsers.observe(t.id);
    return { el: elementOr404(model, p.ref), model };
  }
  if (!p.intent) throw new RpcError(ERR.invalidParams, `Action "${p.action}" needs ref or intent`);
  model = await ctx.browsers.observe(t.id);
  const cfg = ctx.getConfig();
  const intent: Intent = { target: p.intent, kinds: ACTION_KINDS[p.action], action: p.action === 'type' ? 'type' : 'click' };
  const res = await groundByIntent({ jev: ctx.jev, trace: ctx.trace }, model, intent, thresholdsFor(cfg, model.url), { budgetTokens: cfg.limits.stateTokenTarget });
  if (res.decision !== 'act' || !res.ref) {
    return {
      decision: {
        ok: false, reason: res.decision === 'none' ? 'not_found' : 'uncertain',
        message: res.decision === 'none'
          ? `No element matches "${p.intent}" on this page.`
          : `Not confident which element is "${p.intent}". Pick one by ref and call again.`,
        confidence: res.confidence, candidates: res.candidates,
      },
    };
  }
  return { el: elementOr404(model, res.ref), model };
}

export async function act(ctx: DaemonContext, t: TabHandle, p: ActParams): Promise<Record<string, unknown>> {
  const page = await ctx.browsers.page(t.id);
  const cfg = ctx.getConfig();
  const before = t.model;
  let target: ElementNode | null = null;
  let risk: { irreversible: boolean; reasons: string[] } | null = null;
  const elementActions: ActAction[] = ['click', 'type', 'select', 'check', 'uncheck', 'hover', 'upload', 'focus'];
  try {
    if (elementActions.includes(p.action) || (p.action === 'scroll' && (p.ref || p.intent))) {
      const r = await resolveTarget(ctx, t, p);
      if ('decision' in r) return { tab: t.id, ...(r.decision as object) };
      target = r.el;
      risk = deterministicRisk(target, r.model);
    }
    const s = target?.frameSessionId;
    switch (p.action) {
      case 'click': await page.click(target!.backendNodeId, { sessionId: s, force: p.options?.force }); break;
      case 'focus': await page.focus(target!.backendNodeId, s); break;
      case 'hover': await page.hover(target!.backendNodeId, s); break;
      case 'type': {
        if (p.value === undefined) throw new RpcError(ERR.invalidParams, 'type needs value');
        const mode = p.options?.mode ?? (target!.kind === 'combobox' ? 'keys' : 'insert');
        await page.type(target!.backendNodeId, String(p.value), { mode, clear: p.options?.clear ?? true, sessionId: s });
        if (p.options?.submit) await page.press('Enter');
        break;
      }
      case 'select': {
        if (p.value === undefined) throw new RpcError(ERR.invalidParams, 'select needs value');
        if (target!.kind === 'select') { await page.selectOption(target!.backendNodeId, String(p.value), s); break; }
        // Custom dropdown: open it, then ground the option by its text.
        await page.click(target!.backendNodeId, { sessionId: s });
        await page.waitForSettle({ maxMs: cfg.limits.settleMaxMs });
        const opened = await ctx.browsers.observe(t.id);
        const res = await groundByIntent({ jev: ctx.jev, trace: ctx.trace }, opened, {
          target: `the option "${String(p.value)}"`, kinds: ['option', 'menuitem', 'button', 'clickable', 'link', 'radio'],
        }, thresholdsFor(cfg, opened.url), { budgetTokens: cfg.limits.stateTokenTarget });
        if (res.decision !== 'act' || !res.ref) return { tab: t.id, ok: false, reason: 'option_not_found', candidates: res.candidates };
        const opt = opened.elements.get(res.ref)!;
        await page.click(opt.backendNodeId, { sessionId: opt.frameSessionId });
        break;
      }
      case 'check':
      case 'uncheck': {
        const want = p.action === 'check';
        if ((target!.states.checked === true) !== want) await page.click(target!.backendNodeId, { sessionId: s, force: p.options?.force });
        break;
      }
      case 'press': await page.press(String(p.value ?? 'Enter')); break;
      case 'scroll': {
        if (target) { await page.scrollIntoView(target.backendNodeId, s); break; }
        const v = p.value;
        const h = before?.viewport.h ?? 800;
        const dy = typeof v === 'number' ? v : v === 'up' ? -h * 0.8 : v === 'top' ? -1e6 : v === 'bottom' ? 1e6 : h * 0.8;
        if (Math.abs(dy) >= 1e6) await page.evaluate(`window.scrollTo(0, ${dy > 0 ? 'document.documentElement.scrollHeight' : 0})`);
        else await page.scroll(dy);
        break;
      }
      case 'navigate': {
        if (!p.value) throw new RpcError(ERR.invalidParams, 'navigate needs value (a URL)');
        await page.navigate(String(p.value));
        break;
      }
      case 'back': await page.back(); break;
      case 'wait': {
        const ms = typeof p.value === 'number' ? p.value : 0;
        if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 30_000)));
        break;
      }
      case 'upload': {
        const files = Array.isArray(p.value) ? p.value.map(String) : [String(p.value)];
        await page.setFiles(target!.backendNodeId, files, s);
        break;
      }
      default: throw new RpcError(ERR.invalidParams, `Unknown action ${(p as { action: string }).action}`);
    }
  } catch (e) {
    if (e instanceof ActionError) {
      const hint = e.reason === 'occluded'
        ? 'Something covers the element (see coveredBy). Dismiss the overlay first, or retry with options.force.'
        : e.reason === 'detached' ? 'The page changed; observe again and use the new ref.' : undefined;
      return { tab: t.id, ok: false, reason: e.reason, message: e.message, coveredBy: e.detail, hint, target: target ? describeElement(target) : undefined };
    }
    throw e;
  }
  await page.waitForSettle({ maxMs: cfg.limits.settleMaxMs });
  const after = await ctx.browsers.observe(t.id, { settle: false });
  const diff = diffModels(before, after);
  const result: Record<string, unknown> = {
    tab: t.id, ok: true, action: p.action, url: after.url,
    target: target ? `${target.ref} ${describeElement(target)}` : undefined,
    diff: renderDiff(diff, after, 15),
  };
  if (risk?.irreversible) result.warning = `This control looks irreversible (${risk.reasons.join('; ')}).`;
  return result;
}

async function doctor(ctx: DaemonContext): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }> {
  const cfg = ctx.getConfig();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  checks.push({ name: 'daemon', ok: true, detail: `pid ${process.pid}, version ${ctx.version}` });
  for (const prov of ['openrouter', 'typesafe'] as const) {
    const key = resolveApiKey(cfg, prov);
    const active = cfg.provider === prov;
    if (!key && !active) continue;
    checks.push({ name: `key:${prov}`, ok: !!key, detail: key ? `configured (${maskKey(key)})${active ? ', active' : ''}` : `missing — run: jev settings set providers.${prov}.apiKey -` });
  }
  try {
    const started = Date.now();
    const res = await ctx.jev.evaluate({ state: 'The sky is blue.', questions: { ok: { type: 'noul', instructions: 'Does the text describe the sky?' } } });
    checks.push({ name: 'jev', ok: true, detail: `${res.model} via ${res.provider}, ${Date.now() - started} ms` });
  } catch (e) {
    checks.push({ name: 'jev', ok: false, detail: (e as Error).message });
  }
  const chrome = cfg.driver.chromium.executable ?? findChrome();
  checks.push({ name: 'chrome', ok: !!chrome, detail: chrome ?? 'Chrome not found; set driver.chromium.executable' });
  checks.push({ name: 'chromium-driver', ok: true, detail: ctx.browsers.chromiumRunning ? 'running' : 'not started (starts on first use)' });
  checks.push({ name: 'extension', ok: true, detail: ctx.browsers.extensionConnected ? 'connected' : 'not connected (optional; load the extension and run jev pair)' });
  return { ok: checks.every((c) => c.ok), checks };
}

export type { Json };
