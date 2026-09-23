import type { DaemonHandle } from './main.ts';
import { TaskManager } from './tasks.ts';
import { MemoryStore } from '../core/memory/store.ts';

export interface Stage2 { tasks: TaskManager; memory: MemoryStore }

/** Wires stage 2+ features (tasks, site memory, extension bridge, HTTP UI) into a running daemon. */
export async function registerStage2(handle: DaemonHandle): Promise<Stage2> {
  const memory = new MemoryStore(handle.ctx.trace.db);
  const tasks = new TaskManager(handle.ctx, handle.rpc, memory);
  tasks.register();
  handle.busy.push(() => tasks.busy());
  handle.onClose(() => tasks.cancelAll());
  handle.ctx.extras.tasks = () => tasks.tasks.size;
  return { tasks, memory };
}
