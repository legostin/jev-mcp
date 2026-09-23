import { estimateTokens } from '../util/tokens.ts';
import type { ElementNode, PageDiff, PageModel, Region } from './types.ts';

function q(s: string, max = 80): string {
  const t = s.length > max ? s.slice(0, max - 1) + '…' : s;
  return `"${t.replace(/"/g, "'")}"`;
}

function shortHref(href: string, pageUrl: string): string {
  try {
    const u = new URL(href);
    const p = new URL(pageUrl);
    const rel = u.origin === p.origin ? u.pathname + u.search : `${u.host}${u.pathname}`;
    return rel.length > 48 ? rel.slice(0, 47) + '…' : rel;
  } catch { return href.slice(0, 48); }
}

/** One-line element description used everywhere: in JEV state, tool output and escalations. */
export function describeElement(el: ElementNode, opts: { region?: boolean; pageUrl?: string; context?: boolean } = {}): string {
  const parts: string[] = [el.kind];
  if (el.name) parts.push(q(el.name));
  if (el.label) parts.push(`label=${q(el.label, 40)}`);
  if (el.kind === 'textbox' || el.kind === 'combobox' || el.kind === 'select' || el.kind === 'slider') {
    parts.push(`value=${q(el.value ?? '', 60)}`);
  }
  if (el.placeholder && el.placeholder !== el.name) parts.push(`placeholder=${q(el.placeholder, 40)}`);
  if (el.inputType && (el.kind === 'textbox' || el.kind === 'combobox') && !['text', 'textarea'].includes(el.inputType)) parts.push(`type=${el.inputType}`);
  if (el.options?.length) parts.push(`(${el.options.length} options)`);
  if (el.text && el.text !== el.name && el.kind !== 'text' && el.kind !== 'heading' && el.text.length <= 80) parts.push(`text=${q(el.text, 60)}`);
  if (el.href && opts.pageUrl) parts.push(`→${shortHref(el.href, opts.pageUrl)}`);
  const flags: string[] = [];
  const s = el.states;
  if (s.disabled) flags.push('disabled');
  if (s.checked === true) flags.push('checked');
  if (s.checked === false && (el.kind === 'checkbox' || el.kind === 'radio')) flags.push('unchecked');
  if (s.expanded === true) flags.push('expanded');
  if (s.selected) flags.push('selected');
  if (s.required) flags.push('required');
  if (s.invalid) flags.push('invalid');
  if (s.focused) flags.push('focused');
  if (s.readonly) flags.push('readonly');
  if (!el.visible) flags.push('hidden');
  else if (!el.inViewport) flags.push('offscreen');
  if (el.occluded) flags.push('covered');
  if (flags.length) parts.push(`[${flags.join(',')}]`);
  if (el.hints?.length) parts.push(`<${el.hints.join(',')}>`);
  if (opts.context !== false && el.context) parts.push(`(section ${q(el.context, 40)})`);
  if (opts.region) parts.push(`{${el.regionId}}`);
  return parts.join(' ');
}

function regionHeader(r: Region, model: PageModel): string {
  const els = r.refs.map((ref) => model.elements.get(ref)!).filter(Boolean);
  const controls = els.filter((e) => e.interactive && e.visible).length;
  const bits = [`${r.id} ${r.kind}`];
  if (r.label) bits.push(q(r.label, 60));
  if (r.blocking) bits.push('[BLOCKING]');
  if (r.items) bits.push(`${r.items.length} items`);
  bits.push(`— ${controls} controls`);
  return bits.join(' ');
}

function priority(e: ElementNode): number {
  if (!e.visible) return 4;
  if (e.interactive && e.inViewport && !e.occluded) return 0;
  if (e.interactive && e.inViewport) return 1;
  if (e.interactive) return 2;
  return e.inViewport ? 2.5 : 3;
}

function childRegions(model: PageModel, id: string): Region[] {
  return model.regions.filter((r) => r.parentId === id);
}

/** Region tree with a few sample controls per region; shrinks samples to fit the token budget. */
export function renderOverview(model: PageModel, budgetTokens = 1500): string {
  const head = [
    `Page: ${q(model.title, 100)}`,
    `URL: ${model.url}`,
    `Scroll: ${model.scroll.y}/${model.scroll.maxY}px, viewport ${model.viewport.w}x${model.viewport.h}`,
  ];
  for (const samples of [6, 3, 1, 0]) {
    const lines: string[] = [...head, 'Regions:'];
    const walk = (id: string, depth: number) => {
      for (const r of childRegions(model, id)) {
        const els = r.refs.map((ref) => model.elements.get(ref)!).filter((e) => e && e.visible);
        const picks = els.filter((e) => e.interactive).sort((a, b) => priority(a) - priority(b)).slice(0, samples);
        const sample = picks.length ? `: ${picks.map((e) => `${e.ref} ${e.kind} ${q(e.name || e.value || '', 30)}`).join(', ')}` : '';
        lines.push(`${'  '.repeat(depth)}- ${regionHeader(r, model)}${sample}`);
        walk(r.id, depth + 1);
      }
    };
    const top = model.regions[0];
    const loose = top.refs.map((ref) => model.elements.get(ref)!).filter((e) => e.interactive && e.visible);
    walk('r0', 0);
    if (loose.length) {
      const picks = loose.sort((a, b) => priority(a) - priority(b)).slice(0, samples);
      lines.push(`- r0 page (outside regions) — ${loose.length} controls${picks.length ? `: ${picks.map((e) => `${e.ref} ${e.kind} ${q(e.name || '', 30)}`).join(', ')}` : ''}`);
    }
    const text = lines.join('\n');
    if (estimateTokens(text) <= budgetTokens || samples === 0) return text;
  }
  return head.join('\n');
}

/** All elements of a region (and nested regions), most actionable first when the budget is tight. */
export function renderRegion(model: PageModel, regionId: string, budgetTokens = 3000, opts: { includeText?: boolean } = {}): string {
  const region = model.regions.find((r) => r.id === regionId);
  if (!region) return `Unknown region ${regionId}. Known: ${model.regions.map((r) => r.id).join(', ')}`;
  const ids = new Set<string>([regionId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of model.regions) if (r.parentId && ids.has(r.parentId) && !ids.has(r.id)) { ids.add(r.id); grew = true; }
  }
  const els = [...model.elements.values()].filter((e) => ids.has(e.regionId) && (opts.includeText !== false || e.interactive));
  const sorted = [...els].sort((a, b) => priority(a) - priority(b) || a.order - b.order);
  const header = regionHeader(region, model);
  const chosen = new Set<string>();
  let tokens = estimateTokens(header);
  for (const e of sorted) {
    const line = `${e.ref} ${describeElement(e, { pageUrl: model.url })}`;
    const t = estimateTokens(line);
    if (tokens + t > budgetTokens) break;
    tokens += t;
    chosen.add(e.ref);
  }
  const lines = [header];
  let currentRegion = regionId;
  for (const e of els) {
    if (!chosen.has(e.ref)) continue;
    if (e.regionId !== currentRegion) {
      const r = model.regions.find((x) => x.id === e.regionId)!;
      lines.push(`  ${regionHeader(r, model)}`);
      currentRegion = e.regionId;
    }
    lines.push(`${e.regionId === regionId ? '' : '  '}${e.ref} ${describeElement(e, { pageUrl: model.url })}`);
  }
  const omitted = els.length - chosen.size;
  if (omitted > 0) lines.push(`+${omitted} more elements (raise the budget or narrow with jev_find)`);
  return lines.join('\n');
}

/** Full details of one element and its neighbours. */
export function renderElement(model: PageModel, ref: string): string {
  const e = model.elements.get(ref);
  if (!e) return `Unknown element ${ref}`;
  const region = model.regions.find((r) => r.id === e.regionId);
  const chain: string[] = [];
  for (let r = region; r; r = model.regions.find((x) => x.id === r!.parentId)) chain.push(`${r.id} ${r.kind}${r.label ? ` ${q(r.label, 40)}` : ''}`);
  const siblings = region ? region.refs.filter((x) => x !== ref) : [];
  const idx = region ? region.refs.indexOf(ref) : -1;
  const near = region ? region.refs.slice(Math.max(0, idx - 3), idx + 4).filter((x) => x !== ref) : [];
  const lines = [
    `${e.ref} ${describeElement(e, { pageUrl: model.url, region: true })}`,
    `name source: ${e.nameSource}; tag: ${e.tag}${e.role ? `; role: ${e.role}` : ''}`,
    `rect: x=${Math.round(e.rect.x)} y=${Math.round(e.rect.y)} w=${Math.round(e.rect.w)} h=${Math.round(e.rect.h)}`,
    `regions: ${chain.join(' < ')}`,
  ];
  if (e.text && e.text !== e.name) lines.push(`text: ${q(e.text, 160)}`);
  if (e.href) lines.push(`href: ${e.href}`);
  if (e.occludedBy) lines.push(`covered by: ${e.occludedBy}`);
  if (Object.keys(e.attrs).length) lines.push(`attributes: ${Object.entries(e.attrs).map(([k, v]) => `${k}=${q(v, 50)}`).join(' ')}`);
  if (e.options?.length) lines.push(`options: ${e.options.slice(0, 30).map((o) => `${o.selected ? '*' : ''}${q(o.label, 30)}`).join(', ')}`);
  if (near.length) lines.push('nearby:', ...near.map((r) => `  ${r} ${describeElement(model.elements.get(r)!, { pageUrl: model.url })}`));
  void siblings;
  return lines.join('\n');
}

const bare = (s: string, max = 40): string => (s.length > max ? s.slice(0, max - 1) + '…' : s);

/** Visible elements of the same region whose vertical centre falls inside the element's height, left to right. */
export function rowOf(model: PageModel, ref: string, max = 10): string[] {
  const e = model.elements.get(ref);
  const region = e && model.regions.find((r) => r.id === e.regionId);
  if (!e || !region) return [];
  const cy = e.rect.y + e.rect.h / 2;
  const tol = Math.max(e.rect.h / 2, 8);
  const row = region.refs.map((r) => model.elements.get(r))
    .filter((x): x is ElementNode => !!x && x.visible && !!(x.name || x.text) && Math.abs(x.rect.y + x.rect.h / 2 - cy) <= tol)
    .sort((a, b) => a.rect.x - b.rect.x);
  const i = row.findIndex((x) => x.ref === ref);
  const start = Math.max(0, Math.min(i - Math.floor(max / 2), row.length - max));
  return row.slice(start, start + max).map((x) => {
    const name = bare((x.name || x.text || '').trim());
    return x.ref === ref ? `[${name}]` : name;
  });
}

/**
 * A candidate as JEV sees it on a second look: the element, the regions around it and the row it sits in
 * ("Модель | [Camry] | RAV4" tells a value button from the field it belongs to). No layout or class noise.
 */
export function renderCandidate(model: PageModel, ref: string): string {
  const e = model.elements.get(ref);
  if (!e) return `Unknown element ${ref}`;
  const chain: string[] = [];
  for (let r = model.regions.find((x) => x.id === e.regionId); r && r.kind !== 'page'; r = model.regions.find((x) => x.id === r!.parentId)) {
    chain.push(`${r.id} ${r.kind}${r.label ? ` ${q(r.label, 40)}` : ''}`);
  }
  const lines = [`${e.ref} ${describeElement(e, { pageUrl: model.url })}`];
  if (chain.length) lines.push(`in: ${chain.join(' < ')}`);
  if (e.text && e.text !== e.name) lines.push(`text: ${q(e.text, 160)}`);
  if (e.options?.length) lines.push(`options: ${e.options.slice(0, 20).map((o) => `${o.selected ? '*' : ''}${q(o.label, 30)}`).join(', ')}`);
  const row = rowOf(model, ref);
  if (row.length > 1) lines.push(`row: ${row.join(' | ')}`);
  return lines.join('\n');
}

export function renderDiff(diff: PageDiff, model: PageModel, maxLines = 20): string {
  const lines: string[] = [];
  if (diff.urlChanged) lines.push(`URL changed: ${model.url}`);
  for (const id of diff.newRegions) {
    const r = model.regions.find((x) => x.id === id);
    if (r) lines.push(`New region: ${regionHeader(r, model)}`);
  }
  if (diff.goneRegions.length) lines.push(`Gone regions: ${diff.goneRegions.join(', ')}`);
  const show = (label: string, refs: string[]) => {
    const els = refs.map((r) => model.elements.get(r)).filter((e): e is ElementNode => !!e && (e.interactive || e.kind === 'heading'));
    if (!els.length) return;
    lines.push(`${label} (${els.length}):`);
    for (const e of els.slice(0, maxLines)) lines.push(`  ${e.ref} ${describeElement(e, { pageUrl: model.url, region: true })}`);
    if (els.length > maxLines) lines.push(`  +${els.length - maxLines} more`);
  };
  show('Added', diff.added);
  show('Changed', diff.changed);
  if (diff.removed.length) lines.push(`Removed: ${diff.removed.length} elements`);
  if (!lines.length) lines.push('No visible change');
  return lines.join('\n');
}

/** Map of ref -> one-line description, for JEV state. */
export function elementLines(model: PageModel, refs: string[], opts: { region?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of refs) {
    const e = model.elements.get(r);
    if (e) out[r] = describeElement(e, { pageUrl: model.url, region: opts.region ?? true });
  }
  return out;
}

export function regionLines(model: PageModel, ids?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const subtree = (id: string): string[] => {
    const own = model.regions.find((x) => x.id === id)?.refs ?? [];
    return [...own, ...model.regions.filter((x) => x.parentId === id).flatMap((x) => subtree(x.id))];
  };
  for (const r of model.regions) {
    if (r.id === 'r0' || (ids && !ids.includes(r.id))) continue;
    // Summaries include nested regions: a modal overlay usually wraps a dialog that holds the content.
    const els = subtree(r.id).map((x) => model.elements.get(x)!).filter((e) => e && e.visible);
    const sample = els.filter((e) => e.interactive).slice(0, 5).map((e) => `${e.kind} ${q(e.name || e.value || '', 24)}`);
    const texts = els.filter((e) => !e.interactive).slice(0, 2).map((e) => q(e.name, 40));
    out[r.id] = `${r.kind}${r.label ? ` ${q(r.label, 50)}` : ''}${r.blocking ? ' [BLOCKING]' : ''}${r.items ? ` ${r.items.length} items` : ''}`
      + `; ${sample.length} controls: ${sample.join(', ')}${texts.length ? `; text: ${texts.join(', ')}` : ''}`;
  }
  return out;
}
