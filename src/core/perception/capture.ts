import type { PageSession, FrameInfo } from '../cdp/page.ts';
import type { Rect } from './types.ts';
import { logger } from '../util/log.ts';

const log = logger('capture');

export const STYLE_PROPS = [
  'display', 'visibility', 'opacity', 'cursor', 'pointer-events', 'position', 'z-index', 'overflow-x', 'overflow-y',
] as const;

export interface RawStyle {
  display: string; visibility: string; opacity: number; cursor: string; pointerEvents: string;
  position: string; zIndex: number | null; overflowX: string; overflowY: string;
}

export interface RawAx {
  role: string;
  name: string;
  nameSource?: { type: string; attribute?: string; nativeSource?: string };
  ignored: boolean;
  props: Record<string, unknown>;
}

/** One DOM node from any frame, with layout (top-level viewport coordinates) and accessibility data merged in. */
export interface RawNode {
  idx: number;
  parent: number;
  children: number[];
  nodeType: number;
  tag: string;
  text?: string;
  attrs: Record<string, string>;
  backendNodeId: number;
  inputValue?: string;
  checked?: boolean;
  optionSelected?: boolean;
  clickable?: boolean;
  isShadowRoot?: boolean;
  rect?: Rect;
  style?: RawStyle;
  paintOrder?: number;
  ax?: RawAx;
  frameSessionId?: string;
  /** Index of the frame document this node belongs to (0 = main document). */
  doc: number;
}

export interface RawCapture {
  url: string;
  title: string;
  lang: string;
  viewport: { w: number; h: number };
  scroll: { x: number; y: number };
  contentHeight: number;
  nodes: RawNode[];
  captureMs: number;
}

interface Snapshot {
  documents: any[];
  strings: string[];
}

function rareIndexSet(data: { index: number[] } | undefined): Set<number> {
  return new Set(data?.index ?? []);
}

function rareStringMap(data: { index: number[]; value: number[] } | undefined, strings: string[]): Map<number, string> {
  const m = new Map<number, string>();
  if (!data) return m;
  data.index.forEach((nodeIdx, i) => m.set(nodeIdx, strings[data.value[i]] ?? ''));
  return m;
}

function rareIntMap(data: { index: number[]; value: number[] } | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!data) return m;
  data.index.forEach((nodeIdx, i) => m.set(nodeIdx, data.value[i]));
  return m;
}

function parseStyle(values: number[], strings: string[]): RawStyle {
  const get = (i: number) => strings[values[i]] ?? '';
  const z = get(6);
  return {
    display: get(0), visibility: get(1), opacity: Number(get(2) || '1'), cursor: get(3), pointerEvents: get(4),
    position: get(5), zIndex: z === 'auto' || z === '' ? null : Number(z), overflowX: get(7), overflowY: get(8),
  };
}

/** Converts one DOMSnapshot (possibly with several same-process documents) into RawNodes appended to `out`. */
function ingestSnapshot(
  snap: Snapshot, out: RawNode[], frameSessionId: string | undefined, baseOffset: { x: number; y: number }, docBase: number,
): { rootIdx: number[]; docs: any[] } {
  const { strings } = snap;
  const docRoots: number[] = [];
  const docStartIdx: number[] = [];
  const iframeContent = new Map<number, number>(); // global node idx -> document index
  // First pass: create nodes for each document.
  snap.documents.forEach((doc, d) => {
    const nodes = doc.nodes;
    const start = out.length;
    docStartIdx[d] = start;
    const count = nodes.parentIndex.length;
    const textValue = rareStringMap(nodes.textValue, strings);
    const inputValue = rareStringMap(nodes.inputValue, strings);
    const inputChecked = rareIndexSet(nodes.inputChecked);
    const optionSelected = rareIndexSet(nodes.optionSelected);
    const clickable = rareIndexSet(nodes.isClickable);
    const contentDoc = rareIntMap(nodes.contentDocumentIndex);
    const shadowType = rareStringMap(nodes.shadowRootType, strings);
    for (let i = 0; i < count; i++) {
      const attrsFlat: number[] = nodes.attributes?.[i] ?? [];
      const attrs: Record<string, string> = {};
      // An empty value comes as string index -1: boolean attributes (required, disabled, readonly) and value="".
      for (let a = 0; a + 1 < attrsFlat.length; a += 2) attrs[strings[attrsFlat[a]].toLowerCase()] = attrsFlat[a + 1] >= 0 ? strings[attrsFlat[a + 1]] : '';
      const nodeType = nodes.nodeType[i];
      const nodeName = strings[nodes.nodeName[i]] ?? '';
      const raw: RawNode = {
        idx: start + i,
        parent: nodes.parentIndex[i] >= 0 ? start + nodes.parentIndex[i] : -1,
        children: [],
        nodeType,
        tag: nodeType === 1 ? nodeName.toLowerCase() : nodeName,
        attrs,
        backendNodeId: nodes.backendNodeId[i],
        doc: docBase + d,
        frameSessionId,
      };
      if (nodeType === 3) raw.text = strings[nodes.nodeValue[i]] ?? '';
      if (textValue.has(i)) raw.inputValue = textValue.get(i);
      if (inputValue.has(i)) raw.inputValue = inputValue.get(i);
      if (inputChecked.has(i)) raw.checked = true;
      if (optionSelected.has(i)) raw.optionSelected = true;
      if (clickable.has(i)) raw.clickable = true;
      if (shadowType.has(i)) raw.isShadowRoot = true;
      if (contentDoc.has(i)) iframeContent.set(start + i, contentDoc.get(i)!);
      out.push(raw);
    }
    docRoots[d] = start;
  });
  // Layout pass with per-document offsets. Same-process child documents are positioned by their owner iframe.
  const docOffset: Array<{ x: number; y: number }> = [];
  const resolveOffset = (d: number): { x: number; y: number } => {
    if (docOffset[d]) return docOffset[d];
    // Find the iframe that hosts document d.
    for (const [ownerIdx, childDoc] of iframeContent) {
      if (childDoc === d) {
        const owner = out[ownerIdx];
        const r = owner.rect;
        // Owner rects are already in top-level coordinates (the owner's document is laid out first).
        docOffset[d] = r ? { x: r.x, y: r.y } : resolveOffset(owner.doc - docBase);
        return docOffset[d];
      }
    }
    docOffset[d] = baseOffset;
    return baseOffset;
  };
  snap.documents.forEach((doc, d) => {
    const layout = doc.layout;
    const start = docStartIdx[d];
    const scrollX = doc.scrollOffsetX ?? 0;
    const scrollY = doc.scrollOffsetY ?? 0;
    const off = d === 0 ? baseOffset : resolveOffset(d);
    for (let li = 0; li < layout.nodeIndex.length; li++) {
      const node = out[start + layout.nodeIndex[li]];
      const b = layout.bounds[li];
      node.rect = { x: b[0] - scrollX + off.x, y: b[1] - scrollY + off.y, w: b[2], h: b[3] };
      node.style = parseStyle(layout.styles[li] ?? [], strings);
      if (layout.paintOrders) node.paintOrder = layout.paintOrders[li] + (docBase + d) * 1_000_000;
    }
  });
  // Children lists and iframe content linkage.
  for (let i = docStartIdx[0] ?? out.length; i < out.length; i++) {
    const n = out[i];
    if (n.parent >= 0) out[n.parent].children.push(n.idx);
  }
  for (const [ownerIdx, childDoc] of iframeContent) {
    const root = docRoots[childDoc];
    if (root !== undefined) { out[root].parent = ownerIdx; out[ownerIdx].children.push(root); }
  }
  return { rootIdx: docRoots, docs: snap.documents };
}

async function axFor(page: PageSession, sessionId: string | undefined, nodes: RawNode[], first: number): Promise<void> {
  const byBackend = new Map<number, RawNode>();
  for (let i = first; i < nodes.length; i++) byBackend.set(nodes[i].backendNodeId, nodes[i]);
  const frameIds: string[] = [];
  try {
    const { frameTree } = await page.send<{ frameTree: any }>('Page.getFrameTree', {}, sessionId);
    const walk = (t: any) => { frameIds.push(t.frame.id); for (const c of t.childFrames ?? []) walk(c); };
    walk(frameTree);
  } catch { frameIds.push(''); }
  for (const frameId of frameIds) {
    let axNodes: any[] = [];
    try {
      ({ nodes: axNodes } = await page.send<{ nodes: any[] }>('Accessibility.getFullAXTree', frameId ? { frameId } : {}, sessionId));
    } catch (e) {
      log.debug(`AX tree unavailable for frame ${frameId}`, (e as Error).message);
      continue;
    }
    for (const ax of axNodes) {
      if (ax.backendDOMNodeId === undefined) continue;
      const node = byBackend.get(ax.backendDOMNodeId);
      if (!node) continue;
      const props: Record<string, unknown> = {};
      for (const p of ax.properties ?? []) props[p.name] = p.value?.value;
      const source = (ax.name?.sources ?? []).find((s: any) => !s.superseded && s.value?.value);
      node.ax = {
        role: ax.role?.value ?? '',
        name: String(ax.name?.value ?? '').trim(),
        nameSource: source ? { type: source.type, attribute: source.attribute, nativeSource: source.nativeSource } : undefined,
        ignored: !!ax.ignored,
        props,
      };
    }
  }
}

/** Captures DOM, layout, paint order and accessibility for the main frame and all out-of-process iframes. */
export async function capturePage(page: PageSession): Promise<RawCapture> {
  const started = Date.now();
  await page.markListeners();
  const nodes: RawNode[] = [];
  const frames = page.frames();
  const metrics = await page.send<any>('Page.getLayoutMetrics');
  const vv = metrics.cssVisualViewport ?? metrics.visualViewport;
  const content = metrics.cssContentSize ?? metrics.contentSize;
  let url = '';
  let title = '';
  let lang = '';
  const ownerOf = new Map<string, number>(); // child frame sessionId -> owner iframe global idx
  let docBase = 0;
  for (const frame of frames) {
    let offset = { x: 0, y: 0 };
    if (!frame.isMain) {
      try { offset = await page.frameOffset(frame); } catch { continue; }
    }
    let snap: Snapshot;
    try {
      snap = await page.send<Snapshot>('DOMSnapshot.captureSnapshot', {
        computedStyles: [...STYLE_PROPS], includeDOMRects: true, includePaintOrder: true,
      }, frame.sessionId);
    } catch (e) {
      if (frame.isMain) throw e;
      log.debug(`snapshot failed for frame ${frame.url}`, (e as Error).message);
      continue;
    }
    const first = nodes.length;
    const { rootIdx, docs } = ingestSnapshot(snap, nodes, frame.isMain ? undefined : frame.sessionId, offset, docBase);
    docBase += docs.length;
    if (frame.isMain) {
      url = snap.strings[docs[0].documentURL] ?? '';
      title = snap.strings[docs[0].title] ?? '';
      lang = snap.strings[docs[0].contentLanguage] ?? '';
    } else {
      // Link the OOPIF document under its owner <iframe> element in the parent frame.
      try {
        const owner = await page.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.frameId }, frame.parentSessionId);
        const ownerNode = nodes.find((n, i) => i < first && n.backendNodeId === owner.backendNodeId
          && n.frameSessionId === (frames.find((f) => f.sessionId === frame.parentSessionId)?.isMain ? undefined : frame.parentSessionId));
        if (ownerNode) {
          nodes[rootIdx[0]].parent = ownerNode.idx;
          ownerNode.children.push(rootIdx[0]);
          ownerOf.set(frame.sessionId ?? '', ownerNode.idx);
        }
      } catch { /* frame went away */ }
    }
    await axFor(page, frame.sessionId, nodes, first);
  }
  if (!lang) {
    const html = nodes.find((n) => n.tag === 'html');
    lang = html?.attrs.lang ?? '';
  }
  return {
    url, title, lang,
    viewport: { w: Math.round(vv.clientWidth), h: Math.round(vv.clientHeight) },
    scroll: { x: Math.round(vv.pageX ?? 0), y: Math.round(vv.pageY ?? 0) },
    contentHeight: Math.round(content.height),
    nodes,
    captureMs: Date.now() - started,
  };
}

export type { FrameInfo };
