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

  it('cleans site furniture repeated across items and keeps titles and prices', () => {
    const els: any[] = [];
    const items: string[][] = [];
    const prices = ['US $ 8,98', 'US $ 73,39', 'US $ 248,00', 'US $ 259,99', 'US $ 262,50', 'US $ 270,00'];
    prices.forEach((price, i) => {
      const ids = [`w${i}`, `t${i}`, `l${i}`, `c${i}`, `p${i}`];
      els.push(
        el(`w${i}`, 'button', 'отслеживать'),
        el(`t${i}`, 'text', `Sony WH-1000XM5 model ${i} Image 1 of ${i + 3}`),
        el(`l${i}`, 'link', `Sony WH-1000XM5 model ${i} Открывается в новом окне или вкладке`, `/itm/${i}?itmmeta=01M37YEEDQE23N3RM4V8VGNG0P`),
        el(`c${i}`, 'text', 'Совершенно новый'),
        el(`p${i}`, 'text', price),
      );
      items.push(ids);
    });
    const m = page(els, items);
    const lines = listItems(m, m.regions[0]);
    expect(lines[0]).toEqual({ i: 0, text: 'Sony WH-1000XM5 model 0 | US $ 8,98', url: 'https://shop.example/itm/0' });
    expect(lines.every((l) => !/отслеживать|Открывается|Image|Совершенно/.test(l.text))).toBe(true);
    // Titles stay even when every item has the same one.
    const same = page([el('a0', 'link', 'Toyota Camry', '/a/0'), el('b0', 'text', '650 000 ₸'), el('a1', 'link', 'Toyota Camry', '/a/1'), el('b1', 'text', '700 000 ₸'),
      el('a2', 'link', 'Toyota Camry', '/a/2'), el('b2', 'text', '710 000 ₸'), el('a3', 'link', 'Toyota Camry', '/a/3'), el('b3', 'text', '720 000 ₸'),
      el('a4', 'link', 'Toyota Camry', '/a/4'), el('b4', 'text', '730 000 ₸')], [['a0', 'b0'], ['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3'], ['a4', 'b4']]);
    expect(listItems(same, same.regions[0])[0].text).toBe('Toyota Camry | 650 000 ₸');
    // Long prices share a numeric tail ("# # ₸"): that is data, not furniture.
    const big = page([0, 1, 2, 3, 4].flatMap((i) => [el(`a${i}`, 'link', `Car ${i}`, `/a/${i}`), el(`b${i}`, 'text', i === 0 ? '9 000 ₸' : `1 ${i}50 000 ₸`)]),
      [0, 1, 2, 3, 4].map((i) => [`a${i}`, `b${i}`]));
    expect(listItems(big, big.regions[0]).map((l) => l.text)).toEqual(['Car 0 | 9 000 ₸', 'Car 1 | 1 150 000 ₸', 'Car 2 | 1 250 000 ₸', 'Car 3 | 1 350 000 ₸', 'Car 4 | 1 450 000 ₸']);
  });

  it('drops tag chips before values when a line is too long', () => {
    const tags = ['productivity', 'crawler', 'scraper', 'automation', 'agents', 'python', 'chrome', 'testing', 'mcp', 'ai', 'llm', 'cli'];
    const m = page([el('t', 'link', 'owner/repo', '/owner/repo'), el('d', 'text', 'A long description of the project '.repeat(6)),
      ...tags.map((t, i) => el(`g${i}`, 'link', t, `/topics/${t}`)), el('s', 'text', '31.6k'), el('u', 'text', 'Updated yesterday')], [[]]);
    const text = itemLine(m, ['t', 'd', ...tags.map((_, i) => `g${i}`), 's', 'u']).text;
    expect(text).toContain('31.6k');
    expect(text.length).toBeLessThanOrEqual(260);
  });

  it('stops at the token budget', () => {
    const els = Array.from({ length: 100 }, (_, i) => el(`e${i}`, 'text', `Item number ${i} with a fairly long description of the product and its seller`));
    const items = listItems(page(els, els.map((e) => [e.ref])), { id: 'r1', kind: 'list', label: '', refs: [], items: els.map((e) => [e.ref]) } as any, 300);
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThan(40);
    expect(items[0]).toMatchObject({ i: 0, text: expect.stringContaining('Item number 0') });
  });
});
