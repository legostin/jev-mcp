import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonBridge } from './client.ts';
import { registerPageTools, type ToolDeps, type ToolResult } from './tools.ts';
import { registerTaskTools, formatQuestion, formatResult } from './task-tools.ts';
import { VERSION } from '../daemon/main.ts';
import { INSTRUCTIONS } from './instructions.ts';
import { toolsFingerprint } from './fingerprint.ts';

export { INSTRUCTIONS };

export async function runMcpServer(): Promise<void> {
  const bridge = new DaemonBridge();
  const server = new McpServer(
    { name: 'jev-browser', version: VERSION },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: INSTRUCTIONS },
  );
  const deps: ToolDeps = { bridge, decorate: async (r: ToolResult) => r };
  registerPageTools(server, deps);
  registerTaskTools(server, deps);
  // The tools the agent got from this process: a daemon on newer code reports different ones.
  bridge.own = { tools: toolsFingerprint(), startedAt: Date.now() };
  const withQuestions = deps.decorate;
  deps.decorate = async (r: ToolResult) => {
    const out = await withQuestions(r);
    return bridge.notice ? { ...out, content: [...out.content, { type: 'text', text: `\n--- ${bridge.notice} ---` }] } : out;
  };
  // Claude Code channels: push questions and results into the session (ignored by clients without channel support).
  let initialized = false;
  const push = (content: string, meta: Record<string, string>) => {
    if (!initialized) return;
    server.server.notification({ method: 'notifications/claude/channel', params: { content, meta } }).catch(() => {});
  };
  bridge.onEvent((method, ev) => {
    if (method !== 'task.event' || !ev?.channel) return;
    if (ev.type === 'question') push(formatQuestion(ev.payload), { task_id: ev.task_id, question_id: ev.payload.question_id, kind: ev.payload.kind });
    else if (ev.type === 'done') push(formatResult(ev.task_id, ev.payload), { task_id: ev.task_id, status: String(ev.payload?.status ?? 'done') });
  });
  server.server.oninitialized = () => {
    initialized = true;
    const info = server.server.getClientVersion();
    if (info?.name) bridge.clientName = info.name;
    // Connect eagerly so events (questions) can flow before the first tool call.
    bridge.get().catch(() => {});
  };
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => { bridge.close(); process.exit(0); };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}
