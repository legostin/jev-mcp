import { describe, it, expect } from 'vitest';
import { rollbackPlan, hadEffect } from '../../src/core/runner/rollback.ts';

const el = (states = {}, value?: string, kind = 'button') => ({ ref: 'e1', sig: 's1', kind, states, value, rect: { x: 0, y: 0, w: 10, h: 10 } } as any);
const page = (url: string, els: any[], layers: string[] = []) => ({
  url, elements: new Map(els.map((e) => [e.ref, e])),
  regions: layers.map((s, i) => ({ id: `r${i + 1}`, sig: s, kind: 'popup', refs: [] })),
  signature: `${url}|${JSON.stringify(els.map((e) => [e.states, e.value]))}|${layers.join()}`,
} as any);

describe('trial rollback', () => {
  it('goes back after a navigation', () => {
    expect(rollbackPlan(page('http://a/1', [el()]), page('http://a/2', [el()]), el())).toEqual(['back']);
  });

  it('closes a new layer, restores a value, re-clicks a toggle', () => {
    expect(rollbackPlan(page('u', [el()]), page('u', [el()], ['p1']), el())).toEqual(['escape']);
    expect(rollbackPlan(page('u', [el({}, '', 'textbox')]), page('u', [el({}, 'Camry', 'textbox')]), el({}, '', 'textbox'))).toEqual(['restore']);
    expect(rollbackPlan(page('u', [el({ selected: false })]), page('u', [el({ selected: true })]), el({ selected: false }))).toEqual(['reclick']);
    expect(rollbackPlan(page('u', [el()], ['p1']), page('u', [el()], ['p1']), el())).toEqual([]);
  });

  it('detects whether an action changed anything', () => {
    expect(hadEffect(page('u', [el()]), page('u', [el()]), el())).toBe(false);
    expect(hadEffect(page('u', [el()]), page('u', [el({ selected: true })]), el())).toBe(true);
    expect(hadEffect(page('u', [el()]), page('v', [el()]), el())).toBe(true);
  });
});
