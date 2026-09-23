import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../../src/core/trace/store.ts';

let dir: string;
let store: TraceStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jevtrace-')); store = TraceStore.open(join(dir, 'db.sqlite'), join(dir, 'blobs')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('TraceStore', () => {
  it('round-trips tasks, steps, calls and escalations', () => {
    store.recordTask({ id: 't1', session: 's1', createdAt: 1, updatedAt: 1, state: 'running', goal: 'g', spec: { a: 1 } });
    store.updateTask('t1', { state: 'done', result: { ok: true } });
    expect(store.getTask('t1')).toMatchObject({ state: 'done', result: { ok: true }, spec: { a: 1 } });
    store.recordStep({ id: 'st1', taskId: 't1', idx: 0, startedAt: 5, subintent: 'fill_param(from)', action: { type: 'type' } });
    expect(store.getSteps('t1')[0]).toMatchObject({ subintent: 'fill_param(from)', action: { type: 'type' } });
    store.recordJevCall({ id: 'c1', taskId: 't1', stepId: 'st1', at: 6, template: 'ground.element', state: { x: 1 }, questions: {}, answers: { q: 1 }, costUsd: 0.00001 });
    store.labelCall('c1', true, 'verified');
    expect(store.getJevCalls({ template: 'ground.element' })[0]).toMatchObject({ label: true, labelNote: 'verified', answers: { q: 1 } });
    store.recordEscalation({ id: 'q1', taskId: 't1', createdAt: 7, kind: 'ground', payload: { summary: 's' } });
    expect(store.getEscalations('t1')).toHaveLength(1);
    expect(store.listTasks({ session: 's1' })).toHaveLength(1);
  });

  it('refuses to store API keys', () => {
    expect(() => store.recordJevCall({ id: 'c2', at: 1, template: 'x', state: { note: 'sk-or-v1-abcdef0123456789abcdef' }, questions: {} })).toThrow(/API key/);
    expect(() => store.saveBlob('t1', 'x.txt', 'key sk-or-v1-abcdef0123456789abcdef')).toThrow(/API key/);
  });

  it('prunes old tasks and their blobs', () => {
    store.recordTask({ id: 'old', session: 's', createdAt: 0, updatedAt: 0, state: 'done', goal: '', spec: {} });
    store.recordTask({ id: 'new', session: 's', createdAt: Date.now(), updatedAt: Date.now(), state: 'done', goal: '', spec: {} });
    const rel = store.saveBlob('old', 'shot.png', Buffer.from([1, 2, 3]));
    expect(store.readBlob(rel)).toEqual(Buffer.from([1, 2, 3]));
    expect(store.prune({ retentionDays: 1, maxMb: 100 }).removedTasks).toBe(1);
    expect(store.getTask('old')).toBeNull();
    expect(store.getTask('new')).not.toBeNull();
    expect(existsSync(join(dir, 'blobs', 'old'))).toBe(false);
  });
});
