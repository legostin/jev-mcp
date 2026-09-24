import type { Question, Json, Answer } from '../../jev/types.ts';
import type { ElementNode, PageModel, Region } from '../../perception/types.ts';
import { describeElement, elementLines, regionLines } from '../../perception/render.ts';
import { buildState, type ParamSpec } from '../state.ts';
import { choiceOf, noulOf, type QuestionSet } from '../run.ts';

export const PAGE_KINDS = {
  search_form: 'A form to search or filter (fields for the search criteria and a search button) is the main content.',
  results_list: 'A list of search results, offers or products is the main content.',
  item_details: 'The page shows the details of one item, offer or product.',
  login: 'The page asks to sign in or register before continuing.',
  captcha: 'The page shows a CAPTCHA, a bot check or an "are you human" challenge.',
  error: 'The page shows an error instead of its content: a server error, page not found or access denied.',
  no_results: 'The search ran but found nothing: an empty result list or a "nothing found" message.',
  checkout: 'The page collects passenger, shipping or payment details to complete a purchase.',
  other: 'None of the above.',
} as const;
export type PageKind = keyof typeof PAGE_KINDS;

export const OVERLAY_KINDS = {
  captcha: 'A CAPTCHA or bot check: pick images, "I am not a robot", puzzles or audio tests.',
  cookie_consent: 'A cookie, tracking or privacy consent notice.',
  promo: 'A promotion, newsletter, discount or subscription offer.',
  region_picker: 'A choice of region, city, language or currency.',
  login_wall: 'A prompt to sign in or register.',
  goal_step: 'A step of what `goal` itself asks for (a payment, a choice of plan or card, a form or a confirmation it needs), not an obstacle.',
  app_banner: 'An invitation to install a mobile app.',
  other: 'Something else.',
} as const;
export type OverlayKind = keyof typeof OVERLAY_KINDS;

export interface AssessInput {
  model: PageModel;
  goal: string;
  params: Record<string, ParamSpec>;
  progress: Record<string, string>;
  hints: string[];
  /** Params whose on-page presence code could not decide. */
  uncertainParams: string[];
  overlays: Region[];
  /** Empty required fields that no param obviously covers. */
  requiredEmpty: ElementNode[];
  hasResultSchema: boolean;
  /** Ask whether the page's form leads to the goal (params are still pending and the page has fields). */
  checkFormFit?: boolean;
  /** Pending params to check for a field on this page (one batched noul each: absent ones are skipped without grounding). */
  pendingParams?: string[];
  budgetTokens: number;
}

export interface AssessOutput {
  pageKind: PageKind;
  pageKindConfidence: number;
  pageKindProbabilities: Record<string, number>;
  overlays: Record<string, { kind: OverlayKind; confidence: number }>;
  goalReached: number;
  resultsMatch: number;
  validationError: number;
  paramReflected: Record<string, number>;
  requiredUncovered: Record<string, number>;
  /** Does the form on the page lead to the goal? 1 when not asked. */
  formServesGoal: number;
  /** Per pending param: is there a control on this page to set it? */
  paramHere: Record<string, number>;
}

/** Elements that best summarise a page for page-level judgments: headings, visible text and controls in view. */
export function summaryRefs(model: PageModel, limit = 120): string[] {
  const els = [...model.elements.values()].filter((e) => e.visible);
  const score = (e: ElementNode) => (e.inViewport ? 0 : 10) + (e.kind === 'heading' ? 0 : e.interactive ? 1 : 2);
  return els.sort((a, b) => score(a) - score(b) || a.order - b.order).slice(0, limit).sort((a, b) => a.order - b.order).map((e) => e.ref);
}

export function buildAssess(input: AssessInput): QuestionSet {
  const { model } = input;
  const questions: Record<string, Question> = {
    page_kind: { type: 'choice', instructions: 'What kind of page is `page`?', criteria: { ...PAGE_KINDS } },
    // "Shows what the goal asks for" read a page where the action could still be done (an unpaid ad with its Pay
    // button) as done (0.8); asking for the outcome, with a confirmation required for actions, gives 0.1 there.
    goal_reached: {
      type: 'noul',
      instructions: 'Is the outcome `goal` asks for already reached on `page`? For an action (post, pay, book, send), only a message confirming it was done counts: a page where it can still be done does not. For finding or opening something, the page must show it.',
    },
    validation_error: { type: 'noul', instructions: 'Does `page` show an error or validation message about entered data?' },
  };
  if (input.checkFormFit) {
    // Two plain judgments instead of one about "fit": a search form is wrong only when the goal is not a search.
    questions.goal_is_search = { type: 'noul', instructions: 'Does `goal` ask to find, search, browse or compare existing items or offers?' };
    questions.form_is_search = { type: 'noul', instructions: 'Is the main form on `page` a search or a filter over existing items or offers (not a form that creates, posts, books or signs in)?' };
  }
  for (const k of input.pendingParams ?? []) {
    questions[`param_here_${k}`] = { type: 'noul', instructions: `Does \`page\` show a field, list, option or button where \`params.${k}\` can be set?` };
  }
  if (input.hasResultSchema) {
    questions.results_match = { type: 'noul', instructions: 'Does `page` show a list of results for the search described by `params`?' };
  }
  for (const r of input.overlays) {
    questions[`overlay_kind_${r.id}`] = { type: 'choice', instructions: `What is \`page.regions.${r.id}\`?`, criteria: { ...OVERLAY_KINDS } };
  }
  for (const k of input.uncertainParams) {
    questions[`param_reflected_${k}`] = { type: 'noul', instructions: `Is \`params.${k}.value\` currently entered or selected on the page?` };
  }
  const required: Record<string, string> = {};
  for (const e of input.requiredEmpty.slice(0, 8)) {
    required[e.ref] = describeElement(e, { pageUrl: model.url });
    questions[`required_uncovered_${e.ref}`] = {
      type: 'noul',
      instructions: `Must \`required_fields.${e.ref}\` be filled in to continue, while no entry in \`params\` provides a value for it?`,
    };
  }
  const state = buildState({
    goal: input.goal, params: input.params, hints: input.hints, progress: input.progress,
    page: { url: model.url, title: model.title, regions: regionLines(model), elements: elementLines(model, summaryRefs(model)) },
    extra: Object.keys(required).length ? { required_fields: required as unknown as Json } : undefined,
  }, input.budgetTokens);
  return { template: 'assess', state, questions };
}

/**
 * After a way in was taken: does the page it opened lead toward the goal? Clear "no" (the new-ad form when the
 * goal is about an existing ad: 0.12) is rolled back; the right section scores 0.85-0.95.
 */
export function buildLeads(model: PageModel, goal: string, hints: string[], budgetTokens: number): QuestionSet {
  const state = buildState({
    goal, hints, page: { url: model.url, title: model.title, regions: regionLines(model), elements: elementLines(model, summaryRefs(model)) },
  }, budgetTokens);
  return { template: 'assess.leads', state, questions: { leads: { type: 'noul', instructions: 'Does `page` lead toward `goal`: is it where `goal` is done, or a step on the way there?' } } };
}

/**
 * A dialog the task's own click opened that JEV called "other" or "promo": can the goal go on from it? A price
 * notice with "Continue to payment" scores 0.55-0.6, a newsletter offer 0.05-0.15.
 */
export function buildGoesOn(model: PageModel, regionId: string, goal: string, hints: string[], budgetTokens: number): QuestionSet {
  const state = buildState({
    goal, hints, page: { url: model.url, title: model.title, regions: regionLines(model), elements: elementLines(model, summaryRefs(model)) },
  }, budgetTokens);
  return {
    template: 'assess.goes_on', state,
    questions: { goes_on: { type: 'noul', instructions: `Can \`goal\` go on from \`page.regions.${regionId}\`: does it offer a way to pay, continue or confirm what \`goal\` asks for?` } },
  };
}

export function readAssess(answers: Record<string, Answer>, input: AssessInput): AssessOutput {
  const pk = choiceOf(answers, 'page_kind');
  const overlays: AssessOutput['overlays'] = {};
  for (const r of input.overlays) {
    const a = choiceOf(answers, `overlay_kind_${r.id}`);
    overlays[r.id] = { kind: a.choice as OverlayKind, confidence: a.confidence };
  }
  const paramReflected: Record<string, number> = {};
  for (const k of input.uncertainParams) paramReflected[k] = noulOf(answers, `param_reflected_${k}`);
  const requiredUncovered: Record<string, number> = {};
  for (const e of input.requiredEmpty.slice(0, 8)) requiredUncovered[e.ref] = noulOf(answers, `required_uncovered_${e.ref}`);
  return {
    pageKind: pk.choice as PageKind,
    pageKindConfidence: pk.confidence,
    pageKindProbabilities: pk.probabilities,
    overlays,
    goalReached: noulOf(answers, 'goal_reached'),
    resultsMatch: input.hasResultSchema ? noulOf(answers, 'results_match') : 0,
    validationError: noulOf(answers, 'validation_error'),
    paramReflected,
    requiredUncovered,
    // The form fails the goal when it searches existing items and the goal is not a search.
    formServesGoal: input.checkFormFit ? 1 - noulOf(answers, 'form_is_search') * (1 - noulOf(answers, 'goal_is_search')) : 1,
    paramHere: Object.fromEntries((input.pendingParams ?? []).map((k) => [k, noulOf(answers, `param_here_${k}`)])),
  };
}
