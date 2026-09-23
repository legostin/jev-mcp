import type { ElementNode } from '../perception/types.ts';

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'and', 'or', 'with', 'field', 'input', 'button', 'element',
  'и', 'в', 'на', 'для', 'с', 'по', 'поле', 'кнопка']);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t));
}

function sim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))) return 0.6;
  return 0;
}

/** Cheap lexical relevance used only to order and trim candidates before JEV decides. */
export function lexicalScore(query: string[], el: ElementNode): number {
  const hay = tokens([el.name, el.placeholder, el.context, el.text, el.attrs.name, el.attrs.id, el.attrs['aria-label'], el.attrs.autocomplete, el.attrs.title]
    .filter(Boolean).join(' '));
  if (!hay.length || !query.length) return 0;
  let score = 0;
  for (const q of query) {
    let best = 0;
    for (const h of hay) { best = Math.max(best, sim(q, h)); if (best === 1) break; }
    score += best;
  }
  return score / query.length;
}

export const normalizeLabel = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/[\s\u00a0]+/g, ' ').trim();

/** Is this control's label the value itself? Ignores dropdown arrows and trailing counts ("Toyota (1 234)", "Toyota 1234"). */
export function isValueLabel(name: string, want: string): boolean {
  const n = normalizeLabel(name).replace(/[\s▾▼⌄›»✓✔]+$/u, '');
  if (!n || !want) return false;
  if (n === want) return true;
  const m = n.match(/^(.*?\S)\s*(?:\(\s*\d[\d\s.,]*\)|\s\d[\d\s.,]*)$/u);
  return !!m && m[1] === want;
}
