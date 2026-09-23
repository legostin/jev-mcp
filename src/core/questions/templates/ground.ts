import type { Question, Json } from '../../jev/types.ts';
import type { ElementKind, ElementNode, PageModel } from '../../perception/types.ts';
import type { Thresholds } from '../../config/thresholds.ts';
import { describeElement, regionLines, renderCandidate } from '../../perception/render.ts';
import { buildState, type ParamSpec } from '../state.ts';
import { runQuestions, choiceOf, noulOf, type QuestionContext } from '../run.ts';
import { gateChoice, gateNoul, topCandidates } from '../../decide/gating.ts';
import { fuse } from '../../decide/fuse.ts';
import type { StepCard } from '../step.ts';
import { lexicalScore, tokens } from '../lexical.ts';

export interface Intent {
  /** Plain-English description of the target, e.g. "the input for the departure city". */
  target: string;
  /** What will be done with it; helps JEV rule out e.g. labels when we want to type. */
  action?: 'click' | 'type' | 'select' | 'check' | 'read';
  kinds?: ElementKind[];
  /** Restrict to a region (and its sub-regions). */
  regionId?: string;
  /** Allow elements covered by an overlay (default true; the caller handles overlays). */
  allowOccluded?: boolean;
  /** Reversible step: a leader below `act` may be tried and verified instead of asking (see `Thresholds.trial`). */
  trial?: boolean;
  /** Signatures of elements already tried and rolled back for this step. */
  exclude?: string[];
  /**
   * Asked in the same call: used when `target` is not on the page. For params, `target` is "the control that sets X
   * to V" (a button showing V is best) and `fallback` is the field where X is chosen (V is not shown as a button).
   */
  fallback?: string;
}

export interface GroundCandidate { ref: string; p: number; desc: string }

export interface GroundResult {
  ref: string | null;
  confidence: number;
  exists: number;
  candidates: GroundCandidate[];
  /** Candidates by final probability (fused over both looks when there was a second one). */
  ranked: GroundCandidate[];
  stage: 'direct' | 'region' | 'rerank' | 'none';
  /** `try`: a reversible step may act on `ranked[0]` and verify, instead of asking. */
  decision: 'act' | 'try' | 'escalate' | 'none';
  callIds: string[];
  costUsd: number;
}

export interface GroundContext {
  goal?: string;
  /** The step being done; with it, questions carry the step's param and value instead of every param. */
  step?: StepCard;
  params?: Record<string, ParamSpec>;
  hints?: string[];
  budgetTokens: number;
}

const DIRECT_MAX = 60;
const ELEMENT_MAX = 200;

const INTERACTIVE_KINDS: ElementKind[] = ['link', 'button', 'textbox', 'combobox', 'select', 'checkbox', 'radio', 'slider', 'option', 'tab', 'menuitem', 'clickable', 'file'];

function regionAndDescendants(model: PageModel, id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of model.regions) if (r.parentId && ids.has(r.parentId) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
  }
  return ids;
}

export function candidateElements(model: PageModel, intent: Intent): ElementNode[] {
  const kinds = new Set(intent.kinds ?? INTERACTIVE_KINDS);
  const regionIds = intent.regionId ? regionAndDescendants(model, intent.regionId) : null;
  const out: ElementNode[] = [];
  for (const e of model.elements.values()) {
    if (!kinds.has(e.kind)) continue;
    if (!e.visible) continue;
    // Visually hidden helpers (1-5 px native selects behind custom widgets) are never the target.
    if ((e.rect.w < 6 || e.rect.h < 6) && e.kind !== 'checkbox' && e.kind !== 'radio') continue;
    if (e.states.disabled && intent.action !== 'read') continue;
    if (regionIds && !regionIds.has(e.regionId)) continue;
    if (intent.exclude?.includes(e.sig)) continue;
    if (intent.allowOccluded === false && e.occluded) continue;
    out.push(e);
  }
  return out;
}

function intentState(intent: Intent): Record<string, Json> {
  const s: Record<string, Json> = { target: intent.target };
  if (intent.fallback) s.fallback = intent.fallback;
  if (intent.action) s.action = intent.action;
  return s;
}

function elementQuestions(refs: string[], fallback: boolean): Record<string, Question> {
  const criteria: Record<string, Json | null> = {};
  for (const r of refs) criteria[r] = null;
  const qs: Record<string, Question> = {
    pick: { type: 'choice', instructions: 'Which element in `page.elements` is `intent.target`?', criteria: { ...criteria, none: 'No element in `page.elements` is `intent.target`.' } },
    exists: { type: 'noul', instructions: 'Is `intent.target` one of the elements listed in `page.elements`?' },
  };
  if (fallback) {
    qs.fallback = { type: 'choice', instructions: 'Which element in `page.elements` is `intent.fallback`?', criteria: { ...criteria, none: 'No element in `page.elements` is `intent.fallback`.' } };
    qs.fallback_exists = { type: 'noul', instructions: 'Is `intent.fallback` one of the elements listed in `page.elements`?' };
  }
  return qs;
}

/**
 * Finds the element matching an intent. Small candidate sets go straight to one choice; large pages are
 * narrowed by region first. A separate noul asks whether the target exists at all, because a choice always
 * picks something. Mid-confidence answers get a second, independent look at the top candidates.
 */
export async function groundByIntent(
  ctx: QuestionContext, model: PageModel, intent: Intent, th: Thresholds, gctx: GroundContext,
): Promise<GroundResult> {
  const callIds: string[] = [];
  let cost = 0;
  const all = candidateElements(model, intent);
  const empty: GroundResult = { ref: null, confidence: 1, exists: 0, candidates: [], ranked: [], stage: 'none', decision: 'none', callIds, costUsd: 0 };
  let ctxParts = { goal: gctx.goal, step: gctx.step, params: gctx.params, hints: gctx.hints, intent: intentState(intent) };
  if (!all.length) return empty;
  const q = tokens(`${intent.target} ${gctx.goal ?? ''}`);
  const scored = all
    .map((e) => ({ e, s: lexicalScore(q, e) + (e.inViewport ? 0.05 : 0) - (e.occluded ? 0.02 : 0) }))
    .sort((a, b) => b.s - a.s || a.e.order - b.e.order);

  let pool = scored.map((x) => x.e);
  let stage: GroundResult['stage'] = 'direct';

  if (pool.length > DIRECT_MAX) {
    // Region stage: which regions hold the target? Keep the most probable ones (beam of 3).
    const regionCounts = new Map<string, number>();
    for (const e of pool) regionCounts.set(e.regionId, (regionCounts.get(e.regionId) ?? 0) + 1);
    const rl = regionLines(model, [...regionCounts.keys()]);
    const regionsDesc: Record<string, string> = {};
    for (const id of regionCounts.keys()) {
      regionsDesc[id] = rl[id] ?? `page body (outside landmarks); ${regionCounts.get(id)} candidate controls`;
    }
    const criteria: Record<string, Json | null> = {};
    for (const id of Object.keys(regionsDesc)) criteria[id] = null;
    criteria.none = 'No region in `page.regions` contains `intent.target`.';
    const state = buildState({ ...ctxParts, page: { url: model.url, title: model.title, regions: regionsDesc } }, gctx.budgetTokens);
    const res = await runQuestions(ctx, {
      template: 'ground.region', state,
      questions: { region: { type: 'choice', instructions: intent.fallback ? 'Which region in `page.regions` contains `intent.target` or `intent.fallback`?' : 'Which region in `page.regions` contains `intent.target`?', criteria } },
    });
    callIds.push(res.callId); cost += res.costUsd;
    const regionAns = choiceOf(res.answers, 'region');
    const beam: string[] = [];
    let mass = 0;
    for (const c of topCandidates(regionAns, 3, ['none'])) {
      if (beam.length && c.p < 0.05) break;
      beam.push(c.key); mass += c.p;
      if (mass >= 0.9) break;
    }
    const inBeam = new Set(beam);
    pool = pool.filter((e) => inBeam.has(e.regionId));
    stage = 'region';
    if (!pool.length) return { ...empty, callIds, costUsd: cost };
  }
  pool = pool.slice(0, ELEMENT_MAX);
  const refs = pool.map((e) => e.ref);
  const elements: Record<string, string> = {};
  for (const e of pool) elements[e.ref] = describeElement(e, { pageUrl: model.url, region: true });
  const state = buildState({ ...ctxParts, page: { url: model.url, title: model.title, elements } }, gctx.budgetTokens);
  // The state builder may have trimmed elements to fit the budget; only ask about what JEV can see.
  const visibleRefs = Object.keys(((state as Record<string, Json>).page as Record<string, Json>).elements as Record<string, string>);
  const res = await runQuestions(ctx, { template: 'ground.element', state, questions: elementQuestions(visibleRefs.length >= 1 ? visibleRefs : refs, !!intent.fallback) });
  callIds.push(res.callId); cost += res.costUsd;
  let pick = choiceOf(res.answers, 'pick');
  let exists = noulOf(res.answers, 'exists');
  if (intent.fallback && (pick.choice === 'none' || gateNoul(exists, th.ground.noul) === 'no')) {
    const fb = choiceOf(res.answers, 'fallback');
    if (fb.choice !== 'none') {
      // The main target is not on the page (no button shows the value): go for the field where it is chosen.
      intent = { ...intent, target: intent.fallback, fallback: undefined };
      ctxParts = { ...ctxParts, intent: intentState(intent) };
      pick = fb;
      exists = noulOf(res.answers, 'fallback_exists');
    }
  }
  const candidates = topCandidates(pick, 5, ['none']).map((c) => ({ ref: c.key, p: c.p, desc: elements[c.key] ?? '' }));
  const base = { confidence: pick.confidence, exists, candidates, ranked: candidates, stage, callIds, costUsd: cost };
  const trial = !!intent.trial && th.trial.enabled;

  if (pick.choice === 'none' || gateNoul(exists, th.ground.noul) === 'no') {
    const clearlyAbsent = gateNoul(exists, th.ground.noul) === 'no' || gateChoice(pick, th.ground.choice) === 'act';
    return { ...base, ref: null, decision: clearlyAbsent ? 'none' : 'escalate' };
  }
  const gate = gateChoice(pick, th.ground.choice);
  if (gate === 'act') return { ...base, ref: pick.choice, decision: 'act' };

  // Second look: the top candidates as compact cards (with the row they sit in).
  const top = candidates.filter((c) => c.p >= 0.02).slice(0, 3);
  if (top.length < 2) {
    // A single plausible candidate: check it on its own (absolute fit) instead of comparing.
    const only = pick.choice;
    const fitState = buildState({ ...ctxParts, candidates: { [only]: renderCandidate(model, only) } }, gctx.budgetTokens);
    const fit = await runQuestions(ctx, {
      template: 'ground.rerank', state: fitState,
      questions: { [`fit_${only}`]: { type: 'noul', instructions: `Is \`candidates.${only}\` \`intent.target\`?` } },
    });
    callIds.push(fit.callId); cost += fit.costUsd;
    const verdict = gateNoul(noulOf(fit.answers, `fit_${only}`), th.ground.noul);
    const decision = verdict === 'yes' || (verdict === 'unsure' && gate === 'uncertain') ? 'act'
      : trial && verdict !== 'no' && (pick.probabilities[only] ?? 0) >= th.trial.floor ? 'try' : 'escalate';
    return { ...base, ref: only, stage: 'rerank', decision, callIds, costUsd: cost };
  }
  const details: Record<string, string> = {};
  for (const c of top) details[c.ref] = renderCandidate(model, c.ref);
  const rrCriteria: Record<string, Json | null> = {};
  for (const c of top) rrCriteria[c.ref] = null;
  rrCriteria.none = 'None of `candidates` is `intent.target`.';
  const rrState = buildState({ ...ctxParts, candidates: details }, gctx.budgetTokens);
  const rr = await runQuestions(ctx, {
    template: 'ground.rerank', state: rrState,
    questions: { pick: { type: 'choice', instructions: 'Which of `candidates` is `intent.target`?', criteria: rrCriteria } },
  });
  callIds.push(rr.callId); cost += rr.costUsd;
  const rrPick = choiceOf(rr.answers, 'pick');
  // Both looks are evidence: average them over the same options instead of taking the last one.
  const keys = [...top.map((c) => c.ref), 'none'];
  const fused = fuse(pick.probabilities, rrPick.probabilities, keys);
  const ranked = top.map((c) => ({ ...c, desc: details[c.ref] ?? c.desc, p: fused[c.ref] })).sort((a, b) => b.p - a.p);
  const lead = ranked[0];
  const second = Math.max(ranked[1]?.p ?? 0, fused.none);
  const result = { ...base, confidence: lead.p, candidates: ranked, ranked, stage: 'rerank' as const, callIds, costUsd: cost };
  if (fused.none >= lead.p) return { ...result, ref: null, decision: gateNoul(exists, th.ground.noul) === 'no' ? 'none' : 'escalate' };
  const c = th.ground.choice;
  const agree = pick.choice === lead.ref && rrPick.choice === lead.ref;
  const marginOk = c.margin === null || lead.p - second >= c.margin;
  if (marginOk && (lead.p >= c.act || (agree && lead.p >= c.escalate))) return { ...result, ref: lead.ref, decision: 'act' };
  if (trial && lead.p >= th.trial.floor) return { ...result, ref: lead.ref, decision: 'try' };
  return { ...result, ref: lead.ref, decision: 'escalate' };
}
