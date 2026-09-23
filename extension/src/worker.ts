/// <reference types="chrome" />
import type { DaemonToExt, ExtToDaemon, ExtTab } from '../../src/daemon/ext-protocol.ts';

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 47913;

type Status = 'connecting' | 'unpaired' | 'connected' | 'offline';
let ws: WebSocket | null = null;
let status: Status = 'offline';
let lastError = '';
let backoff = 1000;
const attached = new Set<number>();
const uiPending = new Map<number, (r: { result?: unknown; error?: string }) => void>();
let uiSeq = 0;

async function settings(): Promise<{ port: number; token?: string }> {
  const s = await chrome.storage.local.get(['port', 'token']);
  return { port: Number(s.port) || DEFAULT_PORT, token: s.token as string | undefined };
}

function send(msg: ExtToDaemon): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function setStatus(s: Status, err = ''): void {
  status = s;
  lastError = err;
  chrome.runtime.sendMessage({ type: 'status', status, error: lastError }).catch(() => {});
  void chrome.action.setBadgeText({ text: s === 'connected' ? '' : s === 'unpaired' ? '!' : '×' });
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { port, token } = await settings();
  setStatus('connecting');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  ws = socket;
  socket.onopen = () => {
    backoff = 1000;
    send({ type: 'hello', token, version: VERSION, extensionId: chrome.runtime.id });
  };
  socket.onmessage = (ev) => { void onMessage(JSON.parse(String(ev.data)) as DaemonToExt); };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    setStatus('offline', 'daemon not reachable (is jev running?)');
    for (const tabId of [...attached]) chrome.debugger.detach({ tabId }).catch(() => {});
    attached.clear();
    setTimeout(() => { void connect(); }, backoff);
    // Reconnecting to localhost is cheap: keep the gap short so a restarted daemon sees the extension quickly.
    backoff = Math.min(backoff * 2, 5_000);
  };
  socket.onerror = () => {};
}

async function onMessage(msg: DaemonToExt): Promise<void> {
  switch (msg.type) {
    case 'welcome': setStatus(msg.paired ? 'connected' : 'unpaired'); break;
    case 'paired': await chrome.storage.local.set({ token: msg.token }); setStatus('connected'); break;
    case 'pair_failed': setStatus('unpaired', msg.reason); break;
    case 'ping': send({ type: 'pong' }); break;
    case 'push': chrome.runtime.sendMessage({ type: 'push', event: msg.event }).catch(() => {}); break;
    case 'ui_reply': { const cb = uiPending.get(msg.id); uiPending.delete(msg.id); cb?.({ result: msg.result, error: msg.error }); break; }
    case 'call': {
      try {
        const result = await handleCall(msg.method, msg.params);
        send({ type: 'reply', id: msg.id, result });
      } catch (e) {
        send({ type: 'reply', id: msg.id, error: (e as Error).message ?? String(e) });
      }
      break;
    }
  }
}

function tabInfo(t: chrome.tabs.Tab): ExtTab {
  return { tabId: t.id!, url: t.url ?? t.pendingUrl ?? '', title: t.title ?? '', windowId: t.windowId, active: !!t.active };
}

async function handleCall(method: string, p: any): Promise<unknown> {
  switch (method) {
    case 'listTabs': {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((t) => t.id !== undefined && !(t.url ?? '').startsWith('chrome://') && !(t.url ?? '').startsWith('chrome-extension://')).map(tabInfo);
    }
    case 'openTab': return tabInfo(await chrome.tabs.create({ url: p.url ?? 'about:blank', active: p.active ?? true }));
    case 'closeTab': await chrome.tabs.remove(p.tabId); return {};
    case 'activateTab': {
      const t = await chrome.tabs.update(p.tabId, { active: true });
      if (t?.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true });
      return {};
    }
    case 'attach': {
      if (!attached.has(p.tabId)) {
        try { await chrome.debugger.attach({ tabId: p.tabId }, '1.3'); } catch (e) {
          if (!String((e as Error).message).includes('Already attached')) throw e;
        }
        attached.add(p.tabId);
      }
      return {};
    }
    case 'detach': {
      attached.delete(p.tabId);
      await chrome.debugger.detach({ tabId: p.tabId }).catch(() => {});
      return {};
    }
    case 'send': {
      const target: chrome.debugger.DebuggerSession = { tabId: p.tabId };
      if (p.sessionId) (target as { sessionId?: string }).sessionId = p.sessionId;
      return await chrome.debugger.sendCommand(target, p.method, p.params ?? {});
    }
    default: throw new Error(`unknown method ${method}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined) return;
  send({ type: 'event', tabId: source.tabId, sessionId: (source as { sessionId?: string }).sessionId, method, params: params ?? {} });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  attached.delete(source.tabId);
  send({ type: 'detached', tabId: source.tabId, reason });
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined) return;
  send({ type: 'tab_created', tabId: tab.id, openerTabId: tab.openerTabId, url: tab.pendingUrl ?? tab.url ?? '' });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attached.has(tabId)) { attached.delete(tabId); send({ type: 'detached', tabId, reason: 'tab closed' }); }
});

// Side panel <-> daemon relay.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'getStatus') { reply({ status, error: lastError }); return false; }
  if (msg?.type === 'pair') { send({ type: 'pair', code: String(msg.code).trim() }); reply({ ok: true }); return false; }
  if (msg?.type === 'setPort') {
    void chrome.storage.local.set({ port: Number(msg.port) }).then(() => { ws?.close(); reply({ ok: true }); });
    return true;
  }
  if (msg?.type === 'forget') {
    void chrome.storage.local.remove('token').then(() => { ws?.close(); reply({ ok: true }); });
    return true;
  }
  if (msg?.type === 'ui') {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reply({ error: 'not connected' }); return false; }
    const id = ++uiSeq;
    uiPending.set(id, reply);
    send({ type: 'ui', id, method: msg.method, params: msg.params });
    return true;
  }
  return false;
});

chrome.action.onClicked.addListener((tab) => { if (tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId }); });
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Keep the service worker alive and reconnect after it was suspended.
chrome.alarms.create('jev-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'jev-keepalive') void connect(); });
setInterval(() => { if (ws?.readyState === WebSocket.OPEN) send({ type: 'pong' }); }, 20_000);
void connect();
