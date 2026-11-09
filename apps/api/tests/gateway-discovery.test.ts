import { describe, expect, it } from 'bun:test';
import { createApp, drainingResponse } from '../src/gateway/app.js';
import { EXPORTS_PER_IP_PER_MIN, MAX_CONCURRENT_EXPORTS, PUBLIC_READS_PER_IP_PER_MIN } from '../src/gateway/discovery.js';

const API = 'https://api.agentenact.io';
const ORIGIN = 'https://app.agentenact.io';

function setup(o: { truncated?: boolean; fail?: boolean; exportCsv?: (name: string, x: { includeExcluded: boolean }) => Promise<{ csv: string; truncated: boolean }>; now?: () => number } = {}) {
  const calls: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const boom = () => { throw new Error('secret-detail-xyz'); };
  const app = createApp({
    sql: (async () => []) as never,
    verify: async () => null,
    passkey: {} as never,
    signRequests: {} as never,
    provisioner: {} as never,
    appOrigin: ORIGIN,
    log: (e) => void logs.push(e),
    discovery: {
      log: (e) => void logs.push(e),
      discovery: {
        stats: async () => (o.fail ? boom() : ({ agents: 1 } as never)),
        feed: async (f) => (calls.push(`feed ${JSON.stringify(f)}`), { items: [], latestSeq: 0 }),
        agents: async (a) => (calls.push(`agents ${JSON.stringify(a)}`), { items: [], next: null, payments: { source: 'agentkarma', available: true, asOf: null } }),
        profile: async (id) => (id === 7 ? ({ agentId: 7 } as never) : null),
      },
      intake: { submit: async () => ({ status: 'refused', code: 'malformed' }), record: async () => null },
      sealBySignature: async (sig) => (calls.push(`sig ${sig}`), sig.startsWith('Fy') ? 'ab'.repeat(32) : null),
      exportCsv: o.exportCsv
        ? (name, x) => (calls.push(`csv ${name} ${x.includeExcluded}`), o.exportCsv!(name, x))
        : async (name, x) => (calls.push(`csv ${name} ${x.includeExcluded}`), { csv: 'a,b\n1,2\n', truncated: o.truncated === true }),
      ...(o.now ? { now: o.now } : {}),
    },
  });
  return { app, calls, logs };
}
const get = (app: ReturnType<typeof createApp>, path: string, ip = '203.0.113.1') => app(new Request(`${API}${path}`), ip);

describe('gateway: public discovery routes', () => {
  it('serves each endpoint as json with ACAO * and its cache-control', async () => {
    const { app, calls } = setup();
    for (const [path, cache] of [['/public/stats', 'public, max-age=5'], ['/public/feed?after=3&limit=10', 'public, max-age=2'], ['/public/agents?q=bot&limit=5', 'public, max-age=5'], ['/public/agents/7', 'public, max-age=5']] as const) {
      const r = await get(app, path);
      expect([path, r.status, r.headers.get('access-control-allow-origin'), r.headers.get('cache-control'), r.headers.get('content-type')]).toEqual([path, 200, '*', cache, 'application/json']);
    }
    expect(calls).toEqual(['feed {"after":3,"limit":10}', 'agents {"q":"bot","limit":5}']);
    expect(((await get(app, '/public/stats')).headers.get('access-control-expose-headers'))).toContain('retry-after');
  });

  it('finds a seal by its signature in the query; unknown is tx null with 200, junk is 400', async () => {
    const { app, calls } = setup();
    const sig = 'FyLPmvo4q/MnIYUX2vuM4Tv9PihpgTWqwU2rnp4qu8sLZSM+l4z/QaIOK71rV254yYhdpit6cEFU2fPDl8EQCQ==';
    const hit = await get(app, `/public/seals/by-signature?sig=${encodeURIComponent(sig)}`);
    expect([hit.status, hit.headers.get('access-control-allow-origin'), await hit.json()]).toEqual([200, '*', { tx: 'ab'.repeat(32) }]);
    const miss = await get(app, `/public/seals/by-signature?sig=${encodeURIComponent('A'.repeat(86) + '==')}`);
    expect([miss.status, await miss.json()]).toEqual([200, { tx: null }]);
    expect((await get(app, '/public/seals/by-signature?sig=nope')).status).toBe(400);
    expect(calls).toEqual([`sig ${sig}`, `sig ${'A'.repeat(86)}==`]);
  });

  it('passes junk limit/after to the queries (they clamp) instead of rejecting', async () => {
    const { app, calls } = setup();
    expect((await get(app, '/public/feed?after=-5&limit=abc')).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('answers a preflight for /public/records with the public headers', async () => {
    const { app } = setup();
    const r = await app(new Request(`${API}/public/records`, { method: 'OPTIONS', headers: { origin: 'https://agentenact.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } }));
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(r.headers.get('access-control-allow-headers')).toBe('content-type');
    expect(drainingResponse('/public/stats').headers.get('access-control-allow-origin')).toBe('*');
  });

  it('404s an unknown or non-numeric agent id', async () => {
    const { app } = setup();
    for (const p of ['/public/agents/999', '/public/agents/abc', '/public/agents/12345678901', '/public/nothing']) {
      const r = await get(app, p);
      expect([p, r.status, r.headers.get('access-control-allow-origin')]).toEqual([p, 404, '*']);
    }
    expect(await (await get(app, '/public/agents/999')).json()).toEqual({ error: 'not_found' });
  });

  it('returns csv with attachment headers; payments honors include=excluded', async () => {
    const { app, calls } = setup({ truncated: true });
    const r = await get(app, '/public/export/payments.csv?include=excluded');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="payments.csv"');
    expect(r.headers.get('cache-control')).toBe('public, max-age=60');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.get('x-truncated')).toBe('1');
    expect(await r.text()).toBe('a,b\n1,2\n');
    const plain = await get(app, '/public/export/agents.csv?include=excluded');
    expect(plain.headers.get('x-truncated')).toBe('1');
    expect(calls).toEqual(['csv payments true', 'csv agents false']);
    expect((await get(app, '/public/export/secrets.csv')).status).toBe(404);
  });

  it('omits x-truncated when the export is complete', async () => {
    const { app } = setup();
    expect((await get(app, '/public/export/proven-sales.csv')).headers.get('x-truncated')).toBeNull();
  });

  it('400s a q longer than 64 characters', async () => {
    const { app } = setup();
    const r = await get(app, `/public/agents?q=${'x'.repeat(65)}`);
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([400, { error: 'bad_query' }, '*']);
    expect((await get(app, `/public/agents?q=${'x'.repeat(64)}`)).status).toBe(200);
  });

  it('passes sort and filters to the agents query, and 400s unknown ones', async () => {
    const { app, calls } = setup();
    expect((await get(app, '/public/agents?sort=paid&built=agentenact&sells=1&hire=1&paid=1')).status).toBe(200);
    expect((await get(app, '/public/agents?sort=&built=&sells=0')).status).toBe(200);
    expect(calls).toEqual(['agents {"sort":"paid","filter":{"built":"agentenact","sells":true,"hire":true,"paid":true}}', 'agents {}']);
    for (const [q, error] of [['sort=cheapest', 'bad_sort'], ['built=hosted', 'bad_filter']] as const) {
      const r = await get(app, `/public/agents?${q}`);
      expect([r.status, await r.json()]).toEqual([400, { error }]);
    }
  });

  it('rate limits one ip at 120 per minute and reports retry-after', async () => {
    const { app } = setup();
    for (let i = 0; i < PUBLIC_READS_PER_IP_PER_MIN; i++) expect((await get(app, '/public/stats', '198.51.100.5')).status).toBe(200);
    const r = await get(app, '/public/stats', '198.51.100.5');
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([429, { error: 'rate_limited' }, '*']);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get(app, '/public/stats', '198.51.100.6')).status).toBe(200);
  });

  it('a thrown query gives 500 internal and logs without the error text', async () => {
    const { app, logs } = setup({ fail: true });
    const r = await get(app, '/public/stats');
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([500, { error: 'internal' }, '*']);
    expect(logs).toEqual([{ event: 'unhandled', path: '/public/stats' }]);
    expect(JSON.stringify(logs)).not.toContain('secret-detail');
  });

  it('existing routes are unaffected: /health still works and /a/ keeps its own preflight', async () => {
    const { app } = setup();
    const h = await app(new Request(`${API}/health`, { headers: { origin: ORIGIN } })).catch(() => null);
    expect(h?.status).toBe(200);
    expect(h?.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    const p = await app(new Request(`${API}/a/00000000-0000-0000-0000-000000000000/x`, { method: 'OPTIONS' }));
    expect(p.headers.get('access-control-allow-headers')).toContain('payment-signature');
    const o = await app(new Request(`${API}/api/me`, { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(o.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('gateway: public csv export cost control', () => {
  const ok = { csv: 'a,b\n1,2\n', truncated: false };

  it('has its own small per-ip bucket, separate from the cheap reads', async () => {
    const { app } = setup();
    for (let i = 0; i < EXPORTS_PER_IP_PER_MIN; i++) expect((await get(app, `/public/export/${i % 2 ? 'agents' : 'proven-sales'}.csv`, '198.51.100.9')).status).toBe(200);
    const r = await get(app, '/public/export/agents.csv', '198.51.100.9');
    expect([r.status, await r.json(), r.headers.get('access-control-allow-origin')]).toEqual([429, { error: 'rate_limited' }, '*']);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get(app, '/public/stats', '198.51.100.9')).status).toBe(200); // reads are untouched
    expect((await get(app, '/public/export/agents.csv', '198.51.100.10')).status).toBe(200);
  });

  it('exports do not spend the read budget, and a read flood does not block an export', async () => {
    const { app } = setup();
    for (let i = 0; i < PUBLIC_READS_PER_IP_PER_MIN; i++) await get(app, '/public/stats', '198.51.100.11');
    expect((await get(app, '/public/stats', '198.51.100.11')).status).toBe(429);
    expect((await get(app, '/public/export/agents.csv', '198.51.100.11')).status).toBe(200);
  });

  it('builds each (name, include) once per cache window and rebuilds after it', async () => {
    let t = 1_000_000;
    const { app, calls } = setup({ now: () => t });
    const ips = ['203.0.113.21', '203.0.113.22', '203.0.113.23', '203.0.113.24', '203.0.113.25'];
    for (const ip of ips) expect(await (await get(app, '/public/export/agents.csv', ip)).text()).toBe('a,b\n1,2\n');
    expect(calls).toEqual(['csv agents false']);
    await get(app, '/public/export/payments.csv?include=excluded', ips[0]);
    await get(app, '/public/export/payments.csv', ips[0]);
    await get(app, '/public/export/payments.csv?include=excluded', ips[1]);
    expect(calls).toEqual(['csv agents false', 'csv payments true', 'csv payments false']);
    t += 31_000;
    await get(app, '/public/export/agents.csv', ips[2]);
    expect(calls.filter((c) => c === 'csv agents false')).toHaveLength(2);
  });

  it('concurrent identical requests share one build', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app, calls } = setup({ exportCsv: async () => (await gate, ok) });
    const reqs = ['203.0.113.31', '203.0.113.32', '203.0.113.33'].map((ip) => get(app, '/public/export/proven-sales.csv', ip));
    await Bun.sleep(5);
    release();
    expect((await Promise.all(reqs)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toEqual(['csv proven-sales false']);
  });

  it('caps concurrent builds: the extra one gets 503 busy with retry-after, cached ones are still served', async () => {
    const gates = new Map<string, () => void>();
    const { app } = setup({ exportCsv: (name) => new Promise((res) => gates.set(name, () => res(ok))) });
    const names = ['agents', 'proven-sales', 'activity'];
    expect(MAX_CONCURRENT_EXPORTS).toBe(2);
    const first = names.slice(0, 2).map((n, i) => get(app, `/public/export/${n}.csv`, `203.0.113.4${i}`));
    await Bun.sleep(5);
    const busy = await get(app, `/public/export/${names[2]}.csv`, '203.0.113.49');
    expect([busy.status, await busy.json(), busy.headers.get('access-control-allow-origin')]).toEqual([503, { error: 'busy' }, '*']);
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    gates.get('agents')!();
    gates.get('proven-sales')!();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    const again = get(app, `/public/export/${names[2]}.csv`, '203.0.113.50'); // the slot is free again
    await Bun.sleep(5);
    gates.get('activity')!();
    expect((await again).status).toBe(200);
    expect((await get(app, '/public/export/agents.csv', '203.0.113.51')).status).toBe(200); // cached: no new build
  });

  it('a failed build is not cached, frees its slot and answers a plain 500', async () => {
    let fail = true;
    const { app, logs } = setup({ exportCsv: async () => (fail ? Promise.reject(new Error('secret-detail-xyz')) : ok) });
    const r = await get(app, '/public/export/agents.csv', '203.0.113.61');
    expect([r.status, await r.json()]).toEqual([500, { error: 'internal' }]);
    expect(JSON.stringify(logs)).not.toContain('secret-detail-xyz');
    fail = false;
    expect((await get(app, '/public/export/agents.csv', '203.0.113.62')).status).toBe(200);
  });
});
