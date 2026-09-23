import type { CdpConnection } from './connection.ts';

export type DriverKind = 'chromium' | 'extension';

export interface TabInfo { id: string; url: string; title: string; driver: DriverKind }

/** A browser that can hand out flat-session CDP access to its tabs. */
export interface BrowserDriver {
  readonly kind: DriverKind;
  listTabs(): Promise<TabInfo[]>;
  openTab(url?: string): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  /** Attaches to a tab; commands for the page go to `sessionId` on `conn`. */
  attach(tabId: string): Promise<{ conn: CdpConnection; sessionId?: string }>;
  detach(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  close(): Promise<void>;
  onDisconnect(listener: () => void): () => void;
  readonly connected: boolean;
}
