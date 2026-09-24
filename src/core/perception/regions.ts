import type { RawCapture, RawNode } from './capture.ts';
import type { ElementDraft, NodeInfo } from './elements.ts';
import { isDescendant } from './elements.ts';
import { findRepeatedGroups } from './repeated.ts';
import { cleanText } from './naming.ts';
import type { Rect, RegionKind } from './types.ts';

export interface RegionDraft {
  anchor: number;
  kind: RegionKind;
  label: string;
  rect: Rect;
  /** For lists: item root node indices. */
  items?: number[];
  /** For lists whose items span several sibling rows: every node of each item. */
  members?: number[][];
  paintOrder: number;
}

const LANDMARK_TAGS: Record<string, RegionKind> = {
  header: 'header', nav: 'nav', main: 'main', aside: 'aside', footer: 'footer', form: 'form', dialog: 'dialog',
  section: 'section', article: 'section', fieldset: 'section',
};
const LANDMARK_ROLES: Record<string, RegionKind> = {
  banner: 'header', navigation: 'nav', main: 'main', complementary: 'aside', contentinfo: 'footer',
  form: 'form', search: 'form', dialog: 'dialog', alertdialog: 'dialog', listbox: 'popup', menu: 'popup',
  tree: 'popup', region: 'section', grid: 'section', tablist: 'section',
};

function regionName(raw: RawCapture, info: NodeInfo[], n: RawNode): string {
  const a = n.attrs;
  if (a['aria-label']) return cleanText(a['aria-label'], 60);
  if (a['aria-labelledby']) {
    const ids = a['aria-labelledby'].split(/\s+/);
    const texts = ids.map((id) => raw.nodes.find((x) => x.doc === n.doc && x.attrs.id === id)).filter(Boolean)
      .map((x) => firstText(raw, info, x!.idx, 60));
    if (texts.join('')) return cleanText(texts.join(' '), 60);
  }
  if (n.ax?.name) return cleanText(n.ax.name, 60);
  if (n.tag === 'form' || a.role === 'search') {
    const hint = a.name || a.id || (a.class ?? '').split(/\s+/)[0] || '';
    if (hint && !/^[a-z]?[0-9a-f-]{6,}$/i.test(hint)) return hint.replace(/[-_]+/g, ' ');
  }
  // First heading or legend inside.
  const stack = [...n.children];
  let visited = 0;
  while (stack.length && visited < 400) {
    const i = stack.shift()!;
    visited++;
    const c = raw.nodes[i];
    if (c.nodeType === 1 && (/^h[1-6]$/.test(c.tag) || c.tag === 'legend' || c.attrs.role === 'heading')) {
      const t = firstText(raw, info, i, 60);
      if (t) return t;
    }
    if (c.nodeType === 1) stack.push(...c.children);
  }
  return '';
}

function firstText(raw: RawCapture, info: NodeInfo[], idx: number, max: number): string {
  const parts: string[] = [];
  const walk = (i: number) => {
    if (parts.join(' ').length > max) return;
    const n = raw.nodes[i];
    if (n.nodeType === 3) { if (n.text?.trim() && info[i].visible) parts.push(n.text.trim()); return; }
    for (const c of n.children) walk(c);
  };
  walk(idx);
  return cleanText(parts.join(' '), max);
}

/**
 * Detects landmark, overlay, popup, list and section regions. Overlays and popups are positioned layers
 * (fixed or absolute with a z-index); overlays are large or modal, popups are smaller anchored layers.
 */
export function detectRegions(raw: RawCapture, info: NodeInfo[], drafts: ElementDraft[]): RegionDraft[] {
  const vp = raw.viewport;
  const vpArea = vp.w * vp.h;
  const out: RegionDraft[] = [];
  const interactiveIdx = drafts.filter((d) => d.interactive).map((d) => d.idx);
  const countInteractive = (anchor: number) => interactiveIdx.filter((i) => isDescendant(info, anchor, i)).length;

  for (const n of raw.nodes) {
    if (n.nodeType !== 1 || !n.rect || !n.style || !info[n.idx].visible) continue;
    if (n.rect.w < 1 || n.rect.h < 1 || info[n.idx].opacity < 0.05) continue;
    const role = (n.attrs.role ?? '').toLowerCase();
    let kind: RegionKind | null = LANDMARK_ROLES[role] ?? LANDMARK_TAGS[n.tag] ?? null;
    if (n.attrs['aria-modal'] === 'true') kind = 'dialog';
    const s = n.style;
    const positioned = s.position === 'fixed' || (s.position === 'absolute' && (s.zIndex ?? 0) >= 10);
    const area = n.rect.w * n.rect.h;
    if (positioned && kind !== 'dialog' && kind !== 'popup') {
      const coversWidth = n.rect.w >= vp.w * 0.2;
      const onScreen = n.rect.x < vp.w && n.rect.y < vp.h && n.rect.x + n.rect.w > 0 && n.rect.y + n.rect.h > 0;
      const hasContent = countInteractive(n.idx) > 0 || firstText(raw, info, n.idx, 10).length > 0;
      if (onScreen && hasContent) {
        if (s.position === 'fixed' && (area >= vpArea * 0.08 || coversWidth)) kind = 'overlay';
        else if (s.position === 'absolute' && area < vpArea * 0.6) kind = 'popup';
        else if (area >= vpArea * 0.08) kind = 'overlay';
      }
    }
    // Sticky/fixed headers are headers, not overlays: by tag/role, or a full-width band pinned to the top.
    if (kind === 'overlay' && (n.tag === 'header' || role === 'banner' || n.tag === 'nav')) kind = n.tag === 'nav' ? 'nav' : 'header';
    if (kind === 'overlay' && n.rect.y <= 4 && n.rect.h <= vp.h * 0.25 && n.rect.w >= vp.w * 0.7) kind = 'header';
    if (kind === 'section') {
      // Only sections that are worth naming: a heading/label and some interactive content.
      const label = regionName(raw, info, n);
      if (!label || countInteractive(n.idx) === 0) kind = null;
    }
    if (!kind) continue;
    out.push({ anchor: n.idx, kind, label: regionName(raw, info, n), rect: n.rect, paintOrder: n.paintOrder ?? 0 });
  }
  // Heading-led blocks (a div whose first element child is a heading and which holds 2+ controls).
  for (const n of raw.nodes) {
    if (n.nodeType !== 1 || n.tag !== 'div' || !info[n.idx].visible || !n.rect) continue;
    const firstEl = n.children.map((c) => raw.nodes[c]).find((c) => c.nodeType === 1);
    if (!firstEl || !/^h[2-4]$/.test(firstEl.tag)) continue;
    if (out.some((r) => r.anchor === n.idx)) continue;
    if (countInteractive(n.idx) < 2) continue;
    out.push({ anchor: n.idx, kind: 'section', label: firstText(raw, info, firstEl.idx, 60), rect: n.rect, paintOrder: n.paintOrder ?? 0 });
  }
  const textInputs = drafts.filter((d) => d.kind === 'textbox' || d.kind === 'combobox').map((d) => d.idx);
  for (const g of findRepeatedGroups(raw, info)) {
    const p = raw.nodes[g.parent];
    if (!p.rect || p.tag === 'form') continue;
    // Form rows are not result lists: skip groups whose items hold text inputs.
    if ((g.members?.flat() ?? g.items).some((it) => textInputs.some((t) => isDescendant(info, it, t)))) continue;
    const existing = out.find((r) => r.anchor === g.parent);
    const label = `${g.items.length} items`;
    if (existing && (existing.kind === 'section' || existing.kind === 'main' || existing.kind === 'aside')) {
      existing.kind = 'list'; existing.items = g.items; existing.members = g.members; existing.label = existing.label ? `${existing.label}, ${label}` : label;
    } else if (existing) { existing.items = g.items; existing.members = g.members; }
    else out.push({ anchor: g.parent, kind: 'list', label, rect: p.rect, items: g.items, members: g.members, paintOrder: p.paintOrder ?? 0 });
  }
  // Items of a list are not separate sections.
  const listItems = out.filter((r) => r.kind === 'list').flatMap((r) => r.members?.flat() ?? r.items ?? []);
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind === 'section' && listItems.some((it) => it === out[i].anchor || isDescendant(info, it, out[i].anchor))) out.splice(i, 1);
  }
  // Keep a manageable number of regions: prefer overlays, popups, forms, lists, dialogs, then larger ones.
  const priority: Record<RegionKind, number> = {
    dialog: 0, overlay: 0, popup: 0, form: 1, list: 1, main: 2, nav: 2, header: 2, footer: 3, aside: 3, section: 2, page: 9,
  };
  out.sort((a, b) => priority[a.kind] - priority[b.kind] || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  const kept = out.slice(0, 48);
  kept.sort((a, b) => info[a.anchor].tin - info[b.anchor].tin);
  return kept;
}
