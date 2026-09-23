/**
 * Date parsing for page text. JEV is unreliable with dates, so every date comparison happens in code:
 * JEV only decides which element or field holds a date.
 */

const MONTHS: Array<[RegExp, number]> = [
  [/^(январ[ьяе]?|янв|january|jan)/i, 1],
  [/^(феврал[ьяе]?|фев|february|feb)/i, 2],
  [/^(март[ае]?|мар|march|mar)/i, 3],
  [/^(апрел[ьяе]?|апр|april|apr)/i, 4],
  [/^(ма[йяе]|may)/i, 5],
  [/^(июн[ьяе]?|june|jun)/i, 6],
  [/^(июл[ьяе]?|july|jul)/i, 7],
  [/^(август[ае]?|авг|august|aug)/i, 8],
  [/^(сентябр[ьяе]?|сен|сент|september|sept?)/i, 9],
  [/^(октябр[ьяе]?|окт|october|oct)/i, 10],
  [/^(ноябр[ьяе]?|ноя|november|nov)/i, 11],
  [/^(декабр[ьяе]?|дек|december|dec)/i, 12],
];

export function monthFromWord(word: string): number | null {
  const w = word.trim().replace(/\.$/, '');
  for (const [re, m] of MONTHS) if (re.test(w)) return m;
  return null;
}

export interface DateParts { year?: number; month: number; day: number }

const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function validDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}

/**
 * Extracts a calendar date from text such as "14 октября 2026", "October 14, 2026", "2026-10-14",
 * "14.10.2026", "14 окт". Year falls back to `refYear` (rolling forward when the month already passed
 * relative to `refMonth`).
 */
export function parseDateText(text: string, ref: { year: number; month: number } = defaultRef()): DateParts & { year: number } | null {
  const t = text.replace(/\u00a0/g, ' ').trim();
  let m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? { year: y, month: mo, day: d } : null;
  }
  m = t.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (m) {
    const d = Number(m[1]); const mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : inferYear(mo, ref);
    if (y < 100) y += 2000;
    if (validDay(y, mo, d)) return { year: y, month: mo, day: d };
  }
  // "14 октября 2026", "14 окт", "14 October"
  m = t.match(/\b(\d{1,2})\s+([A-Za-zА-Яа-яЁё]{3,}\.?)(?:\s+(\d{4}))?/);
  if (m) {
    const mo = monthFromWord(m[2]);
    if (mo) {
      const d = Number(m[1]);
      const y = m[3] ? Number(m[3]) : inferYear(mo, ref);
      if (validDay(y, mo, d)) return { year: y, month: mo, day: d };
    }
  }
  // "October 14, 2026", "Oct 14"
  m = t.match(/\b([A-Za-zА-Яа-яЁё]{3,}\.?)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
  if (m) {
    const mo = monthFromWord(m[1]);
    if (mo) {
      const d = Number(m[2]);
      const y = m[3] ? Number(m[3]) : inferYear(mo, ref);
      if (validDay(y, mo, d)) return { year: y, month: mo, day: d };
    }
  }
  return null;
}

/** Parses "Октябрь 2026" / "October 2026" / "2026-10" into year and month. */
export function parseMonthText(text: string): { year: number; month: number } | null {
  const t = text.trim();
  let m = t.match(/\b(\d{4})-(\d{2})\b/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  m = t.match(/([A-Za-zА-Яа-яЁё]{3,})\.?\s+(\d{4})/);
  if (m) {
    const mo = monthFromWord(m[1]);
    if (mo) return { year: Number(m[2]), month: mo };
  }
  return null;
}

function defaultRef(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function inferYear(month: number, ref: { year: number; month: number }): number {
  return month < ref.month - 1 ? ref.year + 1 : ref.year;
}

/** Inclusive range check on ISO dates. */
export function inRange(iso: string, range: { from: string; to: string }): boolean {
  return iso >= range.from && iso <= range.to;
}
