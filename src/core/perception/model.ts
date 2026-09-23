import type { RawCapture } from './capture.ts';
import { capturePage } from './capture.ts';
import { extractElements, isDescendant, type ElementDraft, type NodeInfo } from './elements.ts';
import { detectRegions, type RegionDraft } from './regions.ts';
import { elementSignature, hash, normalizeId, normalizeName } from './signature.ts';
import type { ElementNode, PageModel, Region } from './types.ts';
import type { PageSession } from '../cdp/page.ts';

/** PageModel plus the bookkeeping needed to keep refs stable across snapshots. */
export interface ModelState {
  refCounter: number;
  regionCounter: number;
}

const refNum = (ref: string) => Number(ref.slice(1)) || 0;

function regionKey(r: { kind: string; label: string }): string {
  return `${r.kind}:${normalizeName(r.label.replace(/\d+\s+items/, ''))}`;
}

/** Assigns ids so that the same logical thing keeps its id: matched by signature and ordinal among equals. */
function assignStableIds<T>(
  items: T[], sigOf: (t: T) => string, prevBySig: Map<string, string[]>, counter: { value: number }, prefix: string,
): string[] {
  const seen = new Map<string, number>();
  const used = new Set<string>();
  return items.map((it) => {
    const sig = sigOf(it);
    const k = seen.get(sig) ?? 0;
    seen.set(sig, k + 1);
    const prev = prevBySig.get(sig)?.[k];
    if (prev && !used.has(prev)) { used.add(prev); return prev; }
    const id = `${prefix}${++counter.value}`;
    used.add(id);
    return id;
  });
}

export function buildPageModel(raw: RawCapture, prev?: PageModel & Partial<ModelState>): PageModel & ModelState {
  const { drafts, info } = extractElements(raw);
  const regionDrafts = detectRegions(raw, info, drafts);

  // Region ids (r0 is always the page).
  const prevRegionsBySig = new Map<string, string[]>();
  for (const r of prev?.regions ?? []) {
    if (r.id === 'r0') continue;
    const list = prevRegionsBySig.get(r.sig) ?? [];
    list.push(r.id);
    prevRegionsBySig.set(r.sig, list);
  }
  const regionSig = (rd: RegionDraft) => hash([rd.kind, regionKey(rd), raw.nodes[rd.anchor].tag, normalizeId(raw.nodes[rd.anchor].attrs.id)]);
  const regionCounter = { value: prev?.regionCounter ?? 0 };
  const regionIds = assignStableIds(regionDrafts, regionSig, prevRegionsBySig, regionCounter, 'r');

  const regions: Region[] = [{
    id: 'r0', sig: 'page', kind: 'page', label: raw.title, refs: [], rect: { x: 0, y: 0, w: raw.viewport.w, h: raw.contentHeight }, blocking: false,
  }];
  const draftRegion = new Map<RegionDraft, Region>();
  regionDrafts.forEach((rd, i) => {
    const region: Region = { id: regionIds[i], sig: regionSig(rd), kind: rd.kind, label: rd.label, refs: [], rect: rd.rect, blocking: false };
    regions.push(region);
    draftRegion.set(rd, region);
  });
  // Nesting: nearest enclosing region by DOM ancestry.
  const innermost = (nodeIdx: number, exclude?: RegionDraft): RegionDraft | null => {
    let best: RegionDraft | null = null;
    for (const rd of regionDrafts) {
      if (rd === exclude) continue;
      if (rd.anchor === nodeIdx && !exclude) return rd;
      if (isDescendant(info, rd.anchor, nodeIdx) && (!best || info[rd.anchor].tin > info[best.anchor].tin)) best = rd;
    }
    return best;
  };
  for (const rd of regionDrafts) {
    const parent = innermost(rd.anchor, rd);
    draftRegion.get(rd)!.parentId = parent ? draftRegion.get(parent)!.id : 'r0';
  }

  // Element refs.
  const regionOfDraft = new Map<ElementDraft, Region>();
  for (const d of drafts) {
    const rd = innermost(d.idx);
    regionOfDraft.set(d, rd ? draftRegion.get(rd)! : regions[0]);
  }
  const prevElsBySig = new Map<string, string[]>();
  if (prev) for (const el of prev.elements.values()) {
    const list = prevElsBySig.get(el.sig) ?? [];
    list.push(el.ref);
    prevElsBySig.set(el.sig, list);
  }
  const sigs = drafts.map((d) => {
    const reg = regionOfDraft.get(d)!;
    return elementSignature({ ...d, frameKey: d.frameSessionId ? 'oopif' : '' }, regionKey(reg));
  });
  const refCounter = { value: prev?.refCounter ?? 0 };
  const sigByDraft = new Map(drafts.map((d, i) => [d, sigs[i]]));
  const refs = assignStableIds(drafts, (d) => sigByDraft.get(d)!, prevElsBySig, refCounter, 'e');

  const elements = new Map<string, ElementNode>();
  const refByIdx = new Map<number, string>();
  drafts.forEach((d, i) => {
    const region = regionOfDraft.get(d)!;
    const el: ElementNode = {
      ref: refs[i], sig: sigs[i], kind: d.kind, role: d.role, tag: d.tag, name: d.name, nameSource: d.nameSource,
      value: d.value, placeholder: d.placeholder, inputType: d.inputType, href: d.href, text: d.text, options: d.options,
      states: d.states, interactive: d.interactive, visible: d.visible, inViewport: d.inViewport, occluded: d.occluded,
      occludedBy: d.occludedBy, rect: d.rect, regionId: region.id, backendNodeId: d.backendNodeId,
      frameSessionId: d.frameSessionId, attrs: d.attrs, context: d.context, order: d.order,
    };
    elements.set(el.ref, el);
    refByIdx.set(d.idx, el.ref);
    region.refs.push(el.ref);
  });

  // List items as groups of refs.
  for (const rd of regionDrafts) {
    if (!rd.items) continue;
    const region = draftRegion.get(rd)!;
    region.items = rd.items.map((itemIdx) => drafts.filter((d) => isDescendant(info, itemIdx, d.idx)).map((d) => refByIdx.get(d.idx)!));
  }

  // Blocking overlays: they (or their backdrop) cover interactive elements of other regions.
  const layered = regionDrafts.filter((rd) => rd.kind === 'overlay' || rd.kind === 'dialog');
  for (const d of drafts) {
    if (!d.occluded || d.occluderIdx === undefined) continue;
    const occ = d.occluderIdx;
    let owner = layered.find((rd) => rd.anchor === occ || isDescendant(info, rd.anchor, occ));
    if (!owner && layered.length) {
      // A backdrop sibling: attribute to the top-most modal layer.
      owner = [...layered].sort((a, b) => b.paintOrder - a.paintOrder)[0];
    }
    if (owner && !isDescendant(info, owner.anchor, d.idx)) draftRegion.get(owner)!.blocking = true;
  }

  const focused = drafts.find((d) => d.states.focused);
  const pageSig = hash([
    raw.url,
    ...regions.map((r) => r.sig),
    ...[...elements.values()].filter((e) => e.interactive && e.visible)
      .map((e) => `${e.sig}=${e.value ?? ''}|${e.states.checked ?? ''}|${e.states.expanded ?? ''}|${e.occluded}`),
    // Visible text matters too: a status message or error appearing is a change of state.
    ...[...elements.values()].filter((e) => !e.interactive && e.visible && e.inViewport).slice(0, 300).map((e) => e.name),
  ]);

  return {
    url: raw.url,
    title: raw.title,
    lang: raw.lang,
    viewport: raw.viewport,
    scroll: { y: raw.scroll.y, maxY: Math.max(0, raw.contentHeight - raw.viewport.h) },
    elements,
    regions,
    signature: pageSig,
    focusedRef: focused ? refByIdx.get(focused.idx) : undefined,
    capturedAt: Date.now(),
    captureMs: raw.captureMs,
    refCounter: refCounter.value,
    regionCounter: regionCounter.value,
  };
}

/** Captures the page and builds the model in one go. */
export async function observePage(page: PageSession, prev?: PageModel & Partial<ModelState>): Promise<PageModel & ModelState> {
  const raw = await capturePage(page);
  const started = Date.now();
  const model = buildPageModel(raw, prev);
  model.captureMs = raw.captureMs + (Date.now() - started);
  return model;
}

export type { NodeInfo };
