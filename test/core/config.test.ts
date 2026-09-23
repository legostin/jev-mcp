import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, setPath, getPath, redactConfig, resolveApiKey, coerceValue } from '../../src/core/config/store.ts';
import { resolveThresholds, PRESETS } from '../../src/core/config/thresholds.ts';

let dir: string;
let file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jevcfg-')); file = join(dir, 'config.json'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.JEV_OPENROUTER_API_KEY; });

describe('config store', () => {
  it('loads defaults when the file is missing', () => {
    const cfg = loadConfig(file);
    expect(cfg.provider).toBe('openrouter');
    expect(cfg.providers.openrouter.model).toBe('typesafe/jev-1.13');
    expect(cfg.providers.typesafe.baseUrl).toBe('https://api.typesafe.ai/v1');
    expect(cfg.confidence.preset).toBe('balanced');
    expect(cfg.limits.stateTokenTarget).toBe(6000);
  });

  it('persists keys with owner-only permissions', () => {
    const cfg = setPath(loadConfig(file), 'providers.openrouter.apiKey', 'sk-or-v1-abcdefghijklmnop');
    saveConfig(cfg, file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadConfig(file).providers.openrouter.apiKey).toBe('sk-or-v1-abcdefghijklmnop');
  });

  it('rejects invalid values', () => {
    expect(() => setPath(loadConfig(file), 'confidence.preset', 'reckless')).toThrow(/Invalid configuration/);
    expect(() => setPath(loadConfig(file), 'confidence.overrides', { 'ground.maybe': { act: 1 } })).toThrow();
  });

  it('reads nested paths and coerces CLI values', () => {
    const cfg = loadConfig(file);
    expect(getPath(cfg, 'driver.extensionPort')).toBe(47913);
    expect(coerceValue('0.4')).toBe(0.4);
    expect(coerceValue('true')).toBe(true);
    expect(coerceValue('balanced')).toBe('balanced');
  });

  it('JEV env key wins over the file key', () => {
    const cfg = setPath(loadConfig(file), 'providers.openrouter.apiKey', 'sk-or-v1-file-key-000000');
    expect(resolveApiKey(cfg, 'openrouter')).toBe('sk-or-v1-file-key-000000');
    process.env.JEV_OPENROUTER_API_KEY = 'sk-or-v1-env-key-111111';
    expect(resolveApiKey(cfg, 'openrouter')).toBe('sk-or-v1-env-key-111111');
  });

  it('redacts keys', () => {
    const cfg = setPath(loadConfig(file), 'providers.openrouter.apiKey', 'sk-or-v1-abcdefghijklmnop');
    const red = redactConfig(cfg);
    expect(red.providers.openrouter.apiKey).toBe('sk-or-…mnop');
    expect(JSON.stringify(red)).not.toContain('abcdefghijkl');
  });
});

describe('thresholds', () => {
  it('trial settings come from presets and layers', () => {
    expect(resolveThresholds({}).trial).toEqual({ enabled: true, floor: 0.25, tries: 2 });
    expect(resolveThresholds({ task: { preset: 'cautious' } }).trial.enabled).toBe(false);
    expect(resolveThresholds({ domain: { trial: { floor: 0.1 } }, live: { trial: { tries: 4 } } }).trial).toEqual({ enabled: true, floor: 0.1, tries: 4 });
  });
  it('uses the balanced preset by default', () => {
    expect(resolveThresholds({})).toEqual(PRESETS.balanced);
  });

  it('applies presets and per-kind overrides', () => {
    const th = resolveThresholds({ global: { preset: 'autonomous', overrides: { 'ground.choice': { act: 0.7 } } } });
    expect(th.ground.choice.act).toBe(0.7);
    expect(th.assess.choice.act).toBe(0.6);
  });

  it('task escalate:0 beats domain and global', () => {
    const th = resolveThresholds({
      global: { preset: 'cautious' }, domain: { escalate: 0.6 }, task: { escalate: 0 },
    });
    for (const k of ['assess', 'subintent', 'ground', 'verify', 'extract'] as const) expect(th[k].choice.escalate).toBe(0);
    expect(th.ground.choice.act).toBe(0.9);
  });

  it('live override wins over task', () => {
    const th = resolveThresholds({ task: { act: 0.9 }, live: { act: 0.3, escalate: 0.1 } });
    expect(th.ground.choice.act).toBe(0.3);
    expect(th.ground.choice.escalate).toBe(0.1);
  });

  it('keeps escalate <= act', () => {
    const th = resolveThresholds({ task: { act: 0.4, escalate: 0.8 } });
    expect(th.ground.choice.escalate).toBe(0.4);
  });

  it('noul overrides and shorthand', () => {
    const th = resolveThresholds({ task: { escalateOnUnsure: false, overrides: { 'verify.noul': { actYes: 0.9 } } } });
    expect(th.verify.noul.actYes).toBe(0.9);
    expect(th.assess.noul.escalateOnUnsure).toBe(false);
  });
});
