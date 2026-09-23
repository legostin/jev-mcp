import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools.ts';

/** Stage-2 task tools are registered here (jev_task, jev_status, jev_wait, jev_answer, jev_control, jev_result, jev_trace). */
export function registerTaskTools(_server: McpServer, _deps: ToolDeps): void {}
