import type { Config } from '../config/schema.ts';
import { resolveApiKey } from '../config/store.ts';
import { estimateTokens } from '../util/tokens.ts';
import { logger } from '../util/log.ts';
import { JevError, RETRYABLE, kindForStatus } from './errors.ts';
import { RateLimiter } from './rate-limit.ts';
import { validateRequest } from './validate.ts';
import {
  INPUT_PRICE_USD, type Answer, type EvaluateRequest, type EvaluateResult, type JevClient, type ProviderName,
} from './types.ts';

const log = logger('jev');
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

export interface JevClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/**
 * System One client for both providers. Both expose the same `/systemone` contract;
 * OpenRouter additionally returns `usage.cost`, `id` and `provider`.
 */
export function createJevClient(getConfig: () => Config, deps: JevClientDeps = {}): JevClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter({
    requestsPerMinute: () => getConfig().rateLimit.requestsPerMinute,
    tokensPerSecond: () => getConfig().rateLimit.tokensPerSecond,
    now,
    sleep,
  });

  async function once(provider: ProviderName, req: EvaluateRequest, signal?: AbortSignal): Promise<EvaluateResult> {
    const cfg = getConfig();
    const p = cfg.providers[provider];
    const key = resolveApiKey(cfg, provider);
    if (!key) throw new JevError('config', `No API key configured for provider "${provider}". Run: jev settings set providers.${provider}.apiKey -`, { provider });
    const body = JSON.stringify({ model: p.model, state: req.state, questions: req.questions });
    await limiter.acquire(estimateTokens(body));

    let attempts = 0;
    for (;;) {
      attempts++;
      const started = now();
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await doFetch(`${p.baseUrl.replace(/\/$/, '')}/systemone`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body,
          signal: combined,
        });
      } catch (e) {
        if (signal?.aborted) throw new JevError('aborted', 'JEV request aborted', { provider });
        const kind = timeout.aborted ? 'timeout' : 'network';
        if (attempts < MAX_ATTEMPTS) {
          const wait = backoffMs(attempts);
          log.warn(`${provider} ${kind} error, retry ${attempts}/${MAX_ATTEMPTS - 1} in ${Math.round(wait)}ms`, (e as Error).message);
          await sleep(wait);
          continue;
        }
        throw new JevError(kind, `JEV ${kind} error after ${attempts} attempts: ${(e as Error).message}`, { provider });
      }

      const text = await res.text();
      if (res.ok) {
        let data: any;
        try { data = JSON.parse(text); } catch {
          throw new JevError('server', `JEV returned invalid JSON (status ${res.status})`, { status: res.status, body: text.slice(0, 500), provider });
        }
        if (!data || typeof data.answers !== 'object') {
          throw new JevError('server', 'JEV response has no answers', { status: res.status, body: text.slice(0, 500), provider });
        }
        const inputTokens = Number(data.usage?.input_tokens ?? 0);
        const outputTokens = Number(data.usage?.output_tokens ?? 0);
        const reportedCost = data.usage?.cost;
        return {
          model: String(data.model ?? p.model),
          provider,
          answers: data.answers as Record<string, Answer>,
          usage: {
            inputTokens,
            outputTokens,
            costUsd: typeof reportedCost === 'number' ? reportedCost : inputTokens * INPUT_PRICE_USD,
          },
          latencyMs: now() - started,
          requestId: typeof data.id === 'string' ? data.id : undefined,
          attempts,
        };
      }

      const kind = kindForStatus(res.status);
      if (RETRYABLE.has(kind) && attempts < MAX_ATTEMPTS) {
        const wait = parseRetryAfter(res.headers.get('retry-after'), now()) ?? backoffMs(attempts);
        log.warn(`${provider} HTTP ${res.status}, retry ${attempts}/${MAX_ATTEMPTS - 1} in ${Math.round(wait)}ms`);
        await sleep(wait);
        continue;
      }
      const hint = kind === 'auth' ? ' Check the API key with: jev doctor' : '';
      throw new JevError(kind, `JEV HTTP ${res.status} from ${provider}.${hint}`, { status: res.status, body: text.slice(0, 2000), provider });
    }
  }

  return {
    async evaluate(req, opts = {}) {
      validateRequest(req);
      const cfg = getConfig();
      const primary = cfg.provider;
      try {
        return await once(primary, req, opts.signal);
      } catch (e) {
        const other: ProviderName = primary === 'openrouter' ? 'typesafe' : 'openrouter';
        if (e instanceof JevError && RETRYABLE.has(e.kind) && cfg.failover && resolveApiKey(cfg, other)) {
          log.warn(`failing over from ${primary} to ${other}: ${e.message}`);
          return await once(other, req, opts.signal);
        }
        throw e;
      }
    },
  };
}
