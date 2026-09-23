import type { CdpConnection } from './connection.ts';
import type { BrowserDriver } from './driver.ts';
import { INIT_SCRIPT } from './init-script.ts';
import { keyDef, MODIFIERS } from './input.ts';
import { Emitter } from '../util/events.ts';
import { logger } from '../util/log.ts';

const log = logger('page');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A frame that the perception engine snapshots separately (the main frame or an out-of-process iframe). */
export interface FrameInfo {
  /** CDP session for this frame; undefined means the page session itself. */
  sessionId?: string;
  frameId: string;
  url: string;
  isMain: boolean;
  parentSessionId?: string;
}

export interface Point { x: number; y: number }

export class ActionError extends Error {
  readonly reason: 'occluded' | 'not_visible' | 'detached' | 'not_found' | 'unsupported' | 'failed';
  readonly detail?: string;
  constructor(reason: ActionError['reason'], message: string, detail?: string) {
    super(message);
    this.name = 'ActionError';
    this.reason = reason;
    this.detail = detail;
  }
}

type PageEvents = {
  navigated: { url: string };
  closed: { reason: string };
  dialog: { type: string; message: string; accepted: boolean };
  popup: { targetId: string; url: string };
  load: { at: number };
};

interface ChildFrame { sessionId: string; targetId: string; url: string; parentSessionId?: string }

const IGNORED_RESOURCE_TYPES = new Set(['WebSocket', 'EventSource', 'Ping', 'Media', 'Manifest', 'CSPViolationReport']);
const LONG_REQUEST_MS = 5000;

/**
 * Everything jev does to one tab goes through a PageSession: frame tracking, settle detection,
 * snapshots (via the perception engine) and trusted input dispatched through CDP.
 */
export class PageSession extends Emitter<PageEvents> {
  readonly tabId: string;
  readonly driver: BrowserDriver;
  readonly conn: CdpConnection;
  /** Session id of the page target (undefined when the connection is already scoped to the page). */
  readonly sessionId: string | undefined;
  private mainFrameId = '';
  private children = new Map<string, ChildFrame>();
  private inflight = new Map<string, { started: number; type: string }>();
  private lastNetworkActivity = Date.now();
  private inputWindows: { from: number; to: number }[] = [];
  private offListeners: (() => void)[] = [];
  private closedReason: string | null = null;

  private constructor(driver: BrowserDriver, tabId: string, conn: CdpConnection, sessionId: string | undefined) {
    super();
    this.driver = driver;
    this.tabId = tabId;
    this.conn = conn;
    this.sessionId = sessionId;
  }

  static async open(driver: BrowserDriver, tabId: string): Promise<PageSession> {
    const { conn, sessionId } = await driver.attach(tabId);
    const page = new PageSession(driver, tabId, conn, sessionId);
    page.listen();
    await page.initSession(sessionId, true);
    const { frameTree } = await conn.send<{ frameTree: { frame: { id: string; url: string } } }>('Page.getFrameTree', {}, sessionId);
    page.mainFrameId = frameTree.frame.id;
    return page;
  }

  get closed(): boolean { return this.closedReason !== null || this.conn.closed; }

  private owns(sessionId: string | undefined): boolean {
    return sessionId === this.sessionId || (sessionId !== undefined && this.children.has(sessionId));
  }

  private listen(): void {
    this.offListeners.push(this.conn.on((method, params, sessionId) => {
      if (!this.owns(sessionId)) {
        // Child targets auto-attached under one of our sessions announce themselves on the parent session.
        return;
      }
      switch (method) {
        case 'Network.requestWillBeSent':
          if (!IGNORED_RESOURCE_TYPES.has(params.type)) this.inflight.set(`${sessionId}:${params.requestId}`, { started: Date.now(), type: params.type });
          this.lastNetworkActivity = Date.now();
          break;
        case 'Network.loadingFinished':
        case 'Network.loadingFailed':
          this.inflight.delete(`${sessionId}:${params.requestId}`);
          this.lastNetworkActivity = Date.now();
          break;
        case 'Page.frameNavigated':
          if (sessionId === this.sessionId && !params.frame.parentId) {
            this.mainFrameId = params.frame.id;
            this.inflight.clear();
            this.emit('navigated', { url: params.frame.url });
          }
          break;
        case 'Page.loadEventFired':
          if (sessionId === this.sessionId) this.emit('load', { at: Date.now() });
          break;
        case 'Page.javascriptDialogOpening': {
          // Alerts and beforeunload are accepted; confirm/prompt are dismissed and surfaced to the runner.
          const accept = params.type === 'alert' || params.type === 'beforeunload';
          this.conn.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => {});
          this.emit('dialog', { type: params.type, message: params.message, accepted: accept });
          break;
        }
        case 'Page.windowOpen':
          this.emit('popup', { targetId: '', url: params.url });
          break;
        case 'Target.attachedToTarget':
          if (params.targetInfo?.type === 'iframe') {
            const child: ChildFrame = { sessionId: params.sessionId, targetId: params.targetInfo.targetId, url: params.targetInfo.url, parentSessionId: sessionId };
            this.children.set(params.sessionId, child);
            this.initSession(params.sessionId, false).catch((e) => log.debug('child init failed', e));
          } else if (params.sessionId) {
            // Workers and other targets are not ours to drive.
            this.conn.send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
          }
          break;
        case 'Target.detachedFromTarget':
          if (params.sessionId && this.children.has(params.sessionId)) this.children.delete(params.sessionId);
          break;
        case 'Target.targetInfoChanged':
          for (const c of this.children.values()) if (c.targetId === params.targetInfo?.targetId) c.url = params.targetInfo.url;
          break;
        case 'Inspector.detached':
        case 'Inspector.targetCrashed':
          if (sessionId === this.sessionId) this.markClosed(method === 'Inspector.targetCrashed' ? 'crashed' : 'detached');
          break;
      }
    }));
    this.offListeners.push(this.conn.on((method, params) => {
      if (method === 'Target.detachedFromTarget' && params.sessionId === this.sessionId) this.markClosed('detached');
      if (method === 'Target.targetDestroyed' && params.targetId === this.tabId) this.markClosed('tab closed');
    }));
    this.offListeners.push(this.conn.onClose((reason) => this.markClosed(reason)));
  }

  private markClosed(reason: string): void {
    if (this.closedReason) return;
    this.closedReason = reason;
    this.emit('closed', { reason });
  }

  private async initSession(sessionId: string | undefined, isPage: boolean): Promise<void> {
    const send = (m: string, p: Record<string, unknown> = {}) => this.conn.send(m, p, sessionId);
    await Promise.all([
      send('Page.enable'),
      send('DOM.enable'),
      send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => {}),
      send('Accessibility.enable').catch(() => {}),
    ]);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT, runImmediately: true }).catch(() => {});
    await send('Runtime.evaluate', { expression: INIT_SCRIPT, includeCommandLineAPI: false }).catch(() => {});
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    if (isPage) await send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {});
  }

  /** The main frame first, then out-of-process iframes. Same-process iframes are part of the main snapshot. */
  frames(): FrameInfo[] {
    const out: FrameInfo[] = [{ sessionId: this.sessionId, frameId: this.mainFrameId, url: '', isMain: true }];
    for (const c of this.children.values()) {
      out.push({ sessionId: c.sessionId, frameId: c.targetId, url: c.url, isMain: false, parentSessionId: c.parentSessionId });
    }
    return out;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId: string | undefined = this.sessionId): Promise<T> {
    return this.conn.send<T>(method, params, sessionId);
  }

  async evaluate<T = unknown>(expression: string, sessionId: string | undefined = this.sessionId): Promise<T> {
    const res = await this.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  }

  async url(): Promise<string> {
    return (await this.evaluate<string>('location.href').catch(() => '')) || '';
  }

  /** Offset of an out-of-process frame's viewport inside the top-level viewport. */
  async frameOffset(frame: FrameInfo): Promise<Point> {
    if (frame.isMain || !frame.parentSessionId && frame.sessionId === this.sessionId) return { x: 0, y: 0 };
    const parentSession = frame.parentSessionId;
    const parent = this.frames().find((f) => f.sessionId === parentSession) ?? this.frames()[0];
    const parentOffset = await this.frameOffset(parent);
    const owner = await this.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.frameId }, parentSession);
    const { model } = await this.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, parentSession);
    return { x: parentOffset.x + model.content[0], y: parentOffset.y + model.content[1] };
  }

  /**
   * Waits until the DOM has been quiet for `quietMs` and no relevant network request has been in flight
   * for `networkQuietMs`, or until `maxMs` passes.
   */
  async waitForSettle(opts: { maxMs?: number; quietMs?: number; networkQuietMs?: number } = {}): Promise<{ settled: boolean; ms: number }> {
    const maxMs = opts.maxMs ?? 10_000;
    const quietMs = opts.quietMs ?? 300;
    const networkQuietMs = opts.networkQuietMs ?? 500;
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      if (this.closed) return { settled: false, ms: Date.now() - started };
      const probe = await this.evaluate<{ rs: string; age: number; timer: number }>(
        '({ rs: document.readyState, age: window.__jev ? Date.now() - window.__jev.lastMutation : 1e9,' +
        ' timer: window.__jev ? window.__jev.pendingUntil - Date.now() : 0 })',
      ).catch(() => null);
      const now = Date.now();
      let busy = 0;
      for (const [id, r] of this.inflight) {
        if (now - r.started > LONG_REQUEST_MS) { this.inflight.delete(id); continue; }
        busy++;
      }
      const networkQuiet = busy === 0 && now - this.lastNetworkActivity >= networkQuietMs;
      if (probe && probe.rs !== 'loading' && probe.age >= quietMs && probe.timer <= 0 && networkQuiet) {
        return { settled: true, ms: now - started };
      }
      await sleep(100);
    }
    return { settled: false, ms: Date.now() - started };
  }

  private markInput(ms: number): void {
    const now = Date.now();
    this.inputWindows.push({ from: now - 50, to: now + ms + 400 });
    this.inputWindows = this.inputWindows.filter((w) => now - w.to < 120_000);
  }

  /** True when a trusted input event happened in the page after `since` outside jev's own input windows. */
  async userInputSince(since: number): Promise<boolean> {
    const last = await this.evaluate<number>('window.__jev ? window.__jev.lastUserInput : 0').catch(() => 0);
    if (!last || last <= since) return false;
    return !this.inputWindows.some((w) => last >= w.from && last <= w.to);
  }

  /** Ask every frame to tag elements that registered click-like listeners (read by the snapshot). */
  async markListeners(): Promise<void> {
    await Promise.all(this.frames().map((f) =>
      this.evaluate('window.__jev && window.__jev.markListeners ? window.__jev.markListeners() : 0', f.sessionId).catch(() => 0)));
  }

  private async resolve(backendNodeId: number, sessionId: string | undefined): Promise<string> {
    try {
      const { object } = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId }, sessionId);
      return object.objectId;
    } catch {
      throw new ActionError('detached', `Element ${backendNodeId} is no longer in the page`);
    }
  }

  private async callOn<T>(backendNodeId: number, sessionId: string | undefined, fn: string, args: unknown[] = []): Promise<T> {
    const objectId = await this.resolve(backendNodeId, sessionId);
    const res = await this.send<{ result: { value: T }; exceptionDetails?: { text: string } }>('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true,
    }, sessionId);
    if (res.exceptionDetails) throw new ActionError('failed', res.exceptionDetails.text);
    return res.result.value;
  }

  async scrollIntoView(backendNodeId: number, sessionId: string | undefined = this.sessionId): Promise<void> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, sessionId).catch(async () => {
      await this.callOn(backendNodeId, sessionId, 'function(){ this.scrollIntoView({block:"center",inline:"center"}); }');
    });
  }

  /** Finds a point inside the element that actually hits the element (not an overlay), in top-level viewport coordinates. */
  async clickablePoint(backendNodeId: number, sessionId: string | undefined = this.sessionId): Promise<Point> {
    let quads: number[][];
    try {
      ({ quads } = await this.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId }, sessionId));
    } catch {
      throw new ActionError('not_visible', `Element ${backendNodeId} has no layout box (hidden or detached)`);
    }
    const quad = quads.find((q) => Math.abs((q[2] - q[0]) * (q[5] - q[1])) > 1);
    if (!quad) throw new ActionError('not_visible', `Element ${backendNodeId} has zero size`);
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const candidates: Point[] = [{ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }];
    for (const fx of [0.25, 0.5, 0.75]) for (const fy of [0.25, 0.5, 0.75]) {
      if (fx === 0.5 && fy === 0.5) continue;
      candidates.push({ x: minX + (maxX - minX) * fx, y: minY + (maxY - minY) * fy });
    }
    const hits = await this.callOn<{ ok: boolean; by: string }[]>(backendNodeId, sessionId, `function(points){
      const root = this.getRootNode && this.getRootNode().elementFromPoint ? this.getRootNode() : document;
      return points.map(p => {
        const e = root.elementFromPoint(p.x, p.y);
        const ok = !!e && (e === this || this.contains(e) || (e.shadowRoot && e.contains(this)) || (this.labels && [...this.labels].some(l => l === e || l.contains(e))));
        let by = '';
        if (e && !ok) by = (e.tagName || '').toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '') + ' "' + (e.innerText || '').trim().slice(0, 40) + '"';
        return { ok, by };
      });
    }`, [candidates]);
    const idx = hits.findIndex((h) => h.ok);
    const frame = this.frames().find((f) => f.sessionId === sessionId) ?? this.frames()[0];
    const offset = await this.frameOffset(frame);
    if (idx === -1) {
      throw new ActionError('occluded', `Element is covered by another element`, hits[0]?.by);
    }
    return { x: candidates[idx].x + offset.x, y: candidates[idx].y + offset.y };
  }

  async click(backendNodeId: number, opts: { sessionId?: string; force?: boolean; clickCount?: number } = {}): Promise<void> {
    const sessionId = opts.sessionId ?? this.sessionId;
    await this.scrollIntoView(backendNodeId, sessionId);
    let point: Point;
    try {
      point = await this.clickablePoint(backendNodeId, sessionId);
    } catch (e) {
      if (!(opts.force && e instanceof ActionError && e.reason === 'occluded')) throw e;
      const { model } = await this.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId }, sessionId);
      const c = model.content;
      const frame = this.frames().find((f) => f.sessionId === sessionId) ?? this.frames()[0];
      const off = await this.frameOffset(frame);
      point = { x: (c[0] + c[4]) / 2 + off.x, y: (c[1] + c[5]) / 2 + off.y };
    }
    await this.mouseClick(point, opts.clickCount ?? 1);
  }

  async mouseClick(point: Point, clickCount = 1): Promise<void> {
    this.markInput(150);
    const base = { x: point.x, y: point.y, button: 'left', clickCount };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
    await sleep(30);
    await this.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
  }

  async hover(backendNodeId: number, sessionId: string | undefined = this.sessionId): Promise<void> {
    await this.scrollIntoView(backendNodeId, sessionId);
    const p = await this.clickablePoint(backendNodeId, sessionId);
    this.markInput(50);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  }

  async focus(backendNodeId: number, sessionId: string | undefined = this.sessionId): Promise<void> {
    await this.send('DOM.focus', { backendNodeId }, sessionId).catch(async () => {
      await this.callOn(backendNodeId, sessionId, 'function(){ this.focus(); }');
    });
  }

  /**
   * Types into a field. `keys` mode sends one key event per character (autocomplete widgets need it);
   * `insert` mode inserts the text in one input event.
   */
  async type(backendNodeId: number, text: string, opts: { mode?: 'insert' | 'keys'; clear?: boolean; sessionId?: string; click?: boolean } = {}): Promise<void> {
    const sessionId = opts.sessionId ?? this.sessionId;
    if (opts.click !== false) {
      await this.click(backendNodeId, { sessionId }).catch(async () => { await this.focus(backendNodeId, sessionId); });
    }
    await this.focus(backendNodeId, sessionId);
    if (opts.clear !== false) {
      const hadValue = await this.callOn<boolean>(backendNodeId, sessionId, `function(){
        const v = 'value' in this ? this.value : this.textContent;
        if (!v) return false;
        if (typeof this.select === 'function') this.select();
        else { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        return true;
      }`);
      if (hadValue) await this.press('Backspace');
    }
    this.markInput(text.length * 40 + 200);
    if ((opts.mode ?? 'insert') === 'insert') {
      await this.send('Input.insertText', { text });
      return;
    }
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      await sleep(25);
    }
  }

  /** Presses a named key ("Enter", "ArrowDown") or a chord ("Control+A", "Meta+A"). */
  async press(combo: string): Promise<void> {
    const parts = combo.split('+');
    const keyName = parts.pop() as string;
    let modifiers = 0;
    for (const m of parts) modifiers |= MODIFIERS[m as keyof typeof MODIFIERS] ?? 0;
    const def = keyDef(keyName);
    this.markInput(100);
    await this.send('Input.dispatchKeyEvent', {
      type: def.text && !modifiers ? 'keyDown' : 'rawKeyDown', key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, text: modifiers ? undefined : def.text, modifiers,
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode, modifiers });
  }

  /** Selects an option of a native <select> by value or visible label (case-insensitive). */
  async selectOption(backendNodeId: number, value: string, sessionId: string | undefined = this.sessionId): Promise<string> {
    this.markInput(100);
    const picked = await this.callOn<string | null>(backendNodeId, sessionId, `function(v){
      if (!(this instanceof HTMLSelectElement)) return null;
      const norm = s => String(s).trim().toLowerCase();
      const opt = [...this.options].find(o => o.value === v) || [...this.options].find(o => norm(o.label) === norm(v))
        || [...this.options].find(o => norm(o.label).includes(norm(v)));
      if (!opt) return null;
      this.value = opt.value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.label;
    }`, [value]);
    if (picked === null) throw new ActionError('not_found', `No option matching "${value}"`);
    return picked;
  }

  async setFiles(backendNodeId: number, files: string[], sessionId: string | undefined = this.sessionId): Promise<void> {
    await this.send('DOM.setFileInputFiles', { files, backendNodeId }, sessionId);
  }

  /** Scrolls with a mouse wheel at the viewport centre (triggers lazy loading like a real user). */
  async scroll(deltaY: number): Promise<void> {
    const { layoutViewport } = await this.send<{ layoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
    this.markInput(300);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: layoutViewport.clientWidth / 2, y: layoutViewport.clientHeight / 2, deltaX: 0, deltaY,
    });
    await sleep(150);
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<void> {
    const loaded = new Promise<void>((resolve) => {
      const off = this.once('load', () => resolve());
      setTimeout(() => { off(); resolve(); }, timeoutMs);
    });
    const res = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (res.errorText) throw new ActionError('failed', `Navigation failed: ${res.errorText}`);
    await loaded;
  }

  async back(): Promise<boolean> {
    const { currentIndex, entries } = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    if (currentIndex <= 0) return false;
    await this.send('Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
    await sleep(300);
    return true;
  }

  async screenshot(clip?: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
    const params: Record<string, unknown> = { format: 'png' };
    if (clip) params.clip = { x: clip.x, y: clip.y, width: Math.max(1, clip.w), height: Math.max(1, clip.h), scale: 1 };
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', params);
    return Buffer.from(data, 'base64');
  }

  async close(): Promise<void> {
    for (const off of this.offListeners) off();
    this.offListeners = [];
    await this.driver.detach(this.tabId).catch(() => {});
  }
}
