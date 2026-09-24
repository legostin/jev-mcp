import { describe, it, expect } from 'vitest';
import { isSignInParam, Journal, pagePath } from '../../src/core/runner/journal.ts';

describe('task working memory', () => {
  it('keeps facts by key, pages once per address, and ways that did not work', () => {
    const j = new Journal();
    j.addFact('signed_in', 'The user is already signed in.', 3);
    j.addFact('signed_in', 'The user is already signed in: sign-in details are not needed.', 5);
    expect(j.facts).toHaveLength(1);
    j.visit('https://cars.example/', 'Home');
    j.visit('https://cars.example/', 'Home page');
    j.visit('https://cars.example/cabinet/?tab=unpaid', 'My ads', 'Unpaid (1)');
    j.setProgress(2);
    expect(j.trail).toEqual([{ path: 'cars.example/', title: 'Home page', via: undefined }, { path: 'cars.example/cabinet/?tab=unpaid', title: 'My ads', via: 'Unpaid (1)', progress: 2 }]);
    j.deadEnd('https://cars.example/', 'Post an ad', 'the page it opened does not lead to the goal');
    j.deadEnd('https://cars.example/', 'Post an ad', 'again');
    expect(j.deadEnds).toHaveLength(1);
    const slice = j.forQuestion()!;
    expect(slice.facts).toEqual(['The user is already signed in: sign-in details are not needed.']);
    expect(slice.pages_passed).toEqual(['"Home page" cars.example/', '"My ads" cars.example/cabinet/?tab=unpaid (via "Unpaid (1)")']);
    expect(slice.tried_without_success).toEqual(['"Post an ad" on cars.example/: the page it opened does not lead to the goal']);
    expect(Journal.from(JSON.parse(JSON.stringify(j))).toJSON()).toEqual(j.toJSON());
    expect(new Journal().forQuestion()).toBeUndefined();
  });

  it('knows sign-in params and short page paths', () => {
    expect(isSignInParam('phone', 'phone number used to sign in')).toBe(true);
    expect(isSignInParam('password', 'account password')).toBe(true);
    expect(isSignInParam('login', undefined)).toBe(true);
    expect(isSignInParam('card', 'saved card number')).toBe(false);
    expect(isSignInParam('city', 'city where the car is sold')).toBe(false);
    expect(pagePath('https://a.example/x?' + 'q=1&'.repeat(30))).toBe('a.example/x');
  });
});
