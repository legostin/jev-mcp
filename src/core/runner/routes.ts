import type { Json } from '../jev/types.ts';
import type { ElementNode, PageModel } from '../perception/types.ts';
import type { RouteStep, SiteRoute } from '../memory/store.ts';
import { buildState } from '../questions/state.ts';
import type { QuestionSet } from '../questions/run.ts';
import { cleanText } from '../perception/naming.ts';

const ID_LIKE = /^(\d{3,}|[0-9a-f]{8}-[0-9a-f-]{8,}|[0-9a-f]{16,}|[a-z]+-\d{4,})$/i;

/**
 * A page's address with its ids taken out, so the same page of another item matches: host and path segments,
 * query keys with their word values kept (tabs, views) and number or id values replaced.
 */
export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.split('/').map((seg) => (ID_LIKE.test(seg) ? ':id' : seg)).join('/');
    const query = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${/^[a-z_-]{1,24}$/i.test(v) ? v : ':v'}`).join('&');
    return `${u.host}${path}${query ? `?${query}` : ''}`;
  } catch { return url; }
}

export function routeStep(model: PageModel, el: ElementNode, sub: string): RouteStep {
  return { url: urlPattern(model.url), title: model.title, sig: el.sig, name: cleanText(el.name || el.text || '', 60), kind: el.kind, sub };
}

/** One choice: which saved route (by the goal it was made for) fits this goal, or none. */
export function buildRoutePick(goal: string, routes: SiteRoute[], budgetTokens: number): QuestionSet {
  const listed: Record<string, Json> = {};
  const criteria: Record<string, Json | null> = {};
  routes.forEach((r, i) => {
    listed[`r${i}`] = `${r.goal} (steps: ${r.steps.map((st) => `"${st.name}"`).join(' → ')})`;
    criteria[`r${i}`] = null;
  });
  criteria.none = 'None of `routes` was made for this kind of task.';
  return {
    template: 'route.pick',
    state: buildState({ goal, extra: { routes: listed } }, budgetTokens),
    questions: { route: { type: 'choice', instructions: 'Which route in `routes` was made for the same kind of task as `goal`, so that its steps lead there too?', criteria } },
  };
}

/** The element a route step names on this page: by signature, else by kind and name (a site may re-render). */
export function routeElement(model: PageModel, steps: RouteStep[], skip: (sig: string) => boolean, inRegions?: Set<string>): ElementNode | undefined {
  const pattern = urlPattern(model.url);
  const els = [...model.elements.values()].filter((e) => e.visible && !e.occluded && !e.states.disabled && (!inRegions || inRegions.has(e.regionId)));
  for (const st of steps) {
    if (st.url !== pattern || skip(st.sig)) continue;
    const el = els.find((e) => e.sig === st.sig) ?? els.find((e) => e.kind === st.kind && cleanText(e.name || e.text || '', 60) === st.name);
    if (el && !skip(el.sig)) return el;
  }
  return undefined;
}
