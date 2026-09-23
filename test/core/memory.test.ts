import { describe, it, expect } from 'vitest';
import { DatabaseSync } from '../../src/core/trace/sqlite.ts';
import { MemoryStore } from '../../src/core/memory/store.ts';
import { hintsFor, paramCard } from '../../src/core/questions/step.ts';

describe('site hints', () => {
  it('keep the step and param they were given for, and old rows still load', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE site_hints (id TEXT PRIMARY KEY, domain TEXT, text TEXT, created_at INTEGER)');
    db.exec("INSERT INTO site_hints VALUES ('h0', 'cars.example', 'The body type filter (Кузов) is inside advanced search.', 1)");
    const mem = new MemoryStore(db);
    mem.addHint('cars.example', 'Pick the brand from the chips', { step: 'fill_param', key: 'brand', about: 'car brand' });
    const hints = mem.hints('cars.example');
    expect(hints).toEqual([
      { text: 'The body type filter (Кузов) is inside advanced search.', source: 'site' },
      { text: 'Pick the brand from the chips', source: 'site', step: 'fill_param', key: 'brand', about: 'car brand' },
    ]);
    expect(hintsFor(hints, paramCard('fill_param', 'model', { value: 'Camry', about: 'car model' }))).toEqual([]);
    expect(hintsFor(hints, paramCard('fill_param', 'brand', { value: 'Toyota', about: 'car brand' }))).toEqual(['Pick the brand from the chips']);
  });
});
