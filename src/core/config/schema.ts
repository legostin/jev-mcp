import { z } from 'zod';

export const PRESET_NAMES = ['cautious', 'balanced', 'autonomous'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

export const DECISION_KINDS = ['assess', 'subintent', 'ground', 'verify', 'extract'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

const unit = z.number().min(0).max(1);

export const choiceThSchema = z.object({
  act: unit.optional(),
  escalate: unit.optional(),
  margin: unit.nullable().optional(),
});
export const noulThSchema = z.object({
  actYes: unit.optional(),
  actNo: unit.optional(),
  escalateOnUnsure: z.boolean().optional(),
});

const overrideKey = z.string().regex(
  /^(assess|subintent|ground|verify|extract)\.(choice|noul)$/,
  'override keys look like "ground.choice" or "verify.noul"',
);

/** One layer of confidence settings (global, domain, task or live override). */
export const confidenceSchema = z.object({
  preset: z.enum(PRESET_NAMES).optional(),
  /** Shorthand: applies to every choice decision kind. */
  act: unit.optional(),
  /** Shorthand: applies to every choice decision kind. 0 disables confidence-driven escalation. */
  escalate: unit.optional(),
  /** Shorthand: applies to every noul decision kind. */
  escalateOnUnsure: z.boolean().optional(),
  overrides: z.record(overrideKey, z.union([choiceThSchema, noulThSchema])).optional(),
});
export type ConfidenceConfig = z.infer<typeof confidenceSchema>;

const providerSchema = (baseUrl: string, model: string) =>
  z.object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().url().default(baseUrl),
    model: z.string().min(1).default(model),
  });

export const configSchema = z.object({
  provider: z.enum(['openrouter', 'typesafe']).default('openrouter'),
  providers: z.object({
    openrouter: providerSchema('https://openrouter.ai/api/v1', 'typesafe/jev-1.13').prefault({}),
    typesafe: providerSchema('https://api.typesafe.ai/v1', 'jev-latest').prefault({}),
  }).prefault({}),
  failover: z.boolean().default(false),
  rateLimit: z.object({
    requestsPerMinute: z.number().int().positive().default(1200),
    tokensPerSecond: z.number().int().positive().default(250_000),
  }).prefault({}),
  confidence: confidenceSchema.prefault({ preset: 'balanced' }),
  domains: z.record(z.string(), z.object({
    confidence: confidenceSchema.optional(),
    irreversible: z.enum(['ask', 'allow']).optional(),
  })).default({}),
  driver: z.object({
    default: z.enum(['auto', 'extension', 'chromium']).default('auto'),
    extensionPort: z.number().int().min(1024).max(65535).default(47913),
    extensionIds: z.array(z.string()).default([]),
    chromium: z.object({
      headless: z.boolean().default(false),
      executable: z.string().nullable().default(null),
      profileDir: z.string().nullable().default(null),
    }).prefault({}),
  }).prefault({}),
  notify: z.object({
    channel: z.boolean().default(true),
    piggyback: z.boolean().default(true),
  }).prefault({}),
  budgets: z.object({
    perTaskUsd: z.number().positive().default(0.5),
    perDayUsd: z.number().positive().default(5),
  }).prefault({}),
  limits: z.object({
    maxSteps: z.number().int().positive().default(60),
    maxMinutes: z.number().positive().default(15),
    settleMaxMs: z.number().int().positive().default(10_000),
    stateTokenTarget: z.number().int().min(500).max(28_000).default(6000),
    awaitInputPauseMinutes: z.number().positive().default(30),
  }).prefault({}),
  trace: z.object({
    retentionDays: z.number().positive().default(7),
    maxMb: z.number().positive().default(2048),
    screenshots: z.boolean().default(true),
  }).prefault({}),
  memory: z.object({ enabled: z.boolean().default(true) }).prefault({}),
  ui: z.object({ port: z.number().int().min(0).max(65535).default(0) }).prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type ProviderName = Config['provider'];
