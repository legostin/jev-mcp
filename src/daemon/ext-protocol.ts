/** Messages between the jev extension (service worker) and the daemon over the local WebSocket. */
export type ExtToDaemon =
  | { type: 'hello'; token?: string; version: string; extensionId: string }
  | { type: 'pair'; code: string }
  | { type: 'pong' }
  | { type: 'reply'; id: number; result?: unknown; error?: string }
  | { type: 'event'; tabId: number; sessionId?: string; method: string; params: unknown }
  | { type: 'detached'; tabId: number; reason: string }
  | { type: 'ui'; id: number; method: string; params?: unknown };

export type DaemonToExt =
  | { type: 'welcome'; paired: boolean; version: string }
  | { type: 'paired'; token: string }
  | { type: 'pair_failed'; reason: string }
  | { type: 'call'; id: number; method: ExtCallMethod; params: any }
  | { type: 'ping' }
  | { type: 'ui_reply'; id: number; result?: unknown; error?: string }
  | { type: 'push'; event: unknown };

export type ExtCallMethod = 'listTabs' | 'openTab' | 'closeTab' | 'activateTab' | 'attach' | 'detach' | 'send';

export interface ExtTab { tabId: number; url: string; title: string; windowId: number; active: boolean }
