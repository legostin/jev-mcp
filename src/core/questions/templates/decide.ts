import type { Answer, Json, Question } from '../../jev/types.ts';
import type { PageModel } from '../../perception/types.ts';
import { elementLines, regionLines } from '../../perception/render.ts';
import { buildState, type ParamSpec } from '../state.ts';
import { choiceOf, type QuestionSet } from '../run.ts';
import { summaryRefs } from './assess.ts';

export interface SubintentOption { id: string; description: string }

export interface DecideInput {
  model: PageModel;
  goal: string;
  params: Record<string, ParamSpec>;
  progress: Record<string, string>;
  hints: string[];
  recent: string[];
  memory?: Record<string, Json>;
  options: SubintentOption[];
  budgetTokens: number;
}

/** Fallback when code rules do not settle the next step: one choice over code-generated step options. */
export function buildDecide(input: DecideInput): QuestionSet {
  const criteria: Record<string, Json | null> = {};
  for (const o of input.options) criteria[o.id] = null;
  const steps: Record<string, string> = {};
  for (const o of input.options) steps[o.id] = o.description;
  const questions: Record<string, Question> = {
    next: { type: 'choice', instructions: 'Which step in `steps` should be done next to accomplish `goal`, given `progress` and `recent_steps`?', criteria },
  };
  const state = buildState({
    goal: input.goal, params: input.params, hints: input.hints, progress: input.progress, recent: input.recent.slice(-6), memory: input.memory,
    page: { url: input.model.url, title: input.model.title, regions: regionLines(input.model), elements: elementLines(input.model, summaryRefs(input.model, 80)) },
    extra: { steps: steps as unknown as Json },
  }, input.budgetTokens);
  return { template: 'decide.next_subintent', state, questions };
}

export function readDecide(answers: Record<string, Answer>) {
  return choiceOf(answers, 'next');
}
