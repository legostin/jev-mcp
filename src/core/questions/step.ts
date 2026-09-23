import type { Json } from '../jev/types.ts';
import type { Intent } from './templates/ground.ts';
import { SECRET_PLACEHOLDER, type ParamSpec, type ParamValue } from './state.ts';
import { tokens } from './lexical.ts';

/** What the current step does, as JEV sees it. Questions about one step get this instead of every param. */
export interface StepCard { kind: string; do: string; param?: { key: string; about: string; value: Json } }

/** A hint and the place it applies to: task hints go everywhere, the others only to steps about the same thing. */
export interface Hint { text: string; source: 'task' | 'answer' | 'site'; step?: string; key?: string; about?: string }

export const aboutOf = (key: string, p: ParamSpec): string => p.about ?? key.replace(/[_-]+/g, ' ');

export function valueText(v: ParamValue): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v && typeof v === 'object') return `${v.from}..${v.to}`;
  return String(v);
}

export function paramCard(kind: string, key: string, p: ParamSpec, doText?: string): StepCard {
  const about = aboutOf(key, p);
  const value: Json = p.secret ? SECRET_PLACEHOLDER : (p.value as Json);
  const text = doText ?? (p.secret ? `enter the ${about}`
    : typeof p.value === 'boolean' ? `${p.value ? 'turn on' : 'turn off'} "${about}"`
    : `set the ${about} to "${valueText(p.value)}"`);
  return { kind, do: text, param: { key, about, value } };
}

export const stepCard = (kind: string, doText: string): StepCard => ({ kind, do: doText });

/**
 * Grounding intent for filling a param. The value is part of the question: a button or option showing it is as
 * good a target as the field itself, and JEV rates both far more confidently than "the field for X".
 */
export function paramIntent(key: string, p: ParamSpec): Intent {
  const about = aboutOf(key, p);
  if (typeof p.value === 'boolean') {
    return { target: `the checkbox or switch for "${about}"`, action: 'check', kinds: ['checkbox', 'radio', 'button', 'clickable'], trial: true };
  }
  // A secret typed into the wrong field would show on screen: no trials, and JEV never sees the value.
  if (p.secret) return { target: `the input field for the ${about}`, action: 'type', kinds: ['textbox', 'combobox'], trial: false };
  return {
    target: `the control that sets the ${about} to "${valueText(p.value)}": an option or button showing this value, or the field where it is typed or chosen`,
    fallback: `the field, or the button that opens the list of choices, where the ${about} is entered or picked`,
    value: valueText(p.value),
    // Values come as chips, options, menu items, radios, checkboxes or filter links as often as fields.
    kinds: ['textbox', 'combobox', 'select', 'clickable', 'button', 'option', 'menuitem', 'radio', 'checkbox'], valueKinds: ['link', 'tab'], trial: true,
  };
}

// Distinctive words only: short words ("car", "to") are shared by unrelated params.
const words = (s: string): string[] => tokens(s).filter((t) => t.length >= 4);
const near = (a: string, b: string) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

function containment(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  return small.filter((x) => big.some((y) => near(x, y))).length / small.length;
}

/** Hints for a step's questions. Without a card (page-level questions) every hint applies. */
export function hintsFor(hints: Hint[], card?: StepCard): string[] {
  if (!card) return hints.map((h) => h.text);
  const p = card.param;
  const aboutWords = words(`${p?.key ?? ''} ${p?.about ?? ''}`);
  const cardWords = words(`${p?.key ?? ''} ${p?.about ?? ''} ${typeof p?.value === 'string' ? p.value : ''}`);
  return hints.filter((h) => {
    if (h.source === 'task') return true;
    if (h.key && p && h.key === p.key) return true;
    if (h.about) return !!p && containment(words(h.about), aboutWords) >= 0.67;
    if (h.step) return h.step === card.kind && !p;
    // Unbound hints (older site hints): only when they mention what this step is about.
    return words(h.text).some((w) => cardWords.some((c) => near(w, c)));
  }).map((h) => h.text);
}
