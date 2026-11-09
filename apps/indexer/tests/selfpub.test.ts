import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { PARSE_VERSION, hostedDocUrl, parseAgentDoc, readInlineDoc, refreshSelfPublished } from '../src/selfpub.js';
import { createDedicatedDb } from '../src/db.js';
import { freshDb } from './support/db.js';

const BASE = 'https://agentenact.io';
const T0 = new Date('2026-10-12T12:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);
const uuid = (n: number) => `0b9f3c1e-2d4a-4e5f-8a6b-${String(n).padStart(12, '0')}`;
const hostedUri = (n: number) => `${BASE}/a/${uuid(n)}/agent.json`;
const dataUri = (o: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(o)).toString('base64')}`;

describe('parseAgentDoc', () => {
  it('reads our agent.json shape', () => {
    expect(
      parseAgentDoc({ name: 'Scribe', description: 'Writes things', agentId: 1, services: [{ slug: 'summary', description: 'Summarise text', price_usdc: '0.01', url: 'https://api.agentenact.io/a/u/summary', input_schema: {} }] }),
    ).toEqual({ name: 'Scribe', description: 'Writes things', services: [{ slug: 'summary', description: 'Summarise text', priceUsdc: '0.01', url: 'https://api.agentenact.io/a/u/summary' }], x402: false });
  });

  it('reads the x402 flag: ERC-8004 x402support, or x402; only a literal true', () => {
    expect(parseAgentDoc({ name: 'A', x402support: true }).x402).toBe(true);
    expect(parseAgentDoc({ name: 'A', x402Support: true }).x402).toBe(true);
    expect(parseAgentDoc({ name: 'A', x402: true }).x402).toBe(true);
    for (const v of ['true', 1, {}, false, null]) expect(parseAgentDoc({ name: 'A', x402: v, x402support: v }).x402).toBe(false);
    expect(parseAgentDoc(null).x402).toBe(false);
  });

  it('reads the generic registration shape', () => {
    expect(parseAgentDoc({ type: 'x', name: 'Gen', description: 'd', services: [{ name: 'Web Search!', description: 'finds', price: 0.5 }, { name: 'MCP', endpoint: 'https://mcp.example.org/x' }] })).toEqual({
      name: 'Gen',
      description: 'd',
      services: [
        { slug: 'web-search', description: 'finds', priceUsdc: '0.5', url: null },
        { slug: 'mcp', description: null, priceUsdc: null, url: 'https://mcp.example.org/x' },
      ],
      x402: false,
    });
  });

  it('strips html-looking text to plain text and never interprets it', () => {
    const r = parseAgentDoc({ name: '<img onerror=x>‮hi⁦\u0007  there\n', description: 'a\u0085b\tc​d' });
    expect(r.name).toBe('<img onerror=x>hi there');
    expect(r.description).toBe('ab cd');
  });

  it('caps lengths and the service count', () => {
    const services = Array.from({ length: 15 }, (_, i) => ({ slug: `s${i}`, description: 'x'.repeat(500) }));
    const r = parseAgentDoc({ name: 'n'.repeat(200), description: 'd'.repeat(1000), services: [...services, { slug: 's0' }] });
    expect([r.name!.length, r.description!.length, r.services.length, r.services[0]!.description!.length]).toEqual([64, 280, 10, 140]);
    expect(parseAgentDoc({ services: [{ slug: 'a'.repeat(100) }] }).services[0]!.slug).toHaveLength(40);
    expect(parseAgentDoc({ services: [{ slug: 'a' }, { slug: 'A' }, { name: 'a!' }] }).services).toHaveLength(1);
    expect(parseAgentDoc({ services: [{ slug: '!!!' }] }).services).toEqual([]);
  });

  it('keeps a service url only when we would ever call it: https on 443, a public-looking host name', () => {
    const u = (url: unknown) => parseAgentDoc({ services: [{ slug: 'a', url }] }).services[0]!.url;
    expect(u('https://agent.example.org/run?x=1')).toBe('https://agent.example.org/run?x=1');
    expect(u('https://agent.example.org:443/run')).toBe('https://agent.example.org/run');
    for (const bad of ['http://agent.example.org/run', 'https://localhost:8443/summarise', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
      'https://intranet/x', 'https://box.local/x', 'https://svc.internal/x', 'https://a.example.org:8443/x', 'https://u:p@a.example.org/x', 'https://a.example.org/x#f',
      `https://a.example.org/${'x'.repeat(300)}`, 'not a url', 42, null]) expect(u(bad)).toBeNull();
    // the ERC-8004 shape names it `endpoint`
    expect(parseAgentDoc({ services: [{ name: 'run', endpoint: 'https://agent.example.org/run' }] }).services[0]!.url).toBe('https://agent.example.org/run');
  });

  it('ignores a malformed price', () => {
    const p = (price_usdc: unknown) => parseAgentDoc({ services: [{ slug: 'a', price_usdc }] }).services[0]!.priceUsdc;
    expect([p('0.01'), p('1234567'), p('12.12345678'), p('-1'), p('1e3'), p('free'), p(null), p({}), p('12')]).toEqual(['0.01', null, null, null, null, null, null, null, '12']);
  });

  it('survives non-object input', () => {
    const empty = { name: null, description: null, services: [], x402: false };
    for (const v of [null, undefined, 'x', 5, [], [1], { services: 'no' }, { services: [null, 3, 'x'] }]) expect(parseAgentDoc(v)).toEqual(empty);
  });
});

describe('readInlineDoc', () => {
  it('decodes base64 and plain data uris', () => {
    expect(readInlineDoc(dataUri({ a: 1 }))).toEqual({ a: 1 });
    expect(readInlineDoc('data:,{"a":2}')).toEqual({ a: 2 });
    expect(readInlineDoc(`data:application/json,${encodeURIComponent('{"a":3}')}`)).toEqual({ a: 3 });
  });

  it('refuses a data uri over 64 KB', () => {
    expect(readInlineDoc(dataUri({ pad: 'x'.repeat(70_000) }))).toBeNull();
    expect(readInlineDoc(`data:,{"pad":"${'x'.repeat(70_000)}"}`)).toBeNull();
    expect(readInlineDoc(dataUri({ pad: 'x'.repeat(60_000) }))).not.toBeNull();
  });

  it('returns null for http, ipfs and junk', () => {
    for (const u of ['https://x.test/a.json', 'ipfs://bafy', 'data:text/html,<b>', 'data:,not json', 'data:application/json;base64,@@@', '', 'x']) expect(readInlineDoc(u)).toBeNull();
  });
});

describe('hostedDocUrl', () => {
  it('builds the exact url', () => {
    expect(hostedDocUrl(uuid(1), 'https://agentenact.io/')).toBe(`https://agentenact.io/a/${uuid(1)}/agent.json`);
  });
});

describe('refreshSelfPublished', () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.drop();
  });
  beforeEach(async () => {
    for (const t of ['feed', 'services', 'selfpub', 'hidden', 'agents']) await db.sql.unsafe(`delete from discovery.${t}`);
    await db.sql`delete from discovery.meta where key like 'selfpub_retry:%' or key like 'junk:%' or key in ('network', 'refresh_cursor', 'registry_contract')`;
  });

  const OWNER = Keypair.random().publicKey();
  const wallet = (id: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, id)).publicKey();

  async function addAgent(id: number, uri: string, o: { hosted?: number; builder?: string; wallet?: string | null } = {}) {
    const w = o.wallet === undefined ? wallet(id) : o.wallet;
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid)
                 values (${id}, ${OWNER}, ${w}, ${uri}, 'registry_read', ${o.builder ?? 'external'}, ${o.hosted ? uuid(o.hosted) : null}::uuid)`;
  }
  const builderOf = async (id: number) => ((await db.sql`select builder from discovery.agents where agent_id = ${id}`) as Array<{ builder: string }>)[0]!.builder;
  const json = (o: unknown, init?: ResponseInit) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

  function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url));
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const run = (f: typeof fetch, now = T0, extra: { hostedEveryMs?: number } = {}) => refreshSelfPublished({ sql: db.sql, publicBaseUrl: BASE, fetch: f, now: () => now, ...extra });

  it('an x402 agent: prices from its stellar-agent-services manifest, read again every few minutes', async () => {
    const MANIFEST = 'https://seller.example.com/.well-known/stellar-agent-services.json';
    const doc = { name: 'Deck', x402: true, services: [{ name: 'stellar-agent-services', endpoint: MANIFEST }, { name: 'web', endpoint: 'https://seller.example.com' }] };
    await addAgent(121, dataUri(doc));
    await addAgent(7, dataUri({ ...doc, x402: false })); // not x402: its manifest is never fetched
    let amount = '1000000';
    const body = () => ({
      standard: 'stellar-agent-services/provider@1',
      provider: { agentId: 121 },
      payment: { protocol: 'x402', accepts: [{ network: 'stellar:testnet', asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', payTo: OWNER }] },
      services: [{ name: 'pitch-deck', description: 'Makes a deck', price: { amount } }],
    });
    const { f, calls } = fakeFetch(() => json(body()));
    const lookup = async () => ['93.184.216.34'];
    const go = (now: Date) => refreshSelfPublished({ sql: db.sql, publicBaseUrl: BASE, fetch: f, now: () => now, lookup });
    const svc = async (id: number) => (await db.sql`select slug, price_usdc from discovery.services where agent_id = ${id} order by slug`) as Array<{ slug: string; price_usdc: string | null }>;
    await go(T0);
    expect(calls.map((c) => c.url)).toEqual([MANIFEST]);
    expect(await svc(121)).toEqual([{ slug: 'pitch-deck', price_usdc: '0.1' }, { slug: 'web', price_usdc: null }]);
    expect((await svc(7)).map((r) => r.slug)).toEqual(['stellar-agent-services', 'web']);
    // a manifest service has no url: it is reached through the provider protocol, never a plain x402 POST
    expect((await db.sql`select url from discovery.services where agent_id = 121 and slug = 'pitch-deck'`) as unknown[]).toEqual([{ url: null }]);
    // the uri did not change, but the price did: read again after hostedEveryMs (5 min)
    amount = '2500000';
    expect((await go(min(1))).checked).toBe(0);
    await go(min(6));
    expect(await svc(121)).toEqual([{ slug: 'pitch-deck', price_usdc: '0.25' }, { slug: 'web', price_usdc: null }]);
    // a failed read keeps the previous rows
    const down = fakeFetch(() => new Response('x', { status: 503 }));
    await refreshSelfPublished({ sql: db.sql, publicBaseUrl: BASE, fetch: down.f, now: () => min(12), lookup });
    expect(down.calls).toHaveLength(1);
    expect((await svc(121))[0]).toEqual({ slug: 'pitch-deck', price_usdc: '0.25' });
  });

  it('stores the x402 flag of an inline document, and re-reads a row whose doc_hash was cleared (migration 0038)', async () => {
    await addAgent(1, dataUri({ name: 'Paid', x402: true, services: [{ name: 'web', endpoint: 'https://x.test' }] }));
    await addAgent(2, dataUri({ name: 'Plain' }));
    const { f } = fakeFetch(() => json({}));
    await run(f);
    const flags = async () => ((await db.sql`select agent_id, x402 from discovery.selfpub order by agent_id`) as Array<{ agent_id: number; x402: boolean }>).map((r) => [r.agent_id, r.x402]);
    expect(await flags()).toEqual([[1, true], [2, false]]);
    await db.sql`update discovery.selfpub set x402 = false, doc_hash = null where agent_id = 1`;
    expect(await run(f, min(1))).toEqual({ checked: 1, changed: 1 });
    expect(await flags()).toEqual([[1, true], [2, false]]);
    expect((await db.sql`select count(*)::int as n from discovery.feed where kind = 'service_opened'`) as unknown[]).toEqual([{ n: 0 }]);
  });

  it('re-reads a row an older parser wrote, so a field it did not know (x402) fills in without a migration', async () => {
    const uri = dataUri({ name: 'Paid', x402: true });
    await addAgent(1, uri);
    // what the indexer before the x402 flag left behind: the uri hash, the old parse hash, x402 never set
    await db.sql`insert into discovery.selfpub (agent_id, name, fetched_at, doc_hash)
                 values (1, 'Paid', ${T0}, left(encode(sha256(convert_to(${uri}, 'UTF8')), 'hex'), 16) || ':0123456789abcdef')`;
    const { f } = fakeFetch(() => json({}));
    expect(await run(f, min(1))).toEqual({ checked: 1, changed: 1 });
    expect(await db.sql`select x402 from discovery.selfpub where agent_id = 1`).toEqual([{ x402: true }]);
    // read once with the current parser: not a candidate again
    expect(await run(f, min(2))).toEqual({ checked: 0, changed: 0 });
  });

  it('fetches only the exact hosted document url and never for external agents', async () => {
    await addAgent(1, hostedUri(1), { hosted: 1 });
    await addAgent(2, 'https://evil.test/agent.json');
    await addAgent(3, 'ipfs://bafyabc');
    await addAgent(4, dataUri({ name: 'Inline' }));
    const { f, calls } = fakeFetch(() => json({ name: 'Hosted', agentId: 1, agentWallet: wallet(1), services: [] }));
    expect(await run(f)).toEqual({ checked: 4, changed: 4 });
    expect(calls.map((c) => c.url)).toEqual([hostedDocUrl(uuid(1), BASE)]);
    const rows = (await db.sql`select agent_id, name, fetched_at from discovery.selfpub order by agent_id`) as Array<{ agent_id: number; name: string | null; fetched_at: Date }>;
    expect(rows.map((r) => [r.agent_id, r.name])).toEqual([[1, 'Hosted'], [2, null], [3, null], [4, 'Inline']]);
    expect(rows.every((r) => r.fetched_at)).toBe(true);
    // external uris are not retried
    const again = fakeFetch(() => json({}));
    expect(await run(again.f, min(1))).toEqual({ checked: 0, changed: 0 });
    expect(again.calls).toEqual([]);
  });

  it('a spoofed hosted uri whose document names another agent stays external', async () => {
    await addAgent(10, hostedUri(10), { hosted: 10 });
    await addAgent(11, hostedUri(11), { hosted: 11 }); // right id, someone else's wallet
    await addAgent(12, hostedUri(12), { hosted: 12 }); // right wallet, other id
    const docs: Record<string, unknown> = {
      [hostedDocUrl(uuid(10), BASE)]: { name: 'Victim', agentId: 99, agentWallet: wallet(99), services: [{ slug: 'x' }] },
      [hostedDocUrl(uuid(11), BASE)]: { name: 'W', agentId: 11, agentWallet: wallet(98) },
      [hostedDocUrl(uuid(12), BASE)]: { name: 'I', agentId: 13, agentWallet: wallet(12) },
    };
    const { f } = fakeFetch((u) => json(docs[u]));
    await run(f);
    expect([await builderOf(10), await builderOf(11), await builderOf(12)]).toEqual(['external', 'external', 'external']);
    // nothing of the other agent's document is taken over
    expect((await db.sql`select name from discovery.selfpub where name is not null`) as unknown[]).toEqual([]);
    expect((await db.sql`select 1 from discovery.services`) as unknown[]).toEqual([]);
    // a document with no ids at all, and an unbound agent, also stay external
    await addAgent(14, hostedUri(14), { hosted: 14, wallet: null });
    const g = fakeFetch(() => json({ name: 'x', agentId: 14, agentWallet: null }));
    await run(g.f, min(1));
    expect(await builderOf(14)).toBe('external');
  });

  it('a matching document flips builder to hosted', async () => {
    await addAgent(20, hostedUri(20), { hosted: 20 });
    await addAgent(21, hostedUri(21), { hosted: 21, builder: 'library' });
    const { f } = fakeFetch((u) => {
      const id = u.includes(uuid(20)) ? 20 : 21;
      return json({ name: `A${id}`, agentId: id, agentWallet: wallet(id), services: [{ slug: 'summary', description: 'Summarise', price_usdc: '0.01', url: `https://api.agentenact.io/a/${uuid(id)}/summary` }] });
    });
    await run(f);
    expect(await builderOf(20)).toBe('hosted');
    expect(await builderOf(21)).toBe('library'); // never overwritten
    expect((await db.sql`select name from discovery.selfpub where agent_id = 20`) as unknown[]).toEqual([{ name: 'A20' }]);
    expect((await db.sql`select slug, price_usdc, url from discovery.services where agent_id = 20`) as unknown[]).toEqual([
      { slug: 'summary', price_usdc: '0.01', url: `https://api.agentenact.io/a/${uuid(20)}/summary` },
    ]);
  });

  it('a hosted agent whose document stops matching drops back to external', async () => {
    await addAgent(30, hostedUri(30), { hosted: 30 });
    let doc: unknown = { name: 'Mine', agentId: 30, agentWallet: wallet(30) };
    const { f } = fakeFetch(() => json(doc));
    await run(f, T0);
    expect(await builderOf(30)).toBe('hosted');
    doc = { name: 'Mine', agentId: 30, agentWallet: wallet(77) }; // wallet rebound to another key
    expect(await run(f, min(10))).toEqual({ checked: 1, changed: 1 });
    expect(await builderOf(30)).toBe('external');
  });

  it('re-checks hosted agents only after hostedEveryMs', async () => {
    await addAgent(31, hostedUri(31), { hosted: 31 });
    const { f, calls } = fakeFetch(() => json({ agentId: 31, agentWallet: wallet(31) }));
    await run(f, T0);
    await run(f, min(2));
    expect(calls).toHaveLength(1);
    await run(f, min(6));
    expect(calls).toHaveLength(2);
  });

  it('re-evaluates an agent whose uri changed', async () => {
    await addAgent(32, dataUri({ name: 'Old' }));
    await run(fakeFetch(() => json({})).f, T0);
    await db.sql`update discovery.agents set uri = ${dataUri({ name: 'New' })} where agent_id = 32`;
    expect(await run(fakeFetch(() => json({})).f, min(1))).toEqual({ checked: 1, changed: 1 });
    expect((await db.sql`select name from discovery.selfpub where agent_id = 32`) as unknown[]).toEqual([{ name: 'New' }]);
  });

  it('passes redirect error and drops a redirecting response', async () => {
    await addAgent(40, hostedUri(40), { hosted: 40 });
    const { f, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    expect(await run(f)).toEqual({ checked: 1, changed: 0 });
    expect(calls[0]!.init?.redirect).toBe('error');
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(await builderOf(40)).toBe('external');
    expect((await db.sql`select 1 from discovery.selfpub`) as unknown[]).toEqual([]);
  });

  it('a 5 MB body is cut and rejected', async () => {
    await addAgent(41, hostedUri(41), { hosted: 41 });
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 64 * 1024;
        c.enqueue(new Uint8Array(64 * 1024).fill(32));
        if (pulled >= 5 * 1024 * 1024) c.close();
      },
    });
    const { f } = fakeFetch(() => new Response(stream, { status: 200 }));
    expect(await run(f)).toEqual({ checked: 1, changed: 0 });
    expect(pulled).toBeLessThan(1024 * 1024);
    expect(await builderOf(41)).toBe('external');
    expect((await db.sql`select 1 from discovery.selfpub`) as unknown[]).toEqual([]);
  });

  it('stores services with a self_published feed line only for services opened after first sight', async () => {
    await addAgent(50, hostedUri(50), { hosted: 50 });
    let services: unknown[] = [{ slug: 'one', description: 'First', price_usdc: '0.01' }];
    const { f } = fakeFetch(() => json({ name: 'S', agentId: 50, agentWallet: wallet(50), services }));
    await run(f, T0);
    expect((await db.sql`select 1 from discovery.feed`) as unknown[]).toEqual([]); // initial set: no feed rows
    services = [{ slug: 'one', description: 'First', price_usdc: '0.01' }, { slug: 'two', description: 'Second one', price_usdc: '0.02' }, { slug: 'three' }];
    await run(f, min(10));
    const feed = (await db.sql`select kind, agent_id, label, self_published, source_key, at from discovery.feed order by source_key`) as Array<Record<string, unknown>>;
    expect(feed.map((r) => [r.kind, r.agent_id, r.label, r.self_published, r.source_key])).toEqual([
      ['service_opened', 50, 'three', true, 'svc:50:three'],
      ['service_opened', 50, 'Second one', true, 'svc:50:two'],
    ]);
    expect((feed[0]!.at as Date).toISOString()).toBe(min(10).toISOString());
    const svc = (await db.sql`select slug, first_seen_at, last_seen_at from discovery.services where agent_id = 50 order by slug`) as Array<{ slug: string; first_seen_at: Date; last_seen_at: Date }>;
    expect(svc.map((s) => s.slug)).toEqual(['one', 'three', 'two']);
    expect(svc[0]!.first_seen_at.toISOString()).toBe(T0.toISOString());
    expect(svc[0]!.last_seen_at.toISOString()).toBe(min(10).toISOString());
    await run(f, min(20)); // same doc again: no duplicate lines
    expect((await db.sql`select 1 from discovery.feed`) as unknown[]).toHaveLength(2);
  });

  it('removes a service that disappears', async () => {
    await addAgent(51, hostedUri(51), { hosted: 51 });
    let services: unknown[] = [{ slug: 'a' }, { slug: 'b' }];
    const { f } = fakeFetch(() => json({ agentId: 51, agentWallet: wallet(51), services }));
    await run(f, T0);
    services = [{ slug: 'b' }];
    await run(f, min(10));
    expect((await db.sql`select slug from discovery.services where agent_id = 51`) as unknown[]).toEqual([{ slug: 'b' }]);
    services = [];
    await run(f, min(20));
    expect((await db.sql`select slug from discovery.services where agent_id = 51`) as unknown[]).toEqual([]);
  });

  it('hidden agents get no self-published rows', async () => {
    await addAgent(60, dataUri({ name: 'Shy', services: [{ slug: 'a' }] }));
    await addAgent(61, hostedUri(61), { hosted: 61 });
    await db.sql`insert into discovery.hidden (agent_id, reason) values (60, 'x'), (61, 'x')`;
    const { f, calls } = fakeFetch(() => json({ agentId: 61, agentWallet: wallet(61) }));
    expect(await run(f)).toEqual({ checked: 0, changed: 0 });
    expect(calls).toEqual([]);
    expect((await db.sql`select 1 from discovery.selfpub`) as unknown[]).toEqual([]);
    // an agent hidden after it published loses its rows
    await db.sql`delete from discovery.hidden`;
    await run(f, T0);
    expect((await db.sql`select 1 from discovery.selfpub where agent_id = 60`) as unknown[]).toHaveLength(1);
    await db.sql`insert into discovery.feed (kind, agent_id, label, at, self_published, source_key) values ('service_opened', 60, 'Buy now', ${T0}, true, 'svc:60:a')`;
    await db.sql`insert into discovery.hidden (agent_id) values (60)`;
    await run(f, min(1));
    expect((await db.sql`select label from discovery.feed where agent_id = 60`) as unknown[]).toEqual([{ label: null }]);
    expect((await db.sql`select 1 from discovery.selfpub where agent_id = 60`) as unknown[]).toEqual([]);
    expect((await db.sql`select 1 from discovery.services where agent_id = 60`) as unknown[]).toEqual([]);
  });

  it('a fetch failure keeps the previous rows', async () => {
    await addAgent(70, hostedUri(70), { hosted: 70 });
    let mode: 'ok' | 'throw' | '500' | 'junk' = 'ok';
    const { f, calls } = fakeFetch(() => {
      if (mode === 'throw') throw new Error('boom');
      if (mode === '500') return new Response('no', { status: 500 });
      if (mode === 'junk') return new Response('<html>', { status: 200 });
      return json({ name: 'Keep', agentId: 70, agentWallet: wallet(70), services: [{ slug: 'a' }] });
    });
    await run(f, T0);
    for (const m of ['throw', '500', 'junk'] as const) {
      mode = m;
      await run(f, min(10 * (['throw', '500', 'junk'].indexOf(m) + 1)));
    }
    expect(await builderOf(70)).toBe('hosted');
    expect((await db.sql`select name from discovery.selfpub where agent_id = 70`) as unknown[]).toEqual([{ name: 'Keep' }]);
    expect((await db.sql`select slug from discovery.services where agent_id = 70`) as unknown[]).toEqual([{ slug: 'a' }]);
    // a failing agent backs off instead of being hit every tick
    const before = calls.length;
    await run(f, min(31));
    expect(calls.length).toBe(before);
  });

  it('the candidate query survives non-timestamp meta rows (never casts them)', async () => {
    // production meta always holds network / refresh_cursor / registry_contract; enough rows push the planner to a hash anti-join
    await db.sql`insert into discovery.meta (key, value) values ('network', 'testnet'), ('refresh_cursor', 'junk'), ('registry_contract', 'CDE3K4CO')
                 on conflict (key) do update set value = excluded.value`;
    await db.sql`insert into discovery.meta (key, value) select 'junk:' || g, 'junk' from generate_series(1, 300) g`;
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source)
                 select 1000 + g, ${OWNER}, null, 'https://x.test/' || g, 'registry_read' from generate_series(1, 300) g`;
    // already verified: not candidates, so only the query (not 300 refreshes) is exercised
    await db.sql`insert into discovery.selfpub (agent_id, fetched_at, doc_hash)
                 select agent_id, ${T0}, left(encode(sha256(convert_to(uri, 'UTF8')), 'hex'), 16) || ':x:' || ${PARSE_VERSION} from discovery.agents where agent_id > 1000`;
    await db.sql`analyze discovery.meta`;
    await db.sql`analyze discovery.agents`;
    await addAgent(80, hostedUri(80), { hosted: 80 });
    const { f } = fakeFetch(() => json({ name: 'Ok', agentId: 80, agentWallet: wallet(80) }));
    // planner order is not guaranteed: pin the plan that scans every meta row (hash anti join) on a dedicated connection
    const one = createDedicatedDb(db.url);
    try {
      await one`set enable_nestloop = off`;
      await one`set enable_mergejoin = off`;
      const r = await refreshSelfPublished({ sql: one, publicBaseUrl: BASE, fetch: f, now: () => T0 });
      expect(r.checked).toBe(1);
    } finally {
      await one.close();
    }
    expect(await builderOf(80)).toBe('hosted');
    await db.sql`delete from discovery.selfpub where agent_id > 1000`;
    await db.sql`delete from discovery.agents where agent_id > 1000`;
    await db.sql`delete from discovery.meta where key like 'junk:%'`;
  });

  it('a 404 from our api drops a hosted agent to external at once', async () => {
    await addAgent(81, hostedUri(81), { hosted: 81 });
    await addAgent(82, hostedUri(82), { hosted: 82, builder: 'library' });
    let gone = false;
    const { f } = fakeFetch((u) => (gone ? new Response('gone', { status: u.includes(uuid(81)) ? 404 : 410 }) : json({ name: 'N', agentId: u.includes(uuid(81)) ? 81 : 82, agentWallet: wallet(u.includes(uuid(81)) ? 81 : 82), services: [{ slug: 'a' }] })));
    await run(f, T0);
    expect(await builderOf(81)).toBe('hosted');
    gone = true;
    await run(f, min(10));
    expect(await builderOf(81)).toBe('external');
    expect(await builderOf(82)).toBe('library'); // never overwritten
    for (const id of [81, 82]) {
      expect((await db.sql`select slug from discovery.services where agent_id = ${id}`) as unknown[]).toEqual([]);
      expect((await db.sql`select name from discovery.selfpub where agent_id = ${id}`) as unknown[]).toEqual([{ name: null }]);
    }
  });

  it('a transient failure keeps hosted until verification is older than an hour, then drops it', async () => {
    await addAgent(83, hostedUri(83), { hosted: 83 });
    let fail = false;
    const { f } = fakeFetch(() => {
      if (fail) return new Response('no', { status: 503 });
      return json({ name: 'Keep', agentId: 83, agentWallet: wallet(83), services: [{ slug: 'a' }] });
    });
    await run(f, T0);
    fail = true;
    await run(f, min(30));
    expect(await builderOf(83)).toBe('hosted');
    await run(f, min(59));
    expect(await builderOf(83)).toBe('hosted');
    await run(f, min(66)); // past the 5 min back-off of the 59 min try
    expect(await builderOf(83)).toBe('external');
    expect((await db.sql`select slug from discovery.services where agent_id = 83`) as unknown[]).toEqual([{ slug: 'a' }]); // rows kept
    fail = false;
    await run(f, min(80)); // a good fetch restores it
    expect(await builderOf(83)).toBe('hosted');
  });

  it('a wallet that changes mid-fetch never ends as hosted', async () => {
    await addAgent(84, hostedUri(84), { hosted: 84 });
    const { f } = fakeFetch(async () => {
      await db.sql`update discovery.agents set wallet = ${wallet(99)}, builder = 'external' where agent_id = 84`;
      return json({ name: 'Old', agentId: 84, agentWallet: wallet(84) });
    });
    await run(f, T0);
    expect(await builderOf(84)).toBe('external');
  });

  it('control characters are stripped before whitespace is collapsed', () => {
    expect(parseAgentDoc({ name: 'a \u0007 b' }).name).toBe('a b');
  });
});
