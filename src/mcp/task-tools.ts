import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { text, errorResult, wrap, type ToolDeps, type ToolResult } from './tools.ts';

const FIELD_TYPES = ['string', 'number', 'money', 'datetime', 'date', 'time', 'duration', 'url', 'boolean'] as const;

const confidenceArg = z.object({
  preset: z.enum(['cautious', 'balanced', 'autonomous']).optional(),
  act: z.number().min(0).max(1).optional().describe('Act without asking at or above this confidence (all choice decisions).'),
  escalate: z.number().min(0).max(1).optional().describe('Ask you below this confidence; 0 = never ask because of low confidence.'),
  escalateOnUnsure: z.boolean().optional(),
  overrides: z.record(z.string(), z.record(z.string(), z.any())).optional().describe('Per decision kind, e.g. {"ground.choice": {"act": 0.7, "escalate": 0.3}}.'),
  trial: z.object({
    enabled: z.boolean().optional(),
    floor: z.number().min(0).max(1).optional(),
    tries: z.number().int().min(1).max(5).optional(),
  }).optional().describe('Reversible steps (fields, filters, sorting, pickers) act on the best candidate down to `floor` confidence, verify the effect, roll back and try the next, up to `tries` times, before asking you. Default {enabled: true, floor: 0.25, tries: 2}.'),
}).describe('Confidence thresholds for this task (override global and per-domain settings).');

const paramArg = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({ from: z.string(), to: z.string() })])
    .describe('Exactly as the site should receive it (e.g. "Алматы"); dates as YYYY-MM-DD or a {from,to} range.'),
  about: z.string().optional().describe('What it is, in English (e.g. "departure city").'),
  secret: z.boolean().optional().describe('Passwords, card numbers: JEV never sees the value and traces mask it.'),
});

export interface Escalation {
  question_id: string; task_id: string; kind: string; summary: string;
  page: { url: string; title: string; page_kind?: Record<string, number>; regions: string[] };
  decision?: { candidates: { ref: string; p: number; desc: string }[]; confidence: number; thresholds?: { act: number; escalate: number } };
  context?: Record<string, unknown>; recent_steps: string[]; screenshot?: string; answer_with: string[];
}

export function formatQuestion(q: Escalation): string {
  const lines = [`Question ${q.question_id} from task ${q.task_id} [${q.kind}]: ${q.summary}`];
  const pk = q.page.page_kind ? Object.entries(q.page.page_kind).sort((a, b) => b[1] - a[1])[0] : null;
  lines.push(`Page: "${q.page.title}" ${q.page.url}${pk ? ` (looks like ${pk[0]} ${pk[1].toFixed(2)})` : ''}`);
  if (q.decision?.candidates?.length) {
    lines.push('Candidates (JEV probability):');
    for (const c of q.decision.candidates.slice(0, 6)) lines.push(`  ${c.ref} p=${c.p.toFixed(2)} ${c.desc}`);
    const th = q.decision.thresholds;
    lines.push(`Confidence ${q.decision.confidence.toFixed(2)}${th ? ` (acts at ≥ ${th.act}, asks below ${th.escalate})` : ''}`);
  }
  if (q.context && Object.keys(q.context).length) lines.push(`Context: ${JSON.stringify(q.context)}`);
  if (q.recent_steps?.length) lines.push(`Recent steps: ${q.recent_steps.slice(-4).join(' → ')}`);
  lines.push(`Answer with jev_answer {question_id: "${q.question_id}", type: ${q.answer_with.map((a) => `"${a}"`).join(' | ')}, ...}.`);
  lines.push('  pick → ref (element or candidate id); none → the target is not on this page; hint → text (scope "domain" keeps it for this site); set_param → key, value, about;');
  lines.push('  thresholds → confidence; continue → proceed (after you acted yourself or to confirm a risky step); skip; abort. remember:true stores a pick for this site.');
  lines.push('Use jev_observe / jev_find / jev_screenshot on the task tab if you need to look first.');
  return lines.join('\n');
}

export function formatResult(taskId: string, r: any, itemsLimit = 60): string {
  const lines = [`Task ${taskId} finished: ${r.status}${r.error ? ` (${r.error})` : ''}`];
  if (r.page) {
    // The results handed over for the agent to read: JEV found and prepared them, the agent decides.
    lines.push(`Results page: "${r.page.title}" ${r.page.url}${r.page.sorted_by ? ` (sorted on the site ${r.page.sorted_by})` : ''}`);
    lines.push(`Read the list and pick the answer yourself (JEV did not choose; skip accessories, sponsored or unrelated items). ${r.page.items.length} items${r.page.more ? ', the list continues on the page' : ''}:`);
    for (const it of r.page.items.slice(0, itemsLimit)) lines.push(`  ${it.i}. ${it.text}${it.url ? ` → ${it.url}` : ''}`);
    if (r.page.overview) lines.push(r.page.overview);
  }
  if (r.result?.selected) lines.push(`Selected: ${JSON.stringify(r.result.selected)}`);
  if (r.result?.items_count !== undefined && !r.page) lines.push(`Items: ${r.result.items_count} (full list: jev_result)`);
  if (r.result?.goal_reached) lines.push('Goal reached.');
  if (r.evidence && !r.page) lines.push(`Evidence: ${r.evidence.url}${r.evidence.snippets?.length ? ` — ${r.evidence.snippets.slice(0, 4).join(' | ')}` : ''}`);
  if (r.warnings?.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
  if (r.stats) lines.push(`Stats: ${r.stats.steps} steps, ${r.stats.jev_calls} JEV calls, ${r.stats.escalations} questions, $${Number(r.stats.cost_usd).toFixed(4)}, ${r.stats.duration_s}s`);
  return lines.join('\n');
}

function formatStatus(s: any): string {
  const progress = Object.entries(s.progress ?? {}).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `Task ${s.task_id} [${s.state}${s.reason ? `: ${s.reason}` : ''}] tab ${s.tab} step ${s.step}${s.subintent ? ` (${s.subintent})` : ''}`,
    `Goal: ${s.goal}`,
    s.url ? `Page: ${s.url}` : '',
    progress ? `Params: ${progress}` : '',
    s.recent_steps?.length ? `Recent: ${s.recent_steps.join(' → ')}` : '',
    s.pending_question ? `Pending question: ${s.pending_question.question_id} [${s.pending_question.kind}] ${s.pending_question.summary}` : '',
    `Stats: ${s.stats.steps} steps, ${s.stats.jev_calls} JEV calls, $${Number(s.stats.cost_usd).toFixed(4)}`,
  ].filter(Boolean).join('\n');
}

/** Stage-2 task tools, plus pending-question decoration for every tool response. */
export function registerTaskTools(server: McpServer, deps: ToolDeps): void {
  const { bridge } = deps;
  deps.decorate = async (res: ToolResult) => {
    try {
      const { questions } = await bridge.call<{ questions: Escalation[] }>('questions.pending', {}, { timeoutMs: 3000 });
      if (!questions.length) return res;
      const block = ['', '--- JEV is waiting for your answer ---', ...questions.map(formatQuestion)].join('\n');
      return { ...res, content: [...res.content, { type: 'text', text: block }] };
    } catch { return res; }
  };

  server.registerTool('jev_task', {
    title: 'Start a JEV browser task',
    description: [
      'Hand a multi-step browser goal to JEV. It runs in the background: JEV dismisses popups, fills fields from your params',
      '(picking autocomplete suggestions and calendar dates), submits, reads results and verifies each step. It asks you only when',
      'unsure (see instructions for how questions arrive). Write goal/about/hints in English; give param values exactly as the site',
      'needs them. With `result`, the task ends on the results: it applies the site\'s own sorting for select min(field)/max(field)',
      'and hands you the results list, one line per item: you read it and pick the answer (skip accessories, sponsored or',
      'unrelated items). result.extract "code" parses items by result.schema in code instead (bulk collection over many pages).',
      'Irreversible steps (pay, order, send, delete) always ask first',
      'unless policy.irreversible is "allow". Returns the task id immediately.',
    ].join(' '),
    inputSchema: {
      goal: z.string().min(3).describe('What to achieve, in English.'),
      site: z.string().optional().describe('Start URL. Omit to use the current tab (tab:"current").'),
      tab: z.string().optional().describe('Run in this tab id, or "current".'),
      params: z.record(z.string(), paramArg).optional().describe('Named inputs, e.g. {"from": {"value": "Алматы", "about": "departure city"}}.'),
      result: z.object({
        select: z.string().optional().describe('all | first | min(field) | max(field): min/max make JEV sort the list on the site (e.g. min(price)).'),
        extract: z.enum(['agent', 'code']).optional().describe('"agent" (default): you get the results list as text and pick the answer. "code": items are parsed by schema.'),
        pages: z.number().int().min(1).max(10).optional().describe('Result pages or "show more" loads to read before handing over (default 1).'),
        schema: z.record(z.string(), z.union([z.enum(FIELD_TYPES), z.object({ type: z.enum(FIELD_TYPES), about: z.string().optional() })])).optional()
          .describe('Fields to parse, for extract "code" (e.g. {"price": "money", "url": "url"}); with "agent" it only names what matters.'),
      }).optional().describe('The task should end on a results list.'),
      hints: z.array(z.string()).optional().describe('Facts that help JEV, in English (e.g. "The departure field is labelled Откуда").'),
      policy: z.object({
        confidence: confidenceArg.optional(),
        irreversible: z.enum(['ask', 'allow']).optional(),
        allowed_domains: z.array(z.string()).optional(),
        max_steps: z.number().int().positive().optional(),
        max_minutes: z.number().positive().optional(),
        budget_usd: z.number().positive().optional(),
        max_items: z.number().int().positive().optional(),
        fill_required: z.enum(['ask', 'any']).optional().describe('Required choices no param covers (lists, radio groups): "ask" you (default) or take "any" option that fits the goal and hints.'),
      }).optional(),
      driver: z.enum(['auto', 'extension', 'chromium']).optional(),
    },
  }, wrap(deps, async (a: any) => {
    const r = await bridge.call('task.create', a, { timeoutMs: 120_000 });
    return text([
      `Task ${r.task_id} started in tab ${r.tab}.`,
      'JEV works in the background and will ask only when unsure. Next:',
      `  • Claude Code: run \`jev watch ${r.task_id}\` in the background — it exits on the next question or when the task ends; or`,
      `  • call jev_wait {task_id: "${r.task_id}"}; pending questions also appear at the end of every jev tool result.`,
      r.trace ? `Live trace: ${r.trace}` : '',
    ].filter(Boolean).join('\n'));
  }));

  server.registerTool('jev_status', {
    title: 'Task status',
    description: 'Status of one task (task_id) or of all tasks of this session: state, current step, param progress, pending question, cost.',
    inputSchema: { task_id: z.string().optional() },
  }, wrap(deps, async (a: { task_id?: string }) => {
    const r = await bridge.call('task.status', a);
    if (a.task_id) return text(formatStatus(r));
    return text(r.tasks.length ? r.tasks.map(formatStatus).join('\n\n') : 'No tasks in this session.');
  }));

  server.registerTool('jev_wait', {
    title: 'Wait for a task event',
    description: 'Blocks until a task asks a question or finishes (until: "question" also returns on finish; "done"; "any" = any state change), or until the timeout (max 55 s). Without task_id it waits for any task of this session.',
    inputSchema: {
      task_id: z.string().optional(),
      until: z.enum(['question', 'done', 'any']).optional(),
      timeout_s: z.number().min(1).max(55).optional().describe('Default 30.'),
    },
  }, wrap(deps, async (a: { task_id?: string; until?: string; timeout_s?: number }) => {
    const r = await bridge.call('task.wait', { task_id: a.task_id, until: a.until ?? 'question', timeout_ms: (a.timeout_s ?? 30) * 1000 }, { timeoutMs: 70_000 });
    if (r.timeout) return text(`No event yet.${r.status ? `\n${formatStatus(r.status)}` : ''}`);
    const ev = r.event;
    if (ev.type === 'question') return text(formatQuestion(ev.payload));
    if (ev.type === 'done') return text(formatResult(ev.task_id, ev.payload));
    return text(`Task ${ev.task_id}: ${ev.type} ${JSON.stringify(ev.payload)}`);
  }));

  server.registerTool('jev_answer', {
    title: 'Answer a JEV question',
    description: 'Resolve a pending question (escalation). type: pick (ref), none (the target is not on this page; the task then looks behind "more filters" or moves on), hint (text, scope), set_param (key, value, about, secret), thresholds (confidence), continue, skip, abort (reason). remember:true stores a pick as site memory.',
    inputSchema: {
      question_id: z.string(),
      type: z.enum(['pick', 'none', 'hint', 'set_param', 'thresholds', 'continue', 'skip', 'abort']),
      ref: z.string().optional(),
      text: z.string().optional(),
      scope: z.enum(['task', 'domain']).optional(),
      key: z.string().optional(),
      value: z.any().optional(),
      about: z.string().optional(),
      secret: z.boolean().optional(),
      confidence: confidenceArg.optional(),
      reason: z.string().optional(),
      remember: z.boolean().optional(),
    },
  }, wrap(deps, async (a: any) => {
    let answer: Record<string, unknown>;
    switch (a.type) {
      case 'pick': if (!a.ref) return errorResult('pick needs ref'); answer = { type: 'pick', ref: a.ref }; break;
      case 'hint': if (!a.text) return errorResult('hint needs text'); answer = { type: 'hint', text: a.text, scope: a.scope }; break;
      case 'set_param': if (!a.key || a.value === undefined) return errorResult('set_param needs key and value'); answer = { type: 'set_param', key: a.key, value: a.value, about: a.about, secret: a.secret }; break;
      case 'thresholds': if (!a.confidence) return errorResult('thresholds needs confidence'); answer = { type: 'thresholds', value: a.confidence }; break;
      case 'abort': answer = { type: 'abort', reason: a.reason }; break;
      default: answer = { type: a.type };
    }
    const r = await bridge.call('task.answer', { question_id: a.question_id, answer, remember: a.remember });
    return r.accepted ? text(`${r.message} (task ${r.task_id})`) : errorResult(r.message);
  }));

  server.registerTool('jev_control', {
    title: 'Control a task',
    description: 'pause | resume | cancel a task, or update it while it runs (params, hints, confidence thresholds, policy).',
    inputSchema: {
      task_id: z.string(),
      action: z.enum(['pause', 'resume', 'cancel', 'update']),
      params: z.record(z.string(), paramArg).optional(),
      hints: z.array(z.string()).optional(),
      confidence: confidenceArg.optional(),
      policy: z.record(z.string(), z.any()).optional(),
    },
  }, wrap(deps, async (a: any) => {
    const patch = a.action === 'update' ? { params: a.params, hints: a.hints, confidence: a.confidence, policy: a.policy } : undefined;
    const r = await bridge.call('task.control', { task_id: a.task_id, action: a.action, patch });
    return text(formatStatus(r));
  }));

  server.registerTool('jev_result', {
    title: 'Task result',
    description: 'Final result of a task: selected item, all extracted items (up to items_limit), evidence, warnings and stats.',
    inputSchema: { task_id: z.string(), items_limit: z.number().int().min(0).max(500).optional().describe('Default 50.') },
  }, wrap(deps, async (a: { task_id: string; items_limit?: number }) => {
    const r = await bridge.call('task.result', { task_id: a.task_id });
    if (!r.result) return text(`Task ${a.task_id} has no result yet (state ${r.state}).${r.status ? `\n${formatStatus(r.status)}` : ''}`);
    const items = (r.result.items ?? []) as unknown[];
    const limit = a.items_limit ?? 50;
    const body = formatResult(a.task_id, r.result, limit);
    if (r.result.page) return text(body);
    return text(items.length ? `${body}\nItems${items.length > limit ? ` (first ${limit} of ${items.length})` : ''}:\n${items.slice(0, limit).map((it, i) => `${i}. ${JSON.stringify(it)}`).join('\n')}` : body);
  }));

  server.registerTool('jev_trace', {
    title: 'Task trace',
    description: 'How JEV decided: every step with its subintent, outcome, timings and the JEV calls (template, answers, cost), with links to the debug UI and to the TypeSafe playground for each call (pass step for one step in detail).',
    inputSchema: { task_id: z.string(), step: z.number().int().optional() },
  }, wrap(deps, async (a: { task_id: string; step?: number }) => {
    const r = await bridge.call('task.trace', a);
    const lines = [`Task ${r.task.id} [${r.task.state}] ${r.task.goal}`, r.ui ? `Debug UI: ${r.ui}` : ''];
    for (const s of r.steps) {
      lines.push(`step ${s.idx} ${s.subintent} → ${s.outcome}: ${s.notes?.note ?? ''}`);
      for (const c of s.calls) {
        lines.push(`   ${c.template} ${c.latencyMs ?? '?'}ms $${Number(c.costUsd ?? 0).toFixed(6)}${c.error ? ` ERROR ${c.error}` : ''}`);
        if (a.step !== undefined) {
          lines.push(`     answers: ${JSON.stringify(c.answers)}`);
          if (c.playground) lines.push(`     playground: ${c.playground}`);
        }
      }
    }
    if (r.escalations.length) lines.push(`Questions: ${r.escalations.map((e: any) => `${e.id} [${e.kind}] → ${e.answer ? JSON.stringify(e.answer) : 'unanswered'}`).join('; ')}`);
    return text(lines.filter(Boolean).join('\n'));
  }));
}
