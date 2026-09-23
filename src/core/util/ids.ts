import { randomBytes } from 'node:crypto';

let counter = 0;

/** Short, sortable-enough unique id with a readable prefix, e.g. `t_m3k9x2_a1b2`. */
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_679_616;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('hex');
}
