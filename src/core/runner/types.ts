import { z } from 'zod';
import { confidenceSchema } from '../config/schema.ts';

export const FIELD_TYPES = ['string', 'number', 'money', 'datetime', 'date', 'time', 'duration', 'url', 'boolean'] as const;

const paramValueSchema = z.union([
  z.string(), z.number(), z.boolean(), z.array(z.string()),
  z.object({ from: z.string(), to: z.string() }),
]);

export const paramSpecSchema = z.object({
  value: paramValueSchema,
  about: z.string().optional(),
  secret: z.boolean().optional(),
});

export const taskSpecSchema = z.object({
  goal: z.string().min(3),
  site: z.string().optional(),
  tab: z.string().optional(),
  params: z.record(z.string().regex(/^[A-Za-z_]\w*$/, 'param keys are identifiers such as "from" or "departure_date"'), paramSpecSchema).default({}),
  result: z.object({
    schema: z.record(z.string(), z.union([z.enum(FIELD_TYPES), z.object({ type: z.enum(FIELD_TYPES), about: z.string().optional() })])),
    select: z.string().regex(/^(all|first|(min|max)\(\w+\))$/, 'select is all, first, min(field) or max(field)').optional(),
  }).optional(),
  hints: z.array(z.string()).default([]),
  policy: z.object({
    confidence: confidenceSchema.optional(),
    irreversible: z.enum(['ask', 'allow']).optional(),
    allowed_domains: z.array(z.string()).optional(),
    max_steps: z.number().int().positive().optional(),
    max_minutes: z.number().positive().optional(),
    budget_usd: z.number().positive().optional(),
    max_items: z.number().int().positive().optional(),
  }).default({}),
  driver: z.enum(['auto', 'extension', 'chromium']).optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export type TaskState = 'queued' | 'running' | 'awaiting_input' | 'paused' | 'interrupted' | 'done' | 'failed' | 'cancelled';
export const FINAL_STATES: ReadonlySet<TaskState> = new Set(['done', 'failed', 'cancelled']);

export type EscalationKind = 'ground' | 'subintent' | 'assess' | 'risk_confirm' | 'missing_param' | 'blocker' | 'stuck' | 'off_domain' | 'budget';

export interface Escalation {
  question_id: string;
  task_id: string;
  kind: EscalationKind;
  summary: string;
  created_at: number;
  page: { url: string; title: string; page_kind?: Record<string, number>; regions: string[] };
  decision?: {
    template: string;
    asked: string;
    candidates: { ref: string; p: number; desc: string }[];
    confidence: number;
    thresholds?: { act: number; escalate: number };
  };
  context?: Record<string, unknown>;
  recent_steps: string[];
  screenshot?: string;
  answer_with: string[];
}

export const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pick'), ref: z.string() }),
  z.object({ type: z.literal('set_param'), key: z.string(), value: paramValueSchema, about: z.string().optional(), secret: z.boolean().optional() }),
  z.object({ type: z.literal('hint'), text: z.string().min(2), scope: z.enum(['task', 'domain']).optional() }),
  z.object({ type: z.literal('continue') }),
  z.object({ type: z.literal('thresholds'), value: confidenceSchema }),
  z.object({ type: z.literal('skip') }),
  z.object({ type: z.literal('abort'), reason: z.string().optional() }),
]);
export type AnswerInput = z.infer<typeof answerSchema> & { remember?: boolean };

export interface TaskStats { steps: number; jev_calls: number; escalations: number; cost_usd: number; duration_s: number }

export interface TaskResult {
  status: TaskState;
  result?: { selected?: Record<string, unknown>; items_count?: number; goal_reached?: boolean };
  items?: Record<string, unknown>[];
  evidence?: { url: string; refs: string[]; snippets: string[] };
  warnings?: string[];
  error?: string;
  stats: TaskStats;
}

export interface StepSummary { idx: number; subintent: string; outcome: string; note: string; url: string }

export type ParamStatus = 'pending' | 'typed' | 'done' | 'absent' | 'skipped';
