import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Db } from '../src/db/index.js';
import { createApp, drainingResponse, PAID_PER_IP_PER_MIN, type AppDeps } from '../src/gateway/app.js';
import { Keypair } from '@stellar/stellar-sdk';
import { createRecords } from '../src/records/index.js';
import { createSpecs } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { insertAgent, insertUser } from './support/fixtures.js';
import { signedRecord } from './support/records.js';
import { activeAgent, minimalSpec } from './support/specs.js';

const ORIGIN = 'https://app.agentenact.io';
const API = 'https://api.agentenact.io';

describe('gateway: paid route and agent.json', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  const handled: [string, string][] = [];
  const mcpHandled: string[] = [];
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    const deps: AppDeps = {
      sql,
      verify: async () => null,
      passkey: {} as never,
      signRequests: {} as never,
      provisioner: {} as never,
      appOrigin: ORIGIN,
      records: createRecords(sql),
      services: {
        endpoint: {
          handle: async (_req, id, slug) => (handled.push([id, slug]), new Response('{"summary":"ok"}', { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })),
          resourceUrl: (id, slug) => `https://public.example.test/a/${id}/${slug}`,
        },
        specs: createSpecs(sql),
        mcp: { handle: async (_req, id) => (mcpHandled.push(id), new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { 'content-type': 'application/json' } })) },
      },
    };
    app = createApp(deps);
  });
  afterAll(() => drop());

  it('routes POST /a/:uuid/:slug to the endpoint (uuid lower-cased)', async () => {
    const id = crypto.randomUUID();
    const r = await app(new Request(`${API}/a/${id.toUpperCase()}/summary`, { method: 'POST', body: '{}' }), '203.0.113.7');
    expect([r.status, await r.json()]).toEqual([200, { summary: 'ok' }]);
    expect(handled.at(-1)).toEqual([id, 'summary']);
  });

  it('routes POST /a/:uuid/mcp to the agent\'s MCP server, never to a service called mcp', async () => {
    const id = crypto.randomUUID();
    const before = handled.length;
    const r = await app(new Request(`${API}/a/${id}/mcp`, { method: 'POST', body: '{}' }), '203.0.113.8');
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(mcpHandled.at(-1)).toBe(id);
    expect(handled.length).toBe(before);
  });

  it('rate-limits paid calls per IP before the endpoint runs', async () => {
    const id = crypto.randomUUID();
    const before = handled.length;
    for (let i = 0; i < PAID_PER_IP_PER_MIN; i++) await app(new Request(`${API}/a/${id}/summary`, { method: 'POST', body: '{}' }), '198.51.100.9');
    const limited = await app(new Request(`${API}/a/${id}/summary`, { method: 'POST', body: '{}' }), '198.51.100.9');
    expect([limited.status, await limited.json()]).toEqual([429, { error: 'rate_limited' }]);
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(handled.length - before).toBe(PAID_PER_IP_PER_MIN);
  });

  it('allows the request headers the x402 client sends on the paid retry', async () => {
    // @x402/fetch 2.24.0 sets Access-Control-Expose-Headers as a REQUEST header, so browsers list it in the preflight.
    const r = await app(new Request(`${API}/a/${crypto.randomUUID()}/summary`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,payment-signature,access-control-expose-headers' },
    }));
    const allowed = (r.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());
    for (const h of ['content-type', 'payment-signature', 'access-control-expose-headers']) expect(allowed).toContain(h);
  });

  it('gives every /a/ miss the public CORS, never the app origin', async () => {
    const id = crypto.randomUUID();
    const reqs = [
      new Request(`${API}/a/${id}/summary`, { method: 'GET' }),
      new Request(`${API}/a/${id}/summary`, { method: 'PUT', body: '{}' }),
      new Request(`${API}/a/${id}/agent.json`, { method: 'POST', body: '{}' }),
      new Request(`${API}/a/${id}/Summary`, { method: 'POST', body: '{}' }),
    ];
    for (const q of reqs) {
      const r = await app(q, '192.0.2.77');
      expect([q.method, r.status, r.headers.get('access-control-allow-origin')]).toEqual([q.method, 404, '*']);
    }
  });

  it('exposes retry-after to browsers on public responses', async () => {
    const r = await app(new Request(`${API}/a/${crypto.randomUUID()}/summary`, { method: 'OPTIONS' }));
    expect(r.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('retry-after');
  });

  it('answers a draining 503 on /a/ with public CORS and connection: close, and no CORS elsewhere', () => {
    const paid = drainingResponse('/a/abc/summary');
    expect([paid.status, paid.headers.get('access-control-allow-origin'), paid.headers.get('connection')]).toEqual([503, '*', 'close']);
    const other = drainingResponse('/api/me');
    expect([other.status, other.headers.get('access-control-allow-origin'), other.headers.get('connection')]).toEqual([503, null, 'close']);
  });

  it('answers a public preflight for /a/ paths', async () => {
    const r = await app(new Request(`${API}/a/${crypto.randomUUID()}/summary`, { method: 'OPTIONS' }));
    expect(r.status).toBe(204);
    expect([r.headers.get('access-control-allow-origin'), r.headers.get('access-control-allow-methods'), r.headers.get('access-control-allow-headers')]).toEqual(['*', 'GET, POST', 'content-type, payment-signature, access-control-expose-headers, agentenact-delegation, accept, mcp-protocol-version, mcp-session-id']);
    expect(r.headers.get('access-control-expose-headers')).toContain('PAYMENT-RESPONSE');
    const app2 = await app(new Request(`${API}/api/me`, { method: 'OPTIONS', headers: { origin: ORIGIN } }));
    expect(app2.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('agent.json lists live services, and an empty list without any', async () => {
    const a = await activeAgent(sql);
    expect(await (await app(new Request(`${API}/a/${a.agentId}/agent.json`))).json()).toEqual({ name: 'test agent', description: '', agentId: 77, agentWallet: a.address, services: [] });
    const specs = createSpecs(sql);
    const input_schema = { type: 'object' as const, properties: { text: { type: 'string' as const } } };
    const output_schema = { type: 'object' as const, properties: { summary: { type: 'string' as const } } };
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ services: [{ slug: 'summary', description: 'Summarise text', price_usdc: '0.01', input_schema, output_schema, persona: 'p', skill_body: '', tools: [] }] })));
    expect(await (await app(new Request(`${API}/a/${a.agentId}/agent.json`))).json()).toEqual({
      name: 'test agent',
      description: '',
      agentId: 77,
      agentWallet: a.address,
      services: [{ slug: 'summary', description: 'Summarise text', price_usdc: '0.01', url: `https://public.example.test/a/${a.agentId}/summary`, input_schema, output_schema }],
      // With a live service, the agent's MCP server is listed as an ERC-8004 endpoint.
      endpoints: [{ name: 'MCP', endpoint: `https://public.example.test/a/${a.agentId}/mcp`, version: '2025-06-18' }],
    });
  });

  it('a request with no resolvable address shares one bucket instead of skipping the limit', async () => {
    const id = crypto.randomUUID();
    for (let i = 0; i < PAID_PER_IP_PER_MIN; i++) await app(new Request(`${API}/a/${id}/summary`, { method: 'POST', body: '{}' }));
    expect((await app(new Request(`${API}/a/${id}/summary`, { method: 'POST', body: '{}' }))).status).toBe(429);
  });

  it('agent.json lists no service before the agent is active (its agentURI is public while it provisions)', async () => {
    const userId = await insertUser(sql);
    const agentId = await insertAgent(sql, userId, { name: 'Early' }); // status 'provisioning'
    const specs = createSpecs(sql);
    const schema = { type: 'object' as const, properties: { text: { type: 'string' as const } } };
    await specs.approve(userId, agentId, await specs.saveDraft(userId, agentId, minimalSpec({ services: [{ slug: 'summary', description: 'Summarise', price_usdc: '0.01', input_schema: schema, output_schema: schema, persona: 'p', skill_body: '', tools: [] }] })));
    expect(await (await app(new Request(`${API}/a/${agentId}/agent.json`))).json()).toEqual({ name: 'Early', description: '', agentId: null, agentWallet: null, services: [] });
    await sql`update app.agents set status = 'active', stellar_address = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H' where id = ${agentId}`;
    expect(((await (await app(new Request(`${API}/a/${agentId}/agent.json`))).json()) as { services: unknown[] }).services.length).toBe(1);
  });

  it('agent.json lists no services for a paused agent, and lists them again after a resume', async () => {
    const a = await activeAgent(sql);
    const specs = createSpecs(sql);
    const schema = { type: 'object' as const, properties: { text: { type: 'string' as const } } };
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ services: [{ slug: 'summary', description: 'Summarise', price_usdc: '0.01', input_schema: schema, output_schema: schema, persona: 'p', skill_body: '', tools: [] }] })));
    const services = async () => ((await (await app(new Request(`${API}/a/${a.agentId}/agent.json`))).json()) as { services: unknown[] }).services.length;
    expect(await services()).toBe(1);
    await sql`update app.agents set status = 'paused' where id = ${a.agentId}`;
    expect(await services()).toBe(0);
    await sql`update app.agents set status = 'active' where id = ${a.agentId}`;
    expect(await services()).toBe(1);
  });
  describe('public proof URL', () => {
    const txOf = () => crypto.randomUUID().replaceAll('-', '').repeat(2);
    async function stored() {
      const kp = Keypair.random();
      const userId = await insertUser(sql);
      const agentId = await insertAgent(sql, userId, { status: 'active', stellarAddress: kp.publicKey() });
      const tx = txOf();
      const record = await signedRecord(kp, tx);
      expect(await createRecords(sql).save(agentId, null, tx, record)).toBe(true);
      return { agentId, tx, record };
    }

    it('GET /a/<uuid>/records/<tx> serves the record with ACAO * and an immutable cache', async () => {
      const { agentId, tx, record } = await stored();
      const r = await app(new Request(`${API}/a/${agentId.toUpperCase()}/records/${tx.toUpperCase()}`));
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(await r.json()).toEqual(record);
    });

    it('404s carry ACAO *: an unknown tx, a malformed tx', async () => {
      const { agentId } = await stored();
      for (const tx of [txOf(), 'abc']) {
        const r = await app(new Request(`${API}/a/${agentId}/records/${tx}`));
        expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([404, '*']);
      }
    });

    it('a tx of agent B under agent A\'s uuid is 404', async () => {
      const a = await stored();
      const b = await stored();
      const r = await app(new Request(`${API}/a/${a.agentId}/records/${b.tx}`));
      expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([404, '*']);
      expect((await app(new Request(`${API}/a/${b.agentId}/records/${b.tx}`))).status).toBe(200);
    });

    it('the body contains only the record format\'s fields: hashes and public addresses', async () => {
      const { agentId, tx, record } = await stored();
      // Plant extra keys in the stored jsonb: they must never leave.
      await sql`update app.records set record = ${{ ...record, secret: 'S'.repeat(56), agent: { ...record.agent, note: 'x' } }} where tx_hash = ${tx}`;
      const body = (await (await app(new Request(`${API}/a/${agentId}/records/${tx}`))).json()) as Record<string, Record<string, unknown>>;
      expect(Object.keys(body).sort()).toEqual(['agent', 'input', 'issuedAt', 'nonce', 'output', 'settlement', 'sig', 'v']);
      expect(Object.keys(body.agent!).sort()).toEqual(['address', 'agentId', 'chain']);
      expect(Object.keys(body.settlement!).sort()).toEqual(['amount', 'asset', 'chain', 'payer', 'ref']);
      expect(Object.keys(body.sig!).sort()).toEqual(['alg', 'value']);
    });

    it('is 404 with public headers when the gateway has no records', async () => {
      const bare = createApp({ sql, verify: async () => null, passkey: {} as never, signRequests: {} as never, provisioner: {} as never, appOrigin: ORIGIN });
      const r = await bare(new Request(`${API}/a/${crypto.randomUUID()}/records/${txOf()}`));
      expect([r.status, r.headers.get('access-control-allow-origin')]).toEqual([404, '*']);
    });
  });
});
