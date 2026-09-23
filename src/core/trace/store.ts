import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync, type Database } from './sqlite.ts';
import { dbFile, tracesDir } from '../util/paths.ts';

export interface TaskRecord {
  id: string; session: string; createdAt: number; updatedAt: number; state: string; goal: string;
  spec: unknown; result?: unknown; stats?: unknown;
}
export interface StepRecord {
  id: string; taskId: string; idx: number; startedAt: number; endedAt?: number; subintent?: string;
  action?: unknown; outcome?: string; url?: string; pageSig?: string; diff?: string; timings?: unknown;
  screenshot?: string; model?: string; notes?: unknown;
}
export interface JevCallRecord {
  id: string; taskId?: string; stepId?: string; at: number; template: string; state: unknown; questions: unknown;
  answers?: unknown; model?: string; provider?: string; latencyMs?: number; inputTokens?: number; costUsd?: number;
  error?: string; label?: boolean | null; labelNote?: string;
}
export interface EscalationRecord {
  id: string; taskId: string; createdAt: number; kind: string; payload: unknown; answer?: unknown; answeredAt?: number;
}

const FORBIDDEN = /sk-or-v1-[A-Za-z0-9]{8,}|"apiKey"\s*:\s*"[^"…]{12,}"/;

function j(v: unknown): string | null {
  if (v === undefined) return null;
  const text = JSON.stringify(v);
  if (text && FORBIDDEN.test(text)) throw new Error('Refusing to store a value that looks like an API key');
  return text;
}
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? undefined);

/** Local, append-mostly store for tasks, steps, JEV calls and escalations, plus blob files per task. */
export class TraceStore {
  readonly db: Database;
  readonly blobDir: string;

  private constructor(db: Database, blobDir: string) {
    this.db = db;
    this.blobDir = blobDir;
  }

  static open(path = dbFile(), blobDir = tracesDir()): TraceStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(blobDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT, created_at INTEGER, updated_at INTEGER,
        state TEXT, goal TEXT, spec TEXT, result TEXT, stats TEXT);
      CREATE TABLE IF NOT EXISTS steps (id TEXT PRIMARY KEY, task_id TEXT, idx INTEGER, started_at INTEGER, ended_at INTEGER,
        subintent TEXT, action TEXT, outcome TEXT, url TEXT, page_sig TEXT, diff TEXT, timings TEXT, screenshot TEXT,
        model TEXT, notes TEXT);
      CREATE INDEX IF NOT EXISTS steps_task ON steps(task_id, idx);
      CREATE TABLE IF NOT EXISTS jev_calls (id TEXT PRIMARY KEY, task_id TEXT, step_id TEXT, at INTEGER, template TEXT,
        state TEXT, questions TEXT, answers TEXT, model TEXT, provider TEXT, latency_ms INTEGER, input_tokens INTEGER,
        cost_usd REAL, error TEXT, label INTEGER, label_note TEXT);
      CREATE INDEX IF NOT EXISTS calls_task ON jev_calls(task_id, at);
      CREATE INDEX IF NOT EXISTS calls_template ON jev_calls(template, at);
      CREATE TABLE IF NOT EXISTS escalations (id TEXT PRIMARY KEY, task_id TEXT, created_at INTEGER, kind TEXT,
        payload TEXT, answer TEXT, answered_at INTEGER);
    `);
    return new TraceStore(db, blobDir);
  }

  recordTask(t: TaskRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO tasks (id, session, created_at, updated_at, state, goal, spec, result, stats)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.id, t.session, t.createdAt, t.updatedAt, t.state, t.goal, j(t.spec), j(t.result), j(t.stats));
  }

  updateTask(id: string, patch: Partial<Pick<TaskRecord, 'state' | 'result' | 'stats' | 'spec'>>): void {
    const cur = this.getTask(id);
    if (!cur) return;
    this.recordTask({ ...cur, ...patch, updatedAt: Date.now() });
  }

  getTask(id: string): TaskRecord | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    return r ? this.taskRow(r) : null;
  }

  listTasks(opts: { limit?: number; session?: string } = {}): TaskRecord[] {
    const rows = opts.session
      ? this.db.prepare('SELECT * FROM tasks WHERE session = ? ORDER BY created_at DESC LIMIT ?').all(opts.session, opts.limit ?? 50)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 50);
    return (rows as any[]).map((r) => this.taskRow(r));
  }

  private taskRow(r: any): TaskRecord {
    return { id: r.id, session: r.session, createdAt: r.created_at, updatedAt: r.updated_at, state: r.state, goal: r.goal,
      spec: parse(r.spec), result: parse(r.result), stats: parse(r.stats) };
  }

  recordStep(s: StepRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO steps (id, task_id, idx, started_at, ended_at, subintent, action, outcome, url,
      page_sig, diff, timings, screenshot, model, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      s.id, s.taskId, s.idx, s.startedAt, s.endedAt ?? null, s.subintent ?? null, j(s.action), s.outcome ?? null, s.url ?? null,
      s.pageSig ?? null, s.diff ?? null, j(s.timings), s.screenshot ?? null, s.model ?? null, j(s.notes));
  }

  getSteps(taskId: string): StepRecord[] {
    return (this.db.prepare('SELECT * FROM steps WHERE task_id = ? ORDER BY idx').all(taskId) as any[]).map((r) => ({
      id: r.id, taskId: r.task_id, idx: r.idx, startedAt: r.started_at, endedAt: r.ended_at ?? undefined, subintent: r.subintent ?? undefined,
      action: parse(r.action), outcome: r.outcome ?? undefined, url: r.url ?? undefined, pageSig: r.page_sig ?? undefined,
      diff: r.diff ?? undefined, timings: parse(r.timings), screenshot: r.screenshot ?? undefined, model: r.model ?? undefined, notes: parse(r.notes),
    }));
  }

  recordJevCall(c: JevCallRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO jev_calls (id, task_id, step_id, at, template, state, questions, answers, model,
      provider, latency_ms, input_tokens, cost_usd, error, label, label_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      c.id, c.taskId ?? null, c.stepId ?? null, c.at, c.template, j(c.state), j(c.questions), j(c.answers), c.model ?? null,
      c.provider ?? null, c.latencyMs ?? null, c.inputTokens ?? null, c.costUsd ?? null, c.error ?? null,
      c.label === undefined || c.label === null ? null : c.label ? 1 : 0, c.labelNote ?? null);
  }

  getJevCalls(filter: { taskId?: string; stepId?: string; template?: string; limit?: number; since?: number } = {}): JevCallRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.taskId) { where.push('task_id = ?'); args.push(filter.taskId); }
    if (filter.stepId) { where.push('step_id = ?'); args.push(filter.stepId); }
    if (filter.template) { where.push('template = ?'); args.push(filter.template); }
    if (filter.since) { where.push('at >= ?'); args.push(filter.since); }
    const sql = `SELECT * FROM jev_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at LIMIT ?`;
    args.push(filter.limit ?? 5000);
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => this.callRow(r));
  }

  getCall(id: string): JevCallRecord | null {
    const r = this.db.prepare('SELECT * FROM jev_calls WHERE id = ?').get(id) as any;
    return r ? this.callRow(r) : null;
  }

  private callRow(r: any): JevCallRecord {
    return {
      id: r.id, taskId: r.task_id ?? undefined, stepId: r.step_id ?? undefined, at: r.at, template: r.template,
      state: parse(r.state), questions: parse(r.questions), answers: parse(r.answers), model: r.model ?? undefined,
      provider: r.provider ?? undefined, latencyMs: r.latency_ms ?? undefined, inputTokens: r.input_tokens ?? undefined,
      costUsd: r.cost_usd ?? undefined, error: r.error ?? undefined, label: r.label === null ? null : r.label === 1, labelNote: r.label_note ?? undefined,
    };
  }

  labelCall(id: string, correct: boolean, note?: string): void {
    this.db.prepare('UPDATE jev_calls SET label = ?, label_note = ? WHERE id = ?').run(correct ? 1 : 0, note ?? null, id);
  }

  recordEscalation(e: EscalationRecord): void {
    this.db.prepare(`INSERT OR REPLACE INTO escalations (id, task_id, created_at, kind, payload, answer, answered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(e.id, e.taskId, e.createdAt, e.kind, j(e.payload), j(e.answer), e.answeredAt ?? null);
  }

  getEscalations(taskId: string): EscalationRecord[] {
    return (this.db.prepare('SELECT * FROM escalations WHERE task_id = ? ORDER BY created_at').all(taskId) as any[]).map((r) => ({
      id: r.id, taskId: r.task_id, createdAt: r.created_at, kind: r.kind, payload: parse(r.payload), answer: parse(r.answer), answeredAt: r.answered_at ?? undefined,
    }));
  }

  saveBlob(taskId: string, name: string, data: Buffer | string): string {
    const safeTask = taskId.replace(/[^\w-]/g, '_');
    const safeName = name.replace(/[^\w.-]/g, '_');
    const dir = join(this.blobDir, safeTask);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (typeof data === 'string' && FORBIDDEN.test(data)) throw new Error('Refusing to store a value that looks like an API key');
    writeFileSync(join(dir, safeName), data, { mode: 0o600 });
    return `${safeTask}/${safeName}`;
  }

  readBlob(relPath: string): Buffer | null {
    const p = join(this.blobDir, relPath);
    if (!p.startsWith(this.blobDir) || !existsSync(p)) return null;
    return readFileSync(p);
  }

  /** Deletes tasks older than the retention window, then the oldest tasks until blobs fit in maxMb. */
  prune(opts: { retentionDays: number; maxMb: number; now?: number }): { removedTasks: number } {
    const now = opts.now ?? Date.now();
    const cutoff = now - opts.retentionDays * 86_400_000;
    const old = (this.db.prepare('SELECT id FROM tasks WHERE updated_at < ?').all(cutoff) as any[]).map((r) => r.id as string);
    let removed = 0;
    for (const id of old) { this.deleteTask(id); removed++; }
    const sizeOf = (dir: string): number => {
      if (!existsSync(dir)) return 0;
      let total = 0;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        const st = statSync(p);
        total += st.isDirectory() ? sizeOf(p) : st.size;
      }
      return total;
    };
    let size = sizeOf(this.blobDir);
    const limit = opts.maxMb * 1024 * 1024;
    if (size > limit) {
      const rows = (this.db.prepare('SELECT id FROM tasks ORDER BY updated_at ASC').all() as any[]).map((r) => r.id as string);
      for (const id of rows) {
        if (size <= limit) break;
        size -= sizeOf(join(this.blobDir, id.replace(/[^\w-]/g, '_')));
        this.deleteTask(id);
        removed++;
      }
    }
    return { removedTasks: removed };
  }

  deleteTask(id: string): void {
    for (const t of ['jev_calls', 'steps', 'escalations']) this.db.prepare(`DELETE FROM ${t} WHERE task_id = ?`).run(id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    rmSync(join(this.blobDir, id.replace(/[^\w-]/g, '_')), { recursive: true, force: true });
  }

  close(): void { this.db.close(); }
}
