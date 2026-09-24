/**
 * Injected into every frame before page scripts run. It records:
 * - elements that register click-like listeners (so clickable <div>s can be found),
 * - the time of the last DOM mutation (for settle detection),
 * - the time of the last trusted user input (for takeover detection).
 * It never mutates the DOM on its own; `markListeners()` is called right before a snapshot.
 */
export const INIT_SCRIPT = String.raw`(() => {
  if (window.__jev) return;
  const CLICK_TYPES = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']);
  const refs = [];
  const J = { lastMutation: Date.now(), lastUserInput: 0, refs };
  Object.defineProperty(window, '__jev', { value: J, enumerable: false });
  const origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    try {
      if (CLICK_TYPES.has(type) && this instanceof Element && this !== document.documentElement && this !== document.body) {
        refs.push(new WeakRef(this));
      }
    } catch (e) {}
    return origAdd.call(this, type, listener, opts);
  };
  for (const prop of ['onclick', 'onmousedown', 'onpointerdown']) {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
    if (!desc || !desc.set) continue;
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true, enumerable: desc.enumerable, get: desc.get,
      set(v) { try { if (v) refs.push(new WeakRef(this)); } catch (e) {} return desc.set.call(this, v); },
    });
  }
  J.markListeners = () => {
    let n = 0;
    for (let i = refs.length - 1; i >= 0; i--) {
      const el = refs[i].deref();
      if (!el || !el.isConnected) { refs.splice(i, 1); continue; }
      if (!el.hasAttribute('data-jev-l')) { el.setAttribute('data-jev-l', '1'); n++; }
    }
    return n;
  };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && (r.attributeName === 'data-jev-l' || r.attributeName === 'data-jev-hl')) continue;
      J.lastMutation = Date.now();
      return;
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // Short timers scheduled right after an input are usually reactions to it (debounce, delayed render):
  // settle detection waits for them. Timers scheduled later (polling, analytics) are ignored.
  J.pendingUntil = 0;
  const origSetTimeout = window.setTimeout;
  window.setTimeout = function (fn, delay, ...rest) {
    try {
      const d = Number(delay) || 0;
      if (d >= 20 && d <= 2500 && Date.now() - J.lastUserInput < 1500) J.pendingUntil = Math.max(J.pendingUntil, Date.now() + d);
    } catch (e) {}
    return origSetTimeout.call(this, fn, delay, ...rest);
  };
  // A person clicking or typing takes over; scrolling to watch the task does not.
  const onInput = (e) => {
    if (!e.isTrusted) return;
    J.lastUserInput = Date.now();
    J.lastInputKind = e.type;
    J.lastInputX = e.clientX;
    J.lastInputY = e.clientY;
  };
  for (const t of ['pointerdown', 'keydown']) window.addEventListener(t, onInput, true);
})();`;
