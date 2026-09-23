import type { Question, Json } from '../../jev/types.ts';
import type { ElementKind, ElementNode, PageModel } from '../../perception/types.ts';
import type { Thresholds } from '../../config/thresholds.ts';
import { describeElement, regionLines, renderElement } from '../../perception/render.ts';
import { buildState, type ParamSpec } from '../state.ts';
import { runQuestions, choiceOf, noulOf, type QuestionContext } from '../run.ts';
import { gateChoice, gateNoul, topCandidates } from '../../decide/gating.ts';
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
}

export interface GroundCandidate { ref: string; p: number; desc: string }

export interface GroundResult {
  ref: string | null;
  confidence: number;
  exists: number;
  candidates: GroundCandidate[];
  stage: 'direct' | 'region' | 'rerank' | 'none';
  decision: 'act' | 'escalate' | 'none';
  callIds: string[];
  costUsd: number;
}

export interface GroundContext {
  goal?: string;
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
    if (e.states.disabled && intent.action !== 'read') continue;
    if (regionIds && !regionIds.has(e.regionId)) continue;
    if (intent.allowOccluded === false && e.occluded) continue;
    out.push(e);
  }
  return out;
}

function intentState(intent: Intent): Record<string, Json> {
  const s: Record<string, Json> = { target: intent.target };
  if (intent.action) s.action = intent.action;
  return s;
}

function elementQuestions(refs: string[]): Record<string, Question> {
  const criteria: Record<string, Json | null> = {};
  for (const r of refs) criteria[r] = null;
  criteria.none = 'No element in `page.elements` is `intent.target`.';
  return {
    pick: { type: 'choice', instructions: 'Which element in `page.elements` is `intent.target`?', criteria },
    exists: { type: 'noul', instructions: 'Is `intent.target` one of the elements listed in `page.elements`?' },
  };
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
  const empty: GroundResult = { ref: null, confidence: 1, exists: 0, candidates: [], stage: 'none', decision: 'none', callIds, costUsd: 0 };
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
    const state = buildState({ goal: gctx.goal, params: gctx.params, hints: gctx.hints, intent: intentState(intent), page: { url: model.url, title: model.title, regions: regionsDesc } }, gctx.budgetTokens);
    const res = await runQuestions(ctx, {
      template: 'ground.region', state,
      questions: { region: { type: 'choice', instructions: 'Which region in `page.regions` contains `intent.target`?', criteria } },
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
  const state = buildState({ goal: gctx.goal, params: gctx.params, hints: gctx.hints, intent: intentState(intent), page: { url: model.url, title: model.title, elements } }, gctx.budgetTokens);
  // The state builder may have trimmed elements to fit the budget; only ask about what JEV can see.
  const visibleRefs = Object.keys(((state as Record<string, Json>).page as Record<string, Json>).elements as Record<string, string>);
  const res = await runQuestions(ctx, { template: 'ground.element', state, questions: elementQuestions(visibleRefs.length >= 1 ? visibleRefs : refs) });
  callIds.push(res.callId); cost += res.costUsd;
  const pick = choiceOf(res.answers, 'pick');
  const exists = noulOf(res.answers, 'exists');
  const candidates = topCandidates(pick, 5, ['none']).map((c) => ({ ref: c.key, p: c.p, desc: elements[c.key] ?? '' }));
  const base = { confidence: pick.confidence, exists, candidates, stage, callIds, costUsd: cost };

  if (pick.choice === 'none' || gateNoul(exists, th.ground.noul) === 'no') {
    const clearlyAbsent = gateNoul(exists, th.ground.noul) === 'no' || gateChoice(pick, th.ground.choice) === 'act';
    return { ...base, ref: null, decision: clearlyAbsent ? 'none' : 'escalate' };
  }
  const gate = gateChoice(pick, th.ground.choice);
  if (gate === 'act') return { ...base, ref: pick.choice, decision: 'act' };

  // Second look: full details of the top candidates, a relative choice plus an absolute fit check per candidate.
  const top = candidates.filter((c) => c.p >= 0.02).slice(0, 3);
  if (top.length < 2) {
    return { ...base, ref: pick.choice, decision: gate === 'escalate' ? 'escalate' : 'act' };
  }
  const details: Record<string, string> = {};
  for (const c of top) details[c.ref] = renderElement(model, c.ref);
  const rrCriteria: Record<string, Json | null> = {};
  for (const c of top) rrCriteria[c.ref] = null;
  rrCriteria.none = 'None of `candidates` is `intent.target`.';
  const rrQuestions: Record<string, Question> = {
    pick: { type: 'choice', instructions: 'Which of `candidates` is `intent.target`?', criteria: rrCriteria },
  };
  for (const c of top) rrQuestions[`fit_${c.ref}`] = { type: 'noul', instructions: `Is \`candidates.${c.ref}\` \`intent.target\`?` };
  const rrState = buildState({ goal: gctx.goal, params: gctx.params, hints: gctx.hints, intent: intentState(intent), candidates: details }, gctx.budgetTokens);
  const rr = await runQuestions(ctx, { template: 'ground.rerank', state: rrState, questions: rrQuestions });
  callIds.push(rr.callId); cost += rr.costUsd;
  const rrPick = choiceOf(rr.answers, 'pick');
  const fits = Object.fromEntries(top.map((c) => [c.ref, noulOf(rr.answers, `fit_${c.ref}`)]));
  const rrGate = gateChoice(rrPick, th.ground.choice);
  const agree = rrPick.choice === pick.choice;
  const fitOk = rrPick.choice !== 'none' && gateNoul(fits[rrPick.choice] ?? 0, th.ground.noul) !== 'no';
  const rrCandidates = top.map((c) => ({ ...c, p: rrPick.probabilities[c.ref] ?? c.p })).sort((a, b) => b.p - a.p);
  const result = { ...base, confidence: rrPick.confidence, candidates: rrCandidates, stage: 'rerank' as const, callIds, costUsd: cost };
  if (rrPick.choice === 'none') return { ...result, ref: null, decision: 'escalate' };
  // Act when the second look is confident, or when both looks agree above the escalate bar.
  if (fitOk && (rrGate === 'act' || (agree && rrGate === 'uncertain'))) return { ...result, ref: rrPick.choice, decision: 'act' };
  return { ...result, ref: rrPick.choice, decision: 'escalate' };
}
