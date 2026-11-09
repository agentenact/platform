import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import type { ChainAdapter } from 'agentenact';
import { signCommunityTemplate, signHandleChange, type CommunityTemplate, type TemplateAnchorReader } from 'agentenact/community';
import { createStellarAdapter, stellarSecretToBytes } from 'agentenact/adapters/stellar';
import type { Db } from '../src/db/index.js';
import { agentTemplates } from '../src/builder/templates.js';
import { createCommunityIndex, HANDLE_CHANGE_WINDOW_MS, MAX_LISTED_PER_AUTHOR, REPORTS_TO_HIDE, type CommunityVerifier } from '../src/discovery/community.js';
import { createApp } from '../src/gateway/app.js';
import { HANDLE_CHANGES_PER_IP_PER_HOUR, TEMPLATE_PUSHES_PER_IP_PER_HOUR } from '../src/gateway/discovery.js';
import { freshDb } from './support/db.js';

const API = 'https://api.agentenact.io';
const real = createStellarAdapter({ network: 'testnet' }); // sign/verify only; the fakes below answer every chain read
const author = Keypair.random();
const secret = stellarSecretToBytes(author.secret());
const DRAFT = agentTemplates()[0]!.draft;

/** The author's account data entries, as Horizon would hold them: `address/slug` → hash. */
const held = new Map<string, string>();
let chainDown = false;
let chainReads = 0;
const anchors: TemplateAnchorReader = {
  network: 'stellar:testnet',
  async readAnchor(address, slug) {
    chainReads++;
    if (chainDown) throw new Error('Horizon 503');
    return held.get(`${address}/${slug}`) ?? null;
  },
};
const adapter: ChainAdapter = { ...real, resolveIdentity: async (id) => (id === '108' ? { owner: Keypair.random().publicKey(), wallet: author.publicKey() } : null) };
const verifier = async (): Promise<CommunityVerifier> => ({ adapter, anchors });

/** RFC 3339 UTC, whole seconds, `minutes` after the default createdAt. */
const at = (minutes: number, from = Date.parse('2026-10-27T21:00:00Z')) => new Date(from + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** A signed handle change, issued `minutes` from now. */
const handle = (name: string | null, minutes = 0, who = author) =>
  signHandleChange({ format: 'agentenact.handle/1', network: 'stellar:testnet', address: who.publicKey(), name, issuedAt: at(minutes, Date.now()) }, stellarSecretToBytes(who.secret()), real);

const doc = (o: Partial<CommunityTemplate> = {}): CommunityTemplate => ({
  format: 'agentenact.template/1',
  slug: 'xlm-dip',
  version: 1,
  title: 'XLM dip alert',
  summary: 'Emails you when XLM falls in an hour.',
  author: { network: 'stellar:testnet', address: author.publicKey() },
  createdAt: '2026-10-27T21:00:00Z',
  kind: 'agentenact.draft/1',
  body: DRAFT as unknown as CommunityTemplate['body'],
  ...o,
});
/** Signs and anchors (unless told not to), like an author would. */
async function publish(o: Partial<CommunityTemplate> = {}, anchor = true) {
  const s = await signCommunityTemplate(doc(o), secret, real);
  if (anchor) held.set(`${s.template.author.address}/${s.template.slug}`, s.sha256);
  return s;
}

describe('community templates', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  const index = () => createCommunityIndex({ sql, verifier });

  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
  });
  afterAll(() => drop());
  beforeEach(async () => {
    held.clear();
    chainDown = false;
    chainReads = 0;
    await sql`truncate discovery.community_templates, discovery.community_authors cascade`;
  });

  it('lists a signed, anchored template and serves its draft; a second push is already_received', async () => {
    const { template, sha256 } = await publish();
    const i = index();
    expect(await i.submit({ ...template, junk: 1 })).toEqual({ status: 'listed', sha256 });
    expect(await i.submit(template)).toEqual({ status: 'already_received', sha256 });
    const list = await i.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ sha256, slug: 'xlm-dip', version: 1, author: { network: 'stellar:testnet', address: author.publicKey() } });
    const one = await i.get(sha256);
    expect(one?.draft).toEqual(DRAFT);
    expect(JSON.stringify(one?.document)).not.toContain('junk');
  });

  it('refuses an unanchored or superseded template, and a forged one, storing nothing', async () => {
    const i = index();
    const { template } = await publish({}, false);
    expect(await i.submit(template)).toEqual({ status: 'refused', code: 'not_anchored' });
    held.set(`${author.publicKey()}/xlm-dip`, 'ab'.repeat(32));
    expect(await i.submit(template)).toEqual({ status: 'refused', code: 'not_anchored' });
    const ok = await publish();
    expect(await i.submit({ ...ok.template, title: 'Tampered' })).toMatchObject({ status: 'refused', code: 'not_verified', failure: { check: 'signature' } });
    expect((await sql`select 1 from discovery.community_templates`).length).toBe(0);
  });

  it('refuses before any chain read: another network, another kind, a draft outside the Builder scope', async () => {
    const i = index();
    const pub = await signCommunityTemplate(doc({ author: { network: 'stellar:pubnet', address: author.publicKey() } }), secret, real);
    expect(await i.submit(pub.template)).toEqual({ status: 'refused', code: 'wrong_network' });
    expect(await i.submit((await publish({ kind: 'acme.thing/1' })).template)).toEqual({ status: 'refused', code: 'wrong_kind' });
    const hiring = { ...DRAFT, spec: { ...DRAFT.spec, services: [{ id: 'x' }] } };
    expect(await i.submit((await publish({ body: hiring as never })).template)).toMatchObject({ status: 'refused', code: 'bad_draft' });
    expect(await i.submit({ format: 'agentenact.template/1' })).toEqual({ status: 'refused', code: 'malformed' });
    expect(chainReads).toBe(0);
  });

  it('binds an agentId only when the author key is that agent\'s owner or wallet', async () => {
    const i = index();
    const bound = await publish({ slug: 'bound', author: { network: 'stellar:testnet', address: author.publicKey(), agentId: '108' } });
    expect(await i.submit(bound.template)).toMatchObject({ status: 'listed' });
    expect((await i.list())[0]?.author.agentId).toBe('108');
    const stranger = await publish({ slug: 'stranger', author: { network: 'stellar:testnet', address: author.publicKey(), agentId: '7' } });
    expect(await i.submit(stranger.template)).toMatchObject({ status: 'refused', code: 'not_verified', failure: { check: 'identity', reason: 'agent_not_found' } });
  });

  it('a new anchored version replaces the old one in the list', async () => {
    const i = index();
    const v1 = await publish();
    await i.submit(v1.template);
    const v2 = await publish({ version: 2, title: 'XLM dip alert v2' });
    expect(await i.submit(v2.template)).toMatchObject({ status: 'listed' });
    expect((await i.list()).map((t) => t.sha256)).toEqual([v2.sha256]);
    expect(await i.get(v1.sha256)).toBeNull();
  });

  it('recheck unlists a template whose anchor moved or was removed, and keeps rows when Horizon is down', async () => {
    const i = index();
    const a = await publish({ slug: 'one' });
    const b = await publish({ slug: 'two' });
    await i.submit(a.template);
    await i.submit(b.template);
    await sql`update discovery.community_templates set anchor_checked_at = now() - interval '1 hour'`;
    held.delete(`${author.publicKey()}/one`);
    chainDown = true;
    expect(await i.recheck()).toBe(0);
    expect(await i.list()).toHaveLength(2);
    chainDown = false;
    expect(await i.recheck()).toBe(2);
    expect((await i.list()).map((t) => t.slug)).toEqual(['two']);
    expect(await i.recheck()).toBe(0); // just checked
  });

  it('chain trouble is chain_unavailable, never a refusal that sticks', async () => {
    chainDown = true;
    expect(await index().submit((await publish()).template)).toEqual({ status: 'refused', code: 'chain_unavailable' });
  });

  it(`caps an author at ${MAX_LISTED_PER_AUTHOR} listed slugs`, async () => {
    const i = index();
    for (let n = 0; n < MAX_LISTED_PER_AUTHOR; n++) expect(await i.submit((await publish({ slug: `slug-${n}` })).template)).toMatchObject({ status: 'listed' });
    expect(await i.submit((await publish({ slug: 'one-more' })).template)).toEqual({ status: 'refused', code: 'author_limit' });
  });

  it(`hides after ${REPORTS_TO_HIDE} distinct reporters, one report each`, async () => {
    const i = index();
    const { template, sha256 } = await publish();
    await i.submit(template);
    expect(await i.report(sha256, '203.0.113.1', 'spam')).toBe('reported');
    expect(await i.report(sha256, '203.0.113.1', 'harmful')).toBe('already_reported');
    expect(await i.report('cd'.repeat(32), '203.0.113.1', 'spam')).toBe('not_found');
    for (let n = 2; n <= REPORTS_TO_HIDE; n++) await i.report(sha256, `203.0.113.${n}`, 'spam');
    expect(await i.list()).toHaveLength(0);
    const stored = (await sql`select reporter from discovery.community_template_reports`) as { reporter: string }[];
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.reporter))).toBe(true); // never the address
  });

  it('a handle is one key\'s, first come; renaming frees it; reserved handles are refused before any chain read', async () => {
    const i = index();
    let minute = 0;
    const named = (name: string, slug = 'xlm-dip', who = author) =>
      signCommunityTemplate(doc({ slug, createdAt: at(minute++), author: { network: 'stellar:testnet', address: who.publicKey(), name } }), stellarSecretToBytes(who.secret()), real).then((x) => {
        held.set(`${who.publicKey()}/${slug}`, x.sha256);
        return x.template;
      });
    expect(await i.submit(await named('kerem'))).toMatchObject({ status: 'listed' });
    expect((await i.list())[0]?.author.name).toBe('kerem');

    const other = Keypair.random();
    expect(await i.submit(await named('kerem', 'other', other))).toEqual({ status: 'refused', code: 'name_taken' });
    for (const n of ['agentenact', 'agent_enact', 'official-bot', 'claude']) {
      chainReads = 0;
      expect([n, await i.submit(await named(n, 'res'))]).toEqual([n, { status: 'refused', code: 'name_reserved' }]);
      expect(chainReads).toBe(0);
    }

    // the same key signs a new handle: every one of its templates shows it, and the old handle is free again
    expect(await i.submit(await named('knrs', 'second'))).toMatchObject({ status: 'listed' });
    expect((await i.list()).map((t) => t.author.name)).toEqual(['knrs', 'knrs']);
    expect(await i.submit(await named('kerem', 'other', other))).toMatchObject({ status: 'listed' });
    const byAddress = Object.fromEntries((await i.list()).map((t) => [t.slug, t.author]));
    expect(byAddress.other).toMatchObject({ address: other.publicKey(), name: 'kerem' });
    expect(byAddress['xlm-dip']).toMatchObject({ address: author.publicKey(), name: 'knrs' });
  });

  it('an older template cannot undo a newer handle: the document lists, the handle stays', async () => {
    const i = index();
    const signed = async (name: string, slug: string, minutes: number) => {
      const s = await signCommunityTemplate(doc({ slug, createdAt: at(minutes), author: { network: 'stellar:testnet', address: author.publicKey(), name } }), secret, real);
      held.set(`${author.publicKey()}/${slug}`, s.sha256);
      return s.template;
    };
    const late = await signed('newer', 'b-late', 10);
    const early = await signed('older', 'a-early', 0);
    expect(await i.submit(late)).toMatchObject({ status: 'listed' });
    expect(await i.submit(early)).toMatchObject({ status: 'listed' });
    expect((await i.list()).map((t) => t.author.name)).toEqual(['newer', 'newer']);
    // a template dated in the future counts as now, so it cannot lock the handle against a later change
    expect(await i.submit(await signed('future', 'c-future', 60 * 24 * 365 * 10))).toMatchObject({ status: 'listed' });
    expect(await i.setHandle(await handle('present', 1))).toEqual({ status: 'changed', name: 'present' });
  });

  it('a signed handle change renames without a template, drops the handle with null, and refuses replays', async () => {
    const i = index();
    expect(await i.submit((await publish()).template)).toMatchObject({ status: 'listed' });
    const first = await handle('knrs', -2);
    expect(await i.setHandle(first)).toEqual({ status: 'changed', name: 'knrs' });
    expect((await i.list())[0]?.author.name).toBe('knrs');
    expect(await i.setHandle(first)).toEqual({ status: 'refused', code: 'not_fresh' }); // the same change again

    const other = Keypair.random();
    expect(await i.setHandle(await handle('knrs', 0, other))).toEqual({ status: 'refused', code: 'name_taken' });
    expect(await i.setHandle(await handle(null, -1))).toEqual({ status: 'changed', name: null });
    expect((await i.list())[0]?.author.name).toBeUndefined();
    expect(await i.setHandle(first)).toEqual({ status: 'refused', code: 'not_fresh' }); // dropping kept the time: no replay
    expect(await i.setHandle(await handle('knrs', 0, other))).toEqual({ status: 'changed', name: 'knrs' }); // free again
  });

  it('a handle change must be close to now, on testnet, unreserved and signed by its key', async () => {
    const i = index();
    const late = HANDLE_CHANGE_WINDOW_MS / 60_000 + 1;
    expect(await i.setHandle(await handle('knrs', -late))).toEqual({ status: 'refused', code: 'not_fresh' });
    expect(await i.setHandle(await handle('knrs', late))).toEqual({ status: 'refused', code: 'not_fresh' });
    expect(await i.setHandle(await handle('official'))).toEqual({ status: 'refused', code: 'name_reserved' });
    const ok = await handle('knrs');
    expect(await i.setHandle({ ...ok, name: 'other' })).toEqual({ status: 'refused', code: 'not_verified' });
    expect(await i.setHandle({ ...ok, address: Keypair.random().publicKey() })).toEqual({ status: 'refused', code: 'not_verified' });
    expect(await i.setHandle({ ...ok, network: 'stellar:pubnet' })).toEqual({ status: 'refused', code: 'wrong_network' });
    expect(await i.setHandle({ ...ok, name: 'Bad Name' })).toEqual({ status: 'refused', code: 'malformed' });
    expect(await i.setHandle('x')).toEqual({ status: 'refused', code: 'malformed' });
    expect((await sql`select 1 from discovery.community_authors`).length).toBe(0);
  });

  it('list searches title and summary, with LIKE wildcards taken literally', async () => {
    const i = index();
    await i.submit((await publish({ slug: 'a-one', title: 'Gas 100% alert' })).template);
    await i.submit((await publish({ slug: 'b-two', title: 'Other' })).template);
    expect((await i.list({ q: '100%' })).map((t) => t.slug)).toEqual(['a-one']);
    expect((await i.list({ q: '%' })).map((t) => t.slug)).toEqual(['a-one']); // a literal percent sign, not "anything"
    expect(await i.list({ q: '_ther' })).toHaveLength(0);
    expect(await i.list({ q: 'XLM falls' })).toHaveLength(2);
  });

  describe('http', () => {
    const appWith = () =>
      createApp({
        sql: (async () => []) as never, verify: async () => null, passkey: {} as never, signRequests: {} as never, provisioner: {} as never,
        appOrigin: 'https://app.agentenact.io', log: () => undefined,
        discovery: { discovery: {} as never, exportCsv: (async () => ({ csv: '', truncated: false })) as never, intake: {} as never, community: index() },
      });

    it('push 201/200/422/400/413, list and one with ACAO *, 404 for unknown', async () => {
      const app = appWith();
      const post = (body: unknown, ip = '198.51.100.7') => app(new Request(`${API}/public/templates`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ip);
      const { template, sha256 } = await publish();
      const r1 = await post(template);
      expect(r1.status).toBe(201);
      expect(r1.headers.get('access-control-allow-origin')).toBe('*');
      expect((await post(template)).status).toBe(200);
      expect(await (await post({ ...template, title: 'x' })).json()).toEqual({ error: 'not_verified', check: 'signature', reason: 'bad_signature' });
      expect((await post('{nope')).status).toBe(400);
      expect((await post('x'.repeat(50 * 1024))).status).toBe(413);
      const list = await app(new Request(`${API}/public/templates?q=XLM`), '198.51.100.8');
      expect(((await list.json()) as { templates: unknown[] }).templates).toHaveLength(1);
      const one = await app(new Request(`${API}/public/templates/${sha256}`), '198.51.100.8');
      expect(((await one.json()) as { draft: unknown }).draft).toEqual(DRAFT);
      expect((await app(new Request(`${API}/public/templates/${'0'.repeat(64)}`), '198.51.100.8')).status).toBe(404);
    });

    it(`limits pushes to ${TEMPLATE_PUSHES_PER_IP_PER_HOUR} per address per hour, before reading the body`, async () => {
      const app = appWith();
      for (let n = 0; n < TEMPLATE_PUSHES_PER_IP_PER_HOUR; n++) await app(new Request(`${API}/public/templates`, { method: 'POST', body: '{}' }), '198.51.100.9');
      const over = await app(new Request(`${API}/public/templates`, { method: 'POST', body: '{}' }), '198.51.100.9');
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).not.toBeNull();
    });

    it(`handle change 200/409/422/400, limited to ${HANDLE_CHANGES_PER_IP_PER_HOUR} per address per hour`, async () => {
      const app = appWith();
      const put = (body: unknown, ip = '198.51.100.20') => app(new Request(`${API}/public/authors`, { method: 'POST', body: JSON.stringify(body) }), ip);
      const change = await handle('knrs');
      const r = await put(change);
      expect(r.status).toBe(200);
      expect(r.headers.get('access-control-allow-origin')).toBe('*');
      expect(await r.json()).toEqual({ status: 'changed', name: 'knrs' });
      expect(await (await put(change)).json()).toEqual({ error: 'not_fresh' });
      expect((await put({ ...change, name: 'other' })).status).toBe(422);
      expect((await put({})).status).toBe(400);
      for (let n = 0; n < HANDLE_CHANGES_PER_IP_PER_HOUR; n++) await put({}, '198.51.100.21');
      expect((await put({}, '198.51.100.21')).status).toBe(429);
    });

    it('report takes a known reason only', async () => {
      const app = appWith();
      const { template, sha256 } = await publish();
      await app(new Request(`${API}/public/templates`, { method: 'POST', body: JSON.stringify(template) }), '198.51.100.10');
      const report = (body: unknown) => app(new Request(`${API}/public/templates/${sha256}/report`, { method: 'POST', body: JSON.stringify(body) }), '198.51.100.11');
      expect((await report({ reason: 'nope' })).status).toBe(400);
      expect(await (await report({ reason: 'spam' })).json()).toEqual({ status: 'reported' });
      expect(await (await report({ reason: 'spam' })).json()).toEqual({ status: 'already_reported' });
    });
  });
});
