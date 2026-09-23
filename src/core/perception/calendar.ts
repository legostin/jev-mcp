import { isoDate, parseDateText, parseMonthText } from '../extract/dates.ts';
import type { PageModel } from './types.ts';

export interface CalendarCell { ref: string; date: string; price?: number; disabled: boolean; regionId: string }

function parsePrice(text: string): number | undefined {
  const digits = text.replace(/[^\d]/g, '');
  if (digits.length < 2) return undefined;
  const n = Number(digits);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Finds clickable date cells: elements whose data-date, aria-label or name encodes a full date, or
 * bare day numbers inside a region whose heading names a month ("Октябрь 2026").
 * Prices shown inside cells (low-fare calendars) are parsed from the cell text.
 */
export function parseCalendarCells(model: PageModel, ref: { year: number; month: number } = refNow()): CalendarCell[] {
  const cells: CalendarCell[] = [];
  const monthOfRegion = new Map<string, { year: number; month: number } | null>();
  const regionMonth = (regionId: string) => {
    if (monthOfRegion.has(regionId)) return monthOfRegion.get(regionId)!;
    let found: { year: number; month: number } | null = null;
    for (const e of model.elements.values()) {
      if (e.regionId !== regionId || e.interactive) continue;
      found = parseMonthText(e.name);
      if (found) break;
    }
    monthOfRegion.set(regionId, found);
    return found;
  };
  for (const e of model.elements.values()) {
    if (!e.interactive || !e.visible) continue;
    if (!['button', 'clickable', 'link', 'option'].includes(e.kind) && e.role !== 'gridcell') continue;
    let date: string | null = null;
    const dd = e.attrs['data-date'];
    if (dd && /^\d{4}-\d{2}-\d{2}/.test(dd)) date = dd.slice(0, 10);
    if (!date) {
      const parsed = parseDateText(e.attrs['aria-label'] ?? '', ref) ?? (/[A-Za-zА-Яа-я]/.test(e.name) ? parseDateText(e.name, ref) : null);
      if (parsed) date = isoDate(parsed);
    }
    let dayToken: string | undefined;
    if (!date) {
      const m = (e.text ?? e.name).match(/^\s*(\d{1,2})\b/);
      const month = m ? regionMonth(e.regionId) : null;
      if (m && month) {
        dayToken = m[1];
        const day = Number(m[1]);
        if (day >= 1 && day <= new Date(month.year, month.month, 0).getDate()) date = isoDate({ ...month, day });
      }
    }
    if (!date) continue;
    const day = String(Number(date.slice(8, 10)));
    const rest = (e.text ?? '').replace(new RegExp(`^\\s*${dayToken ?? day}\\b`), '');
    cells.push({ ref: e.ref, date, price: parsePrice(rest), disabled: !!e.states.disabled, regionId: e.regionId });
  }
  // A calendar is a grid of dates: a lone element that mentions a date (a filled date field) is not a cell.
  const perRegion = new Map<string, number>();
  for (const c of cells) perRegion.set(c.regionId, (perRegion.get(c.regionId) ?? 0) + 1);
  return cells.filter((c) => (perRegion.get(c.regionId) ?? 0) >= 7);
}

function refNow(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}
