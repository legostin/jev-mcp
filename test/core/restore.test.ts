import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceStore } from '../../src/core/trace/store.ts';
import { Task, type TabPort } from '../../src/core/runner/task.ts';
import { parseConfig } from '../../src/core/config/store.ts';
import { createScriptedClient } from '../../src/core/jev/fake.ts';

const port: TabPort = {
  tabId: 't9', page: async () => { throw new Error('not used'); }, observe: async () => { throw new Error('not used'); },
  lastModel: () => undefined, release: () => {},
};

describe('tasks after a daemon restart', () => {
  it('come back interrupted with their progress, unless they still need a secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevrs-'));
    const trace = TraceStore.open(join(dir, 'db.sqlite'), join(dir, 'blobs'));
    try {
      const spec = (pwStatus: string) => ({
        spec: { goal: 'Sign in and post an ad', params: { email: { value: 'a@b.c' }, pw: { value: '[secret]', secret: true } }, hints: [], policy: {} },
        checkpoint: {
          v: 1, stepIdx: 4, startedAt: Date.now() - 5000, cost: 0.001, jevCalls: 9, escalations: 1,
          status: { email: 'done', pw: pwStatus }, hints: [{ text: 'Skip photos', source: 'task' }],
          submitsDone: 1, dirty: false, sortTried: false, sortedBy: null, url: 'http://x/a/new', driver: 'extension',
        },
      });
      const now = Date.now();
      for (const [id, pw] of [['t_ok', 'done'], ['t_secret', 'pending']] as const) {
        const { spec: sp, checkpoint } = spec(pw);
        trace.recordTask({ id, session: 's1', createdAt: now, updatedAt: now, state: 'running', goal: sp.goal, spec: sp });
        trace.saveCheckpoint(id, checkpoint);
      }
      const recs = trace.unfinishedTasks(3600_000);
      expect(recs.map((r) => r.id).sort()).toEqual(['t_ok', 't_secret']);
      const deps = { sessionId: 's2', getConfig: () => parseConfig({}), jev: createScriptedClient(() => ({})), trace, port };
      const ok = Task.restore(recs.find((r) => r.id === 't_ok')!, deps)!;
      expect(ok.state).toBe('interrupted');
      expect(ok.statusView()).toMatchObject({ step: 4, progress: { email: 'done', pw: 'done' } });
      expect(Task.restore(recs.find((r) => r.id === 't_secret')!, deps)).toBeNull();
    } finally {
      trace.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
