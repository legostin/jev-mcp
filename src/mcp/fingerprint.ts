import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPageTools, type ToolDeps } from './tools.ts';
import { registerTaskTools } from './task-tools.ts';
import { INSTRUCTIONS } from './instructions.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

let tools: string | null = null;

/**
 * What the agent sees of jev-browser: tool names, descriptions, input schemas and the server instructions. An MCP
 * process keeps what it registered at start; a daemon started later computes the current one from disk.
 */
export function toolsFingerprint(): string {
  if (tools) return tools;
  const list: unknown[] = [];
  const capture = {
    registerTool: (name: string, config: { title?: string; description?: string; inputSchema?: Record<string, z.ZodType> }) => {
      const input = config.inputSchema ? z.toJSONSchema(z.object(config.inputSchema), { unrepresentable: 'any' }) : null;
      list.push({ name, title: config.title, description: config.description, input });
    },
  } as unknown as McpServer;
  const deps = { bridge: null, decorate: async (r: unknown) => r } as unknown as ToolDeps;
  registerPageTools(capture, deps);
  registerTaskTools(capture, deps);
  tools = hash(JSON.stringify({ list, instructions: INSTRUCTIONS }));
  return tools;
}

const srcDir = fileURLToPath(new URL('../', import.meta.url));

/** The code on disk (every source file under src/): a daemon whose code changed since it started is stale. */
export function codeFingerprint(dir = srcDir): string {
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    try { h.update(readFileSync(join(dir, f))); } catch { /* removed while reading */ }
  }
  return h.digest('hex').slice(0, 16);
}
