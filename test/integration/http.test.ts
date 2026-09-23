import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const home = mkdtempSync(join(tmpdir(), 'jevh-'));
let daemon: any;
let stage: any;
let base = '';
let token = '';

function http(path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; headers: any; body: string }> {
  const u = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

beforeAll(async () => {
  process.env.JEV_HOME = home;
  process.env.JEV_FAKE = '1';
  process.env.JEV_HTTP_PORT = '0';
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(join(home, 'config', 'config.json'), JSON.stringify({ providers: { openrouter: { apiKey: 'sk-or-v1-httptestkey-000000000000' } } }));
  const { startDaemon } = await import('../../src/daemon/main.ts');
  const { registerStage2 } = await import('../../src/daemon/extend.ts');
  daemon = await startDaemon({ logToStderr: true });
  stage = await registerStage2(daemon, { httpPort: 0 });
  base = stage.http.url('/');
  token = stage.http.token;
}, 30_000);

afterAll(async () => {
  await daemon?.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('debug HTTP API', () => {
  it('requires the token and turns it into an HttpOnly cookie', async () => {
    expect((await http('/api/tasks')).status).toBe(401);
    const r = await http(`/?token=${token}`);
    expect(r.status).toBe(302);
    expect(String(r.headers['set-cookie'])).toMatch(/jev_ui=.*HttpOnly/);
    const cookie = String(r.headers['set-cookie']).split(';')[0];
    expect((await http('/api/tasks', { headers: { cookie } })).status).toBe(200);
    expect((await http('/api/tasks', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await http('/api/tasks', { headers: { cookie: 'jev_ui=wrong' } })).status).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await http('/api/tasks', { headers: { host: 'evil.example:80', authorization: `Bearer ${token}` } });
    expect(r.status).toBe(421);
  });

  it('serves settings without keys, replays JEV calls, and serves the UI', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const s = await http('/api/settings', { headers: auth });
    expect(s.body).not.toContain('httptestkey');
    expect(JSON.parse(s.body).providers.openrouter.apiKey).toMatch(/…/);
    const rep = await http('/api/replay', { method: 'POST', headers: auth, body: { state: { page: { elements: { e1: 'button "Go"' } } }, questions: { q: { type: 'noul', instructions: 'Is there a button?' } } } });
    expect(rep.status).toBe(200);
    expect(JSON.parse(rep.body).answers.q.type).toBe('noul');
    const calls = JSON.parse((await http('/api/calls?template=ui.replay', { headers: auth })).body);
    expect(calls.length).toBe(1);
    expect(calls[0].playground).toMatch(/console\.typesafe\.ai/);
    const index = await http('/', { headers: auth });
    if (existsSync('dist/ui/index.html')) expect(index.body).toContain('JEV Debug');
    const cal = await http('/api/calibration', { headers: auth });
    expect(Array.isArray(JSON.parse(cal.body))).toBe(true);
  });
});
