import type { Answer, Question } from '../../jev/types.ts';

/**
 * Where the task is and what stands in the way, asked in every page assessment (the same call, so almost free).
 * JEV recognises a situation far better than it plans a step: code maps the situation to the step.
 */
export const PROGRESS_QUESTION: Question = {
  type: 'score',
  instructions: 'How far along the way to `goal` is `page`?',
  criteria: [
    'The page has nothing to do with `goal`.',
    'The right site, but not the part of it where `goal` is done.',
    'The part of the site where `goal` is done: its section, the account area or the list it starts from.',
    'The page where `goal` is carried out right now: its form, its item, its checkout or payment step.',
    '`goal` is achieved on the page: it confirms the action was done, or shows what `goal` asked to find.',
  ],
};

export const SITUATIONS = {
  working: 'The page shows what the next step toward `goal` needs (a form, a list, a button to press).',
  loading: 'The page is still loading: a spinner, empty placeholders or "loading" text instead of content.',
  below_fold: 'What `goal` needs next is on this page but further down, out of view.',
  behind_menu: 'What `goal` needs next is inside a menu, tab or collapsed section of this page that is not open yet.',
  wrong_place: 'This page is not on the way to `goal`: another part of the site is needed.',
  needs_input: 'The page asks for information that `params` and `hints` do not give.',
} as const;
export type Situation = keyof typeof SITUATIONS;

export const SITUATION_QUESTION: Question = {
  type: 'choice',
  instructions: 'What is true of `page` right now, for doing `goal`?',
  criteria: { ...SITUATIONS },
};

export interface Progress {
  /** The most likely level, 0-4. */
  level: number;
  /** Its probability. */
  p: number;
  /** JEV's position on the scale (may fall between levels): for trends, not arithmetic. */
  score: number;
}

export function readProgress(answers: Record<string, Answer>): Progress | undefined {
  const a = answers.progress;
  if (!a || a.type !== 'score') return undefined;
  const [level, p] = Object.entries(a.probabilities).map(([k, v]) => [Number(k), v] as const).sort((x, y) => y[1] - x[1])[0] ?? [0, 0];
  return { level, p, score: a.score };
}

export function readSituation(answers: Record<string, Answer>): { kind: Situation; confidence: number; probabilities: Record<string, number> } | undefined {
  const a = answers.situation;
  if (!a || a.type !== 'choice') return undefined;
  return { kind: a.choice as Situation, confidence: a.confidence, probabilities: a.probabilities };
}
