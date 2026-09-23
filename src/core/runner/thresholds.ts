import type { Config, ConfidenceConfig } from '../config/schema.ts';
import { resolveThresholds, type Thresholds } from '../config/thresholds.ts';

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Global config, then the matching domain entry, then the task, then a live override. */
export function thresholdsFor(cfg: Config, url: string, task?: ConfidenceConfig, live?: ConfidenceConfig): Thresholds {
  const host = hostOf(url);
  const domainEntry = Object.entries(cfg.domains).find(([d]) => host === d || host.endsWith(`.${d}`))?.[1];
  return resolveThresholds({ global: cfg.confidence, domain: domainEntry?.confidence, task, live });
}
