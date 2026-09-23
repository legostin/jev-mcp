import { appendFileSync } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: Level = (process.env.JEV_LOG_LEVEL as Level) || 'info';
let sinkFile: string | null = null;

/** Logs go to stderr (stdout is reserved for the MCP protocol) and optionally to a file. */
export function configureLog(opts: { level?: Level; file?: string | null }): void {
  if (opts.level) minLevel = opts.level;
  if (opts.file !== undefined) sinkFile = opts.file;
}

const SECRET_PATTERN = /(sk-or-v1-[A-Za-z0-9]{8,}|"apiKey"\s*:\s*"[^"]+")/g;

export function redactText(text: string): string {
  return text.replace(SECRET_PATTERN, '[redacted]');
}

function write(level: Level, scope: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}`;
  if (extra !== undefined) {
    const rendered = extra instanceof Error ? (extra.stack ?? extra.message) : safeJson(extra);
    line += ` ${rendered}`;
  }
  line = redactText(line);
  if (sinkFile) {
    try { appendFileSync(sinkFile, line + '\n', { mode: 0o600 }); } catch { /* logging must never throw */ }
  } else {
    process.stderr.write(line + '\n');
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  };
}
