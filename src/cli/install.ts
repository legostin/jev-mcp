import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, setPath, resolveApiKey } from '../core/config/store.ts';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'jev.mjs');
const SERVER = 'jev-browser';

function which(cmd: string): string | null {
  try { return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr ?? (e as Error).message) };
  }
}

/** Removes every `[mcp_servers.jev-browser]` table (and its sub-tables) from a Codex config.toml. */
export function stripCodexBlock(toml: string): string {
  const lines = toml.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = header[1] === `mcp_servers.${SERVER}` || header[1].startsWith(`mcp_servers.${SERVER}.`);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function codexBlock(): string {
  return `[mcp_servers.${SERVER}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(BIN)}, "mcp"]\n`;
}

function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) || isSymlink(path)) {
    if (!isSymlink(path)) return `skipped ${path} (a real file or directory is there)`;
    rmSync(path, { force: true });
  }
  symlinkSync(target, path);
  return `linked ${path} -> ${target}`;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function extensionId(): string | null {
  const f = join(ROOT, 'extension', 'id.txt');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

export async function install(args: string[]): Promise<void> {
  const log = (s: string) => console.log(`• ${s}`);
  const skip = (name: string) => args.includes(`--no-${name}`);

  if (!skip('claude')) {
    if (which('claude')) {
      run('claude', ['mcp', 'remove', SERVER, '-s', 'user']);
      const r = run('claude', ['mcp', 'add', '-s', 'user', SERVER, '--', process.execPath, BIN, 'mcp']);
      log(r.ok ? `Claude Code: registered MCP server "${SERVER}" (user scope)` : `Claude Code: registration failed: ${r.out.trim()}`);
    } else log('Claude Code CLI not found; skipped (add it later with: claude mcp add -s user jev-browser -- node bin/jev.mjs mcp)');
  }

  if (!skip('codex')) {
    const codexCfg = join(homedir(), '.codex', 'config.toml');
    if (existsSync(codexCfg)) {
      const next = `${stripCodexBlock(readFileSync(codexCfg, 'utf8')).trimEnd()}\n\n${codexBlock()}`;
      writeFileSync(codexCfg, next);
      log(`Codex: added [mcp_servers.${SERVER}] to ${codexCfg}`);
    } else log('Codex config not found; skipped');
  }

  const skill = join(ROOT, 'skills', 'jev-browser');
  log(`Skill: ${link(skill, join(homedir(), '.claude', 'skills', 'jev-browser'))}`);
  if (existsSync(join(homedir(), '.agents'))) log(`Skill: ${link(skill, join(homedir(), '.agents', 'skills', 'jev-browser'))}`);

  const binDir = join(homedir(), '.local', 'bin');
  log(`CLI: ${link(BIN, join(binDir, 'jev'))}`);
  if (!(process.env.PATH ?? '').split(':').includes(binDir)) log(`Add ${binDir} to PATH to use the "jev" command.`);

  const id = extensionId();
  let cfg = loadConfig();
  if (id && !cfg.driver.extensionIds.includes(id)) {
    cfg = setPath(cfg, 'driver.extensionIds', [...cfg.driver.extensionIds, id]);
    saveConfig(cfg);
  }
  const dist = join(ROOT, 'dist', 'extension');
  log(`Chrome extension: ${existsSync(dist) ? dist : `${dist} (run "npm run build:web" first)`}${id ? ` — id ${id}` : ''}`);
  log('  Load it in chrome://extensions (Developer mode → Load unpacked), then run "jev pair" and enter the code in the side panel.');

  const key = resolveApiKey(cfg, cfg.provider);
  log(key ? `API key for ${cfg.provider}: configured` : `API key missing: jev settings set providers.${cfg.provider}.apiKey -   (reads the key from stdin)`);
  log('Check everything with: jev doctor');
}

export async function uninstall(): Promise<void> {
  const log = (s: string) => console.log(`• ${s}`);
  if (which('claude')) {
    const r = run('claude', ['mcp', 'remove', SERVER, '-s', 'user']);
    log(r.ok ? 'Claude Code: removed MCP server' : 'Claude Code: server was not registered');
  }
  const codexCfg = join(homedir(), '.codex', 'config.toml');
  if (existsSync(codexCfg)) {
    const before = readFileSync(codexCfg, 'utf8');
    const after = stripCodexBlock(before);
    if (after !== before) { writeFileSync(codexCfg, after); log('Codex: removed MCP server block'); }
  }
  for (const p of [join(homedir(), '.claude', 'skills', 'jev-browser'), join(homedir(), '.agents', 'skills', 'jev-browser'), join(homedir(), '.local', 'bin', 'jev')]) {
    if (isSymlink(p) && readlinkSync(p).startsWith(ROOT)) { rmSync(p, { force: true }); log(`removed ${p}`); }
  }
  log('Settings and traces are kept in ~/.config/jev-browser and ~/.local/share/jev-browser (delete them manually if you want).');
}
