import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DaemonBridge } from './client.ts';
import { registerPageTools, type ToolDeps, type ToolResult } from './tools.ts';
import { registerTaskTools, formatQuestion, formatResult } from './task-tools.ts';
import { VERSION } from '../daemon/main.ts';

export const INSTRUCTIONS = [
  'jev-browser drives a real Chrome browser with JEV, a fast decision model (TypeSafe System One). JEV does not write text or plan:',
  'you plan and supply the data; JEV finds elements, reads page state and verifies steps in ~100 ms per decision.',
  'Prefer jev_task for multi-step goals: goal, about and hints in English, param values exactly as the site shows them, dates as',
  'YYYY-MM-DD or {from,to}, secrets as params with secret:true, and a result schema with select (min/max/first/all).',
  'The task runs in the background (consent banners, prefilled fields, autocompletes, date pickers, results in new tabs are handled);',
  'reversible steps (fields, filter chips, dropdowns, pickers, sorting) try the best candidate even at low confidence, verify the effect and',
  'roll back before trying the next (policy.confidence.trial); when that runs out, or before anything irreversible, JEV asks you a question',
  'instead of guessing. Questions arrive as <channel source="jev-browser" task_id=… question_id=…>',
  'events (Claude Code with channels), as "JEV is waiting for your answer" blocks appended to every jev tool result, and through jev_wait.',
  'In Claude Code, run `jev watch <task_id>` in the background after starting a task: it exits on the next question or when the task ends.',
  'Answer with jev_answer. Blocker questions (CAPTCHA, login wall) need a person: ask the user to solve it in the browser, then answer',
  '"continue"; if the tab is headless, abort and rerun with driver "extension" (the user\'s Chrome). Confirm risk_confirm questions only if',
  'the user asked for that action. For direct control use jev_observe (compact page view), jev_find (JEV-ranked search), jev_ask',
  '(your own typed questions) and jev_act. Setup problems: jev_doctor.',
].join(' ');

export async function runMcpServer(): Promise<void> {
  const bridge = new DaemonBridge();
  const server = new McpServer(
    { name: 'jev-browser', version: VERSION },
    { capabilities: { tools: {}, experimental: { 'claude/channel': {} } }, instructions: INSTRUCTIONS },
  );
  const deps: ToolDeps = { bridge, decorate: async (r: ToolResult) => r };
  registerPageTools(server, deps);
  registerTaskTools(server, deps);
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
