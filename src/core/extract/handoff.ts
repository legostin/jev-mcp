import type { PageModel, Region } from '../perception/types.ts';
import { cleanText } from '../perception/naming.ts';
import { estimateTokens } from '../util/tokens.ts';

/**
 * The results page as the main agent reads it. JEV finds the page and the list; choosing the answer (cheapest,
 * newest, "not an accessory") is the agent's job: it reads a list far better than field-by-field extraction.
 */
export interface HandoffItem { i: number; text: string; url: string | null }

/** `title`: the item's title link (the one its URL comes from), never dropped as furniture. */
interface Segment { text: string; link: boolean; title?: boolean }

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

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Share of the shorter text's words found in the longer one. */
function overlap(a: string, b: string): number {
  const [x, y] = a.length <= b.length ? [words(a), new Set(words(b))] : [words(b), new Set(words(a))];
  return x.length ? x.filter((w) => y.has(w)).length / x.length : 0;
}

const letterWords = (s: string) => words(s).filter((w) => /\p{L}/u.test(w)).length;

/**
 * Visible texts of an item in order, and its link: the link with the most words (the title), not the first one,
 * which is often a category tag, a vote arrow or an author.
 */
function segments(model: PageModel, refs: string[]): { segs: Segment[]; url: string | null } {
  const segs: Segment[] = [];
  let best: { href: string; n: number; seg: Segment | null } | null = null;
  for (const r of refs) {
    const e = model.elements.get(r);
    if (!e || !e.visible) continue;
    const text = cleanText(e.text || e.name, 200);
    // Enumeration marks ("1.", "12.") are list furniture.
    const seg: Segment | null = text.length < 2 || /^\d{1,4}\.$/.test(text) ? null : { text, link: e.kind === 'link' };
    if (seg) segs.push(seg);
    if (e.kind === 'link' && e.href) {
      const n = letterWords(text);
      if (!best || n > best.n) best = { href: e.href, n, seg };
    }
  }
  if (best?.seg) best.seg.title = true;
  return { segs, url: best ? compactUrl(best.href, model.url) : null };
}

// A shown address ("(https://site/blog/introducing-x)") repeats a title's words but is not the title.
const urlish = (t: string) => /^\(?\s*(https?:\/\/|www\.)/i.test(t) || /^\(?[\w-]+(\.[\w-]+)+(\/\S*)?\)?$/.test(t);

function dedupe(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const same = out.findIndex((o) => urlish(o.text) === urlish(s.text) && overlap(o.text, s.text) >= 0.8);
    if (same === -1) out.push(s);
    else if (s.text.length > out[same].text.length && words(s.text).length > words(out[same].text).length) out[same] = s;
  }
  return out;
}

/**
 * Site furniture repeated in (almost) every item: short labels ("Watch", "Brand new", the filtered city) and
 * trailing phrases ("Opens in a new window or tab", "Image 1 of 4"). Item titles (link texts) are never dropped.
 */
function boilerplate(items: Segment[][]): { labels: Set<string>; tails: RegExp[] } {
  const n = items.length;
  const labels = new Set<string>();
  const tails: RegExp[] = [];
  if (n < 5) return { labels, tails };
  const label = new Map<string, number>();
  const tail = new Map<string, number>();
  for (const segs of items) {
    const seenL = new Set<string>();
    const seenT = new Set<string>();
    for (const s of segs) {
      const key = s.text.toLowerCase();
      // Short texts, links too ("hide", "Read more"): a title never repeats in most items.
      if (words(key).length <= 3 && !seenL.has(key)) { seenL.add(key); label.set(key, (label.get(key) ?? 0) + 1); }
      const w = s.text.split(/\s+/);
      for (let k = 3; k <= Math.min(8, w.length - 1); k++) {
        // Numbers vary only in short counters ("Image 1 of 4"); longer tails must match literally.
        const lit = w.slice(-k).join(' ').toLowerCase();
        const t = k <= 4 ? lit.replace(/\d+/g, '#') : lit.replace(/#/g, '');
        // Furniture is words ("opens in a new tab"); numbers and currencies are data ("1 150 000 ₸").
        if (words(t).filter((x) => /\p{L}/u.test(x)).length < 2) continue;
        if (!seenT.has(t)) { seenT.add(t); tail.set(t, (tail.get(t) ?? 0) + 1); }
      }
    }
  }
  for (const [k, c] of label) if (c >= n * 0.6) labels.add(k);
  const common = [...tail].filter(([, c]) => c >= n * 0.5).map(([t]) => t).sort((a, b) => b.length - a.length);
  for (const t of common) {
    const src = t.split('#').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+');
    tails.push(new RegExp(`\\s*${src}$`, 'i'));
  }
  return { labels, tails };
}

function line(segs: Segment[], bp: { labels: Set<string>; tails: RegExp[] }, max: number): string {
  const kept: Segment[] = [];
  for (const s of segs) {
    if (bp.labels.has(s.text.toLowerCase()) && !s.title) continue;
    let text = s.text;
    for (const re of bp.tails) text = text.replace(re, '');
    if (text.trim().length >= 2) kept.push({ ...s, text: text.trim() });
  }
  // Long descriptions are cut; when the line is still too long, tag-like chips (short, no digits) go first:
  // numbers carry the values the agent compares (prices, stars, dates).
  const parts = dedupe(kept).map((p, i) => (i > 0 && p.text.length > 120 ? { ...p, text: `${p.text.slice(0, 119)}…` } : p));
  const joined = () => parts.map((p) => p.text).join(' | ');
  for (let i = parts.length - 1; i >= 1 && joined().length > max; i--) {
    if (!/\d/.test(parts[i].text) && words(parts[i].text).length <= 2) parts.splice(i, 1);
  }
  const text = joined();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line for a single item (no list-wide cleanup). */
export function itemLine(model: PageModel, refs: string[], max = 260): Omit<HandoffItem, 'i'> {
  const { segs, url } = segments(model, refs);
  return { text: line(segs, { labels: new Set(), tails: [] }, max), url };
}

/** Lines for the items of a list region, cleaned of site furniture, stopping at the token budget. */
export function listItems(model: PageModel, list: Region, budgetTokens = 4000, start = 0, max = 260): HandoffItem[] {
  const raw = (list.items ?? []).map((refs) => segments(model, refs));
  const bp = boilerplate(raw.map((r) => r.segs));
  const out: HandoffItem[] = [];
  let used = 0;
  for (const r of raw) {
    const text = line(r.segs, bp, max);
    if (!text) continue;
    const cost = estimateTokens(`${text} ${r.url ?? ''}`) + 4;
    if (used + cost > budgetTokens) break;
    used += cost;
    out.push({ i: start + out.length, text, url: r.url });
  }
  return out;
}
