import { describe, it, expect } from 'vitest';
import { calibrationFromCalls } from '../../src/core/trace/calibration.ts';
import type { JevCallRecord } from '../../src/core/trace/store.ts';

const call = (conf: number, ok: boolean, template = 'ground.element'): JevCallRecord => ({
  id: Math.random().toString(36), at: 0, template, state: {}, questions: {},
  answers: { pick: { type: 'choice', choice: 'e1', probabilities: { e1: conf }, confidence: conf } }, label: ok,
});

describe('calibration', () => {
  it('bins by confidence, computes accuracy and ECE, and recommends the lowest safe threshold', () => {
    const calls = [
      ...Array.from({ length: 10 }, () => call(0.95, true)),
      ...Array.from({ length: 10 }, (_, i) => call(0.75, i < 9)),
      ...Array.from({ length: 10 }, (_, i) => call(0.45, i < 5)),
      call(0.5, true, 'other'),
    ];
    const [r] = calibrationFromCalls(calls, 0.95);
    expect(r.template).toBe('ground.element');
    expect(r.n).toBe(30);
    expect(r.bins[9]).toMatchObject({ n: 10, accuracy: 1 });
    expect(r.bins[7]).toMatchObject({ n: 10, accuracy: 0.9 });
    expect(r.bins[4]).toMatchObject({ n: 10, accuracy: 0.5 });
    expect(r.ece).toBeGreaterThan(0);
    // 20 decisions >= 0.75 have 19/20 = 0.95 precision -> threshold 0.75.
    expect(r.recommend.act).toBe(0.75);
    expect(r.recommend.coverage).toBeCloseTo(20 / 30);
    const strict = calibrationFromCalls(calls, 0.99)[0];
    expect(strict.recommend.act).toBe(0.95);
  });
  it('ignores unlabeled calls', () => {
    expect(calibrationFromCalls([{ ...call(0.9, true), label: null }])).toEqual([]);
  });
});
