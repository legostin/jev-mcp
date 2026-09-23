import type { ElementNode, PageDiff, PageModel } from './types.ts';

function fingerprint(e: ElementNode): string {
  const s = e.states;
  return [e.name, e.value ?? '', e.visible, e.occluded, s.checked, s.expanded, s.selected, s.disabled, s.invalid].join('|');
}

export function diffModels(prev: PageModel | undefined, next: PageModel): PageDiff {
  if (!prev) {
    return {
      urlChanged: true, added: [...next.elements.keys()], removed: [], changed: [],
      newRegions: next.regions.map((r) => r.id), goneRegions: [], focusChanged: false,
    };
  }
  const added: string[] = [];
  const changed: string[] = [];
  for (const [ref, el] of next.elements) {
    const before = prev.elements.get(ref);
    if (!before) added.push(ref);
    else if (fingerprint(before) !== fingerprint(el)) changed.push(ref);
  }
  const removed = [...prev.elements.keys()].filter((ref) => !next.elements.has(ref));
  const prevRegions = new Set(prev.regions.map((r) => r.id));
  const nextRegions = new Set(next.regions.map((r) => r.id));
  return {
    urlChanged: prev.url !== next.url,
    added,
    removed,
    changed,
    newRegions: [...nextRegions].filter((id) => !prevRegions.has(id)),
    goneRegions: [...prevRegions].filter((id) => !nextRegions.has(id)),
    focusChanged: prev.focusedRef !== next.focusedRef,
  };
}

export function diffIsEmpty(d: PageDiff): boolean {
  return !d.urlChanged && !d.added.length && !d.removed.length && !d.changed.length && !d.newRegions.length && !d.goneRegions.length;
}
