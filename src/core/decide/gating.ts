import type { ChoiceAnswer } from '../jev/types.ts';
import type { ChoiceThresholds, NoulThresholds } from '../config/thresholds.ts';

export type ChoiceGate = 'act' | 'uncertain' | 'escalate';
export type NoulGate = 'yes' | 'no' | 'unsure';

export function topCandidates(ans: ChoiceAnswer, k = 5, exclude: string[] = []): { key: string; p: number }[] {
  return Object.entries(ans.probabilities)
    .filter(([key]) => !exclude.includes(key))
    .map(([key, p]) => ({ key, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

export function margin(ans: ChoiceAnswer): number {
  const [a, b] = topCandidates(ans, 2);
  return (a?.p ?? 0) - (b?.p ?? 0);
}

/**
 * The answer says what; confidence says whether to act. `act` when confident (and, if configured, clearly
 * ahead of the runner-up), `escalate` below the escalate threshold, `uncertain` in between.
 */
export function gateChoice(ans: ChoiceAnswer, th: ChoiceThresholds): ChoiceGate {
  const conf = ans.confidence;
  const marginOk = th.margin === null || margin(ans) >= th.margin;
  if (conf >= th.act && marginOk) return 'act';
  if (conf < th.escalate) return 'escalate';
  return 'uncertain';
}

export function gateNoul(value: number, th: NoulThresholds): NoulGate {
  if (value >= th.actYes) return 'yes';
  if (value <= th.actNo) return 'no';
  return 'unsure';
}
