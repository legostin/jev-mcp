import type { Answer } from '../../jev/types.ts';
import type { ElementNode, PageModel } from '../../perception/types.ts';
import { renderElement } from '../../perception/render.ts';
import { buildState } from '../state.ts';
import { choiceOf, type QuestionSet } from '../run.ts';

export const ACTION_CLASSES = {
  navigation: 'Opens another page, tab or view; nothing is committed.',
  search_submit: 'Runs a search, applies filters or sorting.',
  input: 'Changes a form value, opens a picker or a menu.',
  irreversible: 'Commits something with consequences: pays, orders, books, sends, posts, subscribes, registers or deletes.',
  other: 'Something else.',
} as const;
export type ActionClass = keyof typeof ACTION_CLASSES;

export function buildActionClass(el: ElementNode, model: PageModel, goal: string, budgetTokens: number): QuestionSet {
  return {
    template: 'safety.action_class',
    state: buildState({ goal, extra: { target: renderElement(model, el.ref), page_title: model.title, page_url: model.url } }, budgetTokens),
    questions: { action_class: { type: 'choice', instructions: 'What happens when `target` is clicked?', criteria: { ...ACTION_CLASSES } } },
  };
}

export function readActionClass(answers: Record<string, Answer>): { cls: ActionClass; pIrreversible: number; confidence: number } {
  const a = choiceOf(answers, 'action_class');
  return { cls: a.choice as ActionClass, pIrreversible: a.probabilities.irreversible ?? 0, confidence: a.confidence };
}
