import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';

export function Inspector({ tab }: { tab?: string }) {
  const [tabs, setTabs] = useState<any[]>([]);
  const [model, setModel] = useState<any>(null);
  const [region, setRegion] = useState<string>('r0');
  const [selected, setSelected] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api('/tabs').then(setTabs).catch((e) => setError(e.message)); }, []);
  const load = (fresh: boolean) => tab && api(`/model/${tab}${fresh ? '?fresh=1' : ''}`).then((m) => { setModel(m); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { setModel(null); setSelected(null); if (tab) load(false); }, [tab]);
  const hl = (refs: string[]) => tab && api('/highlight', { method: 'POST', json: { tab, refs } }).catch(() => {});

  const children = (id: string): any[] => model?.regions.filter((r: any) => r.parentId === id) ?? [];
  const inRegion = (id: string): Set<string> => {
    const ids = new Set([id]);
    let grew = true;
    while (grew) { grew = false; for (const r of model.regions) if (r.parentId && ids.has(r.parentId) && !ids.has(r.id)) { ids.add(r.id); grew = true; } }
    return ids;
  };
  const Tree = ({ id, depth }: { id: string; depth: number }) => (
    <>
      {children(id).map((r) => (
        <>
          <div class={region === r.id ? 'sel' : ''} style={{ paddingLeft: `${6 + depth * 12}px` }}
            onClick={() => { setRegion(r.id); hl(r.refs.filter((x: string) => model.elements.find((e: any) => e.ref === x)?.interactive)); }}>
            <b>{r.id}</b> {r.kind} {r.label && <span class="muted">"{r.label}"</span>} {r.blocking && <span class="badge failed">blocking</span>}
          </div>
          <Tree id={r.id} depth={depth + 1} />
        </>
      ))}
    </>
  );

  return (
    <div>
      <h1>Page inspector</h1>
      <div class="row">
        <select value={tab ?? ''} onChange={(e) => { location.hash = `#/inspect/${(e.target as HTMLSelectElement).value}`; }}>
          <option value="">Choose a tab…</option>
          {tabs.map((t) => <option value={t.id}>{t.id} [{t.driver}] {t.title || t.url}</option>)}
        </select>
        {tab && <button onClick={() => load(true)}>Re-observe</button>}
        {tab && <button onClick={() => hl([])}>Clear highlight</button>}
        {error && <span class="err">{error}</span>}
      </div>
      {model && (
        <div class="cols" style={{ marginTop: '12px' }}>
          <div class="card tree">
            <div class={region === 'r0' ? 'sel' : ''} onClick={() => setRegion('r0')}><b>r0</b> page <span class="muted">"{model.title}"</span></div>
            <Tree id="r0" depth={1} />
          </div>
          <div>
            <input placeholder="Filter elements" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} style={{ width: '100%', marginBottom: '8px' }} />
            <div class="card">
              {model.elements.filter((e: any) => inRegion(region).has(e.regionId))
                .filter((e: any) => !filter || `${e.ref} ${e.kind} ${e.name} ${e.value ?? ''}`.toLowerCase().includes(filter.toLowerCase()))
                .map((e: any) => (
                  <div class={`el ${e.interactive ? '' : 'dim'}`} onClick={() => { setSelected(e); hl([e.ref]); }}>
                    {e.ref} {e.kind} "{e.name}"{e.value ? ` value="${e.value}"` : ''}{e.occluded ? ' [covered]' : ''}{!e.inViewport ? ' [offscreen]' : ''} <span class="muted">{e.nameSource}</span>
                  </div>
                ))}
            </div>
            {selected && <div class="card"><b>{selected.ref}</b><pre>{JSON.stringify(selected, null, 2)}</pre></div>}
          </div>
        </div>
      )}
    </div>
  );
}
