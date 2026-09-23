export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export type NoulQuestion = { type: 'noul'; instructions: Json; criteria?: { true?: Json; false?: Json } };
export type ChoiceQuestion = { type: 'choice'; instructions: Json; criteria: Record<string, Json | null> };
export type ScoreQuestion = { type: 'score'; instructions: Json; criteria: Json[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = {
  type: 'score'; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type ProviderName = 'openrouter' | 'typesafe';

export interface EvaluateRequest { state: Json; questions: Record<string, Question> }

export interface EvaluateResult {
  model: string;
  provider: ProviderName;
  answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
  requestId?: string;
  attempts: number;
}

export interface JevClient {
  evaluate(req: EvaluateRequest, opts?: { signal?: AbortSignal }): Promise<EvaluateResult>;
}

export const MAX_CHOICE_OPTIONS = 255;
export const MAX_SCORE_LEVELS = 10;
/** Published price per input token (USD); output tokens are free. */
export const INPUT_PRICE_USD = 0.042 / 1_000_000;
