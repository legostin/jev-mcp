import type { DaemonContext } from './api.ts';

/** Draws labelled boxes over elements in the live page (fixed-position overlay, removed on the next call). */
export async function highlight(ctx: DaemonContext, tabId: string, refs: string[]): Promise<void> {
  const tab = ctx.browsers.get(tabId);
  const page = await ctx.browsers.page(tabId);
  const model = tab.model ?? await ctx.browsers.observe(tabId);
  const boxes = refs.map((r) => model.elements.get(r)).filter(Boolean).map((e) => ({ ref: e!.ref, x: e!.rect.x, y: e!.rect.y, w: e!.rect.w, h: e!.rect.h }));
  const script = `(() => {
    for (const n of document.querySelectorAll('[data-jev-hl]')) n.remove();
    const boxes = ${JSON.stringify(boxes)};
    for (const b of boxes) {
      const d = document.createElement('div');
      d.setAttribute('data-jev-hl', '1');
      d.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #0a84ff;border-radius:4px;background:rgba(10,132,255,.08);'
        + 'left:' + b.x + 'px;top:' + b.y + 'px;width:' + b.w + 'px;height:' + b.h + 'px';
      const l = document.createElement('span');
      l.textContent = b.ref;
      l.style.cssText = 'position:absolute;top:-18px;left:0;font:11px/16px system-ui;background:#0a84ff;color:#fff;padding:0 4px;border-radius:3px';
      d.appendChild(l);
      document.documentElement.appendChild(d);
    }
  })()`;
  await page.evaluate(script);
}
