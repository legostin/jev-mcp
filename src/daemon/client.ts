import { connect, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, openSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LineDecoder, RpcError } from './protocol.ts';
import { socketPath, logFile, dataDir } from '../core/util/paths.ts';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DaemonClient {
  call<T = any>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  onEvent(fn: (method: string, params: any) => void): () => void;
  onClose(fn: () => void): () => void;
  close(): void;
  readonly closed: boolean;
}

function open(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** Starts `jev daemon` detached, logging to the daemon log file. */
export function spawnDaemon(): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const out = openSync(logFile(), 'a', 0o600);
  const child = spawn(process.execPath, [join(ROOT, 'bin', 'jev.mjs'), 'daemon'], {
    detached: true, stdio: ['ignore', out, out], env: process.env, cwd: ROOT,
  });
  child.unref();
}

/** Connects to the daemon, starting it when `autostart` is set and it is not running yet. */
export async function connectDaemon(opts: { autostart?: boolean; timeoutMs?: number } = {}): Promise<DaemonClient> {
  const path = socketPath();
  let socket: Socket | null = null;
  try { socket = await open(path); } catch {
    if (!opts.autostart) throw new Error('The jev daemon is not running. Start it with: jev daemon');
    spawnDaemon();
    const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
    while (!socket && Date.now() < deadline) {
      await sleep(150);
      if (!existsSync(path)) continue;
      try { socket = await open(path); } catch { /* not ready */ }
    }
    if (!socket) throw new Error(`The jev daemon did not start. See ${logFile()}`);
  }
  return wrap(socket);
}

function wrap(socket: Socket): DaemonClient {
  socket.setEncoding('utf8');
  let seq = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const eventFns = new Set<(m: string, p: any) => void>();
  const closeFns = new Set<() => void>();
  const decoder = new LineDecoder();
  socket.on('data', (chunk: string) => decoder.push(chunk, (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of [...eventFns]) { try { fn(msg.method, msg.params); } catch { /* isolated */ } }
    }
  }));
  const finish = () => {
    if (closed) return;
    closed = true;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('Daemon connection closed')); }
    pending.clear();
    for (const fn of [...closeFns]) fn();
  };
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    get closed() { return closed; },
    call(method, params, opts = {}) {
      if (closed) return Promise.reject(new Error('Daemon connection closed'));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Daemon call ${method} timed out`)); }, opts.timeoutMs ?? 120_000);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
      });
    },
    onEvent(fn) { eventFns.add(fn); return () => eventFns.delete(fn); },
    onClose(fn) { closeFns.add(fn); return () => closeFns.delete(fn); },
    close() { socket.end(); finish(); },
  };
}
