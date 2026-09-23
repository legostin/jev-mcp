import { describe, it, expect } from 'vitest';
import { createJevClient } from '../../src/core/jev/client.ts';
import { JevError } from '../../src/core/jev/errors.ts';
import { playgroundUrl, decodePlayground } from '../../src/core/jev/playground.ts';
import { RateLimiter } from '../../src/core/jev/rate-limit.ts';
import { parseConfig } from '../../src/core/config/store.ts';
import type { Config } from '../../src/core/config/schema.ts';
import type { EvaluateRequest } from '../../src/core/jev/types.ts';

const REQ: EvaluateRequest = {
  state: { goal: 'log in' },
  questions: {
    next: { type: 'choice', instructions: 'Which element?', criteria: { e1: null, e2: null } },
    login: { type: 'noul', instructions: 'Is this a login page?' },
  },
};

const OK_BODY = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    next: { type: 'choice', choice: 'e2', probabilities: { e1: 0.1, e2: 0.9 }, confidence: 0.8 },
    login: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 400, output_tokens: 70, cost: 0.0000168 },
  id: 'gen-1',
};

function cfg(extra: Record<string, unknown> = {}): Config {
  return parseConfig({ providers: { openrouter: { apiKey: 'sk-or-v1-testkey000000' } }, ...extra });
}

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('JEV client', () => {
  it('posts to /systemone with bearer auth and parses the result', async () => {
    const { f, calls } = fakeFetch([json(200, OK_BODY)]);
    const client = createJevClient(() => cfg(), { fetch: f, sleep: async () => {} });
    const res = await client.evaluate(REQ);
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-testkey000000');
    const sent = JSON.parse(String(calls[0].init.body));
    expect(sent).toEqual({ model: 'typesafe/jev-1.13', state: REQ.state, questions: REQ.questions });
    expect(res.answers.next).toMatchObject({ type: 'choice', choice: 'e2' });
    expect(res.usage).toEqual({ inputTokens: 400, outputTokens: 70, costUsd: 0.0000168 });
    expect(res.provider).toBe('openrouter');
    expect(res.requestId).toBe('gen-1');
  });

  it('computes cost from tokens when the provider does not report it', async () => {
    const body = { ...OK_BODY, usage: { input_tokens: 1_000_000, output_tokens: 1 } };
    const { f, calls } = fakeFetch([json(200, body)]);
    const client = createJevClient(() => cfg({ provider: 'typesafe', providers: { typesafe: { apiKey: 'ts-key-123456789' } } }), { fetch: f });
    const res = await client.evaluate(REQ);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('jev-latest');
    expect(res.usage.costUsd).toBeCloseTo(0.042, 6);
  });

  it('retries 429 honoring retry-after', async () => {
    const sleeps: number[] = [];
    const { f, calls } = fakeFetch([json(429, { error: 'slow down' }, { 'retry-after': '1' }), json(200, OK_BODY)]);
    const client = createJevClient(() => cfg(), { fetch: f, sleep: async (ms) => { sleeps.push(ms); } });
    const res = await client.evaluate(REQ);
    expect(calls.length).toBe(2);
    expect(sleeps).toContain(1000);
    expect(res.attempts).toBe(2);
  });

  it('does not retry auth errors', async () => {
    const { f, calls } = fakeFetch([json(401, { error: 'bad key' })]);
    const client = createJevClient(() => cfg(), { fetch: f, sleep: async () => {} });
    await expect(client.evaluate(REQ)).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(calls.length).toBe(1);
  });

  it('maps 422 to validation with the body', async () => {
    const { f } = fakeFetch([json(422, { detail: 'criteria missing' })]);
    const client = createJevClient(() => cfg(), { fetch: f, sleep: async () => {} });
    const err = await client.evaluate(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(JevError);
    expect(err.kind).toBe('validation');
    expect(err.body).toContain('criteria missing');
  });

  it('gives up after 5 overloaded responses', async () => {
    const { f, calls } = fakeFetch(Array.from({ length: 5 }, () => json(529, {})));
    const client = createJevClient(() => cfg(), { fetch: f, sleep: async () => {} });
    await expect(client.evaluate(REQ)).rejects.toMatchObject({ kind: 'overloaded' });
    expect(calls.length).toBe(5);
  });

  it('fails over to the other provider when enabled', async () => {
    const { f, calls } = fakeFetch([...Array.from({ length: 5 }, () => json(529, {})), json(200, OK_BODY)]);
    const c = cfg({ failover: true, providers: { openrouter: { apiKey: 'sk-or-v1-testkey000000' }, typesafe: { apiKey: 'ts-key-123456789' } } });
    const client = createJevClient(() => c, { fetch: f, sleep: async () => {} });
    const res = await client.evaluate(REQ);
    expect(res.provider).toBe('typesafe');
    expect(calls[5].url).toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('reports a config error when no key is set', async () => {
    const client = createJevClient(() => parseConfig({}), { fetch: fakeFetch([]).f });
    await expect(client.evaluate(REQ)).rejects.toMatchObject({ kind: 'config' });
  });

  it('validates questions locally', async () => {
    const client = createJevClient(() => cfg(), { fetch: fakeFetch([]).f });
    const bad: EvaluateRequest = { state: 'x', questions: { q: { type: 'choice', instructions: 'pick', criteria: { only: null } } } };
    await expect(client.evaluate(bad)).rejects.toMatchObject({ kind: 'validation' });
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    await expect(client.evaluate({ state: 'x', questions: { q: { type: 'choice', instructions: 'pick', criteria: many } } }))
      .rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('rate limiter', () => {
  it('delays requests beyond the per-minute budget', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      requestsPerMinute: () => 2, tokensPerSecond: () => 1e9,
      now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    });
    await rl.acquire(10); await rl.acquire(10);
    expect(sleeps).toEqual([]);
    await rl.acquire(10);
    expect(sleeps[0]).toBe(60_000);
  });
});

describe('playground link', () => {
  it('round-trips state and questions', () => {
    const url = playgroundUrl({ a: 1 }, REQ.questions);
    expect(url.startsWith('https://console.typesafe.ai/decode#share/')).toBe(true);
    const decoded = decodePlayground(url) as { documentText: string; promptsText: string; apiVersion: string };
    expect(decoded.apiVersion).toBe('v1');
    expect(JSON.parse(decoded.documentText)).toEqual({ a: 1 });
    expect(JSON.parse(decoded.promptsText)).toEqual(REQ.questions);
  });
});
