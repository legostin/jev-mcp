import type { Answer } from '../../jev/types.ts';
import type { PageModel } from '../../perception/types.ts';
import { renderOverview } from '../../perception/render.ts';
import { buildState } from '../state.ts';
import { noulOf, type QuestionSet } from '../run.ts';

/** Did the step we just took have the effect we wanted? Used when deterministic checks are inconclusive. */
export function buildVerify(step: string, expected: string, changes: string, after: PageModel, budgetTokens: number): QuestionSet {
  return {
    template: 'verify.effect',
    state: buildState({ extra: { step, expected, changes, page_after: renderOverview(after, 800) } }, budgetTokens),
    questions: { effect: { type: 'noul', instructions: 'Do `changes` and `page_after` show that `step` achieved `expected`?' } },
  };
}

export function readVerify(answers: Record<string, Answer>): number {
  return noulOf(answers, 'effect');
}
