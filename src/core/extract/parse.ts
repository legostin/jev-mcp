import { isoDate, parseDateText } from './dates.ts';

export type FieldType = 'string' | 'number' | 'money' | 'datetime' | 'date' | 'time' | 'duration' | 'url' | 'boolean';

export interface Money { amount: number; currency: string | null }

const CURRENCY: Array<[RegExp, string]> = [
  [/₸|\bKZT\b|тенге|\bтг\b/i, 'KZT'],
  [/₽|\bRUB\b|руб/i, 'RUB'],
  [/€|\bEUR\b|евро/i, 'EUR'],
  [/£|\bGBP\b/i, 'GBP'],
  [/₺|\bTRY\b|лир/i, 'TRY'],
  [/\$|\bUSD\b|долл/i, 'USD'],
  [/¥|\bJPY\b|\bCNY\b/i, 'JPY'],
];

/** Parses "41 230", "1,234.56", "1 234,56", "1.234.567" into a number. */
export function parseNumber(text: string): number | null {
  const m = text.replace(/[\u00a0\u2009\u202f]/g, ' ').match(/-?\d[\d\s.,']*/);
  if (!m) return null;
  let s = m[0].trim().replace(/[\s']/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const decimals = s.length - lastComma - 1;
    s = decimals === 2 && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.split(',').join('');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) s = parts.join('');
  }
  s = s.replace(/[.,]$/, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function detectCurrency(text: string): string | null {
  for (const [re, code] of CURRENCY) if (re.test(text)) return code;
  return null;
}

export function parseMoney(text: string): Money | null {
  const amount = parseNumber(text);
  if (amount === null) return null;
  let currency: string | null = null;
  for (const [re, code] of CURRENCY) if (re.test(text)) { currency = code; break; }
  return { amount, currency };
}

/** "5ч 20м", "6 ч 25 мин", "5h 20m", "1h", "45 min" -> minutes. */
export function parseDuration(text: string): number | null {
  const t = text.toLowerCase();
  const h = t.match(/(\d+)\s*(?:hours|hour|hrs|hr|час[а-я]*|ч|h)(?![a-zа-я])/);
  const m = t.match(/(\d+)\s*(?:minutes|minute|mins|min|мин[а-я]*|м|m)(?![a-zа-я])/);
  const d = t.match(/(\d+)\s*(?:days|day|дн[а-я]*|д|d)(?![a-zа-я])/);
  if (!h && !m && !d) return null;
  return (d ? Number(d[1]) * 1440 : 0) + (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

export function parseTime(text: string): string | null {
  const m = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

export function parseDateTime(text: string, ref?: { year: number; month: number }): string | null {
  const d = parseDateText(text, ref);
  const time = parseTime(text);
  if (d && time) return `${isoDate(d)}T${time}`;
  if (d) return isoDate(d);
  return time;
}

export function absUrl(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try { return new URL(href, base).href; } catch { return null; }
}

export function parseBoolean(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (/^(yes|true|да|есть|✓|✔)/.test(t)) return true;
  if (/^(no|false|нет|—|-)$/.test(t)) return false;
  return t ? true : null;
}

export function parseField(type: FieldType, raw: string, base: string, ref?: { year: number; month: number }): unknown {
  const text = raw.replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, '');
  switch (type) {
    case 'number': return parseNumber(text);
    case 'money': return parseMoney(text);
    case 'datetime': return parseDateTime(text, ref);
    case 'date': { const d = parseDateText(text, ref); return d ? isoDate(d) : null; }
    case 'time': return parseTime(text);
    case 'duration': return parseDuration(text);
    case 'url': return absUrl(text, base);
    case 'boolean': return parseBoolean(text);
    default: return text.trim() || null;
  }
}

/** Sortable number for select rules (money uses its amount). */
export function numericValue(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'amount' in v) return (v as Money).amount;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return Date.parse(v);
  if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) return Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  return null;
}
