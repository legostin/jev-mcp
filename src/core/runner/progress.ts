import type { ParamSpec } from '../questions/state.ts';
import type { ElementNode, PageModel } from '../perception/types.ts';

export type ParamKind = 'text' | 'date' | 'boolean' | 'multi';

export function paramKind(p: ParamSpec): ParamKind {
  const v = p.value;
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'multi';
  if (v && typeof v === 'object') return 'date';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
  return 'text';
}

/** Date range covered by a date param. */
export function dateRange(p: ParamSpec): { from: string; to: string } | null {
  const v = p.value;
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as { from: string; to: string };
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { from: v, to: v };
  return null;
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').trim();
}

/** Code-side check: does a field already hold the param's value? */
export function fieldHoldsValue(el: ElementNode | undefined, p: ParamSpec): boolean {
  if (!el || p.secret) return false;
  const want = normalizeText(String(p.value));
  const have = normalizeText(el.value ?? '');
  return !!want && have.includes(want);
}

/** Empty, visible, required text fields: candidates for "the form needs something we were not given". */
export function requiredEmptyFields(model: PageModel): ElementNode[] {
  return [...model.elements.values()].filter((e) =>
    e.visible && (e.kind === 'textbox' || e.kind === 'combobox' || e.kind === 'select') && e.states.required && !e.value);
}
