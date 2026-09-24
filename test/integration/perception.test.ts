import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, nodeId, sleep, type Harness } from './harness.ts';
import { observePage } from '../../src/core/perception/model.ts';
import { diffModels } from '../../src/core/perception/diff.ts';
import { renderOverview, describeElement } from '../../src/core/perception/render.ts';
import { parseCalendarCells } from '../../src/core/perception/calendar.ts';
import { estimateTokens } from '../../src/core/util/tokens.ts';
import type { PageModel } from '../../src/core/perception/types.ts';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

const find = (m: PageModel, pred: (e: any) => boolean) => [...m.elements.values()].find(pred);

describe('perception', () => {
  it('names controls from every source', async () => {
    const page = await h.open('labels.html');
    const m = await observePage(page);
    const byId = (id: string) => find(m, (e) => e.attrs.id === id)!;
    expect(byId('a1')).toMatchObject({ name: 'Full name', nameSource: 'label' });
    expect(byId('a2')).toMatchObject({ name: 'Company', nameSource: 'label' });
    expect(byId('a3')).toMatchObject({ name: 'Promo code', nameSource: 'aria' });
    expect(byId('a4')).toMatchObject({ name: 'Phone number', nameSource: 'aria' });
    expect(byId('a5')).toMatchObject({ name: 'Search products', nameSource: 'placeholder' });
    expect(byId('a6')).toMatchObject({ name: 'Postal code', nameSource: 'title' });
    expect(byId('a7')).toMatchObject({ name: 'Nickname', nameSource: 'nearby' });
    expect(byId('a8')).toMatchObject({ name: 'Delivery notes', nameSource: 'nearby' });
    expect(byId('b2')).toMatchObject({ kind: 'button', name: 'Close dialog' });
    expect(byId('b4')).toMatchObject({ kind: 'clickable', name: 'Open menu' });
    expect(byId('b3')).toMatchObject({ kind: 'clickable', name: 'Load more' });
    expect(byId('s1')).toMatchObject({ kind: 'select', value: 'Turkey' });
    // Hidden content never enters the model.
    expect(find(m, (e) => /Ignore previous/.test(e.name))).toBeUndefined();
    expect(find(m, (e) => /Hidden decorative/.test(e.name))).toBeUndefined();
  });

  it('keeps a story spread over several table rows together, and hands over each item under its title link', async () => {
    const page = await h.open('news.html');
    const m = await observePage(page);
    const lists = m.regions.filter((r) => r.kind === 'list');
    const table = lists.find((r) => r.items?.length === 5)!;
    const cards = lists.find((r) => r.items?.length === 4)!;
    const { listItems } = await import('../../src/core/extract/handoff.ts');
    const stories = listItems(m, table);
    expect(stories.map((s) => s.url)).toEqual([0, 1, 2, 3, 4].map((i) => expect.stringMatching(new RegExp(`/post/${100 + i}$`))));
    expect(stories[0].text).toMatch(/^Open model tops the robotics leaderboard at half the size \| robots\.example \| 312 points/);
    expect(stories[0].text).not.toMatch(/hide|^1\./);
    // Every card is handed over with its own article, not the section tag it starts with.
    const items = listItems(m, cards);
    expect(items).toHaveLength(4);
    expect(items.map((c) => new URL(c.url!).pathname)).toEqual([0, 1, 2, 3].map((i) => `/2026/09/24/story-${i}/`));
    expect(items.every((c) => !/photo of the product/.test(c.text))).toBe(true);
  });

  it('never shows card numbers or security codes as typed', async () => {
    const page = await h.open('checkout.html?price=41230');
    await page.evaluate("document.getElementById('cc').value = '4242 4242 4242 4242'; document.getElementById('exp').value = '12/29'; document.getElementById('fn').value = 'ANNA'");
    const m = await observePage(page);
    const byId = (id: string) => find(m, (e) => e.attrs.id === id)!;
    expect(byId('cc').value).toBe('•••• 4242');
    expect(byId('exp').value).toBe('••••');
    expect(byId('fn').value).toBe('ANNA');
    expect(renderOverview(m, 3000)).not.toContain('4242 4242');
  });

  it('treats a tooltip on an empty dimmer as a blocking dialog', async () => {
    const page = await h.open('tutorial.html');
    const m = await observePage(page);
    const cheap = find(m, (e) => e.name === 'Cheapest')!;
    expect(cheap.occluded).toBe(true);
    const tip = m.regions.find((r) => r.refs.includes(find(m, (e) => e.attrs.id === 'tip-close')!.ref))!;
    expect(tip).toMatchObject({ kind: 'dialog', blocking: true });
  });

  it('detects a blocking consent overlay and covered controls, then the popup after typing', async () => {
    const page = await h.open('flights.html');
    await sleep(500);
    let m = await observePage(page);
    const overlay = m.regions.find((r) => r.kind === 'overlay')!;
    expect(overlay).toBeTruthy();
    expect(overlay.blocking).toBe(true);
    const origin = find(m, (e) => e.kind === 'textbox' && e.name === 'Откуда')!;
    expect(origin.occluded).toBe(true);
    expect(origin.nameSource).toBe('placeholder');
    const dest = find(m, (e) => e.kind === 'textbox' && e.name === 'Куда')!;
    expect(dest.nameSource).toBe('nearby');
    const form = m.regions.find((r) => r.kind === 'form')!;
    expect(form.refs).toContain(origin.ref);
    expect(m.regions.find((r) => r.kind === 'list' && r.refs.includes(origin.ref))).toBeUndefined();
    const subscribeCity = find(m, (e) => e.name === 'Город')!;
    expect(subscribeCity.context).toMatch(/рассылку/);
    expect(estimateTokens(renderOverview(m, 1500))).toBeLessThanOrEqual(1500);

    await page.click(find(m, (e) => e.name === 'Принять все')!.backendNodeId);
    await page.waitForSettle();
    const before = await observePage(page, m);
    expect(before.regions.find((r) => r.kind === 'overlay')).toBeUndefined();
    const origin2 = before.elements.get(origin.ref)!;
    expect(origin2.name).toBe('Откуда');
    expect(origin2.occluded).toBe(false);

    await page.type(origin2.backendNodeId, 'Алм', { mode: 'keys' });
    await page.waitForSettle();
    m = await observePage(page, before);
    const diff = diffModels(before, m);
    const popupId = diff.newRegions.find((id) => m.regions.find((r) => r.id === id)?.kind === 'popup');
    expect(popupId).toBeTruthy();
    const option = find(m, (e) => e.regionId === popupId && e.kind === 'option')!;
    expect(option.name).toContain('Алматы');
    expect(diff.changed).toContain(origin.ref);
    expect(m.elements.get(origin.ref)!.value).toBe('Алм');
  });

  it('finds the results list, and keeps refs stable when more items load', async () => {
    const page = await h.open('results.html?from=ALA&to=AYT&date=2026-10-14');
    await sleep(300);
    const m1 = await observePage(page);
    const list = m1.regions.find((r) => r.kind === 'list')!;
    expect(list.items).toHaveLength(10);
    for (const item of list.items!) expect(item.length).toBeGreaterThanOrEqual(4);
    const firstItemRefs = list.items![0];
    await page.click(find(m1, (e) => e.name === 'Показать ещё 10 билетов')!.backendNodeId);
    await page.waitForSettle();
    const m2 = await observePage(page, m1);
    const list2 = m2.regions.find((r) => r.kind === 'list')!;
    expect(list2.id).toBe(list.id);
    expect(list2.items).toHaveLength(20);
    expect(list2.items![0]).toEqual(firstItemRefs);
  });

  it('sees inside open shadow roots and cross-origin iframes', async () => {
    const page = await h.open('shadow.html');
    const m = await observePage(page);
    expect(find(m, (e) => e.name === 'Work email')).toMatchObject({ kind: 'textbox' });
    expect(find(m, (e) => e.name === 'Subscribe')).toMatchObject({ kind: 'button' });

    const outer = await h.open('iframe-outer.html');
    for (let i = 0; i < 30 && outer.frames().length < 2; i++) await sleep(100);
    const m2 = await observePage(outer);
    const holder = find(m2, (e) => e.name === 'Cardholder name')!;
    expect(holder.frameSessionId).toBeTruthy();
    expect(holder.rect.x).toBeGreaterThan(8);
    await outer.type(holder.backendNodeId, 'Kim', { sessionId: holder.frameSessionId });
    const btn = find(m2, (e) => e.name === 'Continue')!;
    await outer.click(btn.backendNodeId, { sessionId: btn.frameSessionId });
    expect(await outer.evaluate('document.getElementById("inner-out").textContent', holder.frameSessionId)).toBe('Hello Kim');
  });

  it('parses calendar cells with dates and prices', async () => {
    const page = await h.open('flights.html');
    await sleep(500);
    let m = await observePage(page);
    await page.click(find(m, (e) => e.name === 'Принять все')!.backendNodeId);
    // Pick cities so the calendar shows prices.
    for (const [field, value] of [['Откуда', 'Алм'], ['Куда', 'Анта']] as const) {
      m = await observePage(page, m);
      await page.type(find(m, (e) => e.kind === 'textbox' && e.name === field)!.backendNodeId, value, { mode: 'keys' });
      await page.waitForSettle();
      m = await observePage(page, m);
      await page.click(find(m, (e) => e.kind === 'option')!.backendNodeId);
    }
    m = await observePage(page, m);
    await page.click(find(m, (e) => e.name.startsWith('Когда'))!.backendNodeId);
    await page.waitForSettle();
    m = await observePage(page, m);
    await page.click(find(m, (e) => e.name === 'Следующий месяц')!.backendNodeId);
    await page.waitForSettle();
    m = await observePage(page, m);
    const cells = parseCalendarCells(m, { year: 2026, month: 9 });
    const oct = cells.filter((c) => c.date.startsWith('2026-10'));
    if (oct.length !== 31) console.log(oct.map((c) => `${c.date} ${describeElement(m.elements.get(c.ref)!)}`).join('\n'));
    expect(oct).toHaveLength(31);
    const cheapest = oct.reduce((a, b) => ((a.price ?? 1e12) <= (b.price ?? 1e12) ? a : b));
    expect(cheapest).toMatchObject({ date: '2026-10-14', price: 38900 });
    expect(describeElement(m.elements.get(cheapest.ref)!)).toContain('14 октября 2026');
  });

  it('marks jev-reachable nodes with backend ids that the page session can act on', async () => {
    const page = await h.open('counter.html');
    const m = await observePage(page);
    const inc = find(m, (e) => e.name === 'Increment')!;
    expect(inc.backendNodeId).toBe(await nodeId(page, '#inc'));
  });
});
