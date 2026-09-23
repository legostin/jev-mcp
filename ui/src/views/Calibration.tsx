import { useEffect, useState } from 'preact/hooks';
import { api } from '../api.ts';

function Diagram({ bins }: { bins: any[] }) {
  const W = 260, H = 200, P = 26;
  const x = (v: number) => P + v * (W - P - 6);
  const y = (v: number) => H - P - v * (H - P - 8);
  return (
    <svg width={W} height={H}>
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="currentColor" opacity="0.25" stroke-dasharray="4 3" />
      <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} stroke="currentColor" opacity="0.3" />
      <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} stroke="currentColor" opacity="0.3" />
      {bins.map((b) => b.n > 0 && (
        <g>
          <rect x={x(b.lo) + 1} y={y(b.accuracy)} width={x(b.hi) - x(b.lo) - 2} height={y(0) - y(b.accuracy)} fill="var(--bar)" opacity={Math.min(1, 0.35 + b.n / 20)}>
            <title>{`confidence ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}: accuracy ${(b.accuracy * 100).toFixed(0)}% (n=${b.n})`}</title>
          </rect>
        </g>
      ))}
      <text x={x(0)} y={H - 8}>0</text><text x={x(1) - 6} y={H - 8}>1</text><text x={2} y={y(1) + 4}>1</text>
      <text x={W / 2 - 30} y={H - 2}>confidence</text>
    </svg>
  );
}

export function Calibration() {
  const [precision, setPrecision] = useState(0.95);
  const [reports, setReports] = useState<any[] | null>(null);
  useEffect(() => { api(`/calibration?precision=${precision}`).then(setReports).catch(() => setReports([])); }, [precision]);
  return (
    <div>
      <h1>Calibration</h1>
      <p class="muted">How often JEV was right at each confidence level, per question template. Labels come from verified steps, agent answers, evals and manual ✓/✗ marks in task timelines. Bars on the dashed diagonal mean well-calibrated confidence.</p>
      <div class="row">Target precision
        <input type="range" min="0.8" max="0.99" step="0.01" value={precision} onInput={(e) => setPrecision(Number((e.target as HTMLInputElement).value))} />
        <b>{(precision * 100).toFixed(0)}%</b>
      </div>
      {!reports && <p class="muted">Loading…</p>}
      {reports && !reports.length && <p class="muted">No labeled decisions yet. Run tasks or `npm run eval`.</p>}
      <div class="row" style={{ alignItems: 'flex-start', marginTop: '10px' }}>
        {reports?.map((r) => (
          <div class="card">
            <b>{r.template}</b>
            <div class="muted small">n={r.n} · accuracy {(r.accuracy * 100).toFixed(1)}% · ECE {r.ece}</div>
            <Diagram bins={r.bins} />
            <div>{r.recommend.act !== null
              ? <>Act at ≥ <b>{r.recommend.act}</b> for {(precision * 100).toFixed(0)}% precision (covers {(r.recommend.coverage * 100).toFixed(0)}% of decisions)<div class="muted small">set: confidence.overrides["{r.template.split('.')[0]}.choice"].act</div></>
              : <span class="muted">Not enough data for {(precision * 100).toFixed(0)}% precision</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
