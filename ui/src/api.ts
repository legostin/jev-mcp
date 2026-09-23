export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export type Listener = (ev: { type: string; task_id: string; payload: any }) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** Live task events over SSE (one shared connection). */
export function onTaskEvent(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/events');
    source.addEventListener('task', (e) => {
      const ev = JSON.parse((e as MessageEvent).data);
      for (const l of listeners) l(ev);
    });
  }
  return () => listeners.delete(fn);
}

/** Threshold presets, mirrored from the server for chart markers. */
export const PRESETS: Record<string, { act: number; escalate: number }> = {
  cautious: { act: 0.9, escalate: 0.7 },
  balanced: { act: 0.85, escalate: 0.55 },
  autonomous: { act: 0.6, escalate: 0.2 },
};

export function fmtMs(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function fmtTime(t?: number): string {
  return t ? new Date(t).toLocaleString() : '—';
}

export function estimateTokens(v: unknown): number {
  return Math.ceil(JSON.stringify(v ?? '').length / 3.5);
}
