import { describe, it, expect } from 'vitest';
import { compactUrl, itemLine, listItems } from '../../src/core/extract/handoff.ts';

const el = (ref: string, kind: string, text: string, href?: string) => ({ ref, kind, name: text, text, href, visible: true, states: {}, attrs: {} } as any);
const page = (els: any[], items: string[][]) => ({
  url: 'https://shop.example/search?q=x', title: 't', elements: new Map(els.map((e) => [e.ref, e])),
  regions: [{ id: 'r1', kind: 'list', label: '', refs: els.map((e) => e.ref), items }],
} as any);

describe('results handoff', () => {
  it('drops tracking parameters from item links', () => {
    expect(compactUrl('/itm/325222794018?_skw=sony&itmmeta=01M37YEEDQE23N3RM4V8VGNG0P&hash=item4bb8ca0322%3Ag%3AlggAAOSw629ioQoA&utm_source=x', 'https://shop.example/'))
      .toBe('https://shop.example/itm/325222794018?_skw=sony');
    expect(compactUrl('/a/show/123', 'https://cars.example/list')).toBe('https://cars.example/a/show/123');
  });

  it('writes one line per item without repeated titles', () => {
    const m = page([
      el('e1', 'link', 'Sony WH-1000XM5 Headphones Black', '/itm/1?hash=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      el('e2', 'text', 'Sony WH-1000XM5 Headphones Black Opens in a new tab'),
      el('e3', 'text', 'US $278.00'),
      el('e4', 'text', 'Brand new'),
    ], [['e1', 'e2', 'e3', 'e4']]);
    expect(itemLine(m, ['e1', 'e2', 'e3', 'e4'])).toEqual({ text: 'Sony WH-1000XM5 Headphones Black Opens in a new tab | US $278.00 | Brand new', url: 'https://shop.example/itm/1' });
  });

  it('stops at the token budget', () => {
    const els = Array.from({ length: 100 }, (_, i) => el(`e${i}`, 'text', `Item number ${i} with a fairly long description of the product and its seller`));
    const items = listItems(page(els, els.map((e) => [e.ref])), { id: 'r1', kind: 'list', label: '', refs: [], items: els.map((e) => [e.ref]) } as any, 300);
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThan(40);
    expect(items[0]).toMatchObject({ i: 0, text: expect.stringContaining('Item number 0') });
  });
});
