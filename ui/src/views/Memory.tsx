import { useEffect, useState } from 'preact/hooks';
import { api, fmtTime } from '../api.ts';

export function Memory() {
  const [data, setData] = useState<any>(null);
  const load = () => api('/memory').then(setData).catch(() => setData({ entries: [], hints: [] }));
  useEffect(() => { load(); }, []);
  if (!data) return <p class="muted">Loading…</p>;
  const remove = (id: string) => api(`/memory/${id}`, { method: 'DELETE' }).then(load);
  const weight = (id: string, w: number) => api(`/memory/${id}`, { method: 'PATCH', json: { weight: w } }).then(load);
  return (
    <div>
      <h1>Site memory</h1>
      <p class="muted">What JEV learned per site: which element served which purpose. A memory hit is still confirmed by JEV before acting; two misses in a row disable an entry.</p>
      <table>
        <thead><tr><th>Domain</th><th>Page</th><th>Purpose</th><th>Weight</th><th>✓ / ✗</th><th>Updated</th><th /></tr></thead>
        <tbody>
          {data.entries.map((e: any) => (
            <tr>
              <td>{e.domain}</td><td>{e.pageKind}</td><td>{e.key}<div class="muted small">sig {e.sig}</div></td>
              <td>
                <input type="number" step="0.5" min="0" max="5" value={e.weight} style={{ width: '64px' }}
                  onChange={(ev) => weight(e.id, Number((ev.target as HTMLInputElement).value))} />
                {e.disabled && <span class="badge failed">disabled</span>}
              </td>
              <td>{e.successes} / {e.failures}</td>
              <td class="muted">{fmtTime(e.updatedAt)}</td>
              <td><button class="danger" onClick={() => remove(e.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!data.entries.length && <p class="muted">Nothing learned yet.</p>}
      <h2>Site hints</h2>
      {data.hints.map((h: any) => (
        <div class="row"><b>{h.domain}</b><span class="grow">{h.text}</span><button class="danger" onClick={() => remove(h.id)}>Delete</button></div>
      ))}
      {!data.hints.length && <p class="muted">No hints. Agents add them with jev_answer (type "hint", scope "domain").</p>}
    </div>
  );
}
