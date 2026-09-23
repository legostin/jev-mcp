import type { CalibrationReport } from '../core/trace/calibration.ts';

/** Terminal rendering of calibration reports: reliability per confidence bin and a threshold suggestion. */
export function printCalibration(reports: CalibrationReport[]): void {
  if (!reports.length) {
    console.log('No labeled JEV decisions yet. Run tasks (verified steps are labeled automatically) or `npm run eval`.');
    return;
  }
  for (const r of reports) {
    console.log(`\n${r.template}  n=${r.n}  accuracy ${((r.accuracy ?? 0) * 100).toFixed(1)}%  ECE ${r.ece}`);
    for (const b of [...r.bins].reverse()) {
      if (!b.n) continue;
      const acc = b.accuracy ?? 0;
      const bar = '█'.repeat(Math.round(acc * 20)).padEnd(20, '·');
      console.log(`  conf ${b.lo.toFixed(1)}-${b.hi.toFixed(1)}  ${bar}  ${(acc * 100).toFixed(0).padStart(3)}%  n=${b.n}`);
    }
    const kind = r.template.split('.')[0];
    if (r.recommend.act !== null) {
      console.log(`  → act at ≥ ${r.recommend.act} keeps ${(r.recommend.targetPrecision * 100).toFixed(0)}% precision and covers ${((r.recommend.coverage ?? 0) * 100).toFixed(0)}% of decisions`);
      if (['assess', 'subintent', 'ground', 'verify', 'extract'].includes(kind)) {
        console.log(`    jev settings set confidence.overrides '{"${kind}.choice":{"act":${r.recommend.act}}}'`);
      }
    } else console.log(`  → not enough labeled decisions for ${(r.recommend.targetPrecision * 100).toFixed(0)}% precision yet`);
  }
}
