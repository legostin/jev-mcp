import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixtureServer, type FixtureServer } from '../../fixtures/sites/server.ts';

const exec = promisify(execFile);
const home = mkdtempSync(join(tmpdir(), 'jevmt-'));
const env = { ...process.env, JEV_HOME: home, JEV_HEADLESS: '1', JEV_FAKE: '1' } as Record<string, string>;
let fixtures: FixtureServer;
let client: Client;
const textOf = (r: any) => r.content.map((c: any) => c.text ?? '').join('\n');

beforeAll(async () => {
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ trace: { screenshots: false } }));
  fixtures = await startFixtureServer();
  client = new Client({ name: 'jev-task-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/jev.mjs', 'mcp'], env, stderr: 'pipe' }));
}, 60_000);

afterAll(async () => {
  try { await exec(process.execPath, ['bin/jev.mjs', 'stop'], { env }); } catch { /* stopped */ }
  await client?.close();
  await fixtures?.close();
  await new Promise((r) => setTimeout(r, 800));
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('MCP task flow', () => {
  it('exposes the task tools', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['jev_task', 'jev_status', 'jev_wait', 'jev_answer', 'jev_control', 'jev_result', 'jev_trace']) expect(tools).toContain(t);
  });

  it('delivers a question via watch and piggyback, accepts an answer, and ends the task', async () => {
    // act = escalate = 1: every uncertain choice becomes a question, so the flow is deterministic with the offline JEV.
    const created = await client.callTool({ name: 'jev_task', arguments: {
      goal: 'Sign in to the site', site: fixtures.url('login.html'),
      params: { email: { value: 'ann@example.com', about: 'account email' } },
      policy: { confidence: { act: 1, escalate: 1 } },
    } });
    const taskId = textOf(created).match(/Task (t_\S+) started/)![1];
    expect(textOf(created)).toContain(`jev watch ${taskId}`);

    const watched = await exec(process.execPath, ['bin/jev.mjs', 'watch', taskId, '--timeout', '60'], { env });
    const ev = JSON.parse(watched.stdout);
    expect(ev).toMatchObject({ event: 'question', task_id: taskId });
    expect(ev.question_id).toMatch(/^q_/);

    // Any tool result now carries the pending question.
    const tabs = await client.callTool({ name: 'jev_tabs', arguments: {} });
    expect(textOf(tabs)).toContain('JEV is waiting for your answer');
    expect(textOf(tabs)).toContain(ev.question_id);

    const status = await client.callTool({ name: 'jev_status', arguments: { task_id: taskId } });
    expect(textOf(status)).toMatch(/awaiting_input/);

    const ans = await client.callTool({ name: 'jev_answer', arguments: { question_id: ev.question_id, type: 'abort', reason: 'test' } });
    expect(ans.isError).toBeFalsy();
    const waited = await client.callTool({ name: 'jev_wait', arguments: { task_id: taskId, until: 'done', timeout_s: 20 } });
    expect(textOf(waited)).toMatch(/finished: cancelled/);

    const trace = await client.callTool({ name: 'jev_trace', arguments: { task_id: taskId } });
    expect(textOf(trace)).toMatch(/Questions: q_/);
    const again = await client.callTool({ name: 'jev_answer', arguments: { question_id: ev.question_id, type: 'continue' } });
    expect(again.isError).toBe(true);
  });
});
