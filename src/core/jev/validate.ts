import { JevError } from './errors.ts';
import { MAX_CHOICE_OPTIONS, MAX_SCORE_LEVELS, type EvaluateRequest } from './types.ts';

/** Catches malformed questions before they cost a round trip (the API would answer 422). */
export function validateRequest(req: EvaluateRequest): void {
  const entries = Object.entries(req.questions);
  if (entries.length === 0) throw new JevError('validation', 'A JEV request needs at least one question');
  for (const [id, q] of entries) {
    if (!q || typeof q !== 'object') throw new JevError('validation', `Question ${id} is not an object`);
    if (q.instructions === undefined || q.instructions === '') throw new JevError('validation', `Question ${id} has no instructions`);
    if (q.type === 'choice') {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2) throw new JevError('validation', `Choice ${id} needs at least 2 options (got ${n})`);
      if (n > MAX_CHOICE_OPTIONS) throw new JevError('validation', `Choice ${id} has ${n} options; the limit is ${MAX_CHOICE_OPTIONS}`);
    } else if (q.type === 'score') {
      const n = q.criteria?.length ?? 0;
      if (n < 2 || n > MAX_SCORE_LEVELS) throw new JevError('validation', `Score ${id} needs 2-${MAX_SCORE_LEVELS} levels (got ${n})`);
    } else if (q.type !== 'noul') {
      throw new JevError('validation', `Question ${id} has unknown type ${(q as { type: string }).type}`);
    }
  }
}
