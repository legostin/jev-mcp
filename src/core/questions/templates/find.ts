import type { PageModel } from '../../perception/types.ts';
import type { Thresholds } from '../../config/thresholds.ts';
import { groundByIntent, type GroundCandidate, type GroundContext, type GroundResult, type Intent } from './ground.ts';
import type { QuestionContext } from '../run.ts';

export interface FindResult {
  query: string;
  matches: GroundCandidate[];
  exists: number;
  confidence: number;
  best: string | null;
  decision: GroundResult['decision'];
}

/** Free-text search over the page for the main agent: JEV ranks candidates; we return the top k with probabilities. */
export async function findElements(
  ctx: QuestionContext, model: PageModel, query: string, th: Thresholds, gctx: GroundContext, opts: { k?: number; kinds?: Intent['kinds']; regionId?: string } = {},
): Promise<FindResult> {
  const res = await groundByIntent(ctx, model, { target: query, kinds: opts.kinds, regionId: opts.regionId }, th, gctx);
  return {
    query,
    matches: res.candidates.slice(0, opts.k ?? 5),
    exists: res.exists,
    confidence: res.confidence,
    best: res.ref,
    decision: res.decision,
  };
}
