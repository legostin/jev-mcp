import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, flightsFor, dayMinPrice, type FixtureServer } from '../../fixtures/sites/server.ts';

let srv: FixtureServer;
beforeAll(async () => { srv = await startFixtureServer(); });
afterAll(async () => { await srv.close(); });

describe('fixture server', () => {
  it('serves pages on two origins with peer substitution', async () => {
    const outer = await (await fetch(srv.url('iframe-outer.html'))).text();
    expect(outer).toContain(new URL(srv.crossUrl('')).origin);
    const inner = await fetch(srv.crossUrl('iframe-inner.html'));
    expect(inner.status).toBe(200);
  });

  it('paginates flights by 10 and keeps the day minimum consistent with the calendar', async () => {
    const res = await (await fetch(srv.url('api/flights?from=ALA&to=AYT&date=2026-10-14&page=1'))).json();
    expect(res.items).toHaveLength(10);
    expect(res.total).toBe(30);
    const all = flightsFor('ALA', 'AYT', '2026-10-14');
    expect(Math.min(...all.map((f) => f.price))).toBe(dayMinPrice('ALA', 'AYT', '2026-10-14'));
    expect(dayMinPrice('ALA', 'AYT', '2026-10-14')).toBe(38900);
    const cal = await (await fetch(srv.url('api/calendar?from=ALA&to=AYT&month=2026-10'))).json();
    expect(Math.min(...Object.values(cal as Record<string, number>))).toBe(38900);
  });

  it('suggests cities by prefix', async () => {
    const res = await (await fetch(srv.url('api/suggest?q=' + encodeURIComponent('Алм')))).json();
    expect(res.map((c: { code: string }) => c.code)).toEqual(['ALA']);
  });
});
