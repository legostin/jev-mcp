import type { DaemonHandle } from './main.ts';
import { TaskManager } from './tasks.ts';
import { ExtensionBridge } from './ext-bridge.ts';
import { HttpServer } from './http.ts';
import { highlight } from './highlight.ts';
import { MemoryStore } from '../core/memory/store.ts';
import { writeEndpoint } from './lifecycle.ts';
import { answerSchema } from '../core/runner/types.ts';
import { RpcError, ERR } from './protocol.ts';
import { thresholdsFor } from '../core/runner/thresholds.ts';
import { logger } from '../core/util/log.ts';

const log = logger('daemon');

export interface Stage2 { tasks: TaskManager; memory: MemoryStore; bridge: ExtensionBridge; http: HttpServer }

/** Wires the task system, site memory, the Chrome extension bridge and the debug UI into a running daemon. */
export async function registerStage2(handle: DaemonHandle, opts: { httpPort?: number } = {}): Promise<Stage2> {
  const { ctx, rpc } = handle;
  const memory = new MemoryStore(ctx.trace.db);
  const tasks = new TaskManager(ctx, rpc, memory);
  tasks.register();
  tasks.restoreUnfinished();
  const bridge = new ExtensionBridge(() => ctx.getConfig().driver.extensionIds);
  ctx.browsers.setExtensionDriver(bridge.driver, () => bridge.everPaired);
  const http = new HttpServer({ ctx, tasks, memory, bridge });
  const port = await http.listen(opts.httpPort ?? (process.env.JEV_HTTP_PORT ? Number(process.env.JEV_HTTP_PORT) : ctx.getConfig().driver.extensionPort));
  tasks.uiUrl = (path) => http.url(path);

  // Task events also go to the debug UI (SSE) and the extension side panel.
  tasks.listeners.push((ev) => {
    http.publish(ev);
    if (ev.type !== 'step') bridge.push(ev);
  });

  // Extension tasks pause while the extension is away and resume when it is back.
  const pausedByDisconnect = new Set<string>();
  bridge.onDisconnected = () => {
    for (const t of tasks.tasks.values()) {
      const tab = (() => { try { return ctx.browsers.get(t.tabId); } catch { return null; } })();
      if (tab?.driver === 'extension' && !t.finished && t.state !== 'paused') { t.pause('extension disconnected'); pausedByDisconnect.add(t.id); }
    }
  };
  bridge.onConnected = () => {
    for (const id of pausedByDisconnect) tasks.tasks.get(id)?.resume();
    pausedByDisconnect.clear();
  };

  bridge.onUiRequest = async (method, params: any) => {
    switch (method) {
      case 'ext.state': {
        const cutoff = Date.now() - 10 * 60_000;
        const list = [...tasks.tasks.values()]
          .filter((t) => !t.finished || (ctx.trace.getTask(t.id)?.updatedAt ?? 0) > cutoff)
          .map((t) => {
            const url = t.statusView().url ?? '';
            return { ...t.statusView(), act: thresholdsFor(ctx.getConfig(), url, t.spec.policy.confidence).ground.choice.act };
          });
        return { tasks: list };
      }
      case 'ext.control': {
        const t = tasks.get(params.task_id);
        if (params.action === 'pause') t.pause('paused from the side panel');
        else if (params.action === 'takeover') t.pause('user_takeover');
        else if (params.action === 'resume') t.resume();
        else if (params.action === 'cancel') t.cancel('cancelled from the side panel');
        else if (params.action === 'update') t.update(params.patch ?? {});
        return t.statusView();
      }
      case 'ext.answer': {
        const t = tasks.byQuestion(params.question_id);
        if (!t) throw new Error('The question is no longer pending');
        const parsed = answerSchema.safeParse(params.answer);
        if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join('; '));
        return t.answer(params.question_id, parsed.data);
      }
      case 'ext.highlight': {
        const t = tasks.get(params.task_id);
        const q = t.pendingQuestion;
        const refs = params.on ? (q?.decision?.candidates?.map((c) => c.ref) ?? []) : [];
        await highlight(ctx, t.tabId, refs);
        return { ok: true };
      }
      case 'ui.url': return { url: http.authUrl() };
      default: throw new Error(`unknown ui method ${method}`);
    }
  };

  rpc.register('ext.pairingCode', () => bridge.newPairingCode());
  rpc.register('ui.url', () => ({ url: http.authUrl() }));
  rpc.register('trace.calibration', async (p: { template?: string; targetPrecision?: number; days?: number }) => {
    const { calibration } = await import('../core/trace/calibration.ts');
    return calibration(ctx.trace, { template: p.template, targetPrecision: p.targetPrecision, sinceDays: p.days });
  });
  rpc.register('memory.list', () => memory.list());
  rpc.register('memory.remove', (p: { id: string }) => { if (!p.id) throw new RpcError(ERR.invalidParams, 'id required'); memory.remove(p.id); return { ok: true }; });

  handle.endpoint.httpPort = port;
  handle.endpoint.httpToken = http.token;
  handle.endpoint.extensionPort = port;
  writeEndpoint(handle.endpoint);
  handle.busy.push(() => tasks.busy());
  handle.onClose(async () => { tasks.suspendAll(); bridge.close(); await http.close(); });
  ctx.extras.tasks = () => tasks.tasks.size;
  ctx.secrets.push(() => [...tasks.tasks.values()].flatMap((t) => t.secretValues()));
  ctx.extras.ui = () => http.url('/');
  log.info(`debug UI on ${http.url('/')} (extension endpoint ws://127.0.0.1:${port}/ext)`);
  return { tasks, memory, bridge, http };
}
