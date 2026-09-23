import type { ElementNode, PageModel } from '../perception/types.ts';

export type RollbackAction = 'back' | 'escape' | 'restore' | 'reclick';

const LAYERS = new Set(['popup', 'overlay', 'dialog']);
const layerSigs = (m: PageModel) => new Set(m.regions.filter((r) => LAYERS.has(r.kind)).map((r) => r.sig));
const toggled = (a: ElementNode, b: ElementNode) => !!a.states.checked !== !!b.states.checked || !!a.states.selected !== !!b.states.selected;

/**
 * Undo steps for a trial that did not work, most disruptive first. Recompute after each one: Escape often undoes
 * a toggle by itself (closing a dropdown collapses its trigger).
 */
export function rollbackPlan(before: PageModel, now: PageModel, el: ElementNode): RollbackAction[] {
  if (now.url !== before.url) return ['back'];
  const plan: RollbackAction[] = [];
  const had = layerSigs(before);
  if ([...layerSigs(now)].some((s) => !had.has(s))) plan.push('escape');
  const cur = now.elements.get(el.ref);
  if (cur && (el.kind === 'textbox' || el.kind === 'combobox') && (cur.value ?? '') !== (el.value ?? '')) plan.push('restore');
  else if (cur && toggled(el, cur)) plan.push('reclick');
  return plan;
}

/** Did the action change anything visible: the URL, the page structure or the element's own state? */
export function hadEffect(before: PageModel, now: PageModel, el: ElementNode): boolean {
  if (now.url !== before.url || now.signature !== before.signature) return true;
  const cur = now.elements.get(el.ref);
  return !!cur && (toggled(el, cur) || (cur.value ?? '') !== (el.value ?? '') || !!cur.states.expanded !== !!el.states.expanded);
}
