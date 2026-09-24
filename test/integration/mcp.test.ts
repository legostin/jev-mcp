import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

const home = mkdtempSync(join(tmpdir(), 'jevm-'));
const env = { ...process.env, JEV_HOME: home, JEV_HEADLESS: '1', JEV_FAKE: '1' } as Record<string, string>;
let fixtures: FixtureServer;
let client: Client;

const textOf = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');

beforeAll(async () => {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'sk-or-v1-secretsecretsecret0000' } } }));
  fixtures = await startFixtureServer();
  client = new Client({ name: 'jev-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/jev.mjs', 'mcp'], env, stderr: 'pipe' }));
}, 60_000);

afterAll(async () => {
  await client?.callTool({ name: 'jev_settings', arguments: {} }).catch(() => {});
  const { execFileSync } = await import('node:child_process');
  try { execFileSync(process.execPath, ['bin/jev.mjs', 'stop'], { env }); } catch { /* already stopped */ }
  await client?.close();
  await fixtures?.close();
  await new Promise((r) => setTimeout(r, 800));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('MCP server', () => {
  it('exposes the stage-1 tools with instructions', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['jev_observe', 'jev_find', 'jev_ask', 'jev_act', 'jev_tabs', 'jev_screenshot', 'jev_settings', 'jev_doctor']) expect(tools).toContain(t);
    expect(client.getInstructions()).toMatch(/JEV/);
    // A daemon started on the same code reports the same tools: no restart notice.
    expect(textOf(await client.callTool({ name: 'jev_tabs', arguments: {} }))).not.toMatch(/restart|older/);
    expect(client.getServerCapabilities()?.experimental).toHaveProperty('claude/channel');
  });

  it('opens a page, observes it and finds an element through the daemon', async () => {
    const opened = await client.callTool({ name: 'jev_tabs', arguments: { action: 'open', url: fixtures.url('login.html') } });
    expect(textOf(opened)).toMatch(/opened t\d+/);
    const obs = await client.callTool({ name: 'jev_observe', arguments: { view: 'full' } });
    expect(textOf(obs)).toMatch(/textbox "Email address"/);
    const found = await client.callTool({ name: 'jev_find', arguments: { query: 'password input' } });
    expect(textOf(found)).toMatch(/textbox "Password"/);
    const act = await client.callTool({ name: 'jev_act', arguments: { action: 'type', intent: 'email address input', value: 'a@b.co' } });
    expect(act.isError).toBeFalsy();
    expect(textOf(act)).toContain('a@b.co');
    const shot = await client.callTool({ name: 'jev_screenshot', arguments: {} });
    expect((shot.content as any[])[0].type).toBe('image');
  });

  it('never returns the raw key', async () => {
    const r = await client.callTool({ name: 'jev_settings', arguments: { path: 'providers' } });
    expect(textOf(r)).not.toContain('secretsecret');
    expect(textOf(r)).toContain('sk-or-…0000');
  });
});
