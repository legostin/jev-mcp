import type { Answer, EvaluateRequest, Json } from './types.ts';
import { createScriptedClient } from './fake.ts';
import { tokens } from '../questions/lexical.ts';

function lookup(state: Json, key: string): string {
  const s = state as Record<string, any>;
  for (const bag of [s?.page?.elements, s?.candidates, s?.page?.regions, s?.subintents, s?.options, s?.leaves]) {
    if (bag && typeof bag === 'object' && typeof bag[key] === 'string') return bag[key];
  }
  return '';
}

function overlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let n = 0;
  for (const x of a) if (b.some((y) => y === x || (x.length >= 4 && y.startsWith(x.slice(0, 4))))) n++;
  return n / a.length;
}

/**
 * Offline stand-in for JEV (JEV_FAKE=1): lexical overlap between the question focus (intent, goal, params)
 * and each option. Good enough to exercise the full pipeline without network access; never used for real work.
 */
export function createHeuristicClient() {
  return createScriptedClient((req: EvaluateRequest) => {
    const s = req.state as Record<string, any>;
    const focusText = [s?.intent?.target, s?.intent?.param_value, JSON.stringify(s?.params ?? {})].filter(Boolean).join(' ');
    const focus = tokens(focusText);
    const out: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (q.type === 'choice') {
        const scores = Object.entries(q.criteria).map(([k, v]) => {
          if (k === 'none' || k === 'other') return [k, 0.05] as const;
          const text = `${typeof v === 'string' ? v : ''} ${lookup(req.state, k)}`;
          return [k, 0.1 + overlap(focus, tokens(text)) + overlap(tokens(text), focus) * 0.5] as const;
        });
        const total = scores.reduce((a, [, x]) => a + Math.exp(x * 6), 0);
        const probabilities = Object.fromEntries(scores.map(([k, x]) => [k, Math.exp(x * 6) / total]));
        const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
        out[id] = { type: 'choice', choice: sorted[0][0], probabilities, confidence: Math.min(1, sorted[0][1] - (sorted[1]?.[1] ?? 0) + 0.3) };
      } else if (q.type === 'noul') {
        out[id] = { type: 'noul', noul: /exists|fit|effect|present/.test(id) ? 0.9 : 0.1 };
      } else {
        const n = q.criteria.length;
        out[id] = { type: 'score', score: 0, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === 0 ? 1 : 0])), legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), String(c)])), confidence: 1 };
      }
    }
    return out;
  });
}
