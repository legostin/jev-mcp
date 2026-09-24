import { describe, it, expect } from 'vitest';
import { DatabaseSync } from '../../src/core/trace/sqlite.ts';
import { MemoryStore } from '../../src/core/memory/store.ts';
import { buildRoutePick, urlPattern } from '../../src/core/runner/routes.ts';

describe('site routes', () => {
  it('match pages of other items by an address pattern', () => {
    expect(urlPattern('https://cars.example/a/show/228599137')).toBe('cars.example/a/show/:id');
    expect(urlPattern('https://cars.example/cabinet/?tab=limit_pay')).toBe('cars.example/cabinet/?tab=limit_pay');
    expect(urlPattern('https://cars.example/a/success/69722753-4d16-47fb-83bb-a2d1eb257aaa?id=42&view=ads')).toBe('cars.example/a/success/:id?id=:v&view=ads');
    expect(urlPattern('https://shop.example/orders/temp-89557392')).toBe('shop.example/orders/:id');
  });

  it('are saved per goal, offered while they work, and counted', () => {
    const mem = new MemoryStore(new DatabaseSync(':memory:'));
    const steps = [{ url: 'cars.example/', title: 'Home', sig: 's1', name: 'Account', kind: 'button', sub: 'enter' }];
    mem.saveRoute('cars.example', 'Pay for my unpaid ad', [{ do: 'open my ads', done_when: 'my ads are listed' }], steps);
    mem.saveRoute('cars.example', 'Pay for my unpaid ad', null, steps);
    const [r] = mem.routes('cars.example');
    expect(r).toMatchObject({ goal: 'Pay for my unpaid ad', ok: 2, fail: 0, plan: null, steps });
    mem.routeResult(r.id, false);
    mem.routeResult(r.id, false);
    mem.routeResult(r.id, false);
    mem.routeResult(r.id, false);
    expect(mem.routes('cars.example')).toEqual([]);
    expect(mem.list().routes).toHaveLength(1);
    mem.remove(r.id);
    expect(mem.list().routes).toHaveLength(0);
  });

  it('asks which route fits the goal, or none', () => {
    const set = buildRoutePick('Pay for my other unpaid ad', [
      { id: 'a', domain: 'x', goal: 'Pay for my unpaid ad', plan: null, steps: [{ url: 'x/', title: '', sig: 's', name: 'Account', kind: 'button', sub: 'enter' }], ok: 1, fail: 0, updatedAt: 0 },
    ], 2000);
    expect(Object.keys((set.questions.route as any).criteria)).toEqual(['r0', 'none']);
    expect(JSON.stringify(set.state)).toContain('Pay for my unpaid ad (steps: \\"Account\\")');
  });
});
