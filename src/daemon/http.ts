import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { DaemonContext } from './api.ts';
import type { TaskManager, TaskEvent } from './tasks.ts';
import type { ExtensionBridge } from './ext-bridge.ts';
import type { MemoryStore } from '../core/memory/store.ts';
import { redactConfig, saveConfig, setPath, getPath } from '../core/config/store.ts';
import { playgroundUrl } from '../core/jev/playground.ts';
import type { Json, Question } from '../core/jev/types.ts';
import { calibration } from '../core/trace/calibration.ts';
import { answerSchema } from '../core/runner/types.ts';
import { randomToken } from '../core/util/ids.ts';
import { logger } from '../core/util/log.ts';
import { highlight } from './highlight.ts';

const log = logger('http');
const UI_DIR = fileURLToPath(new URL('../../dist/ui/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
};

export interface HttpDeps {
  ctx: DaemonContext;
  tasks: TaskManager;
  memory: MemoryStore;
  bridge: ExtensionBridge;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

function serializeModel(model: any) {
  return {
    url: model.url, title: model.title, viewport: model.viewport, scroll: model.scroll, signature: model.signature,
    regions: model.regions,
    elements: [...model.elements.values()].map((e: any) => ({
      ref: e.ref, kind: e.kind, name: e.name, nameSource: e.nameSource, value: e.value, placeholder: e.placeholder,
      interactive: e.interactive, visible: e.visible, inViewport: e.inViewport, occluded: e.occluded, occludedBy: e.occludedBy,
      regionId: e.regionId, rect: e.rect, states: e.states, context: e.context, href: e.href, text: e.text, attrs: e.attrs,
    })),
  };
}

/**
 * Local HTTP server (127.0.0.1 only): debug UI + JSON API + SSE events, and the WebSocket endpoint for the extension.
 * The UI token arrives once in the URL (?token=) and is kept in an HttpOnly cookie; the Host header must be local
 * (DNS-rebinding protection).
 */
export class HttpServer {
  readonly token = randomToken(16);
  port = 0;
  private server: Server;
  private sse = new Set<ServerResponse>();
  private readonly deps: HttpDeps;

  constructor(deps: HttpDeps) {
    this.deps = deps;
    this.server = createServer((req, res) => { void this.handle(req, res); });
    this.server.on('upgrade', (req, socket, head) => {
      if (!this.hostOk(req) || !(req.url ?? '').startsWith('/ext')) { socket.destroy(); return; }
      deps.bridge.handleUpgrade(req, socket, head);
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port !== 0) {
          log.warn(`port ${port} is busy; the extension will not connect until it is free. Using a random port for the UI.`);
          this.server.removeListener('error', onError);
          this.server.listen(0, '127.0.0.1', () => { this.port = (this.server.address() as { port: number }).port; resolve(this.port); });
        } else reject(e);
      };
      this.server.on('error', onError);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', onError);
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  url(path = '/'): string { return `http://127.0.0.1:${this.port}${path.startsWith('/') ? path : `/${path}`}`; }
  authUrl(): string { return `${this.url('/')}?token=${this.token}`; }

  publish(ev: TaskEvent): void {
    const line = `event: task\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sse) res.write(line);
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '');
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private authed(req: IncomingMessage): boolean {
    const auth = String(req.headers.authorization ?? '');
    if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), this.token)) return true;
    const cookie = String(req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith('jev_ui='));
    return !!cookie && safeEqual(cookie.slice(7), this.token);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.hostOk(req)) { res.writeHead(421); res.end('misdirected request'); return; }
    const url = new URL(req.url ?? '/', 'http://local');
    const q = url.searchParams.get('token');
    if (q && safeEqual(q, this.token)) {
      res.writeHead(302, { 'set-cookie': `jev_ui=${this.token}; HttpOnly; SameSite=Strict; Path=/`, location: url.pathname + url.hash });
      res.end();
      return;
    }
    if (!this.authed(req)) {
      if (url.pathname.startsWith('/api/')) return this.json(res, 401, { error: 'unauthorized: open the link printed by "jev ui"' });
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized. Open the address printed by "jev ui".');
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) return await this.api(req, res, url);
      return this.static(res, url.pathname);
    } catch (e) {
      const err = e as Error & { status?: number };
      this.json(res, err.status ?? 500, { error: err.message });
    }
  }

  private static(res: ServerResponse, path: string): void {
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = normalize(join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) {
      if (existsSync(join(UI_DIR, 'index.html'))) {
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(readFileSync(join(UI_DIR, 'index.html')));
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Debug UI is not built. Run: npm run build:web');
      }
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(readFileSync(file));
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { ctx, tasks, memory } = this.deps;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const method = req.method ?? 'GET';
    const [a, b, c] = parts;

    if (a === 'events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      this.sse.add(res);
      const ka = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { clearInterval(ka); this.sse.delete(res); });
      return;
    }
    if (a === 'info') {
      return this.json(res, 200, {
        version: ctx.version, pid: process.pid, extensionConnected: ctx.browsers.extensionConnected, chromiumRunning: ctx.browsers.chromiumRunning,
        provider: ctx.getConfig().provider, model: ctx.getConfig().providers[ctx.getConfig().provider].model,
      });
    }
    if (a === 'tasks' && !b) {
      const recs = ctx.trace.listTasks({ limit: Number(url.searchParams.get('limit') ?? 100) });
      return this.json(res, 200, recs.map((r) => {
        const live = tasks.tasks.get(r.id);
        return { id: r.id, goal: r.goal, state: live?.state ?? r.state, createdAt: r.createdAt, updatedAt: r.updatedAt, stats: r.stats, live: !!live, pending: live?.pendingQuestion ?? null };
      }));
    }
    if (a === 'tasks' && b && !c) {
      const r = ctx.trace.getTask(b);
      if (!r) return this.json(res, 404, { error: 'unknown task' });
      const live = tasks.tasks.get(b);
      return this.json(res, 200, { ...r, state: live?.state ?? r.state, status: live?.statusView() ?? null, escalations: ctx.trace.getEscalations(b) });
    }
    if (a === 'tasks' && b && c === 'steps') return this.json(res, 200, ctx.trace.getSteps(b));
    if (a === 'calls' && !b) {
      const calls = ctx.trace.getJevCalls({
        taskId: url.searchParams.get('taskId') ?? undefined, stepId: url.searchParams.get('stepId') ?? undefined,
        template: url.searchParams.get('template') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 2000),
      });
      return this.json(res, 200, calls.map((cl) => ({ ...cl, playground: cl.error ? null : playgroundUrl(cl.state as Json, cl.questions as Record<string, Question>) })));
    }
    if (a === 'calls' && b && c === 'label' && method === 'POST') {
      const body = await readBody(req);
      ctx.trace.labelCall(b, !!body.correct, body.note ?? 'labeled in UI');
      return this.json(res, 200, { ok: true });
    }
    if (a === 'blob' && b && c) {
      const data = ctx.trace.readBlob(`${b}/${c}`);
      if (!data) return this.json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES[extname(c)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
      res.end(data);
      return;
    }
    if (a === 'replay' && method === 'POST') {
      const body = await readBody(req);
      let state = body.state;
      let questions = body.questions;
      if (body.callId) {
        const call = ctx.trace.getCall(body.callId);
        if (!call) return this.json(res, 404, { error: 'unknown call' });
        state ??= call.state;
        questions ??= call.questions;
      }
      const r = await ctx.jev.evaluate({ state, questions });
      ctx.trace.recordJevCall({ id: `c_replay_${Date.now().toString(36)}`, at: Date.now(), template: 'ui.replay', state, questions, answers: r.answers, model: r.model, provider: r.provider, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, costUsd: r.usage.costUsd });
      return this.json(res, 200, { answers: r.answers, model: r.model, latencyMs: r.latencyMs, costUsd: r.usage.costUsd, playground: playgroundUrl(state, questions) });
    }
    if (a === 'settings') {
      if (method === 'POST') {
        const body = await readBody(req);
        const next = setPath(ctx.getConfig(), String(body.path), body.value);
        saveConfig(next);
        ctx.setConfig(next);
        return this.json(res, 200, { path: body.path, value: getPath(redactConfig(next), String(body.path)) ?? null });
      }
      return this.json(res, 200, redactConfig(ctx.getConfig()));
    }
    if (a === 'questions' && !b) return this.json(res, 200, tasks.pending());
    if (a === 'questions' && b && c === 'answer' && method === 'POST') {
      const body = await readBody(req);
      const task = tasks.byQuestion(b);
      if (!task) return this.json(res, 404, { error: 'question is not pending' });
      const parsed = answerSchema.safeParse(body.answer);
      if (!parsed.success) return this.json(res, 400, { error: parsed.error.issues.map((i) => i.message).join('; ') });
      return this.json(res, 200, task.answer(b, { ...parsed.data, remember: body.remember }));
    }
    if (a === 'control' && method === 'POST') {
      const body = await readBody(req);
      const task = tasks.get(String(body.task_id));
      if (body.action === 'pause') task.pause('paused from the debug UI');
      else if (body.action === 'resume') task.resume();
      else if (body.action === 'cancel') task.cancel('cancelled from the debug UI');
      else if (body.action === 'update') task.update(body.patch ?? {});
      return this.json(res, 200, task.statusView());
    }
    if (a === 'memory') {
      if (method === 'DELETE' && b) { memory.remove(b); return this.json(res, 200, { ok: true }); }
      if (method === 'PATCH' && b) { const body = await readBody(req); memory.setWeight(b, Number(body.weight)); return this.json(res, 200, { ok: true }); }
      return this.json(res, 200, memory.list());
    }
    if (a === 'calibration') {
      return this.json(res, 200, calibration(ctx.trace, {
        template: url.searchParams.get('template') ?? undefined,
        sinceDays: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : undefined,
        targetPrecision: url.searchParams.get('precision') ? Number(url.searchParams.get('precision')) : undefined,
      }));
    }
    if (a === 'tabs') {
      const list = await ctx.browsers.listTabs();
      return this.json(res, 200, list.map((t) => ({ id: t.id, url: t.url, title: t.title, driver: t.driver, task: t.lease ?? null, hasModel: !!t.model })));
    }
    if (a === 'model' && b) {
      const tab = ctx.browsers.get(b);
      const model = url.searchParams.get('fresh') === '1' || !tab.model ? await ctx.browsers.observe(b) : tab.model;
      return this.json(res, 200, serializeModel(model));
    }
    if (a === 'highlight' && method === 'POST') {
      const body = await readBody(req);
      const tab = ctx.browsers.get(String(body.tab));
      await highlight(ctx, tab.id, body.refs ?? []);
      return this.json(res, 200, { ok: true });
    }
    if (a === 'export' && b) {
      const r = ctx.trace.getTask(b);
      if (!r) return this.json(res, 404, { error: 'unknown task' });
      const steps = ctx.trace.getSteps(b);
      const blobs: Record<string, string> = {};
      for (const s of steps) if (s.screenshot) { const d = ctx.trace.readBlob(s.screenshot); if (d) blobs[s.screenshot] = d.toString('base64'); }
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="jev-trace-${b}.json"` });
      res.end(JSON.stringify({ format: 'jev-trace/1', task: r, steps, calls: ctx.trace.getJevCalls({ taskId: b }), escalations: ctx.trace.getEscalations(b), blobs }));
      return;
    }
    return this.json(res, 404, { error: `unknown endpoint ${url.pathname}` });
  }

  close(): Promise<void> {
    for (const r of this.sse) r.end();
    return new Promise((resolve) => { this.server.closeAllConnections(); this.server.close(() => resolve()); });
  }
}
