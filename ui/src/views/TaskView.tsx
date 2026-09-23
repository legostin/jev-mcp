import { useEffect, useState } from 'preact/hooks';
import { api, estimateTokens, fmtMs, fmtTime, onTaskEvent, PRESETS } from '../api.ts';
import { AnswerView, Badge, Json, Modal } from '../components.tsx';
import { QuestionCard } from './Inbox.tsx';

const TIMING_COLORS: Record<string, string> = { observe: '#8e8e93', assess: '#0a84ff', execute: '#34c759' };

function CallView({ call, thresholds }: { call: any; thresholds: { act: number; escalate: number } }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<boolean | null>(call.label ?? null);
  const elements = call.state?.page?.elements ?? call.state?.candidates ?? call.state?.options ?? {};
  const shortLabels: Record<string, string> = {};
  for (const [k, v] of Object.entries(elements)) shortLabels[k] = String(v).slice(0, 60);
  const mark = async (correct: boolean) => { await api(`/calls/${call.id}/label`, { method: 'POST', json: { correct } }); setLabel(correct); };
  return (
    <div class="call">
      <div class="row">
        <b>{call.template}</b>
        <span class="muted">{fmtMs(call.latencyMs)} · ${Number(call.costUsd ?? 0).toFixed(6)} · {call.model ?? ''} · ~{estimateTokens(call.state)} state tokens</span>
        {call.error && <span class="err">{call.error}</span>}
        <span class="grow" />
        {label !== null && <span class={`badge ${label ? 'ok' : 'failed'}`}>{label ? 'correct' : 'wrong'}</span>}
        <button onClick={() => mark(true)} title="Label as correct (calibration)">✓</button>
        <button onClick={() => mark(false)} title="Label as wrong (calibration)">✗</button>
        {call.playground && <a href={call.playground} target="_blank" rel="noreferrer">Playground ↗</a>}
        <a href={`#/replay?call=${call.id}`}>Replay</a>
        <a href="#" onClick={(e) => { e.preventDefault(); setOpen(!open); }}>{open ? 'Hide' : 'Details'}</a>
      </div>
      {Object.entries(call.answers ?? {}).slice(0, open ? 100 : 3).map(([id, a]) => (
        <AnswerView id={id} answer={a} thresholds={(a as any).type === 'choice' ? thresholds : undefined} labels={shortLabels} />
      ))}
      {!open && Object.keys(call.answers ?? {}).length > 3 && <div class="muted small">+{Object.keys(call.answers).length - 3} more answers</div>}
      {open && <>
        <Json label="Questions" value={call.questions} />
        <Json label="State (as sent to JEV)" value={call.state} />
      </>}
    </div>
  );
}

export function TaskView({ id }: { id: string }) {
  const [task, setTask] = useState<any>(null);
  const [steps, setSteps] = useState<any[]>([]);
  const [calls, setCalls] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = () => Promise.all([api(`/tasks/${id}`), api(`/tasks/${id}/steps`), api(`/calls?taskId=${id}`)])
    .then(([t, s, c]) => { setTask(t); setSteps(s); setCalls(c); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api('/settings').then(setSettings).catch(() => {});
    return onTaskEvent((ev) => { if (ev.task_id === id) load(); });
  }, [id]);
  if (error) return <p class="err">{error}</p>;
  if (!task) return <p class="muted">Loading…</p>;
  const policyConf = task.spec?.policy?.confidence ?? {};
  const base = PRESETS[policyConf.preset ?? settings?.confidence?.preset ?? 'balanced'] ?? PRESETS.balanced;
  const thresholds = { act: policyConf.act ?? base.act, escalate: policyConf.escalate ?? base.escalate };
  const control = (action: string) => api('/control', { method: 'POST', json: { task_id: id, action } }).then(load);
  const live = !!task.status;
  const pending = task.status?.pending_question;
  const stats = task.stats ?? task.status?.stats;
  return (
    <div>
      <div class="row"><a href="#/">← Tasks</a></div>
      <h1>{task.goal}</h1>
      <div class="row">
        <Badge value={task.state} />
        <span class="muted">{task.id} · started {fmtTime(task.createdAt)}</span>
        {stats && <span class="muted">· {stats.steps} steps · {stats.jev_calls} JEV calls · {stats.escalations} questions · ${Number(stats.cost_usd).toFixed(4)} · {stats.duration_s}s</span>}
        <span class="grow" />
        {live && !['done', 'failed', 'cancelled'].includes(task.state) && <>
          {task.state === 'paused' ? <button onClick={() => control('resume')}>Resume</button> : <button onClick={() => control('pause')}>Pause</button>}
          <button class="danger" onClick={() => control('cancel')}>Cancel</button>
        </>}
        <a href={`/api/export/${id}`}>Export trace</a>
      </div>
      {pending && <QuestionCard q={pending} onDone={load} />}
      {task.result && (
        <div class="card">
          <b>Result</b> <Badge value={task.result.status} />
          {task.result.result?.selected && <pre>{JSON.stringify(task.result.result.selected, null, 2)}</pre>}
          {task.result.warnings?.length > 0 && <div class="muted">Warnings: {task.result.warnings.join('; ')}</div>}
          {task.result.error && <div class="err">{task.result.error}</div>}
          {task.result.items && <Json label={`${task.result.items.length} items`} value={task.result.items} />}
        </div>
      )}
      <h2>Timeline</h2>
      {steps.map((s) => {
        const stepCalls = calls.filter((c) => c.stepId === s.id);
        const t = s.timings ?? {};
        const total = t.total || 1;
        return (
          <div class={`step ${s.outcome}`}>
            <div class="row">
              <b>#{s.idx} {s.subintent}</b> <Badge value={s.outcome} />
              <span class="muted">{fmtMs(t.total)}</span>
              <span class="muted small">{s.url}</span>
            </div>
            <div>{s.notes?.note}</div>
            <div class="timing" title={Object.entries(t).map(([k, v]) => `${k}: ${fmtMs(v as number)}`).join(', ')}>
              {['observe', 'assess', 'execute'].map((k) => <span style={{ width: `${((t[k] ?? 0) / total) * 100}%`, background: TIMING_COLORS[k] }} />)}
            </div>
            {s.notes?.assess && <div class="muted small">page kind: {s.notes.assess.pageKind} · goal reached {Number(s.notes.assess.goalReached).toFixed(2)} · results {Number(s.notes.assess.resultsMatch).toFixed(2)}</div>}
            {s.diff && <Json label="Page changes" value={s.diff} />}
            {s.screenshot && <img class="shot" src={`/api/blob/${s.screenshot}`} onClick={() => setZoom(`/api/blob/${s.screenshot}`)} />}
            {stepCalls.map((c) => <CallView call={c} thresholds={thresholds} />)}
          </div>
        );
      })}
      {task.escalations?.length > 0 && <>
        <h2>Questions to the agent</h2>
        {task.escalations.map((e: any) => (
          <div class="card q">
            <div class="row"><b>[{e.kind}]</b> {e.payload?.summary}</div>
            <div class="muted small">{fmtTime(e.createdAt)} · answer: {e.answer ? JSON.stringify(e.answer) : 'pending'}</div>
            {e.payload?.screenshot && <img class="shot" src={`/api/blob/${e.payload.screenshot}`} onClick={() => setZoom(`/api/blob/${e.payload.screenshot}`)} />}
          </div>
        ))}
      </>}
      {zoom && <Modal onClose={() => setZoom(null)}><img src={zoom} /></Modal>}
    </div>
  );
}
