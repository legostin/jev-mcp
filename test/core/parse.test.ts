import { describe, it, expect } from 'vitest';
import { parseMoney, parseNumber, parseDuration, parseDateTime, parseTime, numericValue, absUrl } from '../../src/core/extract/parse.ts';

describe('value parsers', () => {
  it.each([
    ['41 230 ₸', 41230, 'KZT'], ['от 45 200 ₸', 45200, 'KZT'], ['₸41,230', 41230, 'KZT'], ['$1,234.56', 1234.56, 'USD'],
    ['1 234,56 €', 1234.56, 'EUR'], ['12 990 руб.', 12990, 'RUB'], ['1.234.567 ₺', 1234567, 'TRY'], ['£9.99', 9.99, 'GBP'],
    ['38 900', 38900, null], ['41 230 ₸', 41230, 'KZT'],
  ])('money %s', (text, amount, currency) => {
    expect(parseMoney(text)).toEqual({ amount, currency });
  });
  it('numbers', () => {
    expect(parseNumber('3 пересадки')).toBe(3);
    expect(parseNumber('rating 4.5')).toBe(4.5);
    expect(parseNumber('no digits')).toBeNull();
  });
  it.each([['6ч 50м в пути', 410], ['5 ч 20 мин', 320], ['5h 20m', 320], ['1h', 60], ['45 min', 45], ['2 часа 5 минут', 125], ['1д 2ч', 1560]])('duration %s', (t, m) => {
    expect(parseDuration(t)).toBe(m);
  });
  it('times and dates', () => {
    expect(parseTime('06:40 — 11:05')).toBe('06:40');
    expect(parseDateTime('14 октября, 06:40', { year: 2026, month: 9 })).toBe('2026-10-14T06:40');
    expect(parseDateTime('Oct 14 2026', { year: 2026, month: 9 })).toBe('2026-10-14');
  });
  it('numeric values for sorting', () => {
    expect(numericValue({ amount: 5, currency: 'KZT' })).toBe(5);
    expect(numericValue('06:40')).toBe(400);
    expect(numericValue('abc')).toBeNull();
    expect(absUrl('/x?a=1', 'http://h/p')).toBe('http://h/x?a=1');
  });
});
