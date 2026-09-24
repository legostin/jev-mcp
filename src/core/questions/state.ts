import type { Json } from '../jev/types.ts';
import { estimateTokens } from '../util/tokens.ts';
import type { StepCard } from './step.ts';

export type ParamValue = string | number | boolean | string[] | { from: string; to: string };

export interface ParamSpec { value: ParamValue; about?: string; secret?: boolean }

export interface StateParts {
  goal?: string;
  /** The step being done (questions about one step get this instead of every param). */
  step?: StepCard;
  params?: Record<string, ParamSpec>;
  hints?: string[];
  progress?: Record<string, string>;
  intent?: Record<string, Json>;
  page?: { url?: string; title?: string; lang?: string; regions?: Record<string, string>; elements?: Record<string, string>; [k: string]: Json | undefined };
  candidates?: Record<string, string>;
  recent?: string[];
  /** The task's working memory slice (facts, pages passed, what did not work). */
  memory?: Record<string, Json>;
  extra?: Record<string, Json>;
}

export const SECRET_PLACEHOLDER = '[secret]';

/** Param values as JEV sees them: secrets are always replaced, whatever the caller passes. */
export function publicParams(params: Record<string, ParamSpec> | undefined): Record<string, Json> | undefined {
  if (!params) return undefined;
  const out: Record<string, Json> = {};
  for (const [k, p] of Object.entries(params)) {
    const entry: Record<string, Json> = {};
    if (p.about) entry.about = p.about;
    entry.value = p.secret ? SECRET_PLACEHOLDER : (p.value as Json);
    out[k] = entry;
  }
  return out;
}

function trimRecord(rec: Record<string, string>, keep: number): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).slice(0, keep));
}

/**
 * Builds the JEV state from parts, masking secrets, and shrinks the page part (elements first, then regions,
 * then recent steps) until it fits the token budget. Callers order `page.elements` by priority.
 */
export function buildState(parts: StateParts, budgetTokens: number): Json {
  const build = (p: StateParts): Record<string, Json> => {
    const s: Record<string, Json> = {};
    if (p.goal) s.goal = p.goal;
    if (p.step) {
      const st: Record<string, Json> = { do: p.step.do };
      if (p.step.param) { st.about = p.step.param.about; st.value = p.step.param.value; }
      s.step = st;
    }
    const params = publicParams(p.params);
    if (params && Object.keys(params).length) s.params = params;
    if (p.hints?.length) s.hints = p.hints;
    if (p.progress && Object.keys(p.progress).length) s.progress = p.progress;
    if (p.intent) s.intent = p.intent;
    if (p.page) {
      const page: Record<string, Json> = {};
      for (const [k, v] of Object.entries(p.page)) if (v !== undefined && !(typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)) page[k] = v as Json;
      s.page = page;
    }
    if (p.candidates) s.candidates = p.candidates;
    if (p.recent?.length) s.recent_steps = p.recent;
    if (p.memory && Object.keys(p.memory).length) s.task_memory = p.memory;
    if (p.extra) Object.assign(s, p.extra);
    return s;
  };
  let current: StateParts = { ...parts, page: parts.page ? { ...parts.page } : undefined };
  let state = build(current);
  for (let guard = 0; guard < 40 && estimateTokens(state) > budgetTokens; guard++) {
    const page = current.page;
    const els = page?.elements ? Object.keys(page.elements).length : 0;
    const regs = page?.regions ? Object.keys(page.regions).length : 0;
    if (page && els > 8) page.elements = trimRecord(page.elements!, Math.floor(els * 0.75));
    else if (page && regs > 6) page.regions = trimRecord(page.regions!, Math.floor(regs * 0.75));
    else if (current.recent && current.recent.length > 2) current = { ...current, recent: current.recent.slice(-2) };
    else if (current.candidates && Object.keys(current.candidates).length > 2) current = { ...current, candidates: trimRecord(current.candidates, Object.keys(current.candidates).length - 1) };
    else break;
    state = build(current);
  }
  return state;
}
