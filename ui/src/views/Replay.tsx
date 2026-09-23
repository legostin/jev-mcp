import { useEffect, useState } from 'preact/hooks';
import { api, fmtMs } from '../api.ts';
import { AnswerView } from '../components.tsx';

export function Replay({ callId }: { callId?: string }) {
  const [original, setOriginal] = useState<any>(null);
  const [state, setState] = useState('"The sky is blue."');
  const [questions, setQuestions] = useState(JSON.stringify({ q: { type: 'noul', instructions: 'Does the text describe the sky?' } }, null, 2));
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!callId) return;
    api(`/calls?limit=100000`).then((calls: any[]) => {
      const c = calls.find((x) => x.id === callId);
      if (!c) return setError('Call not found');
      setOriginal(c);
      setState(JSON.stringify(c.state, null, 2));
      setQuestions(JSON.stringify(c.questions, null, 2));
    }).catch((e) => setError(e.message));
  }, [callId]);
  const run = async () => {
    setBusy(true); setError('');
    try {
      setResult(await api('/replay', { method: 'POST', json: { state: JSON.parse(state), questions: JSON.parse(questions) } }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <h1>Replay a JEV decision</h1>
      <p class="muted">Edit the state or the questions and run them against JEV again. {original && <>Original: <b>{original.template}</b> ({original.id}).</>}</p>
      <div class="cols" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div><h2>State</h2><textarea value={state} onInput={(e) => setState((e.target as HTMLTextAreaElement).value)} style={{ minHeight: '360px' }} /></div>
        <div><h2>Questions</h2><textarea value={questions} onInput={(e) => setQuestions((e.target as HTMLTextAreaElement).value)} style={{ minHeight: '360px' }} /></div>
      </div>
      <div class="row" style={{ margin: '8px 0' }}>
        <button class="primary" disabled={busy} onClick={run}>{busy ? 'Running…' : 'Run on JEV'}</button>
        {result?.playground && <a href={result.playground} target="_blank" rel="noreferrer">Open in TypeSafe Playground ↗</a>}
        {error && <span class="err">{error}</span>}
      </div>
      <div class="cols" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div>
          {original && <><h2>Original answers</h2>{Object.entries(original.answers ?? {}).map(([id, a]) => <AnswerView id={id} answer={a} />)}</>}
        </div>
        <div>
          {result && <>
            <h2>New answers <span class="muted small">{result.model} · {fmtMs(result.latencyMs)} · ${Number(result.costUsd).toFixed(6)}</span></h2>
            {Object.entries(result.answers).map(([id, a]) => <AnswerView id={id} answer={a} />)}
          </>}
        </div>
      </div>
    </div>
  );
}
