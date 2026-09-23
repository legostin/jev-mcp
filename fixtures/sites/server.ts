import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

export const CITIES = [
  { name: 'Алматы', country: 'Казахстан', code: 'ALA' },
  { name: 'Астана', country: 'Казахстан', code: 'NQZ' },
  { name: 'Актау', country: 'Казахстан', code: 'SCO' },
  { name: 'Актобе', country: 'Казахстан', code: 'AKX' },
  { name: 'Анталия', country: 'Турция', code: 'AYT' },
  { name: 'Анкара', country: 'Турция', code: 'ESB' },
  { name: 'Амстердам', country: 'Нидерланды', code: 'AMS' },
  { name: 'Алания', country: 'Турция', code: 'GZP' },
  { name: 'Москва', country: 'Россия', code: 'MOW' },
  { name: 'Стамбул', country: 'Турция', code: 'IST' },
];

const AIRLINES = ['Air Astana', 'FlyArystan', 'SCAT', 'Pegasus', 'Turkish Airlines', 'AJet'];

/** Deterministic pseudo-random in [0,1) from a string seed. */
function rand(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/** Cheapest fare for a day: October 14 is the known global minimum for ALA→AYT. */
export function dayMinPrice(from: string, to: string, date: string): number {
  if (from === 'ALA' && to === 'AYT' && date === '2026-10-14') return 38900;
  return 41000 + Math.round(rand(`${from}${to}${date}`) * 40) * 500;
}

export interface Flight {
  id: string; price: number; airline: string; depart: string; arrive: string; durationMin: number; stops: number;
}

/** 30 flights per day; the first item is deliberately not the cheapest ("best" ordering). */
export function flightsFor(from: string, to: string, date: string): Flight[] {
  const min = dayMinPrice(from, to, date);
  const out: Flight[] = [];
  for (let i = 0; i < 30; i++) {
    const r = rand(`${from}${to}${date}#${i}`);
    const price = i === 17 ? min : min + 1500 + Math.round(r * 60) * 500;
    const depH = 5 + Math.floor(rand(`d${i}${date}`) * 17);
    const depM = Math.floor(rand(`m${i}${date}`) * 12) * 5;
    const dur = 300 + Math.floor(rand(`u${i}${date}`) * 60) * 10;
    const arr = depH * 60 + depM + dur;
    const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    out.push({
      id: `${date}-${i}`, price, airline: AIRLINES[Math.floor(r * AIRLINES.length)],
      depart: fmt(depH * 60 + depM), arrive: fmt(arr), durationMin: dur, stops: dur > 480 ? 1 : 0,
    });
  }
  return out;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function handler(peerOrigin: () => string) {
  return async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: string, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/api/suggest') {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const items = q ? CITIES.filter((c) => c.name.toLowerCase().startsWith(q)) : [];
      await new Promise((r) => setTimeout(r, 150));
      return send(200, JSON.stringify(items));
    }
    if (url.pathname === '/api/calendar') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const month = url.searchParams.get('month') ?? '2026-10';
      const [y, m] = month.split('-').map(Number);
      const days = new Date(y, m, 0).getDate();
      const prices: Record<string, number> = {};
      for (let d = 1; d <= days; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        if (date >= '2026-09-23') prices[date] = dayMinPrice(from, to, date);
      }
      return send(200, JSON.stringify(prices));
    }
    if (url.pathname === '/api/flights') {
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      const date = url.searchParams.get('date') ?? '';
      const page = Number(url.searchParams.get('page') ?? '1');
      const sort = url.searchParams.get('sort') ?? 'best';
      let all = flightsFor(from, to, date);
      if (sort === 'cheap') all = [...all].sort((a, b) => a.price - b.price);
      if (sort === 'fast') all = [...all].sort((a, b) => a.durationMin - b.durationMin);
      await new Promise((r) => setTimeout(r, 200));
      return send(200, JSON.stringify({ items: all.slice((page - 1) * 10, page * 10), total: all.length }));
    }
    if (url.pathname === '/peer-origin') return send(200, JSON.stringify({ origin: peerOrigin() }));
    const file = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(ROOT)) return send(403, 'forbidden', 'text/plain');
    try {
      let body = await readFile(file, 'utf8');
      body = body.replaceAll('__PEER_ORIGIN__', peerOrigin());
      return send(200, body, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      return send(404, 'not found', 'text/plain');
    }
  };
}

export interface FixtureServer { url(path: string): string; crossUrl(path: string): string; close(): Promise<void> }

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

/** Serves the fixture sites on two ports so iframes can be genuinely cross-origin. */
export async function startFixtureServer(): Promise<FixtureServer> {
  let portA = 0;
  let portB = 0;
  const a = createServer(handler(() => `http://127.0.0.1:${portB}`));
  const b = createServer(handler(() => `http://localhost:${portA}`));
  portA = await listen(a);
  portB = await listen(b);
  return {
    url: (p) => `http://localhost:${portA}/${p.replace(/^\//, '')}`,
    crossUrl: (p) => `http://127.0.0.1:${portB}/${p.replace(/^\//, '')}`,
    close: () => Promise.all([a, b].map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))).then(() => {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFixtureServer();
  console.log(`fixtures: ${s.url('flights.html')}  cross-origin: ${s.crossUrl('')}`);
}
