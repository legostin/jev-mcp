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

/**
 * `items`: the first node of each record. `members` (only for records made of several sibling rows): all nodes of
 * each record, in order.
 */
export interface RepeatedGroup { parent: number; items: number[]; members?: number[][] }

/**
 * Records spread over several sibling rows (a table where each entry is a title row, a details row and a spacer):
 * the repeated buckets interleave one per record. Returns each record's nodes, or null when they do not interleave.
 */
function interleaved(kids: number[], buckets: number[][]): number[][] | null {
  const pos = new Map(kids.map((k, i) => [k, i]));
  const ordered = [...buckets].sort((a, b) => pos.get(a[0])! - pos.get(b[0])!);
  const lead = ordered[0];
  const starts = lead.map((n) => pos.get(n)!);
  const records = starts.map((st, i) => kids.slice(st, i + 1 < starts.length ? starts[i + 1] : kids.length));
  // The rows after the last record's own rows belong to the page, not the record: cut at the record's usual length.
  const usual = Math.max(...records.slice(0, -1).map((r) => r.length), 1);
  records[records.length - 1] = records[records.length - 1].slice(0, usual);
  for (const other of ordered.slice(1)) {
    const set = new Set(other);
    const per = records.map((r) => r.filter((n) => set.has(n)).length);
    if (per.some((c) => c > 1) || per.filter((c) => c === 1).length < records.length * 0.6) return null;
  }
  return records;
}

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
    const found: number[][] = [];
    for (const items of buckets.values()) {
      if (items.length < 3) continue;
      const rich = items.filter((c) => leafTextCount(raw, info, c) >= 2);
      if (rich.length < 3 || rich.length < items.length * 0.6) continue;
      found.push(items);
    }
    if (found.length === 1) groups.push({ parent: n.idx, items: found[0] });
    else if (found.length > 1) {
      // Several kinds of repeated rows under one parent: one record per interleaved run, else the richest kind.
      const records = interleaved(kids, found);
      if (records) groups.push({ parent: n.idx, items: records.map((r) => r[0]), members: records });
      else {
        const text = (items: number[]) => items.reduce((t, c) => t + leafTextCount(raw, info, c), 0);
        groups.push({ parent: n.idx, items: [...found].sort((a, b) => text(b) - text(a))[0] });
      }
    }
  }
  // Keep outermost groups: drop a group whose parent lies inside an item of another group.
  return groups.filter((g) => !groups.some((o) => o !== g && (o.members?.flat() ?? o.items).some((it) =>
    info[it].tin <= info[g.parent].tin && info[g.parent].tout <= info[it].tout)));
}
