import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * All filesystem locations used by jev-browser. `JEV_HOME` relocates everything
 * (used by tests so they never touch the real user config).
 */
function home(): string | null {
  return process.env.JEV_HOME || null;
}

export function configDir(): string {
  const h = home();
  return h ? join(h, 'config') : join(homedir(), '.config', 'jev-browser');
}

export function dataDir(): string {
  const h = home();
  return h ? join(h, 'data') : join(homedir(), '.local', 'share', 'jev-browser');
}

export const configFile = (): string => join(configDir(), 'config.json');
export const endpointFile = (): string => join(dataDir(), 'jevd.json');
export const lockFile = (): string => join(dataDir(), 'jevd.lock');
export const logFile = (): string => join(dataDir(), 'jevd.log');
export const profileDir = (): string => join(dataDir(), 'profile');
export const tracesDir = (): string => join(dataDir(), 'traces');
export const dbFile = (): string => join(dataDir(), 'jev.sqlite');

/** Unix socket paths are limited to ~104 bytes on macOS; fall back to a short hashed path. */
export function socketPath(): string {
  const preferred = join(dataDir(), 'jevd.sock');
  if (Buffer.byteLength(preferred) <= 100) return preferred;
  const hash = createHash('sha256').update(dataDir()).digest('hex').slice(0, 12);
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir();
  return join(base, `jev-${hash}.sock`);
}
