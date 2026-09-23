import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';

interface Field { path: string; label: string; kind: 'text' | 'number' | 'bool' | 'select' | 'secret' | 'json'; options?: string[]; step?: number }

const FIELDS: Field[] = [
  { path: 'provider', label: 'Provider', kind: 'select', options: ['openrouter', 'typesafe'] },
  { path: 'providers.openrouter.apiKey', label: 'OpenRouter API key', kind: 'secret' },
  { path: 'providers.openrouter.model', label: 'OpenRouter model', kind: 'text' },
  { path: 'providers.typesafe.apiKey', label: 'TypeSafe API key', kind: 'secret' },
  { path: 'providers.typesafe.model', label: 'TypeSafe model', kind: 'text' },
  { path: 'failover', label: 'Fail over between providers', kind: 'bool' },
  { path: 'confidence.preset', label: 'Confidence preset', kind: 'select', options: ['cautious', 'balanced', 'autonomous'] },
  { path: 'confidence.act', label: 'Act at confidence ≥ (all choices)', kind: 'number', step: 0.05 },
  { path: 'confidence.escalate', label: 'Ask below (0 = never ask on low confidence)', kind: 'number', step: 0.05 },
  { path: 'confidence.overrides', label: 'Per-decision overrides (JSON)', kind: 'json' },
  { path: 'domains', label: 'Per-domain settings (JSON)', kind: 'json' },
  { path: 'driver.default', label: 'Default driver', kind: 'select', options: ['auto', 'extension', 'chromium'] },
  { path: 'driver.chromium.headless', label: 'Headless chromium', kind: 'bool' },
  { path: 'notify.channel', label: 'Push questions via Claude Code channels', kind: 'bool' },
  { path: 'budgets.perTaskUsd', label: 'Budget per task (USD)', kind: 'number', step: 0.05 },
  { path: 'budgets.perDayUsd', label: 'Budget per day (USD)', kind: 'number', step: 0.5 },
  { path: 'limits.maxSteps', label: 'Max steps per task', kind: 'number', step: 1 },
  { path: 'limits.stateTokenTarget', label: 'JEV state token target', kind: 'number', step: 500 },
  { path: 'trace.screenshots', label: 'Screenshots in traces', kind: 'bool' },
  { path: 'trace.retentionDays', label: 'Trace retention (days)', kind: 'number', step: 1 },
  { path: 'memory.enabled', label: 'Site memory', kind: 'bool' },
];

const get = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

export function Settings() {
  const [cfg, setCfg] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const load = () => api('/settings').then(setCfg).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  if (!cfg) return <p class="muted">Loading…</p>;
  const save = async (f: Field, raw: string | boolean) => {
    let value: unknown = raw;
    try {
      if (f.kind === 'number') value = raw === '' ? undefined : Number(raw);
      if (f.kind === 'json') value = JSON.parse(String(raw));
      await api('/settings', { method: 'POST', json: { path: f.path, value } });
      setMsg(`Saved ${f.label}`);
      setDraft((d) => ({ ...d, [f.path]: '' }));
      load();
    } catch (e) { setMsg(`${f.label}: ${(e as Error).message}`); }
  };
  return (
    <div>
      <h1>Settings</h1>
      <p class="muted">Stored in ~/.config/jev-browser/config.json (owner-only). Keys are write-only.</p>
      <div class="kv">
        {FIELDS.map((f) => {
          const cur = get(cfg, f.path);
          const d = draft[f.path];
          return (
            <>
              <label>{f.label}<div class="muted small">{f.path}</div></label>
              <div class="row">
                {f.kind === 'bool' && <input type="checkbox" checked={!!cur} onChange={(e) => save(f, (e.target as HTMLInputElement).checked)} />}
                {f.kind === 'select' && <select value={cur ?? ''} onChange={(e) => save(f, (e.target as HTMLSelectElement).value)}>{f.options!.map((o) => <option value={o}>{o}</option>)}</select>}
                {(f.kind === 'text' || f.kind === 'number' || f.kind === 'secret') && <>
                  <input type={f.kind === 'number' ? 'number' : f.kind === 'secret' ? 'password' : 'text'} step={f.step}
                    placeholder={f.kind === 'secret' ? (cur ? `configured (${cur})` : 'not set') : ''}
                    value={d ?? (f.kind === 'secret' ? '' : cur ?? '')} onInput={(e) => setDraft({ ...draft, [f.path]: (e.target as HTMLInputElement).value })} />
                  <button disabled={d === undefined || (f.kind === 'secret' && !d)} onClick={() => save(f, d ?? '')}>Save</button>
                </>}
                {f.kind === 'json' && <>
                  <textarea style={{ minHeight: '60px' }} value={d ?? JSON.stringify(cur ?? {}, null, 1)} onInput={(e) => setDraft({ ...draft, [f.path]: (e.target as HTMLTextAreaElement).value })} />
                  <button disabled={d === undefined} onClick={() => save(f, d ?? '{}')}>Save</button>
                </>}
              </div>
            </>
          );
        })}
      </div>
      {msg && <p class="muted">{msg}</p>}
    </div>
  );
}
