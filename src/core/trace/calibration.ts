import type { TraceStore, JevCallRecord } from './store.ts';

export interface CalibrationBin { lo: number; hi: number; n: number; accuracy: number | null; meanConfidence: number | null }
export interface CalibrationReport {
  template: string;
  n: number;
  accuracy: number | null;
  ece: number | null;
  bins: CalibrationBin[];
  recommend: { targetPrecision: number; act: number | null; coverage: number | null };
}

/** The decision confidence of a traced call: the main choice's confidence, or the certainty of its noul. */
export function callConfidence(call: JevCallRecord): number | null {
  const answers = call.answers as Record<string, any> | undefined;
  if (!answers) return null;
  const main = answers.pick ?? answers.next ?? Object.values(answers).find((a) => a?.type === 'choice');
  if (main?.type === 'choice') return main.confidence;
  const noul = Object.values(answers).find((a) => a?.type === 'noul');
  return noul ? Math.max(noul.noul, 1 - noul.noul) : null;
}

/** Reliability of JEV confidence per question template, from calls labeled right/wrong by verification or the agent. */
export function calibrationFromCalls(calls: JevCallRecord[], targetPrecision = 0.95, binCount = 10): CalibrationReport[] {
  const byTemplate = new Map<string, { conf: number; ok: boolean }[]>();
  for (const c of calls) {
    if (c.label === null || c.label === undefined) continue;
    const conf = callConfidence(c);
    if (conf === null) continue;
    const list = byTemplate.get(c.template) ?? [];
    list.push({ conf, ok: c.label });
    byTemplate.set(c.template, list);
  }
  const reports: CalibrationReport[] = [];
  for (const [template, pts] of byTemplate) {
    const bins: CalibrationBin[] = [];
    let ece = 0;
    for (let b = 0; b < binCount; b++) {
      const lo = b / binCount;
      const hi = (b + 1) / binCount;
      const inBin = pts.filter((p) => p.conf >= lo && (b === binCount - 1 ? p.conf <= hi : p.conf < hi));
      const acc = inBin.length ? inBin.filter((p) => p.ok).length / inBin.length : null;
      const mean = inBin.length ? inBin.reduce((s, p) => s + p.conf, 0) / inBin.length : null;
      if (acc !== null && mean !== null) ece += (inBin.length / pts.length) * Math.abs(acc - mean);
      bins.push({ lo, hi, n: inBin.length, accuracy: acc, meanConfidence: mean });
    }
    // Lowest threshold whose accepted decisions still meet the target precision (at least 5 decisions above it).
    const sorted = [...pts].sort((a, b) => b.conf - a.conf);
    let act: number | null = null;
    let coverage: number | null = null;
    let okCount = 0;
    for (let i = 0; i < sorted.length; i++) {
      okCount += sorted[i].ok ? 1 : 0;
      const n = i + 1;
      const next = sorted[i + 1];
      if (next && next.conf === sorted[i].conf) continue;
      if (n >= 5 && okCount / n >= targetPrecision) { act = Number(sorted[i].conf.toFixed(3)); coverage = n / sorted.length; }
    }
    reports.push({
      template, n: pts.length, accuracy: pts.filter((p) => p.ok).length / pts.length, ece: Number(ece.toFixed(4)), bins,
      recommend: { targetPrecision, act, coverage },
    });
  }
  return reports.sort((a, b) => b.n - a.n);
}

export function calibration(store: TraceStore, opts: { template?: string; sinceDays?: number; targetPrecision?: number } = {}): CalibrationReport[] {
  const since = opts.sinceDays ? Date.now() - opts.sinceDays * 86_400_000 : undefined;
  return calibrationFromCalls(store.getJevCalls({ template: opts.template, since, limit: 100_000 }), opts.targetPrecision ?? 0.95);
}
