import type { RawNode } from './capture.ts';
import type { NameSource, Rect } from './types.ts';

export function cleanText(text: string | undefined, max = 100): string {
  if (!text) return '';
  const t = text.replace(/[   ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/** Maps Chrome's accessible-name source to our coarse naming categories. */
export function axNameSource(src: { type: string; attribute?: string; nativeSource?: string } | undefined): NameSource {
  if (!src) return 'content';
  const attr = src.attribute ?? '';
  if (attr === 'aria-label' || attr === 'aria-labelledby') return 'aria';
  if (attr === 'placeholder' || src.type === 'placeholder') return 'placeholder';
  if (attr === 'title') return 'title';
  if (attr === 'alt') return 'alt';
  if (attr === 'value') return 'value';
  if (src.type === 'relatedElement') return src.nativeSource ? 'label' : 'aria';
  if (src.nativeSource && src.nativeSource.startsWith('label')) return 'label';
  if (src.type === 'contents') return 'content';
  if (src.type === 'attribute') return 'aria';
  return 'content';
}

export interface TextBox { text: string; rect: Rect; idx: number }

/**
 * Finds a visible text label next to an unnamed control: to the left on the same row, or just above it.
 * `sameContainer(a, b)` restricts candidates to the control's surrounding container.
 */
export function findNearbyText(target: Rect, candidates: TextBox[], sameContainer: (textIdx: number) => boolean): TextBox | null {
  let best: TextBox | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const r = c.rect;
    if (!sameContainer(c.idx)) continue;
    const vOverlap = Math.min(r.y + r.h, target.y + target.h) - Math.max(r.y, target.y);
    const hOverlap = Math.min(r.x + r.w, target.x + target.w) - Math.max(r.x, target.x);
    let dist = Infinity;
    // Left, same row.
    if (vOverlap >= Math.min(r.h, target.h) * 0.5 && r.x + r.w <= target.x + 6) {
      const gap = target.x - (r.x + r.w);
      if (gap <= 250) dist = gap;
    }
    // Above, overlapping horizontally (or starting near the control's left edge).
    const gapAbove = target.y - (r.y + r.h);
    if (gapAbove >= -6 && gapAbove <= 50 && (hOverlap > 0 || Math.abs(r.x - target.x) <= 24)) {
      dist = Math.min(dist, gapAbove + 10);
    }
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  return best;
}

/** Fallback name from attributes when Chrome's accessible name is empty. */
export function attributeName(node: RawNode): { name: string; source: NameSource } | null {
  const a = node.attrs;
  if (a['aria-label']) return { name: cleanText(a['aria-label']), source: 'aria' };
  if (a.placeholder) return { name: cleanText(a.placeholder), source: 'placeholder' };
  if (a.title) return { name: cleanText(a.title), source: 'title' };
  if (a.alt) return { name: cleanText(a.alt), source: 'alt' };
  if (node.tag === 'input' && ['submit', 'button', 'reset'].includes((a.type ?? '').toLowerCase()) && a.value) {
    return { name: cleanText(a.value), source: 'value' };
  }
  return null;
}
