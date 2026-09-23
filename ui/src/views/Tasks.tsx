import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime, onTaskEvent } from '../api.ts';
import { Badge } from '../components.tsx';

export function Tasks() {
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = () => api('/tasks').then(setTasks).catch((e) => setError(e.message));
  useEffect(() => { load(); return onTaskEvent((ev) => { if (ev.type !== 'step') load(); }); }, []);
  if (error) return <p class="err">{error}</p>;
  if (!tasks) return <p class="muted">Loading…</p>;
  return (
    <div>
      <h1>Tasks</h1>
      {!tasks.length && <p class="muted">No tasks yet. Start one from your agent with jev_task.</p>}
      <table>
        <thead><tr><th>State</th><th>Goal</th><th>Steps</th><th>JEV calls</th><th>Questions</th><th>Cost</th><th>Started</th></tr></thead>
        <tbody>
          {tasks.map((t) => (
            <tr class="click" onClick={() => { location.hash = `#/task/${t.id}`; }}>
              <td><Badge value={t.state} />{t.pending && <> <span class="badge awaiting_input">question</span></>}</td>
              <td>{t.goal}<div class="muted small">{t.id}</div></td>
              <td>{t.stats?.steps ?? '—'}</td>
              <td>{t.stats?.jev_calls ?? '—'}</td>
              <td>{t.stats?.escalations ?? '—'}</td>
              <td>{t.stats ? `$${Number(t.stats.cost_usd).toFixed(4)}` : '—'}</td>
              <td class="muted">{fmtTime(t.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
