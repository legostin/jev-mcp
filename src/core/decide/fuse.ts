/**
 * Averages two looks at the same options after renormalising each to them. A second look adds evidence; it does
 * not overwrite the first (JEV varies by about ±0.08 on identical input, so near ties flip on their own).
 */
export function fuse(p1: Record<string, number>, p2: Record<string, number>, keys: string[]): Record<string, number> {
  const norm = (p: Record<string, number>) => {
    const s = keys.reduce((a, k) => a + (p[k] ?? 0), 0);
    return Object.fromEntries(keys.map((k) => [k, s > 0 ? (p[k] ?? 0) / s : 1 / keys.length]));
  };
  const a = norm(p1);
  const b = norm(p2);
  return Object.fromEntries(keys.map((k) => [k, (a[k] + b[k]) / 2]));
}
