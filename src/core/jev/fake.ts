import type { Answer, EvaluateRequest, EvaluateResult, JevClient } from './types.ts';

export type FakeHandler = (req: EvaluateRequest, call: number) => Record<string, Answer> | Promise<Record<string, Answer>>;

/** Deterministic JEV stand-in for tests and offline runs. */
export function createScriptedClient(handler: FakeHandler): JevClient & { requests: EvaluateRequest[] } {
  const requests: EvaluateRequest[] = [];
  return {
    requests,
    async evaluate(req): Promise<EvaluateResult> {
      requests.push(structuredClone(req));
      const answers = await handler(req, requests.length);
      return {
        model: 'jev-fake', provider: 'openrouter', answers, attempts: 1, latencyMs: 1,
        usage: { inputTokens: Math.ceil(JSON.stringify(req).length / 4), outputTokens: 10, costUsd: 0.000001 },
      };
    },
  };
}

/** Helpers to build answers. */
export const choiceAnswer = (probabilities: Record<string, number>): Answer => {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  const top = entries[0]?.[1] ?? 0;
  const second = entries[1]?.[1] ?? 0;
  return { type: 'choice', choice: entries[0]?.[0] ?? '', probabilities, confidence: Math.max(0, Math.min(1, top - second * 0.5)) };
};
export const noulAnswer = (v: number): Answer => ({ type: 'noul', noul: v });
