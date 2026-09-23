import type { Json, Question } from '../../jev/types.ts';
import type { PageModel } from '../../perception/types.ts';
import { describeElement } from '../../perception/render.ts';
import { buildState, type ParamSpec } from '../state.ts';
import type { QuestionSet } from '../run.ts';

function paramOnly(params: Record<string, ParamSpec>, key: string): Record<string, ParamSpec> {
  return { [key]: params[key] };
}

/** Which autocomplete suggestion (or dropdown option) matches a param value. */
export function buildSuggestionPick(model: PageModel, refs: string[], params: Record<string, ParamSpec>, key: string, budgetTokens: number): QuestionSet {
  const options: Record<string, string> = {};
  for (const r of refs) options[r] = describeElement(model.elements.get(r)!, { context: false });
  const criteria: Record<string, Json | null> = Object.fromEntries(refs.map((r) => [r, null]));
  criteria.none = `No option in \`options\` matches \`params.${key}.value\`.`;
  const questions: Record<string, Question> = {
    pick: { type: 'choice', instructions: `Which option in \`options\` matches \`params.${key}.value\` (the \`params.${key}.about\`)?`, criteria },
  };
  return { template: 'widget.suggestion_pick', state: buildState({ params: paramOnly(params, key), extra: { options: options as unknown as Json } }, budgetTokens), questions };
}

/** Which option of a native <select> matches a param value. */
export function buildOptionPick(options: { value: string; label: string }[], params: Record<string, ParamSpec>, key: string, budgetTokens: number): QuestionSet {
  const opts: Record<string, string> = {};
  options.slice(0, 250).forEach((o, i) => { opts[`o${i}`] = o.label || o.value; });
  const criteria: Record<string, Json | null> = Object.fromEntries(Object.keys(opts).map((k) => [k, null]));
  criteria.none = `No option matches \`params.${key}.value\`.`;
  return {
    template: 'widget.option_pick',
    state: buildState({ params: paramOnly(params, key), extra: { options: opts as unknown as Json } }, budgetTokens),
    questions: { pick: { type: 'choice', instructions: `Which option in \`options\` matches \`params.${key}.value\`?`, criteria } },
  };
}

/** Goal-level preferences that change how code resolves a choice (cheapest day, earliest date). */
export function buildGoalPrefs(goal: string, budgetTokens: number): QuestionSet {
  return {
    template: 'widget.goal_prefs',
    state: buildState({ goal }, budgetTokens),
    questions: {
      lowest_price: { type: 'noul', instructions: 'Does `goal` ask for the lowest price or the cheapest option?' },
      earliest: { type: 'noul', instructions: 'Does `goal` ask for the earliest date or time?' },
    },
  };
}
