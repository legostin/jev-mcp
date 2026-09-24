import type { Json } from '../jev/types.ts';
import type { Progress, Situation } from '../questions/templates/situation.ts';

export const CONSULT_ANSWERS = ['plan', 'hint', 'goto', 'pick', 'set_param', 'continue', 'abort'];

/**
 * What the agent needs to help a stuck task: where it is and how it got there, what JEV recognises on the page,
 * what was tried, and the page itself (compact). The agent answers with a plan, a hint, a URL or an element.
 */
export function consultReport(o: {
  reason: string;
  goal: string;
  plan?: Record<string, Json>;
  progress?: Progress;
  situation?: { kind: Situation; probabilities: Record<string, number> };
  memory?: Record<string, Json>;
  overview: string;
  exploreSteps: number;
}): Record<string, Json> {
  const out: Record<string, Json> = { reason: o.reason, goal: o.goal };
  if (o.plan) out.plan = o.plan;
  const diagnosis: Record<string, Json> = {};
  if (o.progress) diagnosis.progress_level = `${o.progress.level} of 4 (p=${o.progress.p.toFixed(2)})`;
  if (o.situation) {
    diagnosis.situation = Object.entries(o.situation.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, p]) => `${k} ${p.toFixed(2)}`).join(', ');
  }
  if (Object.keys(diagnosis).length) out.jev_sees = diagnosis;
  if (o.memory) out.task_memory = o.memory;
  out.meanwhile = o.exploreSteps > 0
    ? `The task keeps exploring safe steps (scrolling, opening menus and sections, trying ways in with rollback, going back) for up to ${o.exploreSteps} steps; nothing is submitted, paid or signed in until you answer.`
    : 'The task waits for your answer.';
  out.page = o.overview;
  return out;
}
