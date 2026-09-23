import type { PageModel, Region } from '../perception/types.ts';
import { cleanText } from '../perception/naming.ts';
import { estimateTokens } from '../util/tokens.ts';

/**
 * The results page as the main agent reads it. JEV finds the page and the list; choosing the answer (cheapest,
 * newest, "not an accessory") is the agent's job: it reads a list far better than field-by-field extraction.
 */
export interface HandoffItem { i: number; text: string; url: string | null }

/** Drops tracking noise from item links: long parameter values and utm_* tags. Keeps the item's own address. */
export function compactUrl(href: string, base: string): string | null {
  let u: URL;
  try { u = new URL(href, base); } catch { return null; }
  for (const [k, v] of [...u.searchParams.entries()]) {
    if (v.length > 24 || /^utm_/i.test(k)) u.searchParams.delete(k);
  }
  u.hash = '';
  const s = u.toString();
  return s.length > 160 ? `${u.origin}${u.pathname}` : s;
}

/** One line per item: its visible texts in order, without repeats (titles often appear two or three times). */
export function itemLine(model: PageModel, refs: string[], max = 260): Omit<HandoffItem, 'i'> {
  const texts: string[] = [];
  let url: string | null = null;
  for (const r of refs) {
    const e = model.elements.get(r);
    if (!e || !e.visible) continue;
    if (!url && e.kind === 'link' && e.href) url = compactUrl(e.href, model.url);
    const t = cleanText(e.text || e.name, 200);
    if (t.length < 2) continue;
    const n = t.toLowerCase();
    if (texts.some((x) => x.toLowerCase().includes(n))) continue;
    for (let k = texts.length - 1; k >= 0; k--) if (n.includes(texts[k].toLowerCase())) texts.splice(k, 1);
    texts.push(t);
  }
  const text = texts.join(' | ');
  return { text: text.length > max ? `${text.slice(0, max - 1)}…` : text, url };
}

/** Lines for the items of a list region, stopping at the token budget. */
export function listItems(model: PageModel, list: Region, budgetTokens = 4000, start = 0): HandoffItem[] {
  const out: HandoffItem[] = [];
  let used = 0;
  for (const refs of list.items ?? []) {
    const line = itemLine(model, refs);
    if (!line.text) continue;
    const cost = estimateTokens(`${line.text} ${line.url ?? ''}`) + 4;
    if (used + cost > budgetTokens) break;
    used += cost;
    out.push({ i: start + out.length, ...line });
  }
  return out;
}
