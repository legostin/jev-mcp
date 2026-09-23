import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonBridge } from './client.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult { content: Content[]; isError?: boolean; [k: string]: unknown }

const tabArg = z.string().optional().describe('Tab id such as "t2". Defaults to the tab this session used last (a new tab is opened if none).');

function fmtCandidates(c: { ref: string; p: number; desc: string }[] | undefined): string {
  return (c ?? []).map((x) => `  ${x.ref} p=${x.p.toFixed(2)} ${x.desc}`).join('\n');
}

export interface ToolDeps {
  bridge: DaemonBridge;
  /** Appends pending-question notices to every tool response (set up by the task tools). */
  decorate: (result: ToolResult) => Promise<ToolResult>;
}

export function text(t: string): ToolResult { return { content: [{ type: 'text', text: t }] }; }
export function errorResult(t: string): ToolResult { return { content: [{ type: 'text', text: t }], isError: true }; }

/** Wraps a handler: daemon/JEV errors become readable tool errors, and pending questions are appended. */
export function wrap<A>(deps: ToolDeps, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    let res: ToolResult;
    try { res = await fn(args); } catch (e) {
      const err = e as Error & { data?: { kind?: string } };
      const kind = err.data?.kind ? ` [${err.data.kind}]` : '';
      res = errorResult(`${err.message}${kind}`);
    }
    return deps.decorate(res);
  };
}

/** Stage-1 tools: page understanding, direct control, tabs, settings and diagnostics. */
export function registerPageTools(server: McpServer, deps: ToolDeps): void {
  const { bridge } = deps;

  server.registerTool('jev_observe', {
    title: 'Observe page',
    description: [
      'Compact, structured view of a browser page (much cheaper than screenshots or raw HTML).',
      'Views: "overview" = regions (forms, lists, overlays, popups) with sample controls; "region" = all elements of a region (target r3);',
      '"element" = details and neighbours of one element (target e12); "diff" = what changed since the previous observation; "full" = everything, budgeted.',
      'Elements have stable refs (e12) usable with jev_act. Flags: [covered] = hidden behind an overlay, [BLOCKING] = overlay to dismiss first.',
    ].join(' '),
    inputSchema: {
      tab: tabArg,
      view: z.enum(['overview', 'region', 'element', 'diff', 'full']).optional().describe('Default "overview".'),
      target: z.string().optional().describe('Region id (r3) for view "region", element ref (e12) for view "element".'),
      budget: z.number().int().min(200).max(20000).optional().describe('Approximate token budget of the output. Default 2000.'),
    },
  }, wrap(deps, async (a: { tab?: string; view?: string; target?: string; budget?: number }) => {
    const r = await bridge.call('page.observe', a);
    return text(`tab ${r.tab} · ${r.url}\n${r.text}`);
  }));

  server.registerTool('jev_find', {
    title: 'Find elements',
    description: 'Describe what you are looking for in plain English ("the departure city input", "button that applies the price filter"); JEV ranks the page elements and returns the best matches with probabilities, plus whether such an element exists at all. Cheap (~100 ms, fractions of a cent).',
    inputSchema: {
      tab: tabArg,
      query: z.string().min(2).describe('What to find, in English.'),
      k: z.number().int().min(1).max(20).optional().describe('How many matches to return (default 5).'),
      kinds: z.array(z.enum(['link', 'button', 'textbox', 'combobox', 'select', 'checkbox', 'radio', 'slider', 'option', 'tab', 'menuitem', 'clickable', 'file', 'heading', 'text', 'image'])).optional().describe('Restrict to these element kinds.'),
      region: z.string().optional().describe('Restrict to a region id (and its sub-regions).'),
    },
  }, wrap(deps, async (a: { tab?: string; query: string; k?: number; kinds?: string[]; region?: string }) => {
    const r = await bridge.call('page.find', a);
    const head = r.decision === 'none'
      ? `No element matches "${a.query}" (exists=${r.exists.toFixed(2)}).`
      : `Best: ${r.best ?? '—'} (confidence ${r.confidence.toFixed(2)}, exists ${r.exists.toFixed(2)}, ${r.decision === 'act' ? 'confident' : 'uncertain'})`;
    return text(`${head}\n${fmtCandidates(r.matches)}`);
  }));

  server.registerTool('jev_ask', {
    title: 'Ask JEV about the page',
    description: [
      'Ask JEV your own typed questions about the current page (or one region). State is built from the page automatically.',
      'Question types: {type:"noul", instructions} -> probability of yes; {type:"choice", instructions, criteria:{option: description|null}} -> one option with probabilities;',
      '{type:"score", instructions, criteria:[level descriptions, 2-10]} -> position on the scale. Ask several independent questions in one call.',
      'Refer to page data with backticks: `page.elements.e12`, `page.regions.r3`, `context`. JEV does not generate text, count or do date math.',
    ].join(' '),
    inputSchema: {
      tab: tabArg,
      questions: z.record(z.string(), z.object({
        type: z.enum(['noul', 'choice', 'score']),
        instructions: z.any(),
        criteria: z.any().optional(),
      })).describe('Map of question id to question.'),
      region: z.string().optional().describe('Only include elements of this region (default: visible elements in the viewport).'),
      context: z.string().optional().describe('Extra text placed in the state as `context`.'),
    },
  }, wrap(deps, async (a: any) => {
    const r = await bridge.call('page.ask', a);
    const lines = Object.entries(r.answers as Record<string, any>).map(([k, v]) => {
      if (v.type === 'noul') return `${k}: noul=${v.noul.toFixed(3)}`;
      if (v.type === 'choice') return `${k}: choice=${v.choice} confidence=${v.confidence.toFixed(2)} probabilities=${JSON.stringify(Object.fromEntries(Object.entries(v.probabilities as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([o, p]) => [o, Number(p.toFixed(3))])))}`;
      return `${k}: score=${v.score.toFixed(2)} confidence=${v.confidence.toFixed(2)} legend=${JSON.stringify(v.legend)}`;
    });
    return text(`${lines.join('\n')}\nmodel ${r.model} · cost $${r.costUsd.toFixed(6)}\nplayground: ${r.playground}`);
  }));

  server.registerTool('jev_act', {
    title: 'Act on the page',
    description: [
      'Perform one browser action with trusted input and get back what changed.',
      'Target an element by ref (from jev_observe/jev_find) or by intent ("the Search button"); intents are grounded by JEV and refused when uncertain (candidates are returned).',
      'Actions: click, type (value; options.submit presses Enter; options.mode "keys" types per key for autocompletes), select (value = option text or value),',
      'check, uncheck, hover, focus, press (value = key such as Enter, Escape, ArrowDown, Control+A), scroll (value = pixels, "up", "down", "top", "bottom", or a target to scroll into view),',
      'navigate (value = URL), back, wait (value = ms), upload (value = file path or paths).',
      'Clicks on elements covered by an overlay fail with reason "occluded" unless options.force is set.',
    ].join(' '),
    inputSchema: {
      tab: tabArg,
      action: z.enum(['click', 'type', 'select', 'check', 'uncheck', 'press', 'scroll', 'hover', 'focus', 'navigate', 'back', 'wait', 'upload']),
      ref: z.string().optional().describe('Element ref such as e12.'),
      intent: z.string().optional().describe('Plain-English target when you do not have a ref.'),
      value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
      options: z.object({
        mode: z.enum(['insert', 'keys']).optional(),
        clear: z.boolean().optional().describe('Clear the field before typing (default true).'),
        force: z.boolean().optional().describe('Click even if covered.'),
        submit: z.boolean().optional().describe('Press Enter after typing.'),
      }).optional(),
    },
  }, wrap(deps, async (a: any) => {
    const r = await bridge.call('page.act', a);
    if (!r.ok) {
      const parts = [`Not done: ${r.reason}. ${r.message ?? ''}`.trim()];
      if (r.coveredBy) parts.push(`covered by: ${r.coveredBy}`);
      if (r.hint) parts.push(r.hint);
      if (r.candidates?.length) parts.push('candidates:', fmtCandidates(r.candidates));
      return errorResult(parts.join('\n'));
    }
    return text([`ok · ${r.action}${r.target ? ` ${r.target}` : ''} · ${r.url}`, r.warning ? `warning: ${r.warning}` : '', r.diff].filter(Boolean).join('\n'));
  }));

  server.registerTool('jev_tabs', {
    title: 'Tabs',
    description: 'List, open, close or select browser tabs. "open" takes a URL and optional driver ("extension" = your Chrome via the jev extension, "chromium" = jev\'s own Chrome profile, "auto" = extension when connected). Returns an overview of the opened page.',
    inputSchema: {
      action: z.enum(['list', 'open', 'close', 'select']).optional().describe('Default "list".'),
      url: z.string().optional(),
      tab: z.string().optional(),
      driver: z.enum(['auto', 'extension', 'chromium']).optional(),
    },
  }, wrap(deps, async (a: { action?: string; url?: string; tab?: string; driver?: string }) => {
    const action = a.action ?? 'list';
    if (action === 'open') {
      const r = await bridge.call('tabs.open', { url: a.url, driver: a.driver });
      return text(`opened ${r.tab} (${r.driver}) · ${r.url}\n${r.overview}`);
    }
    if (action === 'close') { if (!a.tab) return errorResult('close needs tab'); await bridge.call('tabs.close', { tab: a.tab }); return text(`closed ${a.tab}`); }
    if (action === 'select') { if (!a.tab) return errorResult('select needs tab'); const r = await bridge.call('tabs.select', { tab: a.tab }); return text(`current tab ${r.tab} · ${r.url}`); }
    const r = await bridge.call('tabs.list');
    const lines = r.tabs.map((t: any) => `${t.current ? '*' : ' '} ${t.id} [${t.driver}]${t.task ? ` task ${t.task}` : ''} ${t.title ? `"${t.title}" ` : ''}${t.url}`);
    return text(`${lines.join('\n') || 'no tabs'}\nextension: ${r.extensionConnected ? 'connected' : 'not connected'}`);
  }));

  server.registerTool('jev_screenshot', {
    title: 'Screenshot',
    description: 'PNG screenshot of the viewport or of one element (ref). Use only when you need vision (canvas, images, visual layout); jev_observe is cheaper for everything else.',
    inputSchema: { tab: tabArg, ref: z.string().optional() },
  }, wrap(deps, async (a: { tab?: string; ref?: string }) => {
    const r = await bridge.call('page.screenshot', a);
    return { content: [{ type: 'image', data: r.data, mimeType: r.mimeType }, { type: 'text', text: `tab ${r.tab}` }] };
  }));

  server.registerTool('jev_settings', {
    title: 'Settings',
    description: [
      'Read or change jev settings (~/.config/jev-browser/config.json). Keys are write-only (shown masked).',
      'Useful paths: provider ("openrouter" | "typesafe"), providers.openrouter.apiKey, providers.typesafe.apiKey, providers.<p>.model,',
      'failover, confidence.preset ("cautious" | "balanced" | "autonomous"), confidence.act, confidence.escalate (0 disables confidence-driven questions),',
      'confidence.overrides["ground.choice"], domains.<host>.confidence, domains.<host>.irreversible ("ask" | "allow"), driver.default,',
      'driver.chromium.headless, budgets.perTaskUsd, limits.maxSteps, trace.screenshots.',
    ].join(' '),
    inputSchema: {
      action: z.enum(['get', 'set']).optional().describe('Default "get".'),
      path: z.string().optional().describe('Dotted path; empty = whole config.'),
      value: z.any().optional().describe('New value for "set" (JSON type: number, string, boolean, object).'),
    },
  }, wrap(deps, async (a: { action?: string; path?: string; value?: unknown }) => {
    if ((a.action ?? 'get') === 'set') {
      if (!a.path) return errorResult('set needs path');
      const r = await bridge.call('settings.set', { path: a.path, value: a.value });
      return text(`${r.path} = ${JSON.stringify(r.value)}`);
    }
    const r = await bridge.call('settings.get', { path: a.path });
    return text(JSON.stringify(r.value, null, 2));
  }));

  server.registerTool('jev_doctor', {
    title: 'Diagnostics',
    description: 'Checks the daemon, API key, JEV latency (one tiny request), Chrome and the extension connection.',
    inputSchema: {},
  }, wrap(deps, async () => {
    const r = await bridge.call('doctor', {}, { timeoutMs: 60_000 });
    return text(r.checks.map((c: any) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n'));
  }));
}
