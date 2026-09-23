import type { Answer, ChoiceAnswer, Json, JevClient, NoulAnswer, Question, ScoreAnswer } from '../jev/types.ts';
import type { TraceStore, JevCallRecord } from '../trace/store.ts';
import { JevError } from '../jev/errors.ts';
import { newId } from '../util/ids.ts';

export interface QuestionContext {
  jev: JevClient;
  trace?: TraceStore;
  taskId?: string;
  stepId?: string;
  signal?: AbortSignal;
  /** Called after every JEV call (budgets, live UI). */
  onCall?: (rec: JevCallRecord) => void;
}

export interface QuestionSet { template: string; state: Json; questions: Record<string, Question> }

export interface QuestionSetResult {
  answers: Record<string, Answer>;
  callId: string;
  costUsd: number;
  latencyMs: number;
  model: string;
}

/** One JEV request for one state; every call is traced whether it succeeds or not. */
export async function runQuestions(ctx: QuestionContext, set: QuestionSet): Promise<QuestionSetResult> {
  const callId = newId('c');
  const base: JevCallRecord = {
    id: callId, taskId: ctx.taskId, stepId: ctx.stepId, at: Date.now(), template: set.template, state: set.state, questions: set.questions,
  };
  try {
    const res = await ctx.jev.evaluate({ state: set.state, questions: set.questions }, { signal: ctx.signal });
    const rec: JevCallRecord = {
      ...base, answers: res.answers, model: res.model, provider: res.provider, latencyMs: res.latencyMs,
      inputTokens: res.usage.inputTokens, costUsd: res.usage.costUsd,
    };
    ctx.trace?.recordJevCall(rec);
    ctx.onCall?.(rec);
    return { answers: res.answers, callId, costUsd: res.usage.costUsd, latencyMs: res.latencyMs, model: res.model };
  } catch (e) {
    const rec: JevCallRecord = { ...base, error: e instanceof JevError ? `${e.kind}: ${e.message}${e.body ? ` ${e.body.slice(0, 300)}` : ''}` : String(e) };
    ctx.trace?.recordJevCall(rec);
    ctx.onCall?.(rec);
    throw e;
  }
}

export function choiceOf(answers: Record<string, Answer>, key: string): ChoiceAnswer {
  const a = answers[key];
  if (!a || a.type !== 'choice') throw new Error(`JEV answer ${key} is missing or not a choice`);
  return a;
}

export function noulOf(answers: Record<string, Answer>, key: string): number {
  const a = answers[key] as NoulAnswer | undefined;
  if (!a || a.type !== 'noul') throw new Error(`JEV answer ${key} is missing or not a noul`);
  return a.noul;
}

export function scoreOf(answers: Record<string, Answer>, key: string): ScoreAnswer {
  const a = answers[key];
  if (!a || a.type !== 'score') throw new Error(`JEV answer ${key} is missing or not a score`);
  return a;
}
