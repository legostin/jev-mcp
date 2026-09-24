import { maskSecrets } from './secrets.ts';

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Card layouts: 4-4-4-4(-3), Amex 4-6-5, Diners 4-6-4; or 13-19 digits in a row with a card network prefix.
const GROUPED = new Set(['4-4-4-4', '4-4-4-4-3', '4-6-5', '4-6-4', '4-4-4-1', '4-4-4-2', '4-4-4-3']);

/** Card numbers in free text become "•••• 4242": only layouts cards are written in, and only when the Luhn check passes. */
export function maskCards(text: string): string {
  return text.replace(/(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,])/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    const groups = m.split(/[ -]/).map((g) => g.length).join('-');
    const card = m.includes(' ') || m.includes('-') ? GROUPED.has(groups) : /^[3-6]/.test(digits) && (digits.length === 15 || digits.length === 16);
    return card ? `•••• ${digits.slice(-4)}` : m;
  });
}

/** What leaves the daemon: secret param values of tasks and card numbers are masked in every string. */
export function privacyFilter<T>(value: T, opts: { secrets: string[]; cards: boolean }): T {
  const masked = maskSecrets(value, opts.secrets);
  if (!opts.cards) return masked;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return /\d{4}/.test(v) || /\d[ -]\d/.test(v) ? maskCards(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(masked) as T;
}

/**
 * Inputs whose value must not leave the page as typed: passwords, card numbers, security and one-time codes (by
 * type, autocomplete hint, or a name/id such as "cvv"). Card numbers keep their last four digits.
 */
export function sensitiveValue(attrs: Record<string, string>, inputType: string, value: string): string | null {
  const ac = (attrs.autocomplete ?? '').toLowerCase();
  const ids = `${attrs.name ?? ''} ${attrs.id ?? ''}`.toLowerCase();
  const card = ac === 'cc-number' || /(^|[^a-z])(card_?num(ber)?|cardnumber|cc_?num(ber)?|ccnum)([^a-z]|$)/.test(ids);
  const code = inputType === 'password' || /^(cc-csc|cc-exp|cc-exp-month|cc-exp-year|one-time-code|current-password|new-password)$/.test(ac)
    || /(^|[^a-z])(cvv2?|cvc2?|csc|security_?code|otp|pin)([^a-z]|$)/.test(ids);
  if (!card && !code) return null;
  if (!value) return '';
  const digits = value.replace(/\D/g, '');
  return card && digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '••••';
}
