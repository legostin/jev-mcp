import type { RpcServer, Connection } from './rpc.ts';
import { RpcError, ERR } from './protocol.ts';
import type { DaemonContext } from './api.ts';
import type { TabHandle } from './browsers.ts';
import { Task, type TabPort } from '../core/runner/task.ts';
import { answerSchema, taskSpecSchema, FINAL_STATES, type Escalation, type TaskSpec } from '../core/runner/types.ts';
import type { MemoryStore } from '../core/memory/store.ts';
import { playgroundUrl } from '../core/jev/playground.ts';
import type { Json, Question } from '../core/jev/types.ts';
import { logger } from '../core/util/log.ts';
import { newId } from '../core/util/ids.ts';

const log = logger('tasks');

export type TaskEventType = 'question' | 'done' | 'state' | 'step';
export interface TaskEvent { type: TaskEventType; task_id: string; session: string; at: number; payload: unknown }

interface Waiter {
  taskId?: string;
  sessionId: string;
  until: 'question' | 'done' | 'any';
  resolve: (e: TaskEvent | null) => void;
}

function portFor(ctx: DaemonContext, tab: TabHandle, taskId: string): TabPort {
  tab.lease = taskId;
  return {
    tabId: tab.id,
    page: () => ctx.browsers.page(tab.id),
    observe: (opts) => ctx.browsers.observe(tab.id, opts),
    lastModel: () => tab.model,
    release: () => { if (tab.lease === taskId) tab.lease = undefined; },
  };
}

/** One-line summary of a pending question, with its top candidates, for piggyback and channel delivery. */
export function questionLine(q: Escalation): string {
  const cands = q.decision?.candidates?.slice(0, 3).map((c) => `${c.ref} p=${c.p.toFixed(2)} ${c.desc}`).join('; ');
  return `${q.question_id} (task ${q.task_id}) [${q.kind}] ${q.summary}${cands ? ` Candidates: ${cands}` : ''} Answer with: ${q.answer_with.join(', ')}.`;
}

/** Owns running tasks, routes their events to the owning session, and serves the task RPC methods. */
export class TaskManager {
  readonly tasks = new Map<string, Task>();
  private waiters = new Set<Waiter>();
  /** Extra subscribers (debug UI SSE, extension side panel). */
  readonly listeners: Array<(ev: TaskEvent) => void> = [];
  private readonly ctx: DaemonContext;
  private readonly rpc: RpcServer;
  private readonly memory?: MemoryStore;
  uiUrl: (path: string) => string | null = () => null;

  constructor(ctx: DaemonContext, rpc: RpcServer, memory?: MemoryStore) {
    this.ctx = ctx;
    this.rpc = rpc;
    this.memory = memory;
    // Tasks that were running when a previous daemon stopped cannot continue: mark them interrupted.
    for (const t of ctx.trace.listTasks({ limit: 200 })) {
      if (!['done', 'failed', 'cancelled', 'interrupted'].includes(t.state)) ctx.trace.updateTask(t.id, { state: 'interrupted' });
    }
  }

  busy(): boolean {
    return [...this.tasks.values()].some((t) => !t.finished);
  }

  private publish(task: Task, type: TaskEventType, payload: unknown): void {
    const ev: TaskEvent = { type, task_id: task.id, session: task.sessionId, at: Date.now(), payload };
    const notifyChannel = this.ctx.getConfig().notify.channel;
    this.rpc.broadcast('task.event', { ...ev, channel: notifyChannel }, (c) => c.sessionId === task.sessionId || c.client === 'ui');
    for (const l of this.listeners) { try { l(ev); } catch { /* isolated */ } }
    for (const w of [...this.waiters]) {
      if (w.taskId ? w.taskId !== task.id : w.sessionId !== task.sessionId) continue;
      const match = w.until === 'any' ? type !== 'step' : w.until === 'question' ? type === 'question' || type === 'done' : type === 'done';
      if (match) { this.waiters.delete(w); w.resolve(ev); }
    }
  }

  async create(sessionId: string, raw: unknown): Promise<Task> {
    const parsed = taskSpecSchema.safeParse(raw);
    if (!parsed.success) {
      throw new RpcError(ERR.invalidParams, `Invalid task: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    }
    const spec: TaskSpec = parsed.data;
    let tab: TabHandle;
    if (spec.tab && spec.tab !== 'current') {
      tab = this.ctx.browsers.get(spec.tab);
    } else if (spec.tab === 'current') {
      tab = await this.ctx.browsers.resolve(sessionId);
    } else {
      tab = await this.ctx.browsers.openTab(spec.site, spec.driver);
    }
    if (tab.lease) {
      const other = this.tasks.get(tab.lease);
      if (other && !other.finished) throw new RpcError(ERR.conflict, `Tab ${tab.id} is used by task ${other.id}. Use another tab or cancel that task.`);
    }
    this.ctx.browsers.setCurrent(sessionId, tab.id);
    const id = newId('t');
    const task = new Task(spec, {
      sessionId, getConfig: this.ctx.getConfig, jev: this.ctx.jev, trace: this.ctx.trace,
      port: portFor(this.ctx, tab, id), memory: this.memory,
    }, id);
    this.tasks.set(task.id, task);
    task.on('escalation', (q) => this.publish(task, 'question', q));
    task.on('done', (r) => this.publish(task, 'done', r));
    task.on('state', (s) => this.publish(task, 'state', s));
    task.on('step', (s) => this.publish(task, 'step', s));
    void task.start().catch((e) => log.error(`task ${task.id} crashed`, e));
    return task;
  }

  get(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) {
      const rec = this.ctx.trace.getTask(id);
      if (rec) throw new RpcError(ERR.notFound, `Task ${id} is not running in this daemon (state: ${rec.state}). Its trace is kept; start a new task to continue.`);
      throw new RpcError(ERR.notFound, `Unknown task ${id}`);
    }
    return t;
  }

  pending(sessionId?: string): Escalation[] {
    return [...this.tasks.values()]
      .filter((t) => (!sessionId || t.sessionId === sessionId) && t.pendingQuestion)
      .map((t) => t.pendingQuestion!);
  }

  byQuestion(questionId: string): Task | null {
    for (const t of this.tasks.values()) if (t.pendingQuestion?.question_id === questionId) return t;
    return null;
  }

  wait(opts: { sessionId: string; taskId?: string; until: Waiter['until']; timeoutMs: number }): Promise<TaskEvent | null> {
    if (opts.taskId) {
      const t = this.get(opts.taskId);
      if (t.finished) return Promise.resolve({ type: 'done', task_id: t.id, session: t.sessionId, at: Date.now(), payload: t.result() });
      if (opts.until !== 'done' && t.pendingQuestion) return Promise.resolve({ type: 'question', task_id: t.id, session: t.sessionId, at: Date.now(), payload: t.pendingQuestion });
    } else if (opts.until !== 'done') {
      const q = this.pending(opts.sessionId)[0];
      if (q) return Promise.resolve({ type: 'question', task_id: q.task_id, session: opts.sessionId, at: Date.now(), payload: q });
    }
    return new Promise((resolve) => {
      const w: Waiter = { taskId: opts.taskId, sessionId: opts.sessionId, until: opts.until, resolve };
      this.waiters.add(w);
      setTimeout(() => { if (this.waiters.delete(w)) resolve(null); }, opts.timeoutMs).unref();
    });
  }

  register(): void {
    const { rpc, ctx } = this;
    const session = (conn: Connection) => ctx.sessionOf(conn);

    rpc.register('task.create', async (p: unknown, conn) => {
      const task = await this.create(session(conn), p);
      return { task_id: task.id, tab: task.tabId, state: task.state, trace: this.uiUrl(`/#/task/${task.id}`) };
    });

    rpc.register('task.status', async (p: { task_id?: string }, conn) => {
      if (p.task_id) return this.get(p.task_id).statusView();
      const sid = session(conn);
      return { tasks: [...this.tasks.values()].filter((t) => t.sessionId === sid).map((t) => t.statusView()) };
    });

    rpc.register('task.wait', async (p: { task_id?: string; until?: Waiter['until']; timeout_ms?: number }, conn) => {
      const timeoutMs = Math.min(Math.max(p.timeout_ms ?? 30_000, 100), 600_000);
      const ev = await this.wait({ sessionId: session(conn), taskId: p.task_id, until: p.until ?? 'any', timeoutMs });
      if (!ev) return { timeout: true, status: p.task_id ? this.get(p.task_id).statusView() : null };
      return { timeout: false, event: ev };
    });

    rpc.register('task.answer', async (p: { question_id: string; answer: unknown; remember?: boolean }) => {
      const task = this.byQuestion(p.question_id);
      if (!task) throw new RpcError(ERR.notFound, `Question ${p.question_id} is not pending (already answered, or the task ended).`);
      const parsed = answerSchema.safeParse(p.answer);
      if (!parsed.success) throw new RpcError(ERR.invalidParams, `Invalid answer: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
      const res = task.answer(p.question_id, { ...parsed.data, remember: p.remember });
      return { ...res, task_id: task.id };
    });

    rpc.register('task.control', async (p: { task_id: string; action: 'pause' | 'resume' | 'cancel' | 'update'; patch?: any }) => {
      const task = this.get(p.task_id);
      switch (p.action) {
        case 'pause': task.pause('paused by the agent'); break;
        case 'resume': task.resume(); break;
        case 'cancel': task.cancel('cancelled by the agent'); break;
        case 'update': task.update(p.patch ?? {}); break;
        default: throw new RpcError(ERR.invalidParams, `Unknown action ${p.action}`);
      }
      return task.statusView();
    });

    rpc.register('task.result', async (p: { task_id: string }) => {
      const task = this.tasks.get(p.task_id);
      if (task) return { state: task.state, result: task.result(), status: task.statusView() };
      const rec = ctx.trace.getTask(p.task_id);
      if (!rec) throw new RpcError(ERR.notFound, `Unknown task ${p.task_id}`);
      return { state: rec.state, result: rec.result ?? null };
    });

    rpc.register('task.trace', async (p: { task_id: string; step?: number }) => {
      const rec = ctx.trace.getTask(p.task_id);
      if (!rec) throw new RpcError(ERR.notFound, `Unknown task ${p.task_id}`);
      const steps = ctx.trace.getSteps(p.task_id).filter((s) => p.step === undefined || s.idx === p.step);
      const calls = ctx.trace.getJevCalls({ taskId: p.task_id });
      return {
        task: { id: rec.id, state: rec.state, goal: rec.goal, stats: rec.stats },
        ui: this.uiUrl(`/#/task/${p.task_id}`),
        steps: steps.map((s) => ({
          idx: s.idx, subintent: s.subintent, outcome: s.outcome, url: s.url, timings: s.timings, notes: s.notes,
          calls: calls.filter((c) => c.stepId === s.id).map((c) => ({
            id: c.id, template: c.template, latencyMs: c.latencyMs, costUsd: c.costUsd, error: c.error,
            answers: c.answers, playground: c.error ? undefined : playgroundUrl(c.state as Json, c.questions as Record<string, Question>),
          })),
        })),
        escalations: ctx.trace.getEscalations(p.task_id).map((e) => ({ id: e.id, kind: e.kind, answer: e.answer, created_at: e.createdAt })),
      };
    });

    rpc.register('questions.pending', async (_p, conn) => ({ questions: this.pending(session(conn)) }));
  }

  cancelAll(): void {
    for (const t of this.tasks.values()) if (!FINAL_STATES.has(t.state)) t.cancel('daemon stopping');
  }
}
