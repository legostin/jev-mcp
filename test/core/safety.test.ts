import { describe, it, expect } from 'vitest';
import { deterministicRisk, domainAllowed } from '../../src/core/safety/rules.ts';
import { maskSecrets, secretValues } from '../../src/core/safety/secrets.ts';
import type { ElementNode, PageModel } from '../../src/core/perception/types.ts';

function el(name: string, extra: Partial<ElementNode> = {}): ElementNode {
  return {
    ref: 'e1', sig: 's', kind: 'button', role: '', tag: 'button', name, nameSource: 'content', states: {}, interactive: true,
    visible: true, inViewport: true, occluded: false, rect: { x: 0, y: 0, w: 1, h: 1 }, regionId: 'r1', backendNodeId: 1, attrs: {}, order: 1, ...extra,
  };
}
const model = (els: ElementNode[]): PageModel => ({
  url: 'https://shop.example/cart', title: '', lang: '', viewport: { w: 1, h: 1 }, scroll: { y: 0, maxY: 0 },
  elements: new Map(els.map((e) => [e.ref, e])),
  regions: [{ id: 'r1', sig: '', kind: 'form', label: '', refs: els.map((e) => e.ref), rect: { x: 0, y: 0, w: 1, h: 1 }, blocking: false }],
  signature: '', capturedAt: 0, captureMs: 0,
});

describe('deterministic risk', () => {
  it('flags payment and destructive controls in Russian and English', () => {
    for (const name of ['Оплатить 41 230 ₸', 'Купить', 'Place order', 'Delete account', 'Подтвердить заказ', 'Subscribe']) {
      const e = el(name);
      expect(deterministicRisk(e, model([e])).irreversible, name).toBe(true);
    }
  });
  it('leaves search and navigation alone', () => {
    for (const name of ['Найти билеты', 'Search', 'Показать ещё 10 билетов', 'Выбрать', 'Next month', 'Postpone']) {
      const e = el(name);
      expect(deterministicRisk(e, model([e])).irreversible, name).toBe(false);
    }
  });
  it('flags a submit on a page that collects card details', () => {
    const card = el('Card number', { ref: 'e2', kind: 'textbox', attrs: { autocomplete: 'cc-number' } });
    const go = el('Continue');
    expect(deterministicRisk(go, model([card, go]))).toMatchObject({ irreversible: true, reasons: ['page collects card details'] });
  });
  it('does not flag text inputs', () => {
    const e = el('Delete reason', { kind: 'textbox' });
    expect(deterministicRisk(e, model([e])).irreversible).toBe(false);
  });
});

describe('secrets and domains', () => {
  it('masks nested secret values', () => {
    const secrets = secretValues({ pw: { value: 'hunter22', secret: true }, city: { value: 'Almaty' } });
    expect(maskSecrets({ a: ['typed hunter22 into e3'], b: { c: 'hunter22' }, d: 'Almaty' }, secrets))
      .toEqual({ a: ['typed [secret] into e3'], b: { c: '[secret]' }, d: 'Almaty' });
  });
  it('matches allowed domains including subdomains', () => {
    expect(domainAllowed('https://www.aviasales.kz/search', ['aviasales.kz'])).toBe(true);
    expect(domainAllowed('https://pay.aviasales.kz/', ['aviasales.kz'])).toBe(true);
    expect(domainAllowed('https://evil.example/', ['aviasales.kz'])).toBe(false);
    expect(domainAllowed('https://evil.example/', [])).toBe(true);
  });
});
