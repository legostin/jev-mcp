import { createHash } from 'node:crypto';

/** Names with volatile numbers ("Pay 41 230 ₸", "3 items") keep their shape but not their digits. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\d+(?:[\s.,]\d+)*/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Strips generated suffixes from ids and classes: "dst-9f2c1a" -> "dst", "field_1234" -> "field". */
export function normalizeId(id: string | undefined): string {
  if (!id) return '';
  return id
    .replace(/[-_:]?[0-9a-f]{5,}$/i, '')
    .replace(/[-_:]?\d+$/g, '')
    .replace(/\d+/g, '#')
    .slice(0, 40);
}

export function hash(parts: string[]): string {
  return createHash('sha1').update(parts.join('␟')).digest('hex').slice(0, 12);
}

export function elementSignature(el: {
  kind: string; role: string; name: string; tag: string; attrs: Record<string, string>; frameKey?: string;
}, regionKey: string): string {
  const a = el.attrs;
  return hash([
    el.kind, el.role, normalizeName(el.name), el.tag, a.name ?? '', normalizeId(a.id), a['data-testid'] ?? a['data-test'] ?? a['data-qa'] ?? '',
    a.type ?? '', a.autocomplete ?? '', regionKey, el.frameKey ?? '',
  ]);
}
