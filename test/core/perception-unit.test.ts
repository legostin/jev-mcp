import { describe, it, expect } from 'vitest';
import { normalizeId, normalizeName } from '../../src/core/perception/signature.ts';
import { parseDateText, parseMonthText, monthFromWord } from '../../src/core/extract/dates.ts';
import { findNearbyText } from '../../src/core/perception/naming.ts';
import { renderCandidate } from '../../src/core/perception/render.ts';

describe('signature normalization', () => {
  it('strips generated id suffixes and digits', () => {
    expect(normalizeId('dst-9f2c1a')).toBe('dst');
    expect(normalizeId('field_1234')).toBe('field');
    expect(normalizeId('email')).toBe('email');
    expect(normalizeId(undefined)).toBe('');
  });
  it('keeps name shape without volatile numbers', () => {
    expect(normalizeName('Оплатить 41 230 ₸')).toBe(normalizeName('Оплатить 38 900 ₸'));
    expect(normalizeName('Show 10 more')).toBe('show # more');
  });
});

describe('dates', () => {
  const ref = { year: 2026, month: 9 };
  it('parses Russian and English formats', () => {
    expect(parseDateText('14 октября 2026', ref)).toEqual({ year: 2026, month: 10, day: 14 });
    expect(parseDateText('14 окт', ref)).toEqual({ year: 2026, month: 10, day: 14 });
    expect(parseDateText('October 14, 2026', ref)).toEqual({ year: 2026, month: 10, day: 14 });
    expect(parseDateText('2026-10-14', ref)).toEqual({ year: 2026, month: 10, day: 14 });
    expect(parseDateText('14.10.2026', ref)).toEqual({ year: 2026, month: 10, day: 14 });
    expect(parseDateText('3 января', ref)).toEqual({ year: 2027, month: 1, day: 3 });
    expect(parseDateText('31 февраля 2026', ref)).toBeNull();
    expect(parseDateText('1 пассажир', ref)).toBeNull();
  });
  it('parses month headers', () => {
    expect(parseMonthText('Октябрь 2026')).toEqual({ year: 2026, month: 10 });
    expect(parseMonthText('September 2026')).toEqual({ year: 2026, month: 9 });
    expect(monthFromWord('мая')).toBe(5);
  });
});

describe('nearby text', () => {
  it('prefers the label left on the same row, then above', () => {
    const target = { x: 200, y: 100, w: 150, h: 30 };
    const left = { text: 'Nickname', rect: { x: 100, y: 105, w: 80, h: 20 }, idx: 1 };
    const above = { text: 'Other', rect: { x: 200, y: 60, w: 80, h: 20 }, idx: 2 };
    const far = { text: 'Far', rect: { x: 700, y: 105, w: 50, h: 20 }, idx: 3 };
    expect(findNearbyText(target, [far, above, left], () => true)?.text).toBe('Nickname');
    expect(findNearbyText(target, [far, above], () => true)?.text).toBe('Other');
    expect(findNearbyText(target, [far], () => true)).toBeNull();
  });
});

describe('candidate cards', () => {
  it('show the visual row and drop layout noise', () => {
    const mk = (ref: string, name: string, x: number, y = 100) => ({
      ref, sig: ref, kind: 'button', role: 'button', tag: 'button', name, nameSource: 'content', states: {}, interactive: true, visible: true,
      inViewport: true, occluded: false, rect: { x, y, w: 80, h: 40 }, regionId: 'r1', backendNodeId: 1, attrs: { class: 'filter-button' }, order: x,
    }) as any;
    const els = [mk('e1', 'Модель', 0), mk('e2', 'Camry', 100), mk('e3', 'RAV4', 200), mk('e4', 'Цена', 0, 300)];
    const model: any = {
      url: 'http://x/', title: 't', elements: new Map(els.map((e) => [e.ref, e])),
      regions: [{ id: 'r0', kind: 'page', label: '', refs: [] }, { id: 'r1', kind: 'form', label: 'Поиск', parentId: 'r0', refs: els.map((e) => e.ref) }],
    };
    const card = renderCandidate(model, 'e2');
    expect(card).toContain('row: Модель | [Camry] | RAV4');
    expect(card).toContain('in: r1 form "Поиск"');
    expect(card).not.toContain('rect:');
    expect(card).not.toContain('class=');
    expect(card).not.toContain('Цена');
  });
});
