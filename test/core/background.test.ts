import { describe, it, expect, vi } from 'vitest';
import { ExtensionBridge } from '../../src/daemon/ext-bridge.ts';
import { CdpDispatcher, type CdpConnection } from '../../src/core/cdp/connection.ts';
import type { BrowserDriver } from '../../src/core/cdp/driver.ts';
import { PageSession } from '../../src/core/cdp/page.ts';

function fixture(background: boolean) {
  const bridge = new ExtensionBridge(() => [], () => background);
  const call = vi.spyOn(bridge, 'call').mockImplementation(async (method) =>
    method === 'openTab' ? { tabId: 17, url: 'about:blank', title: '', active: !background } : {});
  return { bridge, call };
}

/** A page behind a driver in or out of background mode; commands are recorded and `fail` makes chosen ones reject. */
function fakePage(background: () => boolean, fail: (method: string) => boolean = () => false) {
  const d = new CdpDispatcher();
  const sent: { method: string; params: any; sessionId?: string }[] = [];
  const conn: CdpConnection = {
    get closed() { return d.closed; },
    send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId });
      if (fail(method)) throw new Error(`${method} failed`);
      return (method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'f1', url: 'about:blank' } } } : {}) as any;
    },
    on: (l) => d.on(l),
    onClose: (l) => d.onClose(l),
    close: async () => d.shutdown('closed'),
  };
  const driver = { kind: 'extension', get background() { return background(); }, attach: async () => ({ conn }) } as unknown as BrowserDriver;
  const focus = () => sent.filter((s) => s.method === 'Emulation.setFocusEmulationEnabled').map((s) => ({ enabled: s.params.enabled, sessionId: s.sessionId }));
  return { d, driver, focus };
}

describe('extension background mode', () => {
  it('opens inactive tabs and suppresses window activation', async () => {
    const { bridge, call } = fixture(true);
    await bridge.driver.openTab('about:blank');
    await bridge.driver.activateTab('17');
    expect(call).toHaveBeenCalledWith('openTab', { url: 'about:blank', active: false });
    expect(call.mock.calls.some(([method]) => method === 'activateTab')).toBe(false);
  });
  it('still shows a tab to the person when asked to', async () => {
    const { bridge, call } = fixture(true);
    await bridge.driver.activateTab('17', { show: true });
    expect(call).toHaveBeenCalledWith('activateTab', { tabId: 17 });
  });
  it('preserves foreground behaviour when background mode is disabled', async () => {
    const { bridge, call } = fixture(false);
    await bridge.driver.openTab();
    await bridge.driver.activateTab('17');
    await bridge.driver.attach('17');
    expect(call).toHaveBeenCalledWith('openTab', { url: undefined, active: true });
    expect(call).toHaveBeenCalledWith('activateTab', { tabId: 17 });
    expect(call.mock.calls.some(([method]) => method === 'send')).toBe(false);
  });
  it('reads the setting on every call, so toggling it needs no restart for new tabs', async () => {
    let background = false;
    const bridge = new ExtensionBridge(() => [], () => background);
    const call = vi.spyOn(bridge, 'call').mockResolvedValue({ tabId: 17, url: 'about:blank', title: '' });
    await bridge.driver.openTab();
    expect(bridge.driver.background).toBe(false);
    background = true;
    await bridge.driver.openTab();
    await bridge.driver.activateTab('17');
    expect(bridge.driver.background).toBe(true);
    expect(call.mock.calls.filter(([method]) => method === 'openTab').map(([, params]) => (params as any).active)).toEqual([true, false]);
    expect(call.mock.calls.some(([method]) => method === 'activateTab')).toBe(false);
  });
});

describe('focus emulation in background mode', () => {
  it('is turned on for the page and for cross-origin iframes', async () => {
    const { d, driver, focus } = fakePage(() => true);
    await PageSession.open(driver, '17');
    d.handleMessage({ method: 'Target.attachedToTarget', params: { sessionId: 'c1', targetInfo: { type: 'iframe', targetId: 'i1', url: 'https://pay.example/' } } });
    await vi.waitFor(() => expect(focus()).toEqual([{ enabled: true, sessionId: undefined }, { enabled: true, sessionId: 'c1' }]));
  });
  it('is not sent outside background mode', async () => {
    const { driver, focus } = fakePage(() => false);
    await PageSession.open(driver, '17');
    expect(focus()).toEqual([]);
  });
  it('does not stop the page from working when the browser rejects it', async () => {
    const { driver, focus } = fakePage(() => true, (m) => m === 'Emulation.setFocusEmulationEnabled');
    const page = await PageSession.open(driver, '17');
    expect(page.closed).toBe(false);
    expect(focus()).toEqual([{ enabled: true, sessionId: undefined }]);
  });
  it('follows the setting on pages that are already open', async () => {
    let background = false;
    const { d, driver, focus } = fakePage(() => background);
    const page = await PageSession.open(driver, '17');
    d.handleMessage({ method: 'Target.attachedToTarget', params: { sessionId: 'c1', targetInfo: { type: 'iframe', targetId: 'i1', url: 'https://pay.example/' } } });
    background = true;
    await page.syncFocusEmulation();
    await page.syncFocusEmulation();
    expect(focus()).toEqual([{ enabled: true, sessionId: undefined }, { enabled: true, sessionId: 'c1' }]);
    background = false;
    await page.syncFocusEmulation();
    expect(focus().slice(2)).toEqual([{ enabled: false, sessionId: undefined }, { enabled: false, sessionId: 'c1' }]);
  });
});
