import type { Json, Question } from '../jev/types.ts';
import type { ElementNode, PageModel, Region } from '../perception/types.ts';
import type { Thresholds } from '../config/thresholds.ts';
import { describeElement } from '../perception/render.ts';
import { buildState } from '../questions/state.ts';
import { runQuestions, choiceOf, noulOf, type QuestionContext } from '../questions/run.ts';
import { gateChoice } from '../decide/gating.ts';
import { detectCurrency, numericValue, parseField, type Money, type FieldType } from './parse.ts';

export type FieldSpec = FieldType | { type: FieldType; about?: string };
export interface ResultSpec { schema: Record<string, FieldSpec>; select?: string }

export interface ExtractOutput {
  listRegionId: string;
  items: Record<string, unknown>[];
  itemRefs: string[][];
  selected?: Record<string, unknown>;
  selectedIndex?: number;
  /** Per item: is it what the goal asks for (not an accessory, a part or another product)? */
  relevant: boolean[];
  mapping: Record<string, string | null>;
  mappingConfidence: Record<string, number>;
  evidence: { refs: string[]; snippets: string[] };
  warnings: string[];
  callIds: string[];
  costUsd: number;
}

const fieldType = (f: FieldSpec): FieldType => (typeof f === 'string' ? f : f.type);

/**
 * Is a parsed value believable for its type? Money needs a currency or a text that is little more than the number
 * ("8 Microphone Active Noise Cancellation" is not a price of 8).
 */
export function plausible(type: FieldType, text: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (type !== 'money') return true;
  if ((value as Money).currency) return true;
  const words = text.replace(/[-+]?\d[\d\s.,']*/g, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
  return words.length <= 12;
}
const fieldAbout = (name: string, f: FieldSpec): string => {
  const about = typeof f === 'string' ? '' : f.about ?? '';
  const human = name.replace(/[_-]+/g, ' ');
  return `${about || human} (${fieldType(f)})`;
};

interface Leaf { id: string; key: string; el: ElementNode }

/** Leaves of an item keyed by structure (kind, tag, first class, occurrence) so a mapping transfers across items. */
function leavesOf(model: PageModel, refs: string[], itemIdx: number): Leaf[] {
  const seen = new Map<string, number>();
  const out: Leaf[] = [];
  let n = 0;
  for (const ref of refs) {
    const el = model.elements.get(ref);
    if (!el || !el.visible) continue;
    if (!(el.name || el.text || el.href)) continue;
    const base = `${el.kind}:${el.tag}.${(el.attrs.class ?? '').split(/\s+/)[0] ?? ''}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    out.push({ id: `i${itemIdx}_l${n++}`, key: `${base}#${k}`, el });
  }
  return out;
}

/**
 * Picks the list region of results: the only list, or the one JEV rates as the page's main results list. Whether
 * the items match the goal is judged per item later (a price-sorted list often starts with accessories).
 */
async function pickList(ctx: QuestionContext, model: PageModel, goal: string, budget: number, callIds: string[], cost: { v: number }): Promise<Region | null> {
  const lists = model.regions.filter((r) => r.kind === 'list' && (r.items?.length ?? 0) >= 2);
  if (!lists.length) return null;
  if (lists.length === 1) return lists[0];
  const regions: Record<string, string> = {};
  for (const r of lists) {
    const sample = r.items![0].map((ref) => model.elements.get(ref)).filter(Boolean).slice(0, 6).map((e) => describeElement(e!, { context: false }));
    regions[r.id] = `${r.items!.length} items; first item: ${sample.join(' | ')}`;
  }
  const questions: Record<string, Question> = {};
  for (const r of lists) {
    questions[`is_results_${r.id}`] = {
      type: 'noul',
      instructions: `Is \`lists.${r.id}\` the main list of results on this page (search results, listings or products), rather than ads, suggestions, filters or navigation?`,
    };
  }
  const res = await runQuestions(ctx, { template: 'extract.is_item', state: buildState({ goal, extra: { lists: regions as unknown as Json } }, budget), questions });
  callIds.push(res.callId); cost.v += res.costUsd;
  let best: Region | null = null;
  let bestP = 0.3;
  for (const r of lists) {
    const p = noulOf(res.answers, `is_results_${r.id}`);
    if (p > bestP) { best = r; bestP = p; }
  }
  return best;
}

/** Index of the selected item; items judged irrelevant to the goal are skipped. */
/** The page's main results list (one JEV call when there are several lists). */
export async function findResultsList(ctx: QuestionContext, model: PageModel, goal: string, budgetTokens: number): Promise<{ list: Region | null; callIds: string[]; costUsd: number }> {
  const callIds: string[] = [];
  const cost = { v: 0 };
  const list = await pickList(ctx, model, goal, budgetTokens, callIds, cost);
  return { list, callIds, costUsd: cost.v };
}

export function applySelect(items: Record<string, unknown>[], select: string | undefined, relevant?: boolean[]): number | undefined {
  if (!items.length) return undefined;
  if (!select || select === 'all') return undefined;
  const ok = (i: number) => !relevant || relevant[i] !== false;
  if (select === 'first') { const i = items.findIndex((_, j) => ok(j)); return i >= 0 ? i : undefined; }
  const m = select.match(/^(min|max)\((\w+)\)$/);
  if (!m) return undefined;
  let bestIdx: number | undefined;
  let bestVal: number | null = null;
  items.forEach((it, i) => {
    if (!ok(i)) return;
    const v = numericValue(it[m[2]]);
    if (v === null) return;
    if (bestVal === null || (m[1] === 'min' ? v < bestVal : v > bestVal)) { bestVal = v; bestIdx = i; }
  });
  return bestIdx;
}

/**
 * One batched call: is each item what the goal asks for? Only clear "no" answers exclude an item, so a vague goal
 * never empties the list; a price-sorted page of accessories does.
 */
async function judgeRelevance(
  ctx: QuestionContext, items: Record<string, unknown>[], leaves: Leaf[][], goal: string, budget: number, th: Thresholds,
  callIds: string[], cost: { v: number },
): Promise<boolean[]> {
  if (items.length < 1 || !goal) return [];
  const n = Math.min(items.length, 60);
  const desc: Record<string, string> = {};
  const questions: Record<string, Question> = {};
  for (let i = 0; i < n; i++) {
    desc[`i${i}`] = leaves[i].map((l) => l.el.text || l.el.name).filter(Boolean).join(' | ').slice(0, 200);
    questions[`r_${i}`] = {
      type: 'noul',
      instructions: `Is \`items.i${i}\` the kind of item \`goal\` is looking for, rather than an accessory, a spare part or a different product? Ignore which item is cheapest, best or first.`,
    };
  }
  const res = await runQuestions(ctx, { template: 'extract.relevant', state: buildState({ goal, extra: { items: desc as unknown as Json } }, Math.max(budget, 8000)), questions });
  callIds.push(res.callId); cost.v += res.costUsd;
  return items.map((_, i) => i >= n || noulOf(res.answers, `r_${i}`) > th.extract.noul.actNo);
}

/**
 * Schema-driven extraction. JEV maps schema fields to item texts on a sample of items; the mapping transfers to
 * all items by structure; code parses values and applies the select rule (min/max/first/all).
 */
export async function extractResults(
  ctx: QuestionContext, model: PageModel, spec: ResultSpec, th: Thresholds,
  opts: { goal: string; budgetTokens: number; refDate?: { year: number; month: number }; sampleSize?: number },
): Promise<ExtractOutput | null> {
  const callIds: string[] = [];
  const cost = { v: 0 };
  const list = await pickList(ctx, model, opts.goal, opts.budgetTokens, callIds, cost);
  if (!list) return null;
  const itemRefs = list.items!;
  const allLeaves = itemRefs.map((refs, i) => leavesOf(model, refs, i));
  const sampleIdx = [...allLeaves.keys()].filter((i) => allLeaves[i].length > 0).slice(0, opts.sampleSize ?? 4);
  const fields = Object.keys(spec.schema);
  // URLs come from the item's links in code; JEV only maps text fields.
  const askFields = fields.filter((f) => fieldType(spec.schema[f]) !== 'url');
  const fieldsDesc: Record<string, string> = Object.fromEntries(askFields.map((f) => [f, fieldAbout(f, spec.schema[f])]));
  const itemsState: Record<string, Record<string, string>> = {};
  const questions: Record<string, Question> = {};
  for (const i of sampleIdx) {
    const leaves = allLeaves[i];
    itemsState[`i${i}`] = Object.fromEntries(leaves.map((l) => [l.id, describeElement(l.el, { context: false })]));
    for (const f of askFields) {
      const criteria: Record<string, Json | null> = Object.fromEntries(leaves.map((l) => [l.id, null]));
      criteria.none = `No entry of \`items.i${i}\` is the \`fields.${f}\`.`;
      questions[`f_${i}_${f}`] = { type: 'choice', instructions: `Which entry of \`items.i${i}\` is the \`fields.${f}\` of this item?`, criteria };
    }
  }
  const res = askFields.length ? await runQuestions(ctx, {
    template: 'extract.field',
    state: buildState({ goal: opts.goal, extra: { fields: fieldsDesc as unknown as Json, items: itemsState as unknown as Json } }, Math.max(opts.budgetTokens, 8000)),
    questions,
  }) : null;
  if (res) { callIds.push(res.callId); cost.v += res.costUsd; }

  const mapping: Record<string, string | null> = {};
  const mappingConfidence: Record<string, number> = {};
  const warnings: string[] = [];
  for (const f of askFields) {
    const votes = new Map<string, number>();
    let confSum = 0;
    for (const i of sampleIdx) {
      const a = choiceOf(res!.answers, `f_${i}_${f}`);
      if (a.choice === 'none' || gateChoice(a, th.extract.choice) === 'escalate') continue;
      const leaf = allLeaves[i].find((l) => l.id === a.choice);
      if (!leaf) continue;
      votes.set(leaf.key, (votes.get(leaf.key) ?? 0) + a.confidence);
      confSum += a.confidence;
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    mapping[f] = best ? best[0] : null;
    mappingConfidence[f] = best && sampleIdx.length ? best[1] / sampleIdx.length : 0;
    if (!best) warnings.push(`No text matched field "${f}" in the sampled items.`);
    else if (confSum && best[1] / confSum < 0.7) warnings.push(`Field "${f}" mapped inconsistently across sampled items.`);
  }

  const base = model.url;
  const items = allLeaves.map((leaves) => {
    const row: Record<string, unknown> = {};
    for (const f of fields) {
      const type = fieldType(spec.schema[f]);
      const key = mapping[f];
      const leaf = key ? leaves.find((l) => l.key === key) : undefined;
      if (type === 'url') {
        const href = leaf?.el.href ?? leaves.find((l) => l.el.href)?.el.href;
        row[f] = href ?? null;
        continue;
      }
      const textOf = (l: Leaf) => l.el.text || l.el.name;
      let value = leaf ? parseField(type, textOf(leaf), base, opts.refDate) : null;
      if (leaf && !plausible(type, textOf(leaf), value)) value = null;
      if ((value === null || value === undefined) && key && type !== 'string') {
        // Items differ slightly (extra badges shift positions): try leaves of the same kind/tag/class that parse,
        // then, for money, any leaf of the item that reads as a price with a currency.
        const baseKey = key.replace(/#\d+$/, '');
        const tries = [...leaves.filter((l) => l.key.startsWith(`${baseKey}#`) && l !== leaf), ...(type === 'money' ? leaves : [])];
        for (const l of tries) {
          const v = parseField(type, textOf(l), base, opts.refDate);
          if (plausible(type, textOf(l), v) && (type !== 'money' || l.key.startsWith(`${baseKey}#`) || (v as Money).currency)) { value = v; break; }
        }
      }
      // A currency sign often sits in its own element next to the amount ("111 888" + "₸").
      if (type === 'money' && value && (value as Money).currency === null) {
        const itemText = leaves.map((l) => l.el.text || l.el.name).join(' ');
        (value as Money).currency = detectCurrency(itemText);
      }
      row[f] = value;
    }
    return row;
  });
  const relevant = await judgeRelevance(ctx, items, allLeaves, opts.goal, opts.budgetTokens, th, callIds, cost);
  if (relevant.length && !relevant.some(Boolean)) warnings.push('No item on this page matches the goal (accessories, parts or other products only).');
  const selectedIndex = applySelect(items, spec.select, relevant);
  const selRefs = selectedIndex !== undefined ? itemRefs[selectedIndex] : [];
  return {
    listRegionId: list.id,
    items,
    itemRefs,
    selected: selectedIndex !== undefined ? items[selectedIndex] : undefined,
    selectedIndex,
    relevant,
    mapping,
    mappingConfidence,
    evidence: {
      refs: selRefs,
      snippets: selRefs.map((r) => model.elements.get(r)).filter(Boolean).map((e) => e!.text || e!.name).filter(Boolean).slice(0, 8),
    },
    warnings,
    callIds,
    costUsd: cost.v,
  };
}
