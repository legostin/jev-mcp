/** JSON helpers that never throw on bad input. */
export function tryParse<T = unknown>(text: string): T | undefined {
  try { return JSON.parse(text) as T; } catch { return undefined; }
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
