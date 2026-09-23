import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/core/util/tokens.ts';
import { newId } from '../../src/core/util/ids.ts';
import { redactText } from '../../src/core/util/log.ts';
import { Emitter } from '../../src/core/util/events.ts';

describe('util', () => {
  it('estimates tokens from JSON length', () => {
    expect(estimateTokens('abcdefg')).toBe(2);
    expect(estimateTokens({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 3.5));
  });

  it('generates unique ids with prefix', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('t')));
    expect(ids.size).toBe(1000);
    expect([...ids][0]).toMatch(/^t_/);
  });

  it('redacts OpenRouter keys and apiKey fields', () => {
    expect(redactText('key sk-or-v1-abcdef0123456789 here')).toBe('key [redacted] here');
    expect(redactText('{"apiKey":"secret"}')).toBe('{[redacted]}');
  });

  it('emits typed events', () => {
    const e = new Emitter<{ x: number }>();
    const got: number[] = [];
    const off = e.on('x', (v) => got.push(v));
    e.emit('x', 1); off(); e.emit('x', 2);
    expect(got).toEqual([1]);
  });
});
