import type { ElementNode, PageModel } from '../perception/types.ts';

/** Words that commit money, data or content (ru + en). Matched as whole words, case-insensitive. */
const IRREVERSIBLE_WORDS = [
  'pay', 'pay now', 'buy', 'buy now', 'purchase', 'place order', 'checkout', 'check out', 'confirm order', 'confirm purchase',
  'complete order', 'complete purchase', 'book now', 'reserve', 'subscribe', 'sign up', 'create account', 'delete', 'remove account',
  'close account', 'publish', 'post', 'send', 'transfer', 'donate', 'submit order', 'confirm payment', 'order now',
  'оплатить', 'оплата', 'купить', 'оформить заказ', 'оформить', 'заказать', 'подтвердить заказ', 'подтвердить оплату',
  'подтвердить', 'забронировать', 'подписаться', 'зарегистрироваться', 'удалить', 'опубликовать', 'отправить', 'перевести',
  'пожертвовать',
];
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${IRREVERSIBLE_WORDS.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const URL_RE = /\/(checkout|payment|payments|pay|order|orders|purchase|buy|billing)(\/|\?|$|\.)/i;
const CLICKABLE = new Set(['button', 'link', 'clickable', 'menuitem', 'option']);

export interface RiskAssessment { irreversible: boolean; reasons: string[] }

/**
 * Code-side risk rules. They override JEV: if these say "irreversible", the action is irreversible no matter
 * how confident the model is.
 */
export function deterministicRisk(el: ElementNode, model: PageModel): RiskAssessment {
  const reasons: string[] = [];
  if (!CLICKABLE.has(el.kind)) return { irreversible: false, reasons };
  const label = [el.name, el.text, el.attrs.value, el.attrs['aria-label'], el.attrs.title].filter(Boolean).join(' ');
  const m = label.match(WORD_RE);
  if (m) reasons.push(`label says "${m[1]}"`);
  if (el.href && URL_RE.test(new URL(el.href, model.url).pathname + '/')) {
    // Links into a checkout are navigation; only flag when the label also commits.
    if (m) reasons.push(`links to ${new URL(el.href, model.url).pathname}`);
  }
  if (el.attrs.action && URL_RE.test(el.attrs.action)) reasons.push(`form action ${el.attrs.action}`);
  // A submit control in a region that collects card details.
  const region = model.regions.find((r) => r.id === el.regionId);
  const sameRegion = region ? region.refs.map((r) => model.elements.get(r)).filter(Boolean) as ElementNode[] : [];
  const hasCard = sameRegion.some((e) => (e.attrs.autocomplete ?? '').startsWith('cc-'))
    || [...model.elements.values()].some((e) => (e.attrs.autocomplete ?? '').startsWith('cc-') && e.visible);
  if (hasCard && (el.kind === 'button' || el.attrs.type === 'submit')) reasons.push('page collects card details');
  return { irreversible: reasons.length > 0, reasons };
}

export function domainAllowed(url: string, allowed: string[] | undefined): boolean {
  if (!allowed || !allowed.length) return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return true; }
  if (url.startsWith('about:') || url.startsWith('data:') || url.startsWith('chrome')) return true;
  return allowed.some((d) => {
    const dom = d.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
    const h = host.replace(/^www\./, '');
    return h === dom || h.endsWith(`.${dom}`);
  });
}
