import { DECISION_KINDS, type ConfidenceConfig, type DecisionKind, type PresetName } from './schema.ts';

export interface ChoiceThresholds { act: number; escalate: number; margin: number | null }
export interface NoulThresholds { actYes: number; actNo: number; escalateOnUnsure: boolean }
export interface KindThresholds { choice: ChoiceThresholds; noul: NoulThresholds }
export type Thresholds = Record<DecisionKind, KindThresholds>;

function uniform(choice: ChoiceThresholds, noul: NoulThresholds): Thresholds {
  const out = {} as Thresholds;
  for (const k of DECISION_KINDS) out[k] = { choice: { ...choice }, noul: { ...noul } };
  return out;
}

/** Starting points only; the calibration view recommends per-template values from traces. */
export const PRESETS: Record<PresetName, Thresholds> = {
  cautious: uniform({ act: 0.9, escalate: 0.7, margin: 0.3 }, { actYes: 0.85, actNo: 0.15, escalateOnUnsure: true }),
  balanced: uniform({ act: 0.85, escalate: 0.55, margin: null }, { actYes: 0.8, actNo: 0.2, escalateOnUnsure: true }),
  autonomous: uniform({ act: 0.6, escalate: 0.2, margin: null }, { actYes: 0.65, actNo: 0.35, escalateOnUnsure: true }),
};

function applyLayer(base: Thresholds, layer: ConfidenceConfig | undefined): Thresholds {
  if (!layer) return base;
  // A preset in a layer replaces everything accumulated from lower layers.
  let th: Thresholds = layer.preset ? structuredClone(PRESETS[layer.preset]) : structuredClone(base);
  for (const k of DECISION_KINDS) {
    if (layer.act !== undefined) th[k].choice.act = layer.act;
    if (layer.escalate !== undefined) th[k].choice.escalate = layer.escalate;
    if (layer.escalateOnUnsure !== undefined) th[k].noul.escalateOnUnsure = layer.escalateOnUnsure;
  }
  for (const [key, value] of Object.entries(layer.overrides ?? {})) {
    const [kind, primitive] = key.split('.') as [DecisionKind, 'choice' | 'noul'];
    const target = th[kind][primitive] as unknown as Record<string, unknown>;
    for (const [field, v] of Object.entries(value)) if (v !== undefined) target[field] = v;
  }
  // Keep the band well-formed: escalate can never exceed act.
  for (const k of DECISION_KINDS) {
    const c = th[k].choice;
    if (c.escalate > c.act) c.escalate = c.act;
    const n = th[k].noul;
    if (n.actNo > n.actYes) n.actNo = n.actYes;
  }
  return th;
}

/** Layers apply lowest to highest precedence: global config, domain, task, live override. */
export function resolveThresholds(layers: {
  global?: ConfidenceConfig; domain?: ConfidenceConfig; task?: ConfidenceConfig; live?: ConfidenceConfig;
}): Thresholds {
  let th = structuredClone(PRESETS.balanced);
  for (const layer of [layers.global, layers.domain, layers.task, layers.live]) th = applyLayer(th, layer);
  return th;
}
