import { SECRET_PLACEHOLDER, type ParamSpec } from '../questions/state.ts';

export function secretValues(params: Record<string, ParamSpec> | undefined): string[] {
  if (!params) return [];
  return Object.values(params).filter((p) => p.secret).map((p) => String(p.value)).filter((v) => v.length >= 3);
}

/** Deep-replaces every occurrence of a secret value in strings of an arbitrary JSON-like structure. */
export function maskSecrets<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  const mask = (s: string) => secrets.reduce((acc, sec) => acc.split(sec).join(SECRET_PLACEHOLDER), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return mask(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
