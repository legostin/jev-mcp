import { describe, it, expect } from 'vitest';
import { maskCards, privacyFilter, sensitiveValue } from '../../src/core/safety/privacy.ts';
import { budgetResult } from '../../src/mcp/tools.ts';

describe('privacy filter', () => {
  it('masks card numbers written as cards and leaves other numbers alone', () => {
    expect(maskCards('card 4242 4242 4242 4242 ok')).toBe('card •••• 4242 ok');
    expect(maskCards('4111111111111111')).toBe('•••• 1111');
    expect(maskCards('Amex 3782 822463 10005')).toBe('Amex •••• 0005');
    // Not a valid card number, a phone, a price, a timestamp, an already masked card.
    for (const s of ['4242 4242 4242 4241', '+7 747 295 7230', '5 000 000 ₸', 'created 1790231582434', 'Сохранённая карта •••• 4242', 'ID 89557392']) {
      expect(maskCards(s)).toBe(s);
    }
  });

  it('masks task secrets and cards deep inside results', () => {
    const out = privacyFilter({ text: 'typed hunter22 into e5', items: [{ note: 'paid with 4242-4242-4242-4242' }], n: 4242424242424242 },
      { secrets: ['hunter22'], cards: true });
    expect(out.text).toBe('typed [secret] into e5');
    expect(out.items[0].note).toBe('paid with •••• 4242');
    expect(out.n).toBe(4242424242424242);
    expect(privacyFilter('4242 4242 4242 4242', { secrets: [], cards: false })).toBe('4242 4242 4242 4242');
  });

  it('hides values of password, card and code fields', () => {
    expect(sensitiveValue({ autocomplete: 'cc-number' }, 'text', '4111 1111 1111 1111')).toBe('•••• 1111');
    expect(sensitiveValue({ name: 'card_number' }, 'text', '4111111111111111')).toBe('•••• 1111');
    expect(sensitiveValue({ id: 'cvv' }, 'text', '123')).toBe('••••');
    expect(sensitiveValue({ autocomplete: 'cc-exp' }, 'text', '12/29')).toBe('••••');
    expect(sensitiveValue({}, 'password', 'x')).toBe('••••');
    expect(sensitiveValue({}, 'password', '')).toBe('');
    expect(sensitiveValue({ name: 'email', autocomplete: 'email' }, 'email', 'a@b.c')).toBeNull();
    expect(sensitiveValue({ name: 'spinner', id: 'pinned' }, 'text', 'x')).toBeNull();
  });
});

describe('tool output budget', () => {
  it('cuts text past the budget, keeps images and says how much is left', () => {
    const res = budgetResult({ content: [{ type: 'text', text: 'a'.repeat(700) }, { type: 'image', data: 'x', mimeType: 'image/png' }, { type: 'text', text: 'b'.repeat(700) }] }, 200);
    const texts = res.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    expect(texts[0]).toBe('a'.repeat(700));
    expect(res.content.some((c) => c.type === 'image')).toBe(true);
    expect(texts.join('')).toMatch(/…\[cut: about 200 more tokens/);
    const small = { content: [{ type: 'text' as const, text: 'short' }] };
    expect(budgetResult(small, 200)).toBe(small);
  });
});
