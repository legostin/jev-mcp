import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startHarness, nodeId, sleep, type Harness } from './harness.ts';
import { ActionError } from '../../src/core/cdp/page.ts';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

describe('PageSession', () => {
  it('clicks, types per key, selects and waits for late DOM changes', async () => {
    const page = await h.open('counter.html');
    await page.click(await nodeId(page, '#inc'));
    await page.click(await nodeId(page, '#inc'));
    expect(await page.evaluate('document.getElementById("count").textContent')).toBe('2');

    await page.type(await nodeId(page, '#name'), 'Алматы', { mode: 'keys' });
    expect(await page.evaluate('document.getElementById("name").value')).toBe('Алматы');
    expect(Number(await page.evaluate('document.getElementById("events").textContent'))).toBeGreaterThanOrEqual(6);

    await page.type(await nodeId(page, '#name'), 'Bob', { mode: 'insert' });
    expect(await page.evaluate('document.getElementById("name").value')).toBe('Bob');

    expect(await page.selectOption(await nodeId(page, '#color'), 'green')).toBe('Green');
    expect(await page.evaluate('document.getElementById("color").value')).toBe('green');

    await page.click(await nodeId(page, '#late'));
    const res = await page.waitForSettle({ maxMs: 5000, quietMs: 300 });
    expect(res.settled).toBe(true);
    // The late item is appended after 700ms; settle must not return before it exists.
    await sleep(50);
    expect(await page.evaluate('document.querySelectorAll("#items li").length')).toBe(1);
  });

  it('scrolls far elements into view before clicking', async () => {
    const page = await h.open('counter.html');
    await page.click(await nodeId(page, '#far'));
    expect(await page.evaluate('document.getElementById("far-count").textContent')).toBe('1');
  });

  it('tags elements that registered click listeners', async () => {
    const page = await h.open('labels.html');
    await page.markListeners();
    expect(await page.evaluate('document.getElementById("b4").getAttribute("data-jev-l")')).toBe('1');
    expect(await page.evaluate('document.getElementById("b3").hasAttribute("data-jev-l")')).toBe(false);
  });

  it('reports an occluding overlay instead of clicking through it', async () => {
    const page = await h.open('modal.html');
    const err = await page.click(await nodeId(page, '#shop')).catch((e) => e);
    expect(err).toBeInstanceOf(ActionError);
    expect(err.reason).toBe('occluded');
    await page.click(await nodeId(page, '#close'));
    await page.click(await nodeId(page, '#shop'));
    expect(await page.evaluate('document.getElementById("shopped").textContent')).toBe('Shopping');
  });

  it('drives a cross-origin iframe through its own session', async () => {
    const page = await h.open('iframe-outer.html');
    for (let i = 0; i < 30 && page.frames().length < 2; i++) await sleep(100);
    const frames = page.frames();
    expect(frames.length).toBe(2);
    const child = frames[1];
    await page.waitForSettle({ maxMs: 3000 });
    await page.type(await nodeId(page, '#holder', child.sessionId), 'Ann', { sessionId: child.sessionId });
    await page.click(await nodeId(page, '#inner-btn', child.sessionId), { sessionId: child.sessionId });
    expect(await page.evaluate('document.getElementById("inner-out").textContent', child.sessionId)).toBe('Hello Ann');
  });

  it('detects user input outside jev input windows', async () => {
    const page = await h.open('counter.html');
    const since = Date.now();
    await page.click(await nodeId(page, '#inc'));
    expect(await page.userInputSince(since)).toBe(false);
  });
});
