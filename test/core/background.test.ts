import { describe, it, expect, vi } from 'vitest';
import { ExtensionBridge } from '../../src/daemon/ext-bridge.ts';

function fixture(background: boolean) {
  const bridge = new ExtensionBridge(() => [], () => background);
  const call = vi.spyOn(bridge, 'call').mockImplementation(async (method) =>
    method === 'openTab' ? { tabId: 17, url: 'about:blank', title: '', active: !background } : {});
  return { bridge, call };
}

describe('extension background mode', () => {
  it('opens inactive tabs and suppresses window activation', async () => {
    const { bridge, call } = fixture(true);
    await bridge.driver.openTab('about:blank');
    await bridge.driver.activateTab('17');
    expect(call).toHaveBeenCalledWith('openTab', { url: 'about:blank', active: false });
    expect(call.mock.calls.some(([method]) => method === 'activateTab')).toBe(false);
  });
  it('emulates focus on attachment so pages work while the user types elsewhere', async () => {
    const { bridge, call } = fixture(true);
    await bridge.driver.attach('17');
    expect(call.mock.calls.some(([method, params]) => method === 'send' &&
      (params as any).method === 'Emulation.setFocusEmulationEnabled' &&
      (params as any).params.enabled === true)).toBe(true);
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
  it('detaches after focus setup fails and allows attachment to be retried', async () => {
    const { bridge, call } = fixture(true);
    call.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('focus setup failed'));
    await expect(bridge.driver.attach('17')).rejects.toThrow('focus setup failed');
    expect(call).toHaveBeenCalledWith('detach', { tabId: 17 });
    expect(bridge.driver.tabs.has(17)).toBe(false);
    await bridge.driver.attach('17');
    expect(bridge.driver.tabs.has(17)).toBe(true);
  });
  it('shares one attachment between concurrent callers', async () => {
    const { bridge, call } = fixture(true);
    const [a, b] = await Promise.all([bridge.driver.attach('17'), bridge.driver.attach('17')]);
    expect(a.conn).toBe(b.conn);
    expect(call.mock.calls.filter(([method]) => method === 'attach')).toHaveLength(1);
  });
  it('reports one focus failure to concurrent callers and detaches once', async () => {
    const { bridge, call } = fixture(true);
    call.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('focus setup failed'));
    const results = await Promise.allSettled([bridge.driver.attach('17'), bridge.driver.attach('17')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(call.mock.calls.filter(([method]) => method === 'detach')).toHaveLength(1);
    expect(bridge.driver.tabs.has(17)).toBe(false);
  });
  it('reads the setting on every call, so toggling it needs no restart for new tabs', async () => {
    let background = false;
    const bridge = new ExtensionBridge(() => [], () => background);
    const call = vi.spyOn(bridge, 'call').mockResolvedValue({ tabId: 17, url: 'about:blank', title: '' });
    await bridge.driver.openTab();
    background = true;
    await bridge.driver.openTab();
    await bridge.driver.activateTab('17');
    expect(call.mock.calls.filter(([method]) => method === 'openTab').map(([, params]) => (params as any).active)).toEqual([true, false]);
    expect(call.mock.calls.some(([method]) => method === 'activateTab')).toBe(false);
  });
});
