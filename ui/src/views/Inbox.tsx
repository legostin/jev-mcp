import { useEffect, useState } from 'preact/hooks';
import { api, onTaskEvent } from '../api.ts';

export function QuestionCard({ q, onDone }: { q: any; onDone: () => void }) {
  const [hint, setHint] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const send = (answer: unknown) => api(`/questions/${q.question_id}/answer`, { method: 'POST', json: { answer, remember } })
    .then(onDone).catch((e) => setError(e.message));
  return (
    <div class="card q">
      <div class="row"><b>[{q.kind}]</b> {q.summary}</div>
      <div class="muted small">task <a href={`#/task/${q.task_id}`}>{q.task_id}</a> · {q.page?.title} · {q.page?.url}</div>
      {q.decision?.candidates?.map((c: any) => (
        <div class="row" style={{ margin: '4px 0' }}>
          <button onClick={() => send({ type: 'pick', ref: c.ref })}>Pick {c.ref}</button>
          <span>{(c.p * 100).toFixed(0)}%</span><code>{c.desc}</code>
        </div>
      ))}
      {q.context && <pre>{JSON.stringify(q.context, null, 2)}</pre>}
      <div class="row">
        <input class="grow" value={hint} placeholder="Hint for JEV (English)" onInput={(e) => setHint((e.target as HTMLInputElement).value)} />
        <button disabled={!hint} onClick={() => send({ type: 'hint', text: hint })}>Send hint</button>
      </div>
      <div class="row" style={{ marginTop: '6px' }}>
        {q.answer_with?.includes('none') && <button onClick={() => send({ type: 'none' })}>Not on page</button>}
        {q.answer_with?.includes('continue') && <button onClick={() => send({ type: 'continue' })}>Continue</button>}
        {q.answer_with?.includes('skip') && <button onClick={() => send({ type: 'skip' })}>Skip</button>}
        <button class="danger" onClick={() => send({ type: 'abort', reason: 'aborted from the debug UI' })}>Abort</button>
        <label class="muted"><input type="checkbox" checked={remember} onChange={(e) => setRemember((e.target as HTMLInputElement).checked)} /> remember for this site</label>
      </div>
      {q.screenshot && <img class="shot" src={`/api/blob/${q.screenshot}`} />}
      {error && <div class="err">{error}</div>}
    </div>
  );
}

export function Inbox() {
  const [qs, setQs] = useState<any[] | null>(null);
  const load = () => api('/questions').then(setQs).catch(() => setQs([]));
  useEffect(() => { load(); return onTaskEvent(() => load()); }, []);
  if (!qs) return <p class="muted">Loading…</p>;
  return (
    <div>
      <h1>Questions from JEV</h1>
      <p class="muted">Tasks ask when JEV is not confident enough. Your agent usually answers; you can answer here too.</p>
      {!qs.length && <p class="muted">No pending questions.</p>}
      {qs.map((q) => <QuestionCard q={q} onDone={load} />)}
    </div>
  );
}
