import type { RawCapture } from './capture.ts';
import type { NodeInfo } from './elements.ts';

/** Structural fingerprint of a subtree, ignoring text: tag + first class + child shapes, to a limited depth. */
function shape(raw: RawCapture, idx: number, depth: number): string {
  const n = raw.nodes[idx];
  if (n.nodeType !== 1) return '';
  const cls = (n.attrs.class ?? '').split(/\s+/)[0] ?? '';
  if (depth === 0) return `${n.tag}.${cls}`;
  const kids = n.children
    .filter((c) => raw.nodes[c].nodeType === 1)
    .map((c) => shape(raw, c, depth - 1))
    .filter(Boolean);
  return `${n.tag}.${cls}(${kids.join(',')})`;
}

function leafTextCount(raw: RawCapture, info: NodeInfo[], idx: number): number {
  let count = 0;
  const stack = [idx];
  while (stack.length && count < 20) {
    const i = stack.pop()!;
    const n = raw.nodes[i];
    if (n.nodeType === 3 && n.text?.trim() && info[i].visible) count++;
    else if (n.nodeType === 1 && n.style?.display !== 'none') stack.push(...n.children);
  }
  return count;
}

export interface RepeatedGroup { parent: number; items: number[] }

/**
 * Finds lists of repeated items (result cards, product tiles): a parent with at least three element
 * children sharing the same structure, each carrying at least two visible text leaves.
 * Nested groups inside an already-found item are skipped.
 */
export function findRepeatedGroups(raw: RawCapture, info: NodeInfo[]): RepeatedGroup[] {
  const groups: RepeatedGroup[] = [];
  for (const n of raw.nodes) {
    if (n.nodeType !== 1 || !info[n.idx].visible) continue;
    const kids = n.children.filter((c) => raw.nodes[c].nodeType === 1 && raw.nodes[c].rect && raw.nodes[c].rect!.h > 0);
    if (kids.length < 3) continue;
    const buckets = new Map<string, number[]>();
    for (const c of kids) {
      const s = shape(raw, c, 2);
      const b = buckets.get(s);
      if (b) b.push(c); else buckets.set(s, [c]);
    }
    for (const items of buckets.values()) {
      if (items.length < 3) continue;
      const rich = items.filter((c) => leafTextCount(raw, info, c) >= 2);
      if (rich.length < 3 || rich.length < items.length * 0.6) continue;
      groups.push({ parent: n.idx, items });
    }
  }
  // Keep outermost groups: drop a group whose parent lies inside an item of another group.
  return groups.filter((g) => !groups.some((o) => o !== g && o.items.some((it) =>
    info[it].tin <= info[g.parent].tin && info[g.parent].tout <= info[it].tout)));
}
