import type { PageSession } from '../cdp/page.ts';
import type { Config } from '../config/schema.ts';
import type { Thresholds } from '../config/thresholds.ts';
import type { JevClient } from '../jev/types.ts';
import type { TraceStore } from '../trace/store.ts';
import type { PageModel, ElementNode, Region } from '../perception/types.ts';
import type { ModelState } from '../perception/model.ts';
import { diffModels } from '../perception/diff.ts';
import { describeElement, renderDiff } from '../perception/render.ts';
import { parseCalendarCells } from '../perception/calendar.ts';
import { groundByIntent, type GroundResult, type Intent } from '../questions/templates/ground.ts';
import { buildAssess, readAssess, type AssessOutput } from '../questions/templates/assess.ts';
import { buildDecide, readDecide, type SubintentOption } from '../questions/templates/decide.ts';
import { buildSuggestionPick, buildOptionPick, buildGoalPrefs } from '../questions/templates/widget.ts';
import { buildActionClass, readActionClass } from '../questions/templates/safety.ts';
import { buildVerify, readVerify } from '../questions/templates/verify.ts';
import { runQuestions, choiceOf, noulOf, type QuestionContext } from '../questions/run.ts';
import { gateChoice, gateNoul, topCandidates } from '../decide/gating.ts';
import { extractResults, type ExtractOutput } from '../extract/extract.ts';
import { inRange } from '../extract/dates.ts';
import { deterministicRisk, domainAllowed } from '../safety/rules.ts';
import { maskSecrets, secretValues } from '../safety/secrets.ts';
import { thresholdsFor, hostOf } from './thresholds.ts';
import { dateRange, fieldHoldsValue, paramKind, requiredEmptyFields } from './progress.ts';
import { Emitter } from '../util/events.ts';
import { newId } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import type { ConfidenceConfig } from '../config/schema.ts';
import type {
  AnswerInput, Escalation, EscalationKind, ParamStatus, StepSummary, TaskResult, TaskSpec, TaskState,
} from './types.ts';
import { FINAL_STATES } from './types.ts';
import type { ParamSpec } from '../questions/state.ts';
import type { MemoryStore } from '../memory/store.ts';

const log = logger('task');

export type Model = PageModel & ModelState;

/** What a task needs from the browser side (implemented by the daemon's tab registry). */
export interface TabPort {
  readonly tabId: string;
  page(): Promise<PageSession>;
  observe(opts?: { settle?: boolean }): Promise<Model>;
  lastModel(): Model | undefined;
  release(): void;
}

export interface TaskDeps {
  sessionId: string;
  getConfig(): Config;
  jev: JevClient;
  trace: TraceStore;
  port: TabPort;
  memory?: MemoryStore;
  now?: () => number;
}

type Subintent =
  | { type: 'dismiss_overlay'; region: string; overlayKind: string }
  | { type: 'fill_param'; key: string }
  | { type: 'pick_suggestion'; key: string }
  | { type: 'pick_date'; key: string }
  | { type: 'submit' }
  | { type: 'extract' }
  | { type: 'load_more' }
  | { type: 'close_popup' }
  | { type: 'scroll' }
  | { type: 'go_back' }
  | { type: 'wait' }
  | { type: 'done'; reason: string }
  | { type: 'blocker'; kind: string; summary: string };

interface Outcome { outcome: 'ok' | 'failed' | 'skipped' | 'retry' | 'finished'; note: string; action?: Record<string, unknown> }

class Cancelled extends Error { constructor(reason = 'cancelled') { super(reason); this.name = 'Cancelled'; } }
class Interrupted extends Error { constructor(reason: string) { super(reason); this.name = 'Interrupted'; } }

const label = (s: Subintent): string => ('key' in s ? `${s.type}(${s.key})` : 'region' in s ? `${s.type}(${s.region})` : s.type);

interface PendingQuestion { q: Escalation; resolve: (a: AnswerInput) => void; reject: (e: Error) => void }

type TaskEvents = {
  state: { state: TaskState; reason?: string };
  step: StepSummary;
  escalation: Escalation;
  done: TaskResult;
};

/**
 * A JEV-driven browser task. Code owns the loop and the rules; JEV answers narrow questions (page kind,
 * which element, which suggestion, did it work); the main agent is asked only when JEV is not confident.
 */
export class Task extends Emitter<TaskEvents> {
  readonly id: string;
  readonly sessionId: string;
  spec: TaskSpec;
  state: TaskState = 'queued';
  stateReason?: string;
  private deps: TaskDeps;
  private hints: string[];
  private params: Record<string, ParamSpec>;
  private status: Record<string, ParamStatus> = {};
  private absentOn: Record<string, string> = {};
  private paramRefs: Record<string, string> = {};
  private recent: string[] = [];
  private stepIdx = 0;
  private stepId = '';
  private startedAt = 0;
  private cost = 0;
  private jevCalls = 0;
  private escalations = 0;
  private liveConfidence: ConfidenceConfig | undefined;
  private seen = new Map<string, number>();
  private failures = new Map<string, number>();
  private forcedRef: { sub: string; ref: string } | null = null;
  private approved = new Set<string>();
  private pending: PendingQuestion | null = null;
  private pausedWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private abort = new AbortController();
  private lastSub: Subintent | null = null;
  private lastTypedKey: string | null = null;
  private loadMoreCount = 0;
  private extractPrev = -1;
  private prefs: { lowestPrice: number; earliest: number } | null = null;
  private extraDomains: string[] = [];
  private finalResult: TaskResult | null = null;
  private maxStepsBonus = 0;
  private budgetBonus = 0;
  private lastInputCheck = 0;
  private model: Model | undefined;
  private assessCache: { sig: string; out: AssessOutput } | null = null;

  constructor(spec: TaskSpec, deps: TaskDeps, id = newId('t')) {
    super();
    this.id = id;
    this.sessionId = deps.sessionId;
    this.spec = spec;
    this.deps = deps;
    this.hints = [...spec.hints];
    this.params = structuredClone(spec.params);
    for (const k of Object.keys(this.params)) this.status[k] = 'pending';
  }

  // ---------------------------------------------------------------- public API

  get tabId(): string { return this.deps.port.tabId; }
  get finished(): boolean { return FINAL_STATES.has(this.state); }
  get pendingQuestion(): Escalation | null { return this.pending?.q ?? null; }

  start(): Promise<void> {
    this.startedAt = this.now();
    this.deps.trace.recordTask({
      id: this.id, session: this.sessionId, createdAt: this.startedAt, updatedAt: this.startedAt, state: 'running',
      goal: this.spec.goal, spec: this.maskedSpec(),
    });
    return this.run();
  }

  statusView() {
    return {
      task_id: this.id, state: this.state, reason: this.stateReason, goal: this.spec.goal, tab: this.tabId,
      step: this.stepIdx, subintent: this.lastSub ? label(this.lastSub) : null, url: this.model?.url ?? null,
      progress: { ...this.status }, pending_question: this.pending?.q ?? null, recent_steps: this.recent.slice(-5),
      stats: this.stats(),
    };
  }

  result(): TaskResult | null { return this.finalResult; }

  answer(questionId: string, input: AnswerInput): { accepted: boolean; message: string } {
    if (!this.pending || this.pending.q.question_id !== questionId) {
      return { accepted: false, message: `Question ${questionId} is not pending for task ${this.id}.` };
    }
    const p = this.pending;
    this.pending = null;
    this.deps.trace.recordEscalation({ id: p.q.question_id, taskId: this.id, createdAt: p.q.created_at, kind: p.q.kind, payload: p.q, answer: this.mask(input), answeredAt: this.now() });
    p.resolve(input);
    return { accepted: true, message: 'Answer accepted; the task continues.' };
  }

  pause(reason = 'paused by request'): void {
    if (this.finished || this.state === 'paused') return;
    if (!this.pausedWaiter) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      this.pausedWaiter = { promise, resolve };
    }
    this.setState('paused', reason);
  }

  resume(): void {
    if (this.pausedWaiter) { const w = this.pausedWaiter; this.pausedWaiter = null; w.resolve(); }
    if (this.state === 'paused') this.setState(this.pending ? 'awaiting_input' : 'running');
    if (this.state === 'interrupted') { void this.run(); }
  }

  cancel(reason = 'cancelled by request'): void {
    if (this.finished) return;
    this.abort.abort();
    this.pending?.reject(new Cancelled(reason));
    this.pending = null;
    this.pausedWaiter?.resolve();
    this.pausedWaiter = null;
    if (this.state === 'interrupted' || this.state === 'queued') this.finish('cancelled', undefined, reason);
  }

  update(patch: { params?: Record<string, ParamSpec>; hints?: string[]; confidence?: ConfidenceConfig; policy?: Partial<TaskSpec['policy']> }): void {
    if (patch.params) for (const [k, v] of Object.entries(patch.params)) { this.params[k] = v; this.status[k] = 'pending'; delete this.absentOn[k]; }
    if (patch.hints) this.hints.push(...patch.hints);
    if (patch.confidence) this.liveConfidence = patch.confidence;
    if (patch.policy) this.spec = { ...this.spec, policy: { ...this.spec.policy, ...patch.policy } };
  }

  // ---------------------------------------------------------------- loop

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private setState(state: TaskState, reason?: string): void {
    this.state = state;
    this.stateReason = reason;
    this.deps.trace.updateTask(this.id, { state });
    this.emit('state', { state, reason });
  }

  private qctx(): QuestionContext {
    return {
      jev: this.deps.jev, trace: this.deps.trace, taskId: this.id, stepId: this.stepId, signal: this.abort.signal,
      onCall: (rec) => { this.jevCalls++; this.cost += rec.costUsd ?? 0; },
    };
  }

  private th(url = this.model?.url ?? ''): Thresholds {
    return thresholdsFor(this.deps.getConfig(), url, this.spec.policy.confidence, this.liveConfidence);
  }

  private budget(): number { return this.deps.getConfig().limits.stateTokenTarget; }

  private async run(): Promise<void> {
    this.setState('running');
    try {
      if (this.stepIdx === 0) await this.prepare();
      else await this.recoverAfterInterrupt();
      while (!this.finished) {
        await this.checkpoint();
        await this.step();
      }
    } catch (e) {
      if (e instanceof Cancelled || this.abort.signal.aborted) this.finish('cancelled', undefined, (e as Error).message);
      else if (e instanceof Interrupted) { this.setState('interrupted', e.message); log.warn(`task ${this.id} interrupted: ${e.message}`); }
      else {
        log.error(`task ${this.id} failed`, e);
        this.finish('failed', undefined, (e as Error).message);
      }
    }
  }

  private async prepare(): Promise<void> {
    const page = await this.page();
    if (this.spec.site) {
      const current = this.deps.port.lastModel()?.url ?? '';
      if (!current.startsWith(this.spec.site)) {
        await page.navigate(this.spec.site);
        this.note(`opened ${this.spec.site}`);
      }
    }
    if (this.deps.memory && this.deps.getConfig().memory.enabled) {
      const host = hostOf(this.spec.site ?? (await page.url()));
      for (const h of this.deps.memory.hints(host)) if (!this.hints.includes(h)) this.hints.push(h);
    }
    this.lastInputCheck = this.now();
  }

  private async recoverAfterInterrupt(): Promise<void> {
    const url = this.model?.url;
    const page = await this.page();
    if (url && (await page.url()) !== url) await page.navigate(url);
  }

  private async page(): Promise<PageSession> {
    try { return await this.deps.port.page(); } catch (e) { throw new Interrupted(`browser tab unavailable: ${(e as Error).message}`); }
  }

  private async observe(settle = true): Promise<Model> {
    try {
      this.model = await this.deps.port.observe({ settle });
      return this.model;
    } catch (e) {
      throw new Interrupted(`could not read the page: ${(e as Error).message}`);
    }
  }

  private async checkpoint(): Promise<void> {
    if (this.abort.signal.aborted) throw new Cancelled();
    if (this.pausedWaiter) await this.pausedWaiter.promise;
    if (this.abort.signal.aborted) throw new Cancelled();
    const cfg = this.deps.getConfig();
    const maxSteps = (this.spec.policy.max_steps ?? cfg.limits.maxSteps) + this.maxStepsBonus;
    if (this.stepIdx >= maxSteps) {
      const a = await this.escalate('stuck', `Reached the step limit (${maxSteps}) without finishing.`, { answer_with: ['continue', 'hint', 'abort'] });
      if (a.type === 'continue' || a.type === 'hint') this.maxStepsBonus += 20;
    }
    const maxMinutes = this.spec.policy.max_minutes ?? cfg.limits.maxMinutes;
    if (this.now() - this.startedAt > maxMinutes * 60_000 * (1 + this.maxStepsBonus / 20)) {
      const a = await this.escalate('stuck', `The task has run longer than ${maxMinutes} minutes.`, { answer_with: ['continue', 'abort'] });
      if (a.type === 'continue') this.maxStepsBonus += 20;
    }
    const budget = (this.spec.policy.budget_usd ?? cfg.budgets.perTaskUsd) + this.budgetBonus;
    if (this.cost > budget) {
      const a = await this.escalate('budget', `JEV spend $${this.cost.toFixed(4)} exceeded the task budget $${budget.toFixed(2)}.`, { answer_with: ['continue', 'abort'] });
      if (a.type === 'continue') this.budgetBonus += budget;
    }
    // A person using the tab takes over: pause until resumed.
    const page = await this.page();
    if (this.state === 'running' && await page.userInputSince(this.lastInputCheck)) {
      this.note('paused: user interacted with the tab');
      this.pause('user_takeover');
      this.lastInputCheck = this.now();
      await this.checkpoint();
    }
    this.lastInputCheck = this.now();
  }

  private note(s: string): void {
    this.recent.push(this.mask(s));
    if (this.recent.length > 30) this.recent.shift();
  }

  private mask<T>(v: T): T { return maskSecrets(v, secretValues(this.params)); }

  private maskedSpec(): unknown {
    return this.mask({ ...this.spec, params: Object.fromEntries(Object.entries(this.spec.params).map(([k, p]) => [k, p.secret ? { ...p, value: '[secret]' } : p])) });
  }

  private stats() {
    return { steps: this.stepIdx, jev_calls: this.jevCalls, escalations: this.escalations, cost_usd: Number(this.cost.toFixed(6)), duration_s: Math.round((this.now() - (this.startedAt || this.now())) / 1000) };
  }

  private finish(status: TaskState, out?: Partial<TaskResult>, error?: string): void {
    if (this.finished) return;
    const result: TaskResult = { status, ...out, error, stats: this.stats() };
    this.finalResult = this.mask(result);
    this.deps.trace.updateTask(this.id, { state: status, result: this.finalResult, stats: result.stats });
    this.setState(status, error);
    this.deps.port.release();
    this.emit('done', this.finalResult);
  }

  // ---------------------------------------------------------------- escalation

  private async escalate(kind: EscalationKind, summary: string, extra: Partial<Escalation> = {}): Promise<AnswerInput> {
    const model = this.model;
    const q: Escalation = {
      question_id: newId('q'), task_id: this.id, kind, summary: this.mask(summary), created_at: this.now(),
      page: {
        url: model?.url ?? '', title: model?.title ?? '',
        page_kind: this.assessCache?.out.pageKindProbabilities,
        regions: (model?.regions ?? []).filter((r) => r.id !== 'r0').slice(0, 16).map((r) => `${r.id} ${r.kind}${r.label ? ` "${r.label}"` : ''}${r.blocking ? ' [BLOCKING]' : ''}`),
      },
      recent_steps: this.recent.slice(-8),
      answer_with: ['pick', 'set_param', 'hint', 'continue', 'thresholds', 'skip', 'abort'],
      ...this.mask(extra),
    };
    if (this.deps.getConfig().trace.screenshots) {
      try {
        const png = await (await this.page()).screenshot();
        q.screenshot = this.deps.trace.saveBlob(this.id, `${q.question_id}.png`, png);
      } catch { /* screenshot is optional */ }
    }
    this.escalations++;
    this.deps.trace.recordEscalation({ id: q.question_id, taskId: this.id, createdAt: q.created_at, kind, payload: q });
    const answer = await new Promise<AnswerInput>((resolve, reject) => {
      this.pending = { q, resolve, reject };
      this.setState('awaiting_input', kind);
      this.emit('escalation', q);
      const pauseMs = this.deps.getConfig().limits.awaitInputPauseMinutes * 60_000;
      const timer = setTimeout(() => { if (this.pending?.q === q) this.setState('paused', 'waiting for an answer'); }, pauseMs);
      timer.unref?.();
    });
    this.setState('running');
    this.note(`answer to ${kind}: ${answer.type}${answer.type === 'pick' ? ` ${answer.ref}` : answer.type === 'hint' ? ` "${answer.text}"` : ''}`);
    if (answer.type === 'abort') throw new Cancelled(answer.reason ?? 'aborted by the agent');
    if (answer.type === 'hint') {
      this.hints.push(answer.text);
      if (answer.scope === 'domain' && this.deps.memory && model) this.deps.memory.addHint(hostOf(model.url), answer.text);
    }
    if (answer.type === 'thresholds') this.liveConfidence = answer.value;
    if (answer.type === 'set_param') {
      this.params[answer.key] = { value: answer.value, about: answer.about ?? this.params[answer.key]?.about, secret: answer.secret };
      this.status[answer.key] = 'pending';
      delete this.absentOn[answer.key];
    }
    return answer;
  }

  /** Grounding with memory fast path, forced refs from answers, and escalation when unsure. */
  private async ground(sub: Subintent, intent: Intent, memoryKey?: string): Promise<{ el: ElementNode | null; res?: GroundResult; answer?: AnswerInput }> {
    const model = this.model!;
    const subLabel = label(sub);
    if (this.forcedRef && this.forcedRef.sub === subLabel) {
      const el = model.elements.get(this.forcedRef.ref) ?? null;
      this.forcedRef = null;
      if (el) return { el };
    }
    const host = hostOf(model.url);
    const pageKind = this.assessCache?.out.pageKind ?? 'other';
    if (memoryKey && this.deps.memory && this.deps.getConfig().memory.enabled) {
      const hit = this.deps.memory.lookup(host, pageKind, memoryKey);
      const el = hit ? [...model.elements.values()].find((e) => e.sig === hit.sig && e.visible) : undefined;
      if (hit && el) {
        const res = await runQuestions(this.qctx(), {
          template: 'ground.memory_confirm',
          state: { intent: { target: intent.target }, element: describeElement(el, { pageUrl: model.url }) },
          questions: { same: { type: 'noul', instructions: 'Is `element` `intent.target`?' } },
        });
        if (gateNoul(noulOf(res.answers, 'same'), this.th().ground.noul) === 'yes') {
          this.memoryUse = { id: hit.id, host, pageKind, key: memoryKey };
          return { el };
        }
        this.deps.memory.recordFailure(hit.id);
      }
    }
    const res = await groundByIntent(this.qctx(), model, intent, this.th(), { goal: this.spec.goal, params: this.params, hints: this.hints, budgetTokens: this.budget() });
    if (res.decision === 'act' && res.ref) {
      if (memoryKey) this.memoryUse = { id: null, host, pageKind, key: memoryKey, sig: model.elements.get(res.ref)!.sig };
      this.groundCalls = res.callIds;
      return { el: model.elements.get(res.ref)!, res };
    }
    if (res.decision === 'none') return { el: null, res };
    const th = this.th().ground.choice;
    const answer = await this.escalate('ground', `Unsure which element is ${intent.target}.`, {
      decision: { template: 'ground.element', asked: `Which element is ${intent.target}?`, candidates: res.candidates, confidence: res.confidence, thresholds: { act: th.act, escalate: th.escalate } },
      answer_with: ['pick', 'hint', 'skip', 'thresholds', 'set_param', 'abort'],
    });
    if (answer.type === 'pick') {
      const fresh = await this.observe(false);
      const el = fresh.elements.get(answer.ref) ?? null;
      if (el && answer.remember && memoryKey && this.deps.memory) this.deps.memory.recordSuccess(host, pageKind, memoryKey, el.sig);
      // The agent's pick is ground truth for the trace (calibration labels).
      for (const id of res.callIds) this.deps.trace.labelCall(id, res.ref === answer.ref, 'agent pick');
      return { el, res, answer };
    }
    return { el: null, res, answer };
  }

  private memoryUse: { id: string | null; host: string; pageKind: string; key: string; sig?: string } | null = null;
  private groundCalls: string[] = [];

  /** Records the outcome of a grounding for memory and calibration once the step is verified. */
  private settleGrounding(ok: boolean): void {
    const mu = this.memoryUse;
    this.memoryUse = null;
    for (const id of this.groundCalls) this.deps.trace.labelCall(id, ok, ok ? 'verified' : 'verify failed');
    this.groundCalls = [];
    if (!mu || !this.deps.memory) return;
    if (ok) this.deps.memory.recordSuccess(mu.host, mu.pageKind, mu.key, mu.sig ?? this.deps.memory.get(mu.id!)?.sig ?? '');
    else if (mu.id) this.deps.memory.recordFailure(mu.id);
  }

  /** Safety gate before clicks that might commit something. */
  private async guard(el: ElementNode, purpose: string, askJev: boolean): Promise<'ok' | 'skip'> {
    const model = this.model!;
    const risk = deterministicRisk(el, model);
    let irreversible = risk.irreversible;
    const reasons = [...risk.reasons];
    if (!irreversible && askJev) {
      const res = await runQuestions(this.qctx(), buildActionClass(el, model, this.spec.goal, this.budget()));
      const cls = readActionClass(res.answers);
      if (cls.pIrreversible >= 0.5) { irreversible = true; reasons.push(`JEV rates it irreversible (p=${cls.pIrreversible.toFixed(2)})`); }
    }
    if (!irreversible) return 'ok';
    const host = hostOf(model.url);
    const domainPolicy = Object.entries(this.deps.getConfig().domains).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1]?.irreversible;
    const policy = this.spec.policy.irreversible ?? domainPolicy ?? 'ask';
    const key = `${model.url}|${el.sig}`;
    if (policy === 'allow' || this.approved.has(key)) return 'ok';
    const a = await this.escalate('risk_confirm', `About to ${purpose}: ${describeElement(el)} — this looks irreversible (${reasons.join('; ')}). Confirm to continue.`, {
      context: { element: `${el.ref} ${describeElement(el, { pageUrl: model.url })}`, reasons },
      answer_with: ['continue', 'skip', 'abort'],
    });
    if (a.type === 'continue') { this.approved.add(key); return 'ok'; }
    return 'skip';
  }

  // ---------------------------------------------------------------- one step

  private async step(): Promise<void> {
    const started = this.now();
    this.stepIdx++;
    this.stepId = newId('st');
    const before = this.deps.port.lastModel();
    const model = await this.observe();
    const timings: Record<string, number> = { observe: this.now() - started };
    const page = await this.page();

    if (!domainAllowed(model.url, [...(this.spec.policy.allowed_domains ?? []), ...this.extraDomains]) && this.spec.policy.allowed_domains?.length) {
      const a = await this.escalate('off_domain', `The page moved to ${hostOf(model.url)}, outside the allowed domains.`, { answer_with: ['continue', 'abort'] });
      if (a.type === 'continue') this.extraDomains.push(hostOf(model.url));
      else if (!(await page.back())) throw new Cancelled('left the allowed domains');
      return;
    }

    const t1 = this.now();
    const assess = await this.assess(model);
    timings.assess = this.now() - t1;
    const sub = await this.chooseSubintent(model, assess);
    this.lastSub = sub;
    const subLabel = label(sub);
    const loopKey = `${model.signature}|${subLabel}`;
    const seen = (this.seen.get(loopKey) ?? 0) + 1;
    this.seen.set(loopKey, seen);
    if (seen >= 3 && !['extract', 'load_more', 'done', 'wait'].includes(sub.type)) {
      this.seen.set(loopKey, 0);
      const a = await this.escalate('stuck', `Repeating "${subLabel}" on the same page state without progress.`, {
        context: { subintent: subLabel }, answer_with: ['hint', 'set_param', 'skip', 'continue', 'abort'],
      });
      if (a.type === 'skip' && 'key' in sub) this.status[sub.key] = 'skipped';
      return;
    }

    const t2 = this.now();
    let out: Outcome;
    try {
      out = await this.execute(sub, model, assess);
    } catch (e) {
      if (e instanceof Cancelled || e instanceof Interrupted) throw e;
      const err = e as Error & { reason?: string; detail?: string };
      out = { outcome: 'failed', note: `${subLabel} failed: ${err.message}${err.detail ? ` (${err.detail})` : ''}` };
    }
    timings.execute = this.now() - t2;
    if (out.outcome === 'failed') {
      const n = (this.failures.get(subLabel) ?? 0) + 1;
      this.failures.set(subLabel, n);
      if (n >= 2) {
        this.failures.set(subLabel, 0);
        const a = await this.escalate('stuck', `Step "${subLabel}" failed twice: ${out.note}`, { answer_with: ['hint', 'set_param', 'skip', 'continue', 'abort'] });
        if (a.type === 'skip' && 'key' in sub) this.status[sub.key] = 'skipped';
      }
    } else if (out.outcome === 'ok') this.failures.set(subLabel, 0);
    this.note(out.note);
    const after = this.deps.port.lastModel();
    let screenshot: string | undefined;
    if (this.deps.getConfig().trace.screenshots) {
      try { screenshot = this.deps.trace.saveBlob(this.id, `step-${this.stepIdx}.png`, await page.screenshot()); } catch { /* optional */ }
    }
    this.deps.trace.recordStep({
      id: this.stepId, taskId: this.id, idx: this.stepIdx, startedAt: started, endedAt: this.now(), subintent: subLabel,
      action: this.mask(out.action), outcome: out.outcome, url: model.url, pageSig: model.signature,
      diff: after && before ? this.mask(renderDiff(diffModels(model, after), after, 10)) : undefined,
      timings: { ...timings, total: this.now() - started }, screenshot,
      notes: this.mask({ note: out.note, assess: { pageKind: assess.pageKind, goalReached: assess.goalReached, resultsMatch: assess.resultsMatch }, progress: this.status }),
    });
    this.emit('step', { idx: this.stepIdx, subintent: subLabel, outcome: out.outcome, note: this.mask(out.note), url: model.url });
  }

  private async assess(model: Model): Promise<AssessOutput> {
    if (this.assessCache?.sig === model.signature) return this.assessCache.out;
    const overlays = model.regions.filter((r) => (r.kind === 'overlay' || r.kind === 'dialog') && r.blocking);
    const allDone = Object.values(this.status).every((s) => s !== 'pending' && s !== 'typed');
    const input = {
      model, goal: this.spec.goal, params: this.params, progress: this.status, hints: this.hints,
      uncertainParams: Object.keys(this.status).filter((k) => this.status[k] === 'typed' && !this.params[k].secret),
      overlays, requiredEmpty: allDone ? requiredEmptyFields(model) : [], hasResultSchema: !!this.spec.result, budgetTokens: this.budget(),
    };
    const res = await runQuestions(this.qctx(), buildAssess(input));
    const out = readAssess(res.answers, input);
    this.assessCache = { sig: model.signature, out };
    return out;
  }

  private popupOptions(model: Model): ElementNode[] {
    const popupIds = new Set(model.regions.filter((r) => r.kind === 'popup').map((r) => r.id));
    return [...model.elements.values()].filter((e) => e.visible && e.interactive && popupIds.has(e.regionId)
      && ['option', 'menuitem', 'link', 'button', 'clickable'].includes(e.kind));
  }

  private async chooseSubintent(model: Model, a: AssessOutput): Promise<Subintent> {
    const th = this.th();
    const yes = (v: number, kind: keyof Thresholds = 'assess') => gateNoul(v, th[kind].noul) === 'yes';
    if (a.pageKind === 'captcha' && a.pageKindConfidence >= th.assess.choice.escalate) {
      return { type: 'blocker', kind: 'captcha', summary: 'The page shows a CAPTCHA or bot check. Solve it in the browser (or ask the user), then answer "continue".' };
    }
    const blocking = model.regions.filter((r) => (r.kind === 'overlay' || r.kind === 'dialog') && r.blocking);
    for (const r of blocking) {
      const kind = a.overlays[r.id]?.kind ?? 'other';
      return { type: 'dismiss_overlay', region: r.id, overlayKind: kind };
    }
    // Suggestions right after typing a param.
    if (this.lastTypedKey && this.status[this.lastTypedKey] === 'typed' && this.popupOptions(model).length) {
      return { type: 'pick_suggestion', key: this.lastTypedKey };
    }
    // An open calendar with a pending date param.
    const pendingDate = Object.keys(this.params).find((k) => paramKind(this.params[k]) === 'date' && this.status[k] === 'pending');
    if (pendingDate && parseCalendarCells(model, this.refDate()).length >= 7) return { type: 'pick_date', key: pendingDate };
    if (this.spec.result && (a.pageKind === 'results_list' || (yes(a.resultsMatch) && model.regions.some((r) => r.kind === 'list')))) {
      return { type: 'extract' };
    }
    if (!this.spec.result && yes(a.goalReached) && Object.values(this.status).every((s) => s !== 'pending')) return { type: 'done', reason: 'goal reached' };
    const onForm = ['search_form', 'login', 'other', 'item_details', 'checkout'].includes(a.pageKind);
    if (onForm) {
      for (const k of Object.keys(this.params)) {
        const s = this.status[k];
        if (s !== 'pending' && s !== 'typed') continue;
        if (this.absentOn[k] === model.signature) continue;
        if (s === 'typed') {
          const reflected = a.paramReflected[k];
          if (reflected !== undefined && yes(reflected)) { this.status[k] = 'done'; continue; }
        }
        return paramKind(this.params[k]) === 'date' ? { type: 'pick_date', key: k } : { type: 'fill_param', key: k };
      }
      const missing = Object.entries(a.requiredUncovered).filter(([, p]) => yes(p));
      if (missing.length) {
        const [ref] = missing[0];
        const el = model.elements.get(ref);
        const ans = await this.escalate('missing_param', `The form requires ${el ? describeElement(el) : ref}, but no param provides it.`, {
          context: { field: el ? `${ref} ${describeElement(el, { pageUrl: model.url })}` : ref },
          answer_with: ['set_param', 'skip', 'hint', 'abort'],
        });
        if (ans.type === 'set_param' || ans.type === 'hint') return this.chooseSubintent(await this.observe(false), a);
      }
      const anyDone = Object.values(this.status).some((s) => s === 'done');
      if (a.pageKind === 'search_form' && (anyDone || Object.keys(this.params).length === 0)) return { type: 'submit' };
    }
    return this.decideFallback(model, a);
  }

  private async decideFallback(model: Model, a: AssessOutput): Promise<Subintent> {
    const options: SubintentOption[] = [];
    const pendingKeys = Object.keys(this.params).filter((k) => this.status[k] === 'pending' || this.status[k] === 'typed');
    for (const k of pendingKeys) options.push({ id: `fill_${k}`, description: `Enter \`params.${k}.value\` (${this.params[k].about ?? k}) into its field.` });
    options.push({ id: 'submit', description: 'Submit the form or start the search.' });
    if (this.spec.result) options.push({ id: 'extract', description: 'Read the results listed on the page.' });
    if (this.popupOptions(model).length || model.regions.some((r) => r.kind === 'popup')) options.push({ id: 'close_popup', description: 'Close the open popup or menu.' });
    options.push({ id: 'scroll', description: 'Scroll down to see more of the page.' });
    options.push({ id: 'go_back', description: 'Go back to the previous page.' });
    options.push({ id: 'wait', description: 'Wait for the page to finish loading or updating.' });
    if (!this.spec.result) options.push({ id: 'done', description: 'The goal is already achieved; stop.' });
    const res = await runQuestions(this.qctx(), buildDecide({ model, goal: this.spec.goal, params: this.params, progress: this.status, hints: this.hints, recent: this.recent, options, budgetTokens: this.budget() }));
    const choice = readDecide(res.answers);
    let pick = choice.choice;
    if (gateChoice(choice, this.th().subintent.choice) !== 'act') {
      const answer = await this.escalate('subintent', 'Unsure what to do next on this page.', {
        decision: {
          template: 'decide.next_subintent', asked: 'Which step should be done next?', confidence: choice.confidence,
          candidates: topCandidates(choice, 6).map((c) => ({ ref: c.key, p: c.p, desc: options.find((o) => o.id === c.key)?.description ?? c.key })),
        },
        context: { page_kind: a.pageKind },
        answer_with: ['pick', 'hint', 'set_param', 'abort'],
      });
      if (answer.type !== 'pick') return { type: 'wait' };
      pick = answer.ref;
    }
    if (pick.startsWith('fill_')) {
      const k = pick.slice(5);
      return paramKind(this.params[k]) === 'date' ? { type: 'pick_date', key: k } : { type: 'fill_param', key: k };
    }
    switch (pick) {
      case 'submit': return { type: 'submit' };
      case 'extract': return { type: 'extract' };
      case 'close_popup': return { type: 'close_popup' };
      case 'scroll': return { type: 'scroll' };
      case 'go_back': return { type: 'go_back' };
      case 'done': return { type: 'done', reason: 'JEV judged the goal achieved' };
      default: return { type: 'wait' };
    }
  }

  private refDate(): { year: number; month: number } {
    const d = new Date(this.startedAt || this.now());
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  }

  // ---------------------------------------------------------------- executors

  private async execute(sub: Subintent, model: Model, a: AssessOutput): Promise<Outcome> {
    switch (sub.type) {
      case 'blocker': {
        const ans = await this.escalate('blocker', sub.summary, { answer_with: ['continue', 'hint', 'abort'] });
        return { outcome: 'retry', note: `blocker (${sub.kind}): ${ans.type}` };
      }
      case 'dismiss_overlay': return this.dismissOverlay(sub, model);
      case 'fill_param': return this.fillParam(sub, model);
      case 'pick_suggestion': return this.pickSuggestion(sub.key, model);
      case 'pick_date': return this.pickDate(sub, model);
      case 'submit': return this.submit(sub, model, a);
      case 'extract': return this.extract(model);
      case 'load_more': return { outcome: 'retry', note: 'load more handled by extract' };
      case 'close_popup': {
        await (await this.page()).press('Escape');
        await this.settle();
        return { outcome: 'ok', note: 'pressed Escape to close the popup', action: { type: 'press', key: 'Escape' } };
      }
      case 'scroll': {
        await (await this.page()).scroll(model.viewport.h * 0.8);
        await this.settle();
        return { outcome: 'ok', note: 'scrolled down', action: { type: 'scroll' } };
      }
      case 'go_back': {
        const ok = await (await this.page()).back();
        await this.settle();
        return { outcome: ok ? 'ok' : 'failed', note: ok ? 'went back' : 'no page to go back to', action: { type: 'back' } };
      }
      case 'wait': {
        await new Promise((r) => setTimeout(r, 1000));
        await this.settle();
        return { outcome: 'ok', note: 'waited for the page', action: { type: 'wait' } };
      }
      case 'done': {
        this.finish('done', { result: { goal_reached: true }, evidence: { url: model.url, refs: [], snippets: [model.title] } });
        return { outcome: 'finished', note: `done: ${sub.reason}` };
      }
    }
  }

  private async settle(): Promise<void> {
    await (await this.page()).waitForSettle({ maxMs: this.deps.getConfig().limits.settleMaxMs });
  }

  private async click(el: ElementNode): Promise<void> {
    await (await this.page()).click(el.backendNodeId, { sessionId: el.frameSessionId });
  }

  private async dismissOverlay(sub: Extract<Subintent, { type: 'dismiss_overlay' }>, model: Model): Promise<Outcome> {
    const region = model.regions.find((r) => r.id === sub.region) as Region;
    const what = sub.overlayKind === 'cookie_consent' ? 'the button that accepts the cookie notice (or closes it)'
      : sub.overlayKind === 'login_wall' ? 'the button that closes the sign-in prompt without signing in'
      : `the button that closes or dismisses this ${sub.overlayKind === 'promo' ? 'promotion' : 'overlay'} without signing up or buying`;
    const g = await this.ground(sub, { target: `${what}${region?.label ? ` ("${region.label}")` : ''}`, kinds: ['button', 'link', 'clickable', 'menuitem'], regionId: sub.region, action: 'click' }, `dismiss:${sub.overlayKind}`);
    const page = await this.page();
    if (!g.el) {
      if (g.answer?.type === 'skip') return { outcome: 'skipped', note: 'overlay left in place (agent said skip)' };
      await page.press('Escape');
      await this.settle();
      const after = await this.observe(false);
      const still = after.regions.find((r) => r.id === sub.region && r.blocking);
      if (still) {
        const ans = await this.escalate('blocker', `Cannot dismiss the overlay ${sub.region} "${region?.label ?? ''}" (${sub.overlayKind}).`, { answer_with: ['pick', 'continue', 'hint', 'abort'] });
        if (ans.type === 'pick') this.forcedRef = { sub: label(sub), ref: ans.ref };
        return { outcome: 'retry', note: `overlay ${sub.region} still blocking` };
      }
      return { outcome: 'ok', note: `closed overlay ${sub.region} with Escape`, action: { type: 'press', key: 'Escape' } };
    }
    if (await this.guard(g.el, 'dismiss an overlay', false) === 'skip') return { outcome: 'skipped', note: 'overlay button not clicked (not approved)' };
    await this.click(g.el);
    await this.settle();
    const after = await this.observe(false);
    const ok = !after.regions.some((r) => r.id === sub.region && r.blocking);
    this.settleGrounding(ok);
    return { outcome: ok ? 'ok' : 'failed', note: `${ok ? 'dismissed' : 'tried to dismiss'} ${sub.overlayKind} overlay via ${g.el.ref} "${g.el.name}"`, action: { type: 'click', ref: g.el.ref } };
  }

  private async fillParam(sub: Extract<Subintent, { type: 'fill_param' }>, model: Model): Promise<Outcome> {
    const k = sub.key;
    const p = this.params[k];
    const about = p.about ?? k.replace(/_/g, ' ');
    const kind = paramKind(p);
    const kinds: Intent['kinds'] = kind === 'boolean' ? ['checkbox', 'radio'] : ['textbox', 'combobox', 'select'];
    const g = await this.ground(sub, { target: kind === 'boolean' ? `the checkbox or switch for "${about}"` : `the input field for the ${about}`, action: kind === 'boolean' ? 'check' : 'type', kinds }, `param:${k}`);
    if (!g.el) {
      if (g.answer?.type === 'skip') { this.status[k] = 'skipped'; return { outcome: 'skipped', note: `skipped param ${k}` }; }
      if (g.res?.decision === 'none') { this.absentOn[k] = model.signature; return { outcome: 'skipped', note: `no field for ${k} on this page` }; }
      return { outcome: 'retry', note: `no field chosen for ${k}` };
    }
    const el = g.el;
    this.paramRefs[k] = el.ref;
    const page = await this.page();
    if (kind === 'boolean') {
      const want = p.value === true;
      if ((el.states.checked === true) !== want) await this.click(el);
      this.status[k] = 'done';
      await this.settle();
      this.settleGrounding(true);
      return { outcome: 'ok', note: `${want ? 'checked' : 'unchecked'} ${el.ref} "${el.name}" for ${k}`, action: { type: 'check', ref: el.ref, value: want } };
    }
    if (el.kind === 'select') {
      const opts = el.options ?? [];
      const res = await runQuestions(this.qctx(), buildOptionPick(opts, this.params, k, this.budget()));
      const pick = choiceOf(res.answers, 'pick');
      if (pick.choice === 'none' || gateChoice(pick, this.th().ground.choice) === 'escalate') {
        const ans = await this.escalate('ground', `Unsure which option of ${describeElement(el)} matches ${k}.`, {
          decision: { template: 'widget.option_pick', asked: `Which option matches params.${k}?`, confidence: pick.confidence,
            candidates: topCandidates(pick, 5, ['none']).map((c) => ({ ref: opts[Number(c.key.slice(1))]?.value ?? c.key, p: c.p, desc: opts[Number(c.key.slice(1))]?.label ?? '' })) },
          answer_with: ['pick', 'set_param', 'skip', 'abort'],
        });
        if (ans.type !== 'pick') return { outcome: 'retry', note: `option for ${k} not chosen` };
        await page.selectOption(el.backendNodeId, ans.ref, el.frameSessionId);
      } else {
        await page.selectOption(el.backendNodeId, opts[Number(pick.choice.slice(1))].value, el.frameSessionId);
      }
      this.status[k] = 'done';
      await this.settle();
      this.settleGrounding(true);
      return { outcome: 'ok', note: `selected ${k} in ${el.ref} "${el.name}"`, action: { type: 'select', ref: el.ref } };
    }
    if (fieldHoldsValue(el, p)) {
      this.status[k] = 'done';
      return { outcome: 'ok', note: `${k} already filled in ${el.ref}` };
    }
    const value = String(p.value);
    const mode = value.length <= 40 && !p.secret ? 'keys' : 'insert';
    await page.type(el.backendNodeId, value, { mode, clear: true, sessionId: el.frameSessionId });
    await this.settle();
    const after = await this.observe(false);
    const field = after.elements.get(el.ref);
    this.status[k] = 'typed';
    this.lastTypedKey = k;
    const typedOk = p.secret || fieldHoldsValue(field, p) || !!field?.value;
    this.settleGrounding(typedOk);
    const note = `typed ${p.secret ? '[secret]' : `"${value}"`} into ${el.ref} "${el.name}" for ${k}`;
    if (this.popupOptions(after).length) {
      const picked = await this.pickSuggestion(k, after);
      return { outcome: picked.outcome, note: `${note}; ${picked.note}`, action: { type: 'type', ref: el.ref, param: k, then: picked.action } };
    }
    if (typedOk) this.status[k] = 'typed';
    return { outcome: typedOk ? 'ok' : 'failed', note, action: { type: 'type', ref: el.ref, param: k } };
  }

  private async pickSuggestion(k: string, model: Model): Promise<Outcome> {
    const options = this.popupOptions(model);
    if (!options.length) { this.status[k] = 'done'; return { outcome: 'ok', note: `no suggestions for ${k}` }; }
    const refs = options.slice(0, 60).map((e) => e.ref);
    const res = await runQuestions(this.qctx(), buildSuggestionPick(model, refs, this.params, k, this.budget()));
    const pick = choiceOf(res.answers, 'pick');
    let ref = pick.choice;
    const gate = gateChoice(pick, this.th().ground.choice);
    if (ref === 'none' || gate !== 'act') {
      const candidates = topCandidates(pick, 5, ['none']).map((c) => ({ ref: c.key, p: c.p, desc: describeElement(model.elements.get(c.key)!) }));
      if (ref !== 'none' && gate === 'uncertain' && candidates[0] && candidates[0].p >= 0.5 && candidates.length === 1) {
        // Single plausible suggestion: accept.
      } else {
        const ans = await this.escalate('ground', `Unsure which suggestion matches ${k} = "${String(this.params[k].value)}".`, {
          decision: { template: 'widget.suggestion_pick', asked: `Which suggestion matches params.${k}?`, candidates, confidence: pick.confidence },
          answer_with: ['pick', 'set_param', 'skip', 'abort'],
        });
        if (ans.type === 'skip') { this.status[k] = 'done'; return { outcome: 'skipped', note: `suggestion for ${k} skipped` }; }
        if (ans.type !== 'pick') return { outcome: 'retry', note: `suggestion for ${k} not chosen` };
        ref = ans.ref;
      }
    }
    const el = model.elements.get(ref);
    if (!el) return { outcome: 'failed', note: `suggestion ${ref} vanished` };
    await this.click(el);
    await this.settle();
    const after = await this.observe(false);
    const stillOpen = this.popupOptions(after).some((o) => o.ref === ref);
    this.deps.trace.labelCall(res.callId, !stillOpen, 'suggestion click');
    this.status[k] = stillOpen ? 'typed' : 'done';
    this.lastTypedKey = null;
    return { outcome: stillOpen ? 'failed' : 'ok', note: `picked suggestion ${ref} "${el.name}" for ${k}`, action: { type: 'click', ref, param: k } };
  }

  private async goalPrefs(): Promise<{ lowestPrice: number; earliest: number }> {
    if (this.prefs) return this.prefs;
    const res = await runQuestions(this.qctx(), buildGoalPrefs(this.spec.goal, this.budget()));
    this.prefs = { lowestPrice: noulOf(res.answers, 'lowest_price'), earliest: noulOf(res.answers, 'earliest') };
    return this.prefs;
  }

  private async pickDate(sub: Extract<Subintent, { type: 'pick_date' }>, model: Model): Promise<Outcome> {
    const k = sub.key;
    const p = this.params[k];
    const range = dateRange(p);
    if (!range) { this.status[k] = 'skipped'; return { outcome: 'skipped', note: `param ${k} is not a date` }; }
    const about = p.about ?? k.replace(/_/g, ' ');
    const page = await this.page();
    let current = model;
    let cells = parseCalendarCells(current, this.refDate());
    if (cells.length < 7) {
      const g = await this.ground(sub, { target: `the field or button that opens the date picker for the ${about}`, kinds: ['textbox', 'combobox', 'button', 'clickable', 'link'], action: 'click' }, `date:${k}`);
      if (!g.el) {
        if (g.res?.decision === 'none') { this.absentOn[k] = model.signature; return { outcome: 'skipped', note: `no date field for ${k}` }; }
        return { outcome: 'retry', note: `no date field chosen for ${k}` };
      }
      if (g.el.kind === 'textbox' && g.el.inputType === 'date') {
        await page.type(g.el.backendNodeId, range.from, { mode: 'insert', sessionId: g.el.frameSessionId });
        this.status[k] = 'done';
        this.settleGrounding(true);
        return { outcome: 'ok', note: `typed ${range.from} into date input ${g.el.ref}`, action: { type: 'type', ref: g.el.ref } };
      }
      await this.click(g.el);
      await this.settle();
      current = await this.observe(false);
      cells = parseCalendarCells(current, this.refDate());
      this.settleGrounding(cells.length >= 7);
      if (cells.length < 7) return { outcome: 'failed', note: `clicked ${g.el.ref} "${g.el.name}" but no calendar appeared` };
    }
    for (let nav = 0; nav < 14; nav++) {
      const candidates = cells.filter((c) => inRange(c.date, range) && !c.disabled);
      if (candidates.length) {
        const prefs = await this.goalPrefs();
        const priced = candidates.filter((c) => c.price !== undefined);
        let chosen = candidates.sort((x, y) => x.date.localeCompare(y.date))[0];
        let why = 'earliest date in range';
        if (priced.length && prefs.lowestPrice >= 0.5) {
          chosen = priced.sort((x, y) => x.price! - y.price! || x.date.localeCompare(y.date))[0];
          why = `cheapest day in range (${chosen.price})`;
        }
        const el = current.elements.get(chosen.ref)!;
        await this.click(el);
        await this.settle();
        this.status[k] = 'done';
        return { outcome: 'ok', note: `picked ${chosen.date} for ${k}: ${why}`, action: { type: 'click', ref: chosen.ref, date: chosen.date } };
      }
      const dates = cells.map((c) => c.date).sort();
      const forward = dates[dates.length - 1] < range.from;
      const calRegion = this.layerRegion(current, cells[0].regionId);
      const g = await this.ground({ type: 'pick_date', key: `${k}:nav` }, {
        target: forward ? 'the button that shows the next month in the calendar' : 'the button that shows the previous month in the calendar',
        kinds: ['button', 'clickable', 'link'], regionId: calRegion, action: 'click',
      }, forward ? 'calendar:next' : 'calendar:prev');
      if (!g.el) return { outcome: 'failed', note: `no ${forward ? 'next' : 'previous'} month button in the calendar` };
      await this.click(g.el);
      await this.settle();
      current = await this.observe(false);
      const newCells = parseCalendarCells(current, this.refDate());
      this.settleGrounding(newCells.length >= 7 && newCells[0]?.date !== cells[0]?.date);
      cells = newCells;
      if (cells.length < 7) return { outcome: 'failed', note: 'the calendar closed while navigating months' };
    }
    return { outcome: 'failed', note: `no selectable date for ${k} within 14 months` };
  }

  /** The popup/overlay/dialog layer that contains a region (calendar grids are lists inside a popup). */
  private layerRegion(model: Model, regionId: string): string | undefined {
    let r = model.regions.find((x) => x.id === regionId);
    while (r) {
      if (r.kind === 'popup' || r.kind === 'overlay' || r.kind === 'dialog') return r.id;
      r = model.regions.find((x) => x.id === r!.parentId);
    }
    return undefined;
  }

  private async submit(sub: Extract<Subintent, { type: 'submit' }>, model: Model, a: AssessOutput): Promise<Outcome> {
    const refs = Object.values(this.paramRefs).map((r) => model.elements.get(r)).filter(Boolean) as ElementNode[];
    const regionCounts = new Map<string, number>();
    for (const e of refs) regionCounts.set(e.regionId, (regionCounts.get(e.regionId) ?? 0) + 1);
    const formRegion = [...regionCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const g = await this.ground(sub, {
      target: 'the button that submits the form and starts the search', kinds: ['button', 'clickable', 'link'],
      regionId: formRegion && formRegion !== 'r0' ? formRegion : undefined, action: 'click',
    }, 'submit');
    if (!g.el) {
      if (g.res?.decision === 'none') {
        await (await this.page()).press('Enter');
        await this.settle();
        return { outcome: 'ok', note: 'no submit button found; pressed Enter', action: { type: 'press', key: 'Enter' } };
      }
      return { outcome: 'retry', note: 'submit button not chosen' };
    }
    if (await this.guard(g.el, 'submit the form', true) === 'skip') return { outcome: 'skipped', note: 'submit not approved' };
    const beforeUrl = model.url;
    await this.click(g.el);
    await this.settle();
    const after = await this.observe(false);
    const diff = diffModels(model, after);
    const progressed = after.url !== beforeUrl || diff.newRegions.length > 0 || after.regions.some((r) => r.kind === 'list');
    let ok = progressed;
    if (!progressed) {
      const res = await runQuestions(this.qctx(), buildVerify('clicked the search/submit button', 'the search started or results appeared', renderDiff(diff, after, 10), after, this.budget()));
      ok = gateNoul(readVerify(res.answers), this.th().verify.noul) === 'yes';
    }
    this.settleGrounding(ok);
    if (!ok) {
      const errors = [...after.elements.values()].filter((e) => e.visible && !e.interactive && /ошиб|выберите|укажите|error|required|invalid|please/i.test(e.name)).map((e) => e.name).slice(0, 3);
      if (errors.length || a.validationError >= 0.5) {
        // Validation complaints usually mean a suggestion was not picked: retry params that are only typed.
        for (const [k, s] of Object.entries(this.status)) if (s === 'done' && paramKind(this.params[k]) === 'text') this.status[k] = 'typed';
        return { outcome: 'failed', note: `submit showed validation errors: ${errors.join(' | ') || 'unknown'}`, action: { type: 'click', ref: g.el.ref } };
      }
    }
    return { outcome: ok ? 'ok' : 'failed', note: `clicked submit ${g.el.ref} "${g.el.name}"${ok ? '' : ' (no visible effect)'}`, action: { type: 'click', ref: g.el.ref } };
  }

  private async extract(model: Model): Promise<Outcome> {
    const spec = this.spec.result!;
    const out: ExtractOutput | null = await extractResults(this.qctx(), model, spec, this.th(), { goal: this.spec.goal, budgetTokens: this.budget(), refDate: this.refDate() });
    if (!out || !out.items.length) {
      const ans = await this.escalate('assess', 'Expected a list of results but could not find one on this page.', { answer_with: ['hint', 'continue', 'abort'] });
      return { outcome: 'retry', note: `no result list found (${ans.type})` };
    }
    const maxItems = this.spec.policy.max_items ?? 200;
    const needsAll = !spec.select || spec.select === 'all' || /^(min|max)\(/.test(spec.select);
    const grew = out.items.length > this.extractPrev;
    this.extractPrev = out.items.length;
    if (needsAll && out.items.length < maxItems && grew && this.loadMoreCount < 30) {
      const g = await this.groundLoadMore(model, out.listRegionId);
      if (g) {
        await this.click(g);
        await this.settle();
        this.loadMoreCount++;
        return { outcome: 'ok', note: `read ${out.items.length} results; loading more via ${g.ref} "${g.name}"`, action: { type: 'click', ref: g.ref, purpose: 'load_more' } };
      }
    }
    this.finish('done', {
      result: { selected: out.selected, items_count: out.items.length },
      items: out.items,
      evidence: { url: model.url, refs: out.evidence.refs, snippets: out.evidence.snippets },
      warnings: out.warnings,
    });
    return { outcome: 'finished', note: `extracted ${out.items.length} results${out.selected ? '; selected one' : ''}` };
  }

  private async groundLoadMore(model: Model, listRegionId: string): Promise<ElementNode | null> {
    const intent: Intent = { target: 'the button or link that loads or shows more results of the list (not a page of another section)', kinds: ['button', 'link', 'clickable'], action: 'click' };
    const res = await groundByIntent(this.qctx(), model, intent, this.th(), { goal: this.spec.goal, budgetTokens: this.budget() });
    if (res.decision !== 'act' || !res.ref) return null;
    const el = model.elements.get(res.ref)!;
    if (deterministicRisk(el, model).irreversible) return null;
    void listRegionId;
    return el;
  }
}

export { Cancelled, Interrupted };
