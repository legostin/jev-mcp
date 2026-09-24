import type { RawCapture, RawNode } from './capture.ts';
import type { ElementKind, ElementStates, NameSource, Rect } from './types.ts';
import { attributeName, axNameSource, cleanText, findNearbyText, type TextBox } from './naming.ts';

/** An element before regions and refs are assigned. */
export interface ElementDraft {
  idx: number;
  kind: ElementKind;
  role: string;
  tag: string;
  name: string;
  nameSource: NameSource;
  value?: string;
  placeholder?: string;
  inputType?: string;
  href?: string;
  text?: string;
  options?: { value: string; label: string; selected: boolean }[];
  states: ElementStates;
  interactive: boolean;
  visible: boolean;
  inViewport: boolean;
  occluded: boolean;
  occludedBy?: string;
  occluderIdx?: number;
  rect: Rect;
  backendNodeId: number;
  frameSessionId?: string;
  attrs: Record<string, string>;
  context?: string;
  label?: string;
  hints?: string[];
  order: number;
}

const UI_WORDS = ['sort', 'order', 'filter', 'search', 'next', 'prev', 'previous', 'more', 'advanced', 'close', 'dismiss', 'accept',
  'cookie', 'consent', 'login', 'signin', 'logout', 'submit', 'price', 'date', 'calendar', 'city', 'region', 'menu', 'dropdown',
  'select', 'modal', 'popup', 'cart', 'basket', 'checkout', 'pay', 'buy', 'pagination', 'pager', 'page', 'tab', 'toggle', 'expand',
  'suggest', 'autocomplete', 'swap', 'reset', 'clear', 'favorite', 'share', 'banner', 'promo', 'subscribe', 'captcha'];

/** Semantic UI words from class and id ("search-sort__button" -> sort). */
export function semanticHints(attrs: Record<string, string>): string[] {
  const text = `${attrs.class ?? ''} ${attrs.id ?? ''} ${attrs['data-testid'] ?? ''} ${attrs.name ?? ''}`.toLowerCase();
  const tokens = new Set(text.split(/[^a-z]+/).filter(Boolean));
  return UI_WORDS.filter((w) => tokens.has(w)).slice(0, 4);
}

export interface NodeInfo {
  tin: number;
  tout: number;
  depth: number;
  visible: boolean;
  opacity: number;
  clip: Rect | null;
  ariaHidden: boolean;
}

const WIDGET_ROLES = new Set([
  'button', 'link', 'checkbox', 'switch', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell',
]);
const KEPT_ATTRS = [
  'id', 'name', 'type', 'placeholder', 'aria-label', 'title', 'role', 'href', 'data-testid', 'data-test', 'data-qa',
  'autocomplete', 'aria-controls', 'aria-haspopup', 'aria-expanded', 'aria-autocomplete', 'for', 'value', 'data-date',
  'action', 'inputmode', 'list', 'class', 'contenteditable',
];
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const LANDMARKS = new Set(['header', 'footer', 'nav', 'main', 'aside', 'form', 'section', 'article', 'dialog', 'fieldset']);
const LANDMARK_ROLES = new Set(['banner', 'contentinfo', 'navigation', 'main', 'complementary', 'form', 'search', 'region', 'dialog', 'alertdialog']);

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

/** Depth-first intervals and inherited visibility for every node. */
export function computeNodeInfo(raw: RawCapture): NodeInfo[] {
  const info: NodeInfo[] = new Array(raw.nodes.length);
  const viewport: Rect = { x: 0, y: 0, w: raw.viewport.w, h: raw.viewport.h };
  let clock = 0;
  const roots = raw.nodes.filter((n) => n.parent === -1);
  const stack: Array<{ idx: number; phase: 0 | 1; parent: NodeInfo | null }> = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ idx: roots[i].idx, phase: 0, parent: null });
  while (stack.length) {
    const item = stack.pop()!;
    const n = raw.nodes[item.idx];
    if (item.phase === 1) { info[n.idx].tout = clock++; continue; }
    const p = item.parent;
    let opacity = p ? p.opacity : 1;
    let clip = p ? p.clip : null;
    let ariaHidden = p ? p.ariaHidden : false;
    let visible = p ? p.visible : true;
    if (n.nodeType === 1) {
      const s = n.style;
      if (n.attrs['aria-hidden'] === 'true' || n.attrs.inert !== undefined) ariaHidden = true;
      if (s) {
        opacity *= Number.isFinite(s.opacity) ? s.opacity : 1;
        if (s.position === 'fixed') clip = null;
        if (s.display === 'none') visible = false;
      } else if (n.tag !== 'html' && n.tag !== 'head' && n.tag !== 'slot' && n.style === undefined && !n.rect) {
        // Elements without a layout object are not rendered (display:none or inside one), except display:contents.
      }
      if (n.rect && s && (s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflowY === 'hidden' || s.overflowY === 'clip')) {
        const own = n.rect;
        clip = clip ? intersect(clip, own) ?? { x: own.x, y: own.y, w: 0, h: 0 } : own;
      }
      if (n.tag === 'iframe' && n.rect) clip = clip ? intersect(clip, n.rect) ?? { ...n.rect, w: 0, h: 0 } : n.rect;
    }
    info[n.idx] = { tin: clock++, tout: 0, depth: p ? p.depth + 1 : 0, visible, opacity, clip, ariaHidden };
    stack.push({ idx: n.idx, phase: 1, parent: p });
    for (let c = n.children.length - 1; c >= 0; c--) stack.push({ idx: n.children[c], phase: 0, parent: info[n.idx] });
  }
  for (let i = 0; i < info.length; i++) if (!info[i]) info[i] = { tin: 0, tout: 0, depth: 0, visible: false, opacity: 0, clip: null, ariaHidden: true };
  void viewport;
  return info;
}

export function isDescendant(info: NodeInfo[], ancestor: number, node: number): boolean {
  return info[ancestor].tin <= info[node].tin && info[node].tout <= info[ancestor].tout;
}

function isRendered(n: RawNode, inf: NodeInfo): boolean {
  if (!inf.visible || inf.ariaHidden || !n.rect || !n.style) return false;
  if (n.style.visibility !== 'visible') return false;
  if (inf.opacity < 0.05) return false;
  const tiny = n.rect.w < 1 || n.rect.h < 1;
  if (tiny) return false;
  if (inf.clip) {
    const vis = intersect(inf.clip, n.rect);
    if (!vis || vis.w < 2 || vis.h < 2) return false;
  }
  return true;
}

/** Visible text of a subtree (text nodes only, capped). `skip` prunes nested controls and popup layers. */
function subtreeText(raw: RawCapture, info: NodeInfo[], idx: number, max = 300, skip?: (i: number) => boolean): string {
  const parts: string[] = [];
  let len = 0;
  const walk = (i: number) => {
    if (len > max) return;
    if (skip && i !== idx && skip(i)) return;
    const n = raw.nodes[i];
    if (n.nodeType === 3) {
      // Keep the node's own spacing: "playwright_<em>mcp</em>" is one word, not "playwright_ mcp".
      const t = n.text;
      if (t && !t.trim()) { parts.push(' '); return; }
      if (t && info[i].visible && !info[i].ariaHidden) { parts.push(t); len += t.length; }
      return;
    }
    // Block boxes separate words; inline ones (highlights, links inside text) do not.
    const block = n.nodeType === 1 && !(n.style?.display ?? '').startsWith('inline');
    if (n.nodeType === 1) {
      if (n.tag === 'script' || n.tag === 'style' || n.tag === 'noscript' || n.tag === 'template') return;
      if (n.style && (n.style.display === 'none' || n.style.visibility !== 'visible')) return;
      if (block || n.tag === 'br') parts.push(' ');
    }
    for (const c of n.children) walk(c);
    if (block) parts.push(' ');
  };
  walk(idx);
  return cleanText(parts.join(''), max);
}

// Inline formatting inside running text: highlighted query words, bold prices, small units.
const INLINE_TEXT_TAGS = new Set(['em', 'strong', 'b', 'i', 'u', 'mark', 'small', 'sub', 'sup', 'code', 'abbr', 'time', 'span', 'bdi', 'q', 's', 'del', 'ins', 'kbd', 'var', 'dfn', 'cite', 'font']);
const CONTROL_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'img', 'svg', 'video', 'iframe']);

/** Non-interactive inline children that belong to the parent's text ("Model Context Protocol (<em>MCP</em>) server"). */
function inlineTextChildren(raw: RawCapture, idx: number): number[] {
  const out: number[] = [];
  const plain = (i: number): boolean => {
    const c = raw.nodes[i];
    if (c.nodeType === 3) return true;
    if (c.nodeType !== 1 || CONTROL_TAGS.has(c.tag) || !INLINE_TEXT_TAGS.has(c.tag)) return false;
    if (c.style && !c.style.display.startsWith('inline')) return false;
    if (c.attrs.onclick !== undefined || c.attrs.role || c.attrs.tabindex !== undefined) return false;
    return c.children.every(plain);
  };
  // Only a pure run of text qualifies: every child is text or inline formatting (no fields, buttons or blocks).
  const kids = raw.nodes[idx].children.filter((c) => raw.nodes[c].nodeType === 1 || raw.nodes[c].nodeType === 3);
  if (!kids.every(plain)) return [];
  for (const c of kids) if (raw.nodes[c].nodeType === 1) out.push(c);
  return out;
}

function ownText(raw: RawCapture, idx: number): string {
  const n = raw.nodes[idx];
  const parts: string[] = [];
  for (const c of n.children) {
    const ch = raw.nodes[c];
    if (ch.nodeType === 3 && ch.text?.trim()) parts.push(ch.text.trim());
  }
  return cleanText(parts.join(' '), 200);
}

function explicitRole(n: RawNode): string {
  return (n.attrs.role ?? '').split(/\s+/)[0].toLowerCase();
}

function inputKind(n: RawNode, role: string): ElementKind | null {
  const type = (n.attrs.type ?? 'text').toLowerCase();
  switch (type) {
    case 'hidden': return null;
    case 'checkbox': return 'checkbox';
    case 'radio': return 'radio';
    case 'range': return 'slider';
    case 'file': return 'file';
    case 'submit': case 'button': case 'reset': case 'image': return 'button';
    default:
      if (role === 'combobox' || n.attrs['aria-autocomplete'] || n.attrs.list || n.attrs['aria-haspopup'] === 'listbox') return 'combobox';
      return 'textbox';
  }
}

function roleKind(role: string): ElementKind | null {
  switch (role) {
    case 'button': return 'button';
    case 'link': return 'link';
    case 'checkbox': case 'switch': case 'menuitemcheckbox': return 'checkbox';
    case 'radio': case 'menuitemradio': return 'radio';
    case 'tab': return 'tab';
    case 'menuitem': case 'treeitem': return 'menuitem';
    case 'option': return 'option';
    case 'combobox': return 'combobox';
    case 'textbox': case 'searchbox': return 'textbox';
    case 'slider': case 'spinbutton': return 'slider';
    case 'gridcell': return 'clickable';
    default: return null;
  }
}

function states(n: RawNode): ElementStates {
  const p = n.ax?.props ?? {};
  const a = n.attrs;
  const bool = (v: unknown) => v === true || v === 'true';
  const st: ElementStates = {};
  // A control that takes no pointer events (inactive wizard tabs, greyed-out steps) cannot be used: treat it as disabled.
  if (bool(p.disabled) || a.disabled !== undefined || a['aria-disabled'] === 'true' || n.style?.pointerEvents === 'none') st.disabled = true;
  const checked = p.checked ?? (n.checked ? true : a['aria-checked']);
  if (checked === true || checked === 'true' || checked === 'mixed') st.checked = true;
  else if (checked === false || checked === 'false') st.checked = false;
  const expanded = p.expanded ?? a['aria-expanded'];
  if (expanded !== undefined) st.expanded = bool(expanded);
  // Toggle buttons (aria-pressed) count as selected: a pressed filter chip is a chosen value.
  if (bool(p.selected) || bool(p.pressed) || a['aria-selected'] === 'true' || a['aria-pressed'] === 'true') st.selected = true;
  if (bool(p.required) || a.required !== undefined || a['aria-required'] === 'true') st.required = true;
  if ((p.invalid && p.invalid !== 'false') || a['aria-invalid'] === 'true') st.invalid = true;
  if (bool(p.focused)) st.focused = true;
  if (bool(p.readonly) || a.readonly !== undefined) st.readonly = true;
  return st;
}

function keptAttrs(n: RawNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEPT_ATTRS) {
    const v = n.attrs[k];
    if (v === undefined || v === '') continue;
    if (k === 'class') { out.class = v.split(/\s+/).slice(0, 3).join(' '); continue; }
    out[k] = v.length > 120 ? v.slice(0, 119) + '…' : v;
  }
  return out;
}

function absoluteHref(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  if (/^\s*javascript:/i.test(href)) return undefined;
  try { return new URL(href, base).href; } catch { return href; }
}

/** Spatial index over layout nodes for paint-order hit testing. */
class HitGrid {
  private cells = new Map<number, number[]>();
  private readonly size = 64;
  private readonly cols: number;
  private readonly raw: RawCapture;
  private readonly info: NodeInfo[];
  constructor(raw: RawCapture, info: NodeInfo[], viewport: Rect) {
    this.raw = raw;
    this.info = info;
    this.cols = Math.ceil(viewport.w / this.size) + 1;
    for (const n of raw.nodes) {
      if (n.nodeType !== 1 || !n.rect || n.paintOrder === undefined || !n.style) continue;
      if (n.style.pointerEvents === 'none' || n.style.visibility !== 'visible') continue;
      if (!info[n.idx].visible || info[n.idx].opacity < 0.01) continue;
      const r = intersect(n.rect, viewport);
      if (!r) continue;
      const clip = info[n.idx].clip;
      const rr = clip ? intersect(r, clip) : r;
      if (!rr) continue;
      for (let cx = Math.floor(rr.x / this.size); cx <= Math.floor((rr.x + rr.w) / this.size); cx++) {
        for (let cy = Math.floor(rr.y / this.size); cy <= Math.floor((rr.y + rr.h) / this.size); cy++) {
          const key = cy * this.cols + cx;
          let cell = this.cells.get(key);
          if (!cell) { cell = []; this.cells.set(key, cell); }
          cell.push(n.idx);
        }
      }
    }
  }

  /** Topmost painted node at a point. */
  hit(x: number, y: number): number | null {
    const cell = this.cells.get(Math.floor(y / this.size) * this.cols + Math.floor(x / this.size));
    if (!cell) return null;
    let best: number | null = null;
    let bestOrder = -1;
    for (const idx of cell) {
      const n = this.raw.nodes[idx];
      const r = n.rect!;
      if (x < r.x || y < r.y || x > r.x + r.w || y > r.y + r.h) continue;
      const clip = this.info[idx].clip;
      if (clip && (x < clip.x || y < clip.y || x > clip.x + clip.w || y > clip.y + clip.h)) continue;
      if (n.paintOrder! > bestOrder) { bestOrder = n.paintOrder!; best = idx; }
    }
    return best;
  }
}

function describeNode(n: RawNode, raw: RawCapture, info: NodeInfo[]): string {
  const id = n.attrs.id ? `#${n.attrs.id}` : '';
  const cls = n.attrs.class ? `.${n.attrs.class.split(/\s+/)[0]}` : '';
  const text = subtreeText(raw, info, n.idx, 40);
  return `${n.tag}${id}${cls}${text ? ` "${text}"` : ''}`;
}

/**
 * Classifies every rendered node into interactive elements and meaningful text, with names,
 * states, visibility and occlusion.
 */
export function extractElements(raw: RawCapture): { drafts: ElementDraft[]; info: NodeInfo[] } {
  const info = computeNodeInfo(raw);
  const viewport: Rect = { x: 0, y: 0, w: raw.viewport.w, h: raw.viewport.h };
  const vpArea = viewport.w * viewport.h;
  const nodes = raw.nodes;

  // 1. Interactivity, bottom-up so weak containers with interactive descendants can be dropped.
  const strong = new Uint8Array(nodes.length);
  const weak = new Uint8Array(nodes.length);
  const kinds = new Array<ElementKind | null>(nodes.length).fill(null);
  const labelTarget = new Map<number, number>(); // label idx -> hidden checkbox/radio idx
  const byId = new Map<string, number>();
  for (const n of nodes) if (n.nodeType === 1 && n.attrs.id) byId.set(`${n.doc}:${n.attrs.id}`, n.idx);

  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const tag = n.tag;
    if (tag === 'html' || tag === 'body' || tag === 'head' || tag === 'option' || tag === 'optgroup') continue;
    const role = explicitRole(n) || (n.ax && WIDGET_ROLES.has(n.ax.role) ? n.ax.role : '');
    let kind: ElementKind | null = null;
    if (tag === 'select') kind = 'select';
    else if (tag === 'input') kind = inputKind(n, role);
    else if (tag === 'textarea') kind = 'textbox';
    else if (n.attrs.contenteditable === 'true' || n.attrs.contenteditable === '' || n.attrs.contenteditable === 'plaintext-only') kind = 'textbox';
    else if (role && roleKind(role)) kind = roleKind(role);
    else if (tag === 'a' && n.attrs.href !== undefined) kind = 'link';
    else if (tag === 'button' || tag === 'summary') kind = 'button';
    if (kind) { strong[n.idx] = 1; kinds[n.idx] = kind; continue; }
    const parent = n.parent >= 0 ? nodes[n.parent] : null;
    const pointer = n.style?.cursor === 'pointer' && parent?.style?.cursor !== 'pointer';
    const tabbable = n.attrs.tabindex !== undefined && Number(n.attrs.tabindex) >= 0;
    if (n.clickable || n.attrs['data-jev-l'] === '1' || pointer || tabbable) {
      if (tag === 'label') {
        const forIdx = n.attrs.for ? byId.get(`${n.doc}:${n.attrs.for}`) : undefined;
        if (forIdx !== undefined) labelTarget.set(n.idx, forIdx);
        continue;
      }
      const area = n.rect ? n.rect.w * n.rect.h : 0;
      if (area > vpArea * 0.6) continue;
      weak[n.idx] = 1;
      kinds[n.idx] = 'clickable';
    }
  }
  // Wrapped labels around hidden checkboxes/radios.
  for (const n of nodes) {
    if (n.nodeType !== 1 || n.tag !== 'label') continue;
    if (labelTarget.has(n.idx)) continue;
    const stack = [...n.children];
    while (stack.length) {
      const c = nodes[stack.pop()!];
      if (c.nodeType === 1 && c.tag === 'input' && ['checkbox', 'radio'].includes((c.attrs.type ?? '').toLowerCase())) { labelTarget.set(n.idx, c.idx); break; }
      stack.push(...c.children);
    }
  }
  // Drop weak containers that hold other interactive elements (delegated listeners, clickable cards).
  const hasInteractiveBelow = new Uint8Array(nodes.length);
  const order = [...nodes.keys()].sort((a, b) => info[b].tin - info[a].tin); // children before parents
  for (const i of order) {
    const n = nodes[i];
    if (n.parent < 0) continue;
    // Only rendered controls count: a dropdown trigger keeps its hidden option list inside it.
    if (((strong[i] || weak[i]) && isRendered(n, info[i])) || hasInteractiveBelow[i]) hasInteractiveBelow[n.parent] = 1;
  }
  for (let i = 0; i < nodes.length; i++) if (weak[i] && hasInteractiveBelow[i]) { weak[i] = 0; kinds[i] = null; }

  // 2. Text candidates for names and meaningful text elements.
  const insideInteractive = new Uint8Array(nodes.length);
  /** Inline pieces already folded into their parent's text. */
  const mergedText = new Set<number>();
  for (const i of [...order].reverse()) { // parents before children
    const n = nodes[i];
    if (n.parent >= 0 && (insideInteractive[n.parent] || strong[n.parent] || weak[n.parent])) insideInteractive[i] = 1;
  }
  const textBoxes: TextBox[] = [];
  const drafts: ElementDraft[] = [];
  const headings: Array<{ tin: number; idx: number; text: string }> = [];

  const makeDraft = (n: RawNode, kind: ElementKind, interactive: boolean): ElementDraft => {
    const inf = info[n.idx];
    const visible = isRendered(n, inf);
    const rect = n.rect ?? { x: 0, y: 0, w: 0, h: 0 };
    const inViewport = visible && !!intersect(rect, viewport);
    return {
      idx: n.idx, kind, role: explicitRole(n) || n.ax?.role || '', tag: n.tag, name: '', nameSource: 'none',
      states: states(n), interactive, visible, inViewport, occluded: false, rect,
      backendNodeId: n.backendNodeId, frameSessionId: n.frameSessionId, attrs: keptAttrs(n), order: inf.tin,
    };
  };

  for (const n of nodes) {
    if (n.nodeType !== 1) continue;
    const inf = info[n.idx];
    const kind = kinds[n.idx];
    if (kind && (strong[n.idx] || weak[n.idx])) {
      drafts.push(makeDraft(n, kind, true));
      continue;
    }
    if (labelTarget.has(n.idx)) {
      const target = nodes[labelTarget.get(n.idx)!];
      if (!isRendered(target, info[target.idx]) && isRendered(n, inf)) {
        const d = makeDraft(n, (target.attrs.type ?? '').toLowerCase() === 'radio' ? 'radio' : 'checkbox', true);
        d.states = states(target);
        d.attrs = { ...keptAttrs(target), ...d.attrs };
        drafts.push(d);
      }
      continue;
    }
    if (insideInteractive[n.idx]) continue;
    if (mergedText.has(n.idx)) continue;
    if (!isRendered(n, inf)) continue;
    let own = ownText(raw, n.idx);
    const inlineKids = inlineTextChildren(raw, n.idx);
    if (inlineKids.length) {
      // The parent's text includes its inline formatting; the pieces do not become elements of their own.
      const full = subtreeText(raw, info, n.idx, 200);
      if (full) {
        own = full;
        const stack = [...inlineKids];
        while (stack.length) { const i = stack.pop()!; mergedText.add(i); stack.push(...raw.nodes[i].children); }
      }
    }
    const isHeading = HEADING_TAGS.has(n.tag) || explicitRole(n) === 'heading' || n.ax?.role === 'heading';
    if (isHeading) {
      const text = subtreeText(raw, info, n.idx, 120);
      if (text) {
        const d = makeDraft(n, 'heading', false);
        d.name = text; d.nameSource = 'content'; d.text = text;
        drafts.push(d);
        headings.push({ tin: inf.tin, idx: n.idx, text });
        textBoxes.push({ text, rect: n.rect!, idx: n.idx });
      }
      continue;
    }
    if (n.tag === 'legend') headings.push({ tin: inf.tin, idx: n.idx, text: subtreeText(raw, info, n.idx, 80) });
    if (n.tag === 'img' && (n.attrs.alt ?? '').trim()) {
      const d = makeDraft(n, 'image', false);
      d.name = cleanText(n.attrs.alt); d.nameSource = 'alt';
      drafts.push(d);
      continue;
    }
    if (own) {
      const d = makeDraft(n, 'text', false);
      d.name = own; d.nameSource = 'content'; d.text = own;
      drafts.push(d);
      textBoxes.push({ text: own, rect: n.rect!, idx: n.idx });
    }
  }

  // 3. Names, values, options, text for interactive drafts.
  headings.sort((a, b) => a.tin - b.tin);
  const isControl = (i: number) => strong[i] === 1 || weak[i] === 1;
  const isLayer = (i: number) => {
    const st = nodes[i].style;
    return !!st && (st.position === 'fixed' || (st.position === 'absolute' && (st.zIndex ?? 0) >= 10));
  };
  const nestedSkip = (i: number) => isControl(i) || isLayer(i);
  for (const d of drafts) {
    const n = nodes[d.idx];
    if (!d.interactive) continue;
    const axName = cleanText(n.ax?.name);
    const source = axNameSource(n.ax?.nameSource);
    if (axName && !(source === 'content' && hasInteractiveBelow[d.idx])) { d.name = axName; d.nameSource = source; }
    else if (axName) {
      // Content-derived names of containers must not swallow nested controls or popups (e.g. a date field hosting a calendar).
      d.name = subtreeText(raw, info, d.idx, 80, nestedSkip) || cleanText(axName, 40);
      d.nameSource = 'content';
    } else {
      const attr = attributeName(n);
      if (attr) { d.name = attr.name; d.nameSource = attr.source; }
    }
    const inner = d.kind === 'select' ? '' : subtreeText(raw, info, d.idx, 160, hasInteractiveBelow[d.idx] ? nestedSkip : undefined);
    if (inner) d.text = inner;
    if (!d.name && inner && d.kind !== 'textbox' && d.kind !== 'combobox') { d.name = cleanText(inner, 80); d.nameSource = 'content'; }
    if (n.attrs.placeholder) d.placeholder = cleanText(n.attrs.placeholder, 80);
    if (n.tag === 'input' || n.tag === 'textarea') {
      d.inputType = (n.attrs.type ?? (n.tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
      if (d.inputType === 'password') d.value = n.inputValue ? '••••' : '';
      else if (d.kind === 'textbox' || d.kind === 'combobox' || d.kind === 'slider') d.value = cleanText(n.inputValue ?? '', 120);
    } else if (d.kind === 'textbox' && n.attrs.contenteditable !== undefined) {
      d.value = inner;
    }
    if (n.tag === 'select') {
      const opts: { value: string; label: string; selected: boolean }[] = [];
      const walk = (i: number) => {
        const c = nodes[i];
        if (c.nodeType === 1 && c.tag === 'option') {
          opts.push({ value: c.attrs.value ?? subtreeText(raw, info, i, 80), label: subtreeText(raw, info, i, 80) || (c.attrs.label ?? ''), selected: !!c.optionSelected });
          return;
        }
        for (const ch of c.children) walk(ch);
      };
      walk(d.idx);
      d.options = opts.slice(0, 100);
      const sel = opts.find((o) => o.selected) ?? opts[0];
      if (sel) d.value = sel.label;
    }
    if (d.kind === 'link') d.href = absoluteHref(n.attrs.href, raw.url);
  }

  // 4. Nearby-text names for unnamed controls; section context for all interactive drafts.
  const textBoxByParentChain = textBoxes;
  for (const d of drafts) {
    if (!d.interactive) continue;
    const hints = semanticHints(nodes[d.idx].attrs);
    if (hints.length) d.hints = hints;
    if (d.visible) {
      const near = findNearbyText(d.rect, textBoxByParentChain, (textIdx) => {
        // Same container: the lowest common ancestor is at most 4 levels above the control.
        let a = d.idx;
        for (let k = 0; k < 4 && a >= 0; k++) {
          a = nodes[a].parent;
          if (a >= 0 && isDescendant(info, a, textIdx)) return true;
        }
        return false;
      });
      if (near && !d.name) { d.name = cleanText(near.text, 80); d.nameSource = 'nearby'; }
      else if (near && near.text !== d.name && near.text.length <= 40 && !(d.text ?? '').includes(near.text)) d.label = cleanText(near.text, 40);
    }
    // Section heading: nearest preceding heading inside one of the first 6 ancestors, not crossing a landmark.
    let a = nodes[d.idx].parent;
    for (let k = 0; k < 6 && a >= 0; k++, a = nodes[a].parent) {
      if (nodes[a].tag === 'body' || nodes[a].tag === 'html') break;
      const lo = info[a].tin;
      const hi = info[d.idx].tin;
      let found: { text: string } | null = null;
      for (let h = headings.length - 1; h >= 0; h--) {
        const hd = headings[h];
        if (hd.tin >= hi) continue;
        if (hd.tin <= lo) break;
        if (isDescendant(info, a, hd.idx)) { found = hd; break; }
      }
      if (found && found.text && found.text !== d.name) { d.context = cleanText(found.text, 60); break; }
      if (LANDMARKS.has(nodes[a].tag) || LANDMARK_ROLES.has(nodes[a].attrs.role ?? '')) break;
    }
  }

  // 5. Occlusion by paint order, for visible in-viewport interactive elements.
  const grid = new HitGrid(raw, info, viewport);
  for (const d of drafts) {
    if (!d.interactive || !d.inViewport) continue;
    const r = intersect(d.rect, viewport)!;
    const points = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    let clear = false;
    let occluder: number | null = null;
    for (const [fx, fy] of points) {
      const hit = grid.hit(r.x + r.w * fx, r.y + r.h * fy);
      if (hit === null || hit === d.idx || isDescendant(info, d.idx, hit) || isDescendant(info, hit, d.idx)) { clear = true; break; }
      // A label pointing at this control is not an occluder.
      if (nodes[hit].tag === 'label') { clear = true; break; }
      occluder ??= hit;
    }
    if (!clear && occluder !== null) {
      d.occluded = true;
      d.occluderIdx = occluder;
      d.occludedBy = describeNode(nodes[occluder], raw, info);
    }
  }

  // Not-rendered elements never enter the model (hidden text is a prompt-injection vector). Elements that are
  // rendered but clipped by a scroll container stay, marked invisible, because scrolling can reveal them.
  const kept = drafts.filter((d) => {
    if (d.visible) return true;
    const n = nodes[d.idx];
    const inf = info[d.idx];
    return !!n.rect && !!n.style && n.style.visibility === 'visible' && inf.visible && !inf.ariaHidden && inf.opacity >= 0.05;
  });
  kept.sort((a, b) => a.order - b.order);
  return { drafts: kept, info };
}
