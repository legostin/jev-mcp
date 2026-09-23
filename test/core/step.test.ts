import { describe, it, expect } from 'vitest';
import { paramCard, paramIntent, hintsFor, type Hint } from '../../src/core/questions/step.ts';
import { buildState } from '../../src/core/questions/state.ts';

describe('step cards and intents', () => {
  it('puts the value into the fill_param target', () => {
    const i = paramIntent('model', { value: 'Camry', about: 'car model' });
    expect(i.target).toContain('car model to "Camry"');
    expect(i.trial).toBe(true);
  });

  it('never exposes secrets and never trials them', () => {
    const i = paramIntent('pw', { value: 'hunter2', about: 'password', secret: true });
    expect(i.target).not.toContain('hunter2');
    expect(i.trial).toBe(false);
    const s = buildState({ step: paramCard('fill_param', 'pw', { value: 'hunter2', about: 'password', secret: true }) }, 2000);
    expect(JSON.stringify(s)).not.toContain('hunter2');
    expect((s as any).step.value).toBe('[secret]');
  });

  it('booleans target the checkbox', () => {
    expect(paramIntent('used', { value: true, about: 'used cars only' }).kinds).toEqual(['checkbox', 'radio', 'button', 'clickable']);
  });

  it('renders the card into the state', () => {
    const s = buildState({ step: paramCard('fill_param', 'model', { value: 'Camry', about: 'car model' }) }, 2000);
    expect((s as any).step).toEqual({ do: 'set the car model to "Camry"', about: 'car model', value: 'Camry' });
  });
});

describe('hint scoping', () => {
  const hints: Hint[] = [
    { text: 'Prefer direct flights', source: 'task' },
    { text: 'Body type sits in advanced search', source: 'answer', step: 'fill_param', key: 'body', about: 'car body type' },
    { text: 'None of these is the body type field. The body type filter (Кузов) is inside advanced search.', source: 'site' },
    { text: 'Departure is the left field', source: 'site', key: 'from', about: 'departure city' },
  ];

  it('keeps task hints and hints about the same param only', () => {
    const model = paramCard('fill_param', 'model', { value: 'Camry', about: 'car model' });
    expect(hintsFor(hints, model)).toEqual(['Prefer direct flights']);
    const body = paramCard('fill_param', 'body_type', { value: 'кроссовер', about: 'body type' });
    expect(hintsFor(hints, body)).toEqual(hints.slice(0, 3).map((h) => h.text));
    const to = paramCard('fill_param', 'to', { value: 'Анталия', about: 'destination city' });
    expect(hintsFor(hints, to)).toEqual(['Prefer direct flights']);
    const from = paramCard('reveal', 'from', { value: 'Алматы', about: 'city of departure' });
    expect(hintsFor(hints, from)).toEqual(['Prefer direct flights', 'Departure is the left field']);
  });

  it('page-level questions get every hint', () => {
    expect(hintsFor(hints)).toHaveLength(4);
  });
});
