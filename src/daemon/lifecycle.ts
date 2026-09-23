import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dataDir, endpointFile, lockFile } from '../core/util/paths.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Exclusive daemon lock; a stale lock (dead pid) is taken over. */
export function acquireLock(): () => void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const path = lockFile();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true }); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8'));
      if (pid && alive(pid) && pid !== process.pid) throw new Error(`jev daemon already running (pid ${pid})`);
      rmSync(path, { force: true });
    }
  }
  throw new Error('Could not acquire the daemon lock');
}

export interface Endpoint { pid: number; socket: string; httpPort: number | null; httpToken: string | null; extensionPort: number | null; version: string; startedAt: number }

export function writeEndpoint(ep: Endpoint): void {
  writeFileSync(endpointFile(), JSON.stringify(ep, null, 2), { mode: 0o600 });
}

export function readEndpoint(): Endpoint | null {
  if (!existsSync(endpointFile())) return null;
  try { return JSON.parse(readFileSync(endpointFile(), 'utf8')); } catch { return null; }
}

export function clearEndpoint(): void { rmSync(endpointFile(), { force: true }); }

/** Calls `onIdle` after `minutes` without clients, tasks or UI viewers. */
export class IdleTimer {
  private timer: NodeJS.Timeout | null = null;
  private readonly ms: number;
  private readonly busy: () => boolean;
  private readonly onIdle: () => void;
  constructor(minutes: number, busy: () => boolean, onIdle: () => void) {
    this.ms = minutes * 60_000;
    this.busy = busy;
    this.onIdle = onIdle;
  }
  poke(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.busy()) this.poke(); else this.onIdle(); }, this.ms);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearTimeout(this.timer); }
}
