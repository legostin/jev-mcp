import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile } from '../util/paths.ts';
import { configSchema, type Config, type ProviderName } from './schema.ts';
import { clone, isPlainObject } from '../util/json.ts';

export class ConfigError extends Error {}

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  return result.data;
}

export function loadConfig(file = configFile()): Config {
  if (!existsSync(file)) return parseConfig({});
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(raw);
}

/** Atomic write with owner-only permissions: the file holds API keys. */
export function saveConfig(cfg: Config, file = configFile()): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Returns a new, validated config with `path` set to `value` (`undefined` deletes). */
export function setPath(cfg: Config, path: string, value: unknown): Config {
  if (!path) throw new ConfigError('A settings path is required');
  const next = clone(cfg) as Record<string, unknown>;
  const parts = path.split('.');
  let cur: Record<string, unknown> = next;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return parseConfig(next);
}

/** Parses CLI-style values: JSON literals when possible, otherwise the raw string. */
export function coerceValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= 12) return '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** Copy of the config that is safe to show to agents, UIs and logs. */
export function redactConfig(cfg: Config): Config {
  const out = clone(cfg);
  for (const name of ['openrouter', 'typesafe'] as const) {
    const p = out.providers[name];
    if (p.apiKey) p.apiKey = maskKey(p.apiKey);
  }
  return out;
}

const ENV: Record<ProviderName, { specific: string; generic: string }> = {
  openrouter: { specific: 'JEV_OPENROUTER_API_KEY', generic: 'OPENROUTER_API_KEY' },
  typesafe: { specific: 'JEV_TYPESAFE_API_KEY', generic: 'TYPESAFE_API_KEY' },
};

/** Key precedence: JEV_*_API_KEY env, then the config file, then the generic provider env var. */
export function resolveApiKey(cfg: Config, provider: ProviderName): string | undefined {
  const env = ENV[provider];
  return process.env[env.specific] || cfg.providers[provider].apiKey || process.env[env.generic] || undefined;
}
