import type { PageSession } from '../cdp/page.ts';
import type { Config } from '../config/schema.ts';
import type { Thresholds } from '../config/thresholds.ts';
import type { JevClient } from '../jev/types.ts';
import type { TraceStore } from '../trace/store.ts';
import type { PageModel, ElementNode, Region } from '../perception/types.ts';
import type { ModelState } from '../perception/model.ts';
import { diffModels } from '../perception/diff.ts';
import { describeElement, renderCandidate, renderDiff, renderOverview } from '../perception/render.ts';
import { parseCalendarCells } from '../perception/calendar.ts';
import { groundByIntent, type GroundResult, type Intent } from '../questions/templates/ground.ts';
import { buildAssess, readAssess, type AssessOutput } from '../questions/templates/assess.ts';
import { buildDecide, readDecide, type SubintentOption } from '../questions/templates/decide.ts';
import { buildSuggestionPick, buildOptionPick, buildGoalPrefs } from '../questions/templates/widget.ts';
import { buildActionClass, readActionClass } from '../questions/templates/safety.ts';
import { buildVerify, readVerify } from '../questions/templates/verify.ts';
import { runQuestions, choiceOf, noulOf, type QuestionContext } from '../questions/run.ts';
import { buildState } from '../questions/state.ts';
import { aboutOf, hintsFor, paramCard, paramIntent, stepCard, type Hint, type StepCard } from '../questions/step.ts';
import { hadEffect, rollbackPlan } from './rollback.ts';
import { gateChoice, gateNoul, topCandidates } from '../decide/gating.ts';
import { extractResults, applySelect, findResultsList, type ExtractOutput } from '../extract/extract.ts';
import { listItems, type HandoffItem } from '../extract/handoff.ts';
import { estimateTokens } from '../util/tokens.ts';
import { inRange } from '../extract/dates.ts';
import { deterministicRisk, domainAllowed } from '../safety/rules.ts';
import { maskSecrets, secretValues } from '../safety/secrets.ts';
import { thresholdsFor, hostOf } from './thresholds.ts';
import { dateRange, fieldHoldsValue, isValueLabel, normalizeText, paramKind, requiredEmptyFields, showsValue } from './progress.ts';
import { Emitter } from '../util/events.ts';
import { newId } from '../util/ids.ts';
import { logger } from '../util/log.ts';
import type { ConfidenceConfig, DecisionKind } from '../config/schema.ts';
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
  /** Drops and re-creates the CDP session for the tab (recovery from a hung renderer connection). */
  reset?(): Promise<void>;
  /** Tabs this task's tab opened since a time (results opened in a new tab). */
  popupsSince?(since: number): { id: string; url: string; title: string }[];
  /** Observes another tab without switching to it. */
  peek?(tabId: string): Promise<Model>;
  /** Moves the task to another tab (it takes the lease). */
  switchTo?(tabId: string): void;
  /** False for browsers nobody can see (headless): user takeover detection is skipped. */
  interactive?(): boolean;
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
  | { type: 'reveal'; key: string }
  | { type: 'apply_sort' }
  | { type: 'extract' }
  | { type: 'load_more' }
  | { type: 'close_popup' }
  | { type: 'scroll' }
  | { type: 'go_back' }
  | { type: 'reload' }
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

/** Does the page's address or title carry the value (a filter applied by navigation)? */
function pageShowsValue(model: PageModel, want: string): boolean {
  let url = model.url;
  try { url = decodeURIComponent(url); } catch { /* keep raw */ }
  const hay = normalizeText(`${url.replace(/[-_+/?=&.]+/g, ' ')} ${model.title}`);
  return want.length >= 2 && hay.includes(want);
}

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
  private hints: Hint[];
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
  private dismissed = new Set<string>();
  private submitsDone = 0;
  private revealTried = new Set<string>();
  /** Error pages already reloaded once (by URL). */
  private reloaded = new Set<string>();
  private noResultsOn: string | null = null;
  private errorPages = 0;
  /** Address right after the last submit: a later change means the site applied filters itself. */
  private lastSubmitUrl: string | null = null;
  /** Params changed since the last submit: filters on list pages apply only after "Show N results". */
  private dirty = false;
  private sortTried = false;
  private sortedBy: string | null = null;
  private collected = new Map<string, { item: Record<string, unknown>; snippets: string[]; url: string; relevant: boolean }>();
  /** Per step: elements tried and rolled back (by signature), so the next grounding skips them. */
  private rejected = new Map<string, { sig: string; desc: string }[]>();
  /** Set when a step ended in a rollback: the retry is progress, not a loop. */
  private trialRolledBack = false;

  constructor(spec: TaskSpec, deps: TaskDeps, id = newId('t')) {
    super();
    this.id = id;
    this.sessionId = deps.sessionId;
    this.spec = spec;
    this.deps = deps;
    this.hints = spec.hints.map((text) => ({ text, source: 'task' as const }));
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
    if (patch.hints) this.hints.push(...patch.hints.map((text) => ({ text, source: 'task' as const })));
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
      for (const h of this.deps.memory.hints(host)) if (!this.hints.some((x) => x.text === h.text)) this.hints.push(h);
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
      if (this.deps.port.reset) {
        log.warn(`task ${this.id}: observation failed (${(e as Error).message}); re-attaching to the tab`);
        try {
          await this.deps.port.reset();
          this.model = await this.deps.port.observe({ settle });
          return this.model;
        } catch { /* fall through */ }
      }
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
    // A person using the tab takes over: pause until resumed (only where a person can see the browser).
    const page = await this.page();
    if (this.state === 'running' && this.deps.port.interactive?.() !== false && await page.userInputSince(this.lastInputCheck)) {
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
      // A hint given to a question about one step belongs to that step and its param; others apply to the whole task.
      const bind = kind === 'ground' ? this.hintBinding() : {};
      this.hints.push({ text: answer.text, source: kind === 'ground' ? 'answer' : 'task', ...bind });
      if (answer.scope === 'domain' && this.deps.memory && model) this.deps.memory.addHint(hostOf(model.url), answer.text, bind);
    }
    if (answer.type === 'thresholds') this.liveConfidence = answer.value;
    if (answer.type === 'set_param') {
      this.params[answer.key] = { value: answer.value, about: answer.about ?? this.params[answer.key]?.about, secret: answer.secret };
      this.status[answer.key] = 'pending';
      delete this.absentOn[answer.key];
    }
    return answer;
  }

  private hintBinding(): { step?: string; key?: string; about?: string } {
    const sub = this.lastSub;
    if (!sub) return {};
    const key = 'key' in sub ? sub.key.split(':')[0] : undefined;
    const p = key ? this.params[key] : undefined;
    return { step: sub.type, ...(key && p ? { key, about: aboutOf(key, p) } : {}) };
  }

  private sortOrder(): string {
    const m = (this.spec.result?.select ?? '').match(/^(min|max)\((\w+)\)$/);
    if (!m) return 'as the goal asks';
    const fieldSpec = this.spec.result!.schema?.[m[2]];
    const about = (typeof fieldSpec === 'object' && fieldSpec.about) || m[2].replace(/_/g, ' ');
    return m[1] === 'min' ? `by ${about}, lowest first (ascending, cheapest first)` : `by ${about}, highest first (descending)`;
  }

  /**
   * Memory keys for a step: a remembered value button ("Павлодар") only serves the same value, a remembered field
   * serves any value. Lookups try the value key first.
   */
  private memKeys(sub: Subintent, memoryKey: string): string[] {
    const p = sub.type === 'fill_param' ? this.params[sub.key] : undefined;
    if (!p || p.secret || typeof p.value === 'boolean') return [memoryKey];
    return [`${memoryKey}=${normalizeText(String(p.value))}`, memoryKey];
  }

  private memKeyFor(sub: Subintent, memoryKey: string, el: ElementNode): string {
    const [valueKey, fieldKey] = this.memKeys(sub, memoryKey);
    if (!fieldKey) return valueKey;
    const want = normalizeText(String((this.params as Record<string, ParamSpec>)[(sub as { key: string }).key].value));
    return isValueLabel(el.name, want) || isValueLabel(el.text ?? '', want) ? valueKey : fieldKey;
  }

  /** What the step does, for JEV: the param and its value, or the step's purpose. */
  private card(sub: Subintent): StepCard {
    const key = 'key' in sub ? sub.key.split(':')[0] : undefined;
    const p = key ? this.params[key] : undefined;
    switch (sub.type) {
      case 'fill_param': case 'pick_suggestion': case 'pick_date':
        return p ? paramCard(sub.type, key!, p) : stepCard(sub.type, label(sub));
      case 'reveal':
        return p ? paramCard('reveal', key!, p, `find where the ${aboutOf(key!, p)} can be set`) : stepCard('reveal', 'show more search filters');
      case 'apply_sort': return stepCard('apply_sort', `sort the results ${this.sortOrder()}`);
      case 'submit': return stepCard('submit', 'submit the search form');
      case 'dismiss_overlay': return stepCard('dismiss_overlay', `close the ${sub.overlayKind.replace(/_/g, ' ')} overlay`);
      default: return stepCard(sub.type, label(sub));
    }
  }

  /**
   * Grounding with memory fast path, forced refs from answers, trials and escalation when unsure. `trial` in the
   * result means the step is reversible and has tries left: the caller verifies the effect and calls `trialFailed`
   * (roll back, try the next candidate) when it did not work. Low-confidence leaders are only returned as trials.
   */
  private async ground(sub: Subintent, intent: Intent, memoryKey?: string): Promise<{ el: ElementNode | null; res?: GroundResult; answer?: AnswerInput; trial?: boolean }> {
    const model = this.model!;
    const subLabel = label(sub);
    if (this.forcedRef && this.forcedRef.sub === subLabel) {
      const el = model.elements.get(this.forcedRef.ref) ?? null;
      this.forcedRef = null;
      if (el) return { el };
    }
    const th = this.th();
    const tried = this.rejected.get(subLabel) ?? [];
    const trial = !!intent.trial && th.trial.enabled && tried.length < th.trial.tries;
    intent = { ...intent, trial, exclude: tried.map((t) => t.sig) };
    const card = this.card(sub);
    const host = hostOf(model.url);
    const pageKind = this.assessCache?.out.pageKind ?? 'other';
    if (memoryKey && this.deps.memory && this.deps.getConfig().memory.enabled) {
      let hit = null;
      let el: ElementNode | undefined;
      for (const key of this.memKeys(sub, memoryKey)) {
        hit = this.deps.memory.lookup(host, pageKind, key);
        el = hit ? [...model.elements.values()].find((e) => e.sig === hit!.sig && e.visible && !intent.exclude!.includes(e.sig)) : undefined;
        if (hit && el) break;
      }
      if (hit && el) {
        // A remembered element for a reversible step is simply tried first: the effect check confirms it.
        if (trial) {
          this.memoryUse = { id: hit.id, host, pageKind, key: hit.key };
          return { el, trial: true };
        }
        const res = await runQuestions(this.qctx(), {
          template: 'ground.memory_confirm',
          state: buildState({ goal: this.spec.goal, step: card, intent: { target: intent.target }, extra: { element: renderCandidate(model, el.ref) } }, this.budget()),
          questions: { same: { type: 'noul', instructions: 'Is `element` `intent.target`?' } },
        });
        // The agent or a verified step confirmed this element before: keep it unless JEV clearly disagrees.
        if (gateNoul(noulOf(res.answers, 'same'), th.ground.noul) !== 'no') {
          this.memoryUse = { id: hit.id, host, pageKind, key: hit.key };
          return { el };
        }
        this.deps.memory.recordFailure(hit.id);
      }
    }
    const res = await groundByIntent(this.qctx(), model, intent, th, { goal: this.spec.goal, step: card, hints: hintsFor(this.hints, card), budgetTokens: this.budget() });
    if ((res.decision === 'act' || res.decision === 'try') && res.ref) {
      const el = model.elements.get(res.ref)!;
      if (memoryKey) this.memoryUse = { id: null, host, pageKind, key: this.memKeyFor(sub, memoryKey, el), sig: el.sig };
      this.groundCalls = res.callIds;
      // Reversible steps verify and roll back whatever the confidence: a confident pick can still be the wrong list.
      return { el, res, trial };
    }
    if (res.decision === 'none') return { el: null, res };
    const thc = th.ground.choice;
    const triedNote = tried.length ? ` Already tried and rolled back: ${tried.map((t) => t.desc).join('; ')}.` : '';
    const answer = await this.escalate('ground', `Unsure which element is ${intent.target}.${triedNote}`, {
      decision: { template: 'ground.element', asked: `Which element is ${intent.target}?`, candidates: res.candidates, confidence: res.confidence, thresholds: { act: thc.act, escalate: thc.escalate } },
      answer_with: ['pick', 'none', 'hint', 'skip', 'thresholds', 'set_param', 'abort'],
    });
    if (answer.type === 'none') {
      // The agent says the target is not on this page: behave as if JEV had said so.
      for (const id of res.callIds) this.deps.trace.labelCall(id, false, 'agent: not on page');
      return { el: null, res: { ...res, ref: null, decision: 'none' }, answer };
    }
    if (answer.type === 'pick') {
      const fresh = await this.observe(false);
      const el = fresh.elements.get(answer.ref) ?? null;
      if (el && answer.remember && memoryKey && this.deps.memory) this.deps.memory.recordSuccess(host, pageKind, this.memKeyFor(sub, memoryKey, el), el.sig);
      // The agent's pick is ground truth for the trace (calibration labels).
      for (const id of res.callIds) this.deps.trace.labelCall(id, res.ref === answer.ref, 'agent pick');
      return { el, res, answer };
    }
    return { el: null, res, answer };
  }

  /**
   * A trial did not have the expected effect: undo it (back, Escape, restore the value, re-click a toggle), remember
   * the element as rejected for this step and let the next iteration ground again without it.
   */
  private async trialFailed(sub: Subintent, el: ElementNode, before: Model, why: string): Promise<Outcome> {
    const page = await this.page();
    for (let i = 0; i < 3; i++) {
      const now = await this.observe(false);
      const [act] = rollbackPlan(before, now, el);
      if (!act) break;
      const cur = now.elements.get(el.ref);
      if (act === 'back') { if (!(await page.back())) break; }
      else if (act === 'escape') await page.press('Escape');
      else if (act === 'restore' && cur) await page.type(cur.backendNodeId, el.value ?? '', { mode: 'insert', clear: true, sessionId: cur.frameSessionId });
      else if (act === 'reclick' && cur) await this.click(cur);
      await this.settle();
    }
    const key = label(sub);
    this.rejected.set(key, [...(this.rejected.get(key) ?? []), { sig: el.sig, desc: `${el.ref} ${describeElement(el)}` }]);
    if ('key' in sub && this.status[sub.key] === 'typed') this.status[sub.key] = 'pending';
    this.lastTypedKey = null;
    this.settleGrounding(false);
    this.trialRolledBack = true;
    return { outcome: 'retry', note: `tried ${el.ref} "${el.name}" for ${key}: ${why}; rolled back` };
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
    if (this.trialRolledBack) {
      // The page is back where it was, but one candidate fewer remains: that is progress, not a loop.
      this.trialRolledBack = false;
      this.seen.set(loopKey, Math.max(0, seen - 1));
    }
    if (out.outcome === 'ok') this.rejected.delete(subLabel);
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
    const overlays = [
      ...model.regions.filter((r) => (r.kind === 'overlay' || r.kind === 'dialog') && r.blocking),
      ...model.regions.filter((r) => r.kind === 'overlay' && !r.blocking && !this.dismissed.has(r.sig) && this.regionVisible(model, r)).slice(0, 2),
    ];
    const allDone = Object.values(this.status).every((s) => s !== 'pending' && s !== 'typed');
    const input = {
      model, goal: this.spec.goal, params: this.params, progress: this.status, hints: hintsFor(this.hints),
      uncertainParams: Object.keys(this.status).filter((k) => this.status[k] === 'typed' && !this.params[k].secret),
      overlays, requiredEmpty: allDone ? requiredEmptyFields(model) : [], hasResultSchema: !!this.spec.result, budgetTokens: this.budget(),
    };
    const res = await runQuestions(this.qctx(), buildAssess(input));
    const out = readAssess(res.answers, input);
    this.assessCache = { sig: model.signature, out };
    return out;
  }

  /**
   * Options of popups that belong to a field: popups near it (below or beside, as autocompletes render), or all
   * popups when no field is given. Unrelated floating layers (ads, chat widgets) are ignored.
   */
  private popupOptions(model: Model, near?: ElementNode): ElementNode[] {
    const popups = model.regions.filter((r) => r.kind === 'popup' || (r.kind === 'list' && r.parentId && model.regions.find((p) => p.id === r.parentId)?.kind === 'popup'));
    const close = near ? popups.filter((r) => {
      const f = near.rect;
      const verticalGap = r.rect.y - (f.y + f.h);
      const horizontalOverlap = Math.min(r.rect.x + r.rect.w, f.x + f.w) - Math.max(r.rect.x, f.x);
      return verticalGap > -f.h - 20 && verticalGap < 420 && horizontalOverlap > -40;
    }) : popups;
    const ids = new Set(close.map((r) => r.id));
    for (const r of model.regions) if (r.parentId && ids.has(r.parentId)) ids.add(r.id);
    return [...model.elements.values()].filter((e) => e.visible && e.interactive && ids.has(e.regionId)
      && ['option', 'menuitem', 'link', 'button', 'clickable'].includes(e.kind));
  }

  /** Options that appeared after clicking a trigger: a popup near it, or new controls from the diff. */
  private revealedOptions(before: Model, after: Model, trigger?: ElementNode): ElementNode[] {
    const near = this.popupOptions(after, trigger);
    if (near.length) return near;
    const diff = diffModels(before, after);
    const kinds = new Set(['option', 'menuitem', 'checkbox', 'radio', 'button', 'clickable', 'link']);
    return diff.added.map((r) => after.elements.get(r)).filter((e): e is ElementNode => !!e && e.visible && e.interactive && kinds.has(e.kind)
      && (!trigger || Math.abs(e.rect.y - trigger.rect.y) < 700));
  }

  private fieldOf(model: Model, key: string): ElementNode | undefined {
    const ref = this.paramRefs[key];
    return ref ? model.elements.get(ref) : undefined;
  }

  private async chooseSubintent(model: Model, a: AssessOutput): Promise<Subintent> {
    const th = this.th();
    const yes = (v: number, kind: DecisionKind = 'assess') => gateNoul(v, th[kind].noul) === 'yes';
    // Results reached without our submit (an autocomplete pick or a filter link started the search) count as one.
    if (a.pageKind === 'results_list' && this.submitsDone === 0) {
      this.submitsDone = 1;
      this.lastSubmitUrl = model.url;
    }
    // A server error is often transient: reload once, then go back. "Nothing found" is a question for the agent.
    if (a.pageKind === 'error' && a.pageKindConfidence >= th.assess.choice.escalate) {
      this.errorPages++;
      if (this.errorPages >= 3) {
        // Errors that survive a reload and a step back usually mean the site limits automated browsing.
        this.errorPages = 0;
        return {
          type: 'blocker', kind: 'site_error',
          summary: 'The site keeps showing error pages (a reload and going back did not help); it may be limiting automated browsing. Try later, or rerun with driver "extension" (your Chrome); answer "continue" to retry now, or abort.',
        };
      }
      return this.reloaded.has(model.url) ? { type: 'go_back' } : { type: 'reload' };
    }
    if (a.pageKind === 'no_results' && a.pageKindConfidence >= th.assess.choice.act && this.spec.result && this.noResultsOn !== model.signature) {
      // Asked once per page state; after the answer (a new param, a hint, or "continue") the usual rules apply.
      this.noResultsOn = model.signature;
      await this.escalate('assess', 'The search found nothing for these params. Change a param (set_param), give a hint, answer "continue" to read the page anyway, or abort.', {
        answer_with: ['set_param', 'hint', 'continue', 'abort'],
      });
    }
    if (a.pageKind === 'captcha' && a.pageKindConfidence >= th.assess.choice.escalate) {
      return { type: 'blocker', kind: 'captcha', summary: 'The page shows a CAPTCHA or bot check. Solve it in the browser (or ask the user), then answer "continue".' };
    }
    const blocking = model.regions.filter((r) => (r.kind === 'overlay' || r.kind === 'dialog') && r.blocking);
    for (const r of blocking) {
      const kind = a.overlays[r.id]?.kind ?? 'other';
      if (kind === 'captcha') {
        return { type: 'blocker', kind: 'captcha', summary: 'The site shows a CAPTCHA / bot check. Solve it in the browser (or ask the user to), then answer "continue".' };
      }
      return { type: 'dismiss_overlay', region: r.id, overlayKind: kind };
    }
    // Non-blocking cookie notices are dismissed once, proactively (they tend to cover results and buttons).
    for (const r of model.regions) {
      const o = a.overlays[r.id];
      if (r.kind === 'overlay' && !r.blocking && !this.dismissed.has(r.sig) && o?.kind === 'cookie_consent' && o.confidence >= th.assess.choice.act) {
        return { type: 'dismiss_overlay', region: r.id, overlayKind: 'cookie_consent' };
      }
    }
    // Suggestions right after typing a param.
    if (this.lastTypedKey && this.lastSub?.type === 'fill_param' && this.status[this.lastTypedKey] !== 'skipped'
      && this.popupOptions(model, this.fieldOf(model, this.lastTypedKey)).length) {
      return { type: 'pick_suggestion', key: this.lastTypedKey };
    }
    // An open calendar with a pending date param.
    const pendingDate = Object.keys(this.params).find((k) => paramKind(this.params[k]) === 'date' && this.status[k] === 'pending');
    if (pendingDate && this.popupCalendar(model).length >= 7) return { type: 'pick_date', key: pendingDate };
    // Params come first while the page still has a form for them (sites often preview results before the search).
    // A param counts as pending while it can still be filled here, or revealed behind "more filters".
    const pendingKeys = Object.keys(this.params).filter((k) => (this.status[k] === 'pending' || this.status[k] === 'typed')
      && (this.absentOn[k] !== model.signature || !this.revealTried.has(k)));
    const hasForm = model.regions.some((r) => r.kind === 'form');
    // After a search, filters that moved the page to a new address were applied by the site: no second submit.
    if (this.dirty && this.submitsDone > 0 && this.lastSubmitUrl && model.url !== this.lastSubmitUrl) this.dirty = false;
    if (this.spec.result && this.dirty && hasForm && !pendingKeys.length) return { type: 'submit' };
    // Params first while one of them can still be looked for here (filters are often dropdown buttons outside any form).
    if (this.spec.result && !pendingKeys.length && (a.pageKind === 'results_list' || (yes(a.resultsMatch) && model.regions.some((r) => r.kind === 'list')))) {
      // For min/max, let the site sort first: then the first page holds the answer instead of every page.
      if (!this.sortTried && /^(min|max)\(/.test(this.spec.result.select ?? '')) return { type: 'apply_sort' };
      return { type: 'extract' };
    }
    if (!this.spec.result && yes(a.goalReached) && Object.values(this.status).every((s) => s !== 'pending')) return { type: 'done', reason: 'goal reached' };
    const onForm = ['search_form', 'login', 'other', 'item_details', 'checkout'].includes(a.pageKind) || pendingKeys.length > 0;
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
      // A param with no field here usually lives on the results page (filters come with results): search first.
      // Only then look behind "advanced search" / "more filters", once.
      const anyFilled = Object.values(this.status).some((s) => s === 'done');
      if (this.submitsDone > 0 || !anyFilled) {
        for (const k of Object.keys(this.params)) {
          if ((this.status[k] === 'pending' || this.status[k] === 'typed') && this.absentOn[k] === model.signature && !this.revealTried.has(k)) {
            return { type: 'reveal', key: k };
          }
        }
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
      if ((a.pageKind === 'search_form' || (hasForm && this.submitsDone === 0 && anyDone)) && (anyDone || Object.keys(this.params).length === 0)) return { type: 'submit' };
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
    const res = await runQuestions(this.qctx(), buildDecide({ model, goal: this.spec.goal, params: this.params, progress: this.status, hints: hintsFor(this.hints), recent: this.recent, options, budgetTokens: this.budget() }));
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
        const headless = this.deps.port.interactive?.() === false;
        const summary = headless
          ? `${sub.summary} This tab runs in a headless browser nobody can see: restart the task with driver "extension" (your Chrome) or set driver.chromium.headless=false, or abort.`
          : sub.summary;
        const ans = await this.escalate('blocker', summary, { answer_with: ['continue', 'hint', 'abort'], context: { headless } });
        return { outcome: 'retry', note: `blocker (${sub.kind}): ${ans.type}` };
      }
      case 'dismiss_overlay': return this.dismissOverlay(sub, model);
      case 'fill_param': return this.fillParam(sub, model);
      case 'pick_suggestion': return this.pickSuggestion(sub.key, model);
      case 'pick_date': return this.pickDate(sub, model);
      case 'submit': return this.submit(sub, model, a);
      case 'reveal': return this.reveal(sub, model);
      case 'apply_sort': return this.applySort(sub, model);
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
      case 'reload': {
        this.reloaded.add(model.url);
        await (await this.page()).navigate(model.url);
        await this.settle();
        this.recheckParams();
        return { outcome: 'ok', note: 'the page showed an error; reloaded it', action: { type: 'reload' } };
      }
      case 'go_back': {
        const ok = await (await this.page()).back();
        await this.settle();
        this.recheckParams();
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

  /** After going back or reloading, typed values may be gone: let the next assess check them again. */
  private recheckParams(): void {
    for (const [k, st] of Object.entries(this.status)) {
      if (st === 'done' && paramKind(this.params[k]) === 'text' && !this.params[k].secret) this.status[k] = 'typed';
    }
  }

  private async settle(): Promise<void> {
    await (await this.page()).waitForSettle({ maxMs: this.deps.getConfig().limits.settleMaxMs });
  }

  private async click(el: ElementNode): Promise<void> {
    const page = await this.page();
    try {
      await page.click(el.backendNodeId, { sessionId: el.frameSessionId });
    } catch (e) {
      // Something we did not see as a layer covers the target (tutorial dimmers, tooltips): Escape usually closes it.
      if ((e as { reason?: string }).reason !== 'occluded') throw e;
      await page.press('Escape');
      await this.settle();
      await page.click(el.backendNodeId, { sessionId: el.frameSessionId });
    }
  }

  private regionVisible(model: Model, r: Region): boolean {
    return r.refs.some((ref) => { const e = model.elements.get(ref); return !!e && e.visible && e.inViewport; });
  }

  private async dismissOverlay(sub: Extract<Subintent, { type: 'dismiss_overlay' }>, model: Model): Promise<Outcome> {
    const region = model.regions.find((r) => r.id === sub.region) as Region;
    if (region) this.dismissed.add(region.sig);
    const what = sub.overlayKind === 'cookie_consent' ? 'the button that accepts the cookie notice (or closes it)'
      : sub.overlayKind === 'login_wall' ? 'the button that closes the sign-in prompt without signing in'
      : `the button that closes or dismisses this ${sub.overlayKind === 'promo' ? 'promotion' : 'overlay'} without signing up or buying`;
    const g = await this.ground(sub, { target: `${what}${region?.label ? ` ("${region.label}")` : ''}`, kinds: ['button', 'link', 'clickable', 'menuitem'], regionId: sub.region, action: 'click', trial: true }, `dismiss:${sub.overlayKind}`);
    const page = await this.page();
    const before = this.model!;
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
    const ok = !after.regions.some((r) => r.id === sub.region && (r.blocking || this.regionVisible(after, r)));
    if (!ok && g.trial) {
      if (region) this.dismissed.delete(region.sig);
      return this.trialFailed(sub, g.el, before, 'the overlay is still there');
    }
    this.settleGrounding(ok);
    return { outcome: ok ? 'ok' : 'failed', note: `${ok ? 'dismissed' : 'tried to dismiss'} ${sub.overlayKind} overlay via ${g.el.ref} "${g.el.name}"`, action: { type: 'click', ref: g.el.ref } };
  }

  private async fillParam(sub: Extract<Subintent, { type: 'fill_param' }>, model: Model): Promise<Outcome> {
    const k = sub.key;
    const p = this.params[k];
    const about = p.about ?? k.replace(/_/g, ' ');
    const kind = paramKind(p);
    const g = await this.ground(sub, paramIntent(k, p), `param:${k}`);
    if (!g.el) {
      if (g.answer?.type === 'skip') { this.status[k] = 'skipped'; return { outcome: 'skipped', note: `skipped param ${k}` }; }
      if (g.res?.decision === 'none') { this.absentOn[k] = model.signature; return { outcome: 'skipped', note: `no field for ${k} on this page` }; }
      return { outcome: 'retry', note: `no field chosen for ${k}` };
    }
    const el = g.el;
    const before = this.model!;
    const trial = !!g.trial;
    this.paramRefs[k] = el.ref;
    const page = await this.page();
    if (kind === 'boolean') {
      const want = p.value === true;
      const on = (e: ElementNode) => (e.states.checked ?? e.states.selected ?? false) === true;
      if (on(el) !== want) await this.click(el);
      await this.settle();
      if (trial) {
        const cur = (await this.observe(false)).elements.get(el.ref);
        if (!cur || on(cur) !== want) return this.trialFailed(sub, el, before, 'the switch did not change');
      }
      this.status[k] = 'done';
      this.dirty = true;
      this.settleGrounding(true);
      return { outcome: 'ok', note: `${want ? 'checked' : 'unchecked'} ${el.ref} "${el.name}" for ${k}`, action: { type: 'check', ref: el.ref, value: want } };
    }
    if (el.kind === 'select') {
      const opts = el.options ?? [];
      const res = await runQuestions(this.qctx(), buildOptionPick(opts, this.params, k, this.budget()));
      const pick = choiceOf(res.answers, 'pick');
      if (pick.choice === 'none' && trial) return this.trialFailed(sub, el, before, `none of its options matches "${String(p.value)}"`);
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
      this.dirty = true;
      await this.settle();
      this.settleGrounding(true);
      return { outcome: 'ok', note: `selected ${k} in ${el.ref} "${el.name}"`, action: { type: 'select', ref: el.ref } };
    }
    // Anything clickable is either the value itself (a chip, option, filter link) or the trigger of a list of values.
    // A combobox that is not a text input (a div or button with role combobox) is a dropdown, not a field to type in.
    const typable = el.tag === 'input' || el.tag === 'textarea' || el.attrs.contenteditable === 'true';
    if (['clickable', 'button', 'option', 'menuitem', 'radio', 'checkbox', 'link', 'tab'].includes(el.kind) || (el.kind === 'combobox' && !typable)) {
      return this.pickFromDropdown(sub, el, before, trial);
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
    if (!typedOk && trial) return this.trialFailed(sub, el, before, 'the field did not take the value');
    this.settleGrounding(typedOk);
    const note = `typed ${p.secret ? '[secret]' : `"${value}"`} into ${el.ref} "${el.name}" for ${k}`;
    if (this.popupOptions(after, field).length) {
      const picked = await this.pickSuggestion(k, after);
      return { outcome: picked.outcome, note: `${note}; ${picked.note}`, action: { type: 'type', ref: el.ref, param: k, then: picked.action } };
    }
    // No suggestions appeared after the page settled: the value is in. (Late suggestions or validation errors
    // bring the param back: see the pick_suggestion rule and submit's validation handling.)
    if (typedOk) { this.status[k] = 'done'; this.dirty = true; }
    return { outcome: typedOk ? 'ok' : 'failed', note, action: { type: 'type', ref: el.ref, param: k } };
  }

  /**
   * Does a control whose label is not literally the value stand for it anyway ("Новый" for "New", "Almaty" for
   * "Алматы")? Sites pick their UI language themselves; the agent cannot know it. Dropdown openers are not asked.
   */
  private async standsForValue(sub: Extract<Subintent, { type: 'fill_param' }>, el: ElementNode): Promise<boolean> {
    const label = (el.name || el.text || '').trim();
    if (!label || label.length > 40 || el.states.expanded !== undefined || el.attrs['aria-haspopup']) return false;
    if (el.hints?.some((h) => /dropdown|toggle|select|picker/.test(h))) return false;
    const res = await runQuestions(this.qctx(), {
      template: 'widget.same_value',
      state: buildState({ step: this.card(sub), extra: { element: renderCandidate(this.model!, el.ref) } }, this.budget()),
      questions: { same: { type: 'noul', instructions: 'Does `element` show the value `step.value` itself (the same value, possibly translated or abbreviated), rather than a field or list for choosing it?' } },
    });
    // A wrong "yes" only costs a verified, rolled-back trial: the bar is lower than for acting blind.
    return noulOf(res.answers, 'same') >= 0.5;
  }

  /** Custom dropdowns (div-based selects, multi-select checkboxes): open, pick the option matching the value, close. */
  private async pickFromDropdown(sub: Extract<Subintent, { type: 'fill_param' }>, trigger: ElementNode, model: Model, trial: boolean): Promise<Outcome> {
    const k = sub.key;
    const p = this.params[k];
    const want = normalizeText(String(p.value));
    if (isValueLabel(trigger.name, want) || isValueLabel(trigger.text ?? '', want) || await this.standsForValue(sub, trigger)) {
      // A quick-select button that IS the value ("Павлодар", "Toyota"): press it unless it is already on.
      if (!trigger.states.selected && !trigger.states.checked) {
        await this.click(trigger);
        await this.settle();
        if (trial && !hadEffect(model, await this.observe(false), trigger)) return this.trialFailed(sub, trigger, model, 'pressing it changed nothing');
      }
      this.status[k] = 'done';
      this.dirty = true;
      this.settleGrounding(true);
      return { outcome: 'ok', note: `pressed ${trigger.ref} "${trigger.name}" for ${k}`, action: { type: 'click', ref: trigger.ref, param: k } };
    }
    // A dropdown trigger that already shows the value ("Караганда ▾" instead of "Город ▾").
    if ((trigger.kind === 'button' || trigger.kind === 'clickable') && showsValue(trigger, want)) {
      this.status[k] = 'done';
      return { outcome: 'ok', note: `${k} already set in ${trigger.ref} "${trigger.name}"` };
    }
    await this.click(trigger);
    await this.settle();
    const opened = await this.observe(false);
    if (opened.url !== model.url) {
      // A filter link ("Toyota Camry" → /cars/toyota/camry/): the navigation itself applies the value.
      if (pageShowsValue(opened, want)) {
        this.status[k] = 'done';
        this.dirty = true;
        this.settleGrounding(true);
        return { outcome: 'ok', note: `followed ${trigger.ref} "${trigger.name}" for ${k}; the page now shows "${String(p.value)}"`, action: { type: 'click', ref: trigger.ref, param: k } };
      }
      if (trial) return this.trialFailed(sub, trigger, model, 'it opened a page without the value');
    }
    const options = this.revealedOptions(model, opened, opened.elements.get(trigger.ref) ?? trigger).slice(0, 60);
    if (!options.length) {
      if (trial) return this.trialFailed(sub, trigger, model, 'no options appeared');
      return { outcome: 'failed', note: `clicked ${trigger.ref} "${trigger.name}" but no options appeared` };
    }
    const res = await runQuestions(this.qctx(), buildSuggestionPick(opened, options.map((o) => o.ref), this.params, k, this.budget()));
    const pick = choiceOf(res.answers, 'pick');
    let ref = pick.choice;
    if (ref === 'none' && trial) {
      // Wrong list (a city list for a brand): close it and try the next control.
      await (await this.page()).press('Escape');
      await this.settle();
      return this.trialFailed(sub, trigger, model, `its options do not include "${String(p.value)}"`);
    }
    if (ref === 'none' || gateChoice(pick, this.th().ground.choice) !== 'act') {
      const ans = await this.escalate('ground', `Unsure which option of "${trigger.name}" matches ${k} = "${String(p.value)}".`, {
        decision: { template: 'widget.suggestion_pick', asked: `Which option matches params.${k}?`, confidence: pick.confidence,
          candidates: topCandidates(pick, 5, ['none']).map((c) => ({ ref: c.key, p: c.p, desc: describeElement(opened.elements.get(c.key)!) })) },
        answer_with: ['pick', 'none', 'set_param', 'skip', 'abort'],
      });
      if (ans.type !== 'pick') {
        await (await this.page()).press('Escape');
        if (ans.type === 'skip') this.status[k] = 'skipped';
        return { outcome: ans.type === 'skip' ? 'skipped' : 'retry', note: `no option chosen for ${k}` };
      }
      ref = ans.ref;
    }
    const opt = opened.elements.get(ref);
    if (!opt) return { outcome: 'failed', note: `option ${ref} vanished` };
    await this.click(opt);
    await this.settle();
    // Multi-select dropdowns stay open: close them so they do not cover the form.
    const after = await this.observe(false);
    if (after.elements.get(ref)?.visible && after.elements.get(ref)?.inViewport) {
      await (await this.page()).press('Escape');
      await this.settle();
    }
    this.status[k] = 'done';
    this.dirty = true;
    this.lastTypedKey = null;
    this.deps.trace.labelCall(res.callId, true, 'dropdown pick');
    this.settleGrounding(true);
    return { outcome: 'ok', note: `opened ${trigger.ref} "${trigger.name}" and picked ${ref} "${opt.name}" for ${k}`, action: { type: 'click', ref, param: k } };
  }

  private async pickSuggestion(k: string, model: Model): Promise<Outcome> {
    const options = this.popupOptions(model, this.fieldOf(model, k));
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
    const stillOpen = this.popupOptions(after, this.fieldOf(after, k)).some((o) => o.ref === ref);
    this.deps.trace.labelCall(res.callId, !stillOpen, 'suggestion click');
    this.status[k] = stillOpen ? 'typed' : 'done';
    if (!stillOpen) this.dirty = true;
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
    // Only an open picker counts before we click the date field (pages also list prices by date elsewhere).
    let cells = this.popupCalendar(current);
    if (cells.length < 7) {
      const g = await this.ground(sub, { target: `the field or button that opens the date picker for the ${about}`, kinds: ['textbox', 'combobox', 'button', 'clickable', 'link'], action: 'click', trial: true }, `date:${k}`);
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
      const before = this.model!;
      await this.click(g.el);
      await this.settle();
      current = await this.observe(false);
      cells = parseCalendarCells(current, this.refDate());
      if (cells.length < 7 && g.trial) return this.trialFailed(sub, g.el, before, 'no calendar appeared');
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
        this.dirty = true;
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

  /**
   * Sites often open results in a new tab (and send the old tab elsewhere). If our tab opened tabs, JEV picks the
   * tab that continues the goal and the task moves there.
   */
  private async followPopups(since: number, what: string): Promise<string | null> {
    const port = this.deps.port;
    if (!port.popupsSince || !port.peek || !port.switchTo) return null;
    await new Promise((r) => setTimeout(r, 600));
    const popups = port.popupsSince(since);
    if (!popups.length) return null;
    const current = await this.observe(false);
    const tabs: Record<string, string> = { current: `"${current.title}" ${current.url}` };
    const ids: Record<string, string> = {};
    for (const [i, p] of popups.slice(0, 5).entries()) {
      const m = await port.peek(p.id).catch(() => null);
      tabs[`new_${i}`] = m ? `"${m.title}" ${m.url}` : `${p.title} ${p.url}`;
      ids[`new_${i}`] = p.id;
    }
    const criteria = Object.fromEntries(Object.keys(tabs).map((k) => [k, null]));
    const res = await runQuestions(this.qctx(), {
      template: 'tabs.follow',
      state: buildState({ goal: this.spec.goal, extra: { tabs, expected: what } }, this.budget()),
      questions: { tab: { type: 'choice', instructions: 'Which tab in `tabs` shows `expected` for `goal`?', criteria } },
    });
    const pick = choiceOf(res.answers, 'tab');
    if (pick.choice === 'current' || !ids[pick.choice]) return null;
    port.switchTo(ids[pick.choice]);
    this.note(`followed a new tab: ${tabs[pick.choice]}`);
    await this.observe();
    return `continued in the new tab ${tabs[pick.choice]}`;
  }

  /** Calendar cells inside an open popup, overlay or dialog. */
  private popupCalendar(model: Model) {
    return parseCalendarCells(model, this.refDate()).filter((c) => this.layerRegion(model, c.regionId) !== undefined);
  }

  /** Opens "advanced search" / "more filters" (or a tab) that may hold the field for a param. */
  private async reveal(sub: Extract<Subintent, { type: 'reveal' }>, model: Model): Promise<Outcome> {
    const k = sub.key;
    this.revealTried.add(k);
    const about = this.params[k].about ?? k.replace(/_/g, ' ');
    const g = await this.ground(sub, {
      target: `the button, link or tab that shows more search filters (such as advanced search or "more filters") where the ${about} can be set`,
      kinds: ['button', 'link', 'clickable', 'tab'], action: 'click', trial: true,
    }, `reveal:${k}`);
    if (!g.el) return { outcome: 'skipped', note: `no control reveals a field for ${k}; continuing without it` };
    const before = this.model!;
    await this.click(g.el);
    await this.settle();
    if (g.trial) {
      const after = await this.observe(false);
      const added = diffModels(before, after).added.filter((r) => after.elements.get(r)?.interactive && after.elements.get(r)?.visible).length;
      if (after.url === before.url && added < 2) {
        this.revealTried.delete(k);
        return this.trialFailed(sub, g.el, before, 'no new filters appeared');
      }
    }
    delete this.absentOn[k];
    this.settleGrounding(true);
    return { outcome: 'ok', note: `opened ${g.el.ref} "${g.el.name}" to look for the ${about} field`, action: { type: 'click', ref: g.el.ref } };
  }

  /** Uses the site's own sorting so the extreme value is on the first page. */
  private async applySort(sub: Extract<Subintent, { type: 'apply_sort' }>, model: Model): Promise<Outcome> {
    this.sortTried = true;
    const select = this.spec.result!.select!;
    const order = this.sortOrder();
    const g = await this.ground(sub, {
      target: `the control that sorts the result list ${order}, or the sort menu that offers this order`,
      kinds: ['select', 'combobox', 'button', 'link', 'tab', 'clickable', 'option', 'radio'], action: 'click', trial: true,
    }, `sort:${select}`);
    if (!g.el) return { outcome: 'skipped', note: 'no sort control found; reading results as listed' };
    const page = await this.page();
    const start = this.model!;
    const before = start.url;
    const failTrial = (why: string) => { this.sortTried = false; return this.trialFailed(sub, g.el!, start, why); };
    if (g.el.kind === 'select') {
      const opts = g.el.options ?? [];
      const res = await runQuestions(this.qctx(), buildOptionPick(opts, { sort: { value: `sort ${order}`, about: 'sort order' } }, 'sort', this.budget()));
      const pick = choiceOf(res.answers, 'pick');
      if (pick.choice === 'none' && g.trial) return failTrial('none of its options sorts that way');
      if (pick.choice === 'none' || gateChoice(pick, this.th().ground.choice) === 'escalate') return { outcome: 'skipped', note: 'no matching sort option' };
      await page.selectOption(g.el.backendNodeId, opts[Number(pick.choice.slice(1))].value, g.el.frameSessionId);
    } else {
      await this.click(g.el);
      await this.settle();
      const opened = await this.observe(false);
      const options = this.revealedOptions(model, opened, opened.elements.get(g.el.ref) ?? g.el);
      if (options.length) {
        const restricted = new Set(options.map((o) => o.ref));
        const view = { ...opened, elements: new Map([...opened.elements].filter(([r]) => restricted.has(r))) } as Model;
        const res = await groundByIntent(this.qctx(), view, { target: `the option that sorts ${order}`, kinds: ['option', 'menuitem', 'link', 'button', 'clickable', 'radio'], action: 'click' },
          this.th(), { goal: this.spec.goal, step: this.card(sub), budgetTokens: this.budget() });
        if (res.decision !== 'act' || !res.ref) {
          if (g.trial && res.decision === 'none') return failTrial('its menu has no such order');
          await page.press('Escape');
          await this.settle();
          return { outcome: 'skipped', note: 'sort menu opened but no matching order' };
        }
        const opt = opened.elements.get(res.ref)!;
        await this.click(opt);
      } else if (g.trial && !hadEffect(start, opened, g.el)) {
        return failTrial('clicking it changed nothing');
      }
    }
    await this.settle();
    const after = await this.observe(false);
    this.sortedBy = select;
    this.settleGrounding(true);
    return { outcome: 'ok', note: `sorted results ${order} via ${g.el.ref} "${g.el.name}"${after.url !== before ? ` (${after.url})` : ''}`, action: { type: 'sort', ref: g.el.ref } };
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
    // Search in the whole form around the fields: the fields often sit in a sub-region, the button does not.
    const fieldRegion = [...regionCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    let formRegion: string | undefined;
    for (let r = model.regions.find((x) => x.id === fieldRegion); r; r = model.regions.find((x) => x.id === r!.parentId)) {
      if (r.kind === 'form') { formRegion = r.id; break; }
    }
    const g = await this.ground(sub, {
      target: 'the button that submits the form and starts the search (or shows the matching results)', kinds: ['button', 'clickable', 'link'],
      regionId: formRegion, action: 'click',
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
    this.submitsDone++;
    this.dirty = false;
    const clickedAt = this.now();
    await this.click(g.el);
    await this.settle();
    const switched = await this.followPopups(clickedAt, 'the search results');
    if (switched) {
      this.lastSubmitUrl = this.model?.url ?? null;
      this.lastSubmitUrl = this.model?.url ?? null;
      this.settleGrounding(true);
      return { outcome: 'ok', note: `clicked submit ${g.el.ref} "${g.el.name}"; ${switched}`, action: { type: 'click', ref: g.el.ref } };
    }
    const after = await this.observe(false);
    this.lastSubmitUrl = after.url;
    const diff = diffModels(model, after);
    const newRegions = diff.newRegions.map((id) => after.regions.find((r) => r.id === id)).filter(Boolean) as Region[];
    const progressed = after.url !== beforeUrl || newRegions.some((r) => r.kind === 'list')
      || newRegions.filter((r) => r.kind !== 'popup' && r.kind !== 'overlay' && r.kind !== 'dialog').length >= 2;
    // The form may answer a submit by opening its date picker: the date is missing or was not taken.
    const dateKey = Object.keys(this.params).find((k) => paramKind(this.params[k]) === 'date');
    if (!progressed && dateKey && this.popupCalendar(after).length >= 7) {
      this.status[dateKey] = 'pending';
      this.settleGrounding(true);
      return { outcome: 'retry', note: 'submit opened the date picker; picking the date again', action: { type: 'click', ref: g.el.ref } };
    }
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

  private handoffItems: HandoffItem[] = [];
  private handoffSeen = new Set<string>();
  private handoffPages = 0;

  /**
   * extract "agent": JEV brought the task to the results; the main agent reads them and picks the answer. The list
   * goes over as one line per item (site-sorted when select is min/max), within a token budget.
   */
  private async handoff(model: Model): Promise<Outcome> {
    const spec = this.spec.result!;
    const budget = 4000;
    const found = await findResultsList(this.qctx(), model, this.spec.goal, this.budget());
    let fresh: HandoffItem[] = [];
    if (found.list) {
      const used = estimateTokens(this.handoffItems);
      fresh = listItems(model, found.list, budget - used, this.handoffItems.length)
        .filter((it) => { const key = it.url ?? it.text; if (this.handoffSeen.has(key)) return false; this.handoffSeen.add(key); return true; })
        .map((it, j) => ({ ...it, i: this.handoffItems.length + j }));
      this.handoffItems.push(...fresh);
    }
    this.handoffPages++;
    const room = estimateTokens(this.handoffItems) < budget * 0.9;
    if (found.list && fresh.length && room && this.handoffPages < spec.pages) {
      const g = await this.groundLoadMore(model, found.list.id);
      if (g) {
        await this.click(g);
        await this.settle();
        this.loadMoreCount++;
        return { outcome: 'ok', note: `read ${this.handoffItems.length} results; loading more via ${g.ref} "${g.name}"`, action: { type: 'click', ref: g.ref, purpose: 'load_more' } };
      }
    }
    const total = found.list?.items?.length ?? 0;
    const warnings: string[] = [];
    if (!found.list) warnings.push('No results list was recognised on this page: see page.overview, or look with jev_observe on the task tab.');
    this.finish('done', {
      result: { handoff: true, items_count: this.handoffItems.length },
      page: {
        url: model.url, title: model.title, sorted_by: this.sortedBy ? this.sortOrder() : null, items: this.handoffItems,
        more: fresh.length < total,
        ...(found.list ? {} : { overview: renderOverview(model, 1200) }),
      },
      items: this.handoffItems as unknown as Record<string, unknown>[],
      evidence: { url: model.url, refs: [], snippets: [] },
      warnings,
    });
    return { outcome: 'finished', note: `handed ${this.handoffItems.length} results to the agent` };
  }

  private async extract(model: Model): Promise<Outcome> {
    if (this.spec.result!.extract !== 'code') return this.handoff(model);
    const spec = { schema: this.spec.result!.schema!, select: this.spec.result!.select };
    const out: ExtractOutput | null = await extractResults(this.qctx(), model, spec, this.th(), { goal: this.spec.goal, budgetTokens: this.budget(), refDate: this.refDate() });
    if (!out || !out.items.length) {
      const ans = await this.escalate('assess', 'Expected a list of results but could not find one on this page.', { answer_with: ['hint', 'continue', 'abort'] });
      return { outcome: 'retry', note: `no result list found (${ans.type})` };
    }
    // Accumulate across "show more" and page-by-page pagination (items are keyed by link or content).
    out.items.forEach((item, i) => {
      const key = String(item.url ?? '') || JSON.stringify(item);
      const snippets = out.itemRefs[i].map((r) => model.elements.get(r)).filter(Boolean).map((e) => e!.text || e!.name).filter(Boolean).slice(0, 8);
      if (!this.collected.has(key)) this.collected.set(key, { item, snippets, url: model.url, relevant: out.relevant[i] !== false });
    });
    const maxItems = this.spec.policy.max_items ?? 200;
    const sorted = !!spec.select && this.sortedBy === spec.select;
    const anyRelevant = [...this.collected.values()].some((c) => c.relevant);
    // A sorted page answers min/max only if it holds a matching item (price-sorted pages often start with accessories).
    const needsAll = !spec.select || spec.select === 'all' || (/^(min|max)\(/.test(spec.select) && (!sorted || !anyRelevant));
    const grew = this.collected.size > this.extractPrev;
    this.extractPrev = this.collected.size;
    if (needsAll && this.collected.size < maxItems && grew && this.loadMoreCount < 30) {
      const g = await this.groundLoadMore(model, out.listRegionId);
      if (g) {
        await this.click(g);
        await this.settle();
        this.loadMoreCount++;
        return { outcome: 'ok', note: `read ${this.collected.size} results; loading more via ${g.ref} "${g.name}"`, action: { type: 'click', ref: g.ref, purpose: 'load_more' } };
      }
    }
    const collected = [...this.collected.values()];
    // Items that clearly do not match the goal (accessories, parts) are left out, unless nothing matched at all.
    const all = collected.some((c) => c.relevant) ? collected.filter((c) => c.relevant) : collected;
    const excluded = collected.length - all.length;
    const items = all.map((c) => c.item);
    const idx = applySelect(items, spec.select);
    const chosen = idx !== undefined ? all[idx] : undefined;
    this.finish('done', {
      result: { selected: chosen?.item, items_count: items.length },
      items,
      evidence: { url: chosen?.url ?? model.url, refs: chosen && out.items.includes(chosen.item) ? out.itemRefs[out.items.indexOf(chosen.item)] : [], snippets: chosen?.snippets ?? [] },
      warnings: [
        ...out.warnings,
        ...(sorted ? [`Results were sorted on the site (${spec.select}); the answer comes from the first page${this.loadMoreCount ? 's' : ''} read.`] : []),
        ...(excluded ? [`${excluded} item(s) did not match the goal (accessories, parts or other products) and were left out.`] : []),
      ],
    });
    return { outcome: 'finished', note: `extracted ${items.length} results${chosen ? '; selected one' : ''}${sorted ? ' (site-sorted)' : ''}` };
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
