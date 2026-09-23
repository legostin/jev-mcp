import { connectDaemon } from '../daemon/client.ts';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * `jev watch <task> [--until question|done|any] [--timeout s]`: waits for the next task event, prints it as JSON
 * and exits 0 (exit 2 on timeout). Meant to run in the background so the harness wakes the agent when it exits.
 */
export async function watch(args: string[]): Promise<number> {
  const taskId = args.find((a) => !a.startsWith('--') && a !== flag(args, 'until') && a !== flag(args, 'timeout'));
  const until = (flag(args, 'until') ?? 'question') as 'question' | 'done' | 'any';
  const timeoutS = Number(flag(args, 'timeout') ?? 3600);
  if (!['question', 'done', 'any'].includes(until)) { console.error('--until must be question, done or any'); return 1; }
  const c = await connectDaemon({ autostart: false });
  await c.call('session.hello', { client: 'watch', pid: process.pid });
  const deadline = Date.now() + timeoutS * 1000;
  try {
    while (Date.now() < deadline) {
      const chunk = Math.min(55_000, deadline - Date.now());
      const r = await c.call('task.wait', { task_id: taskId, until, timeout_ms: chunk }, { timeoutMs: chunk + 10_000 });
      if (!r.timeout) {
        const ev = r.event;
        const out: Record<string, unknown> = { event: ev.type, task_id: ev.task_id };
        if (ev.type === 'question') {
          out.question_id = ev.payload.question_id;
          out.kind = ev.payload.kind;
          out.summary = ev.payload.summary;
          out.candidates = ev.payload.decision?.candidates?.slice(0, 5);
          out.answer_with = ev.payload.answer_with;
          out.next = 'Answer with the jev_answer MCP tool, then start `jev watch` again.';
        } else if (ev.type === 'done') {
          out.status = ev.payload?.status;
          out.result = ev.payload?.result;
          out.stats = ev.payload?.stats;
          out.next = 'Full items: jev_result.';
        } else out.payload = ev.payload;
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
    }
    console.log(JSON.stringify({ event: 'timeout', task_id: taskId ?? null }));
    return 2;
  } finally { c.close(); }
}
