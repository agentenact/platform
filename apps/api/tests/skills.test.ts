import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { dailyDigest, xlmDrop } from '../src/builder/examples.js';
import type { Db } from '../src/db/index.js';
import { BROWSE_SKILL_QUERIES, boundedFetch, createSkillCatalog, loadServiceSkills, MAX_SERVICE_SKILL_CHARS, missionQuery, MIN_SKILL_INSTALLS, skillQueries, type SkillCatalog } from '../src/skills/index.js';
import { createSpecs, type Specs } from '../src/specs/index.js';
import { parseSpec, type AgentSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { activeAgent } from './support/specs.js';

import { C1, C2, fakeNet } from './support/skills-net.js';

describe('skill queries', () => {
  it('turns a mission into a few content words (a whole sentence finds nothing on skills.sh)', () => {
    expect(missionQuery('Write a short digest of what happened in Stellar DeFi in the last day and email it.')).toBe('write short digest');
    expect(missionQuery('the and of')).toBeNull();
  });
  it('owner words first, then missions, then what the tools are about; deduplicated and capped', () => {
    const s = dailyDigest().spec;
    expect(skillQueries(s)).toEqual(['write short digest', 'web research', 'crypto market']);
    expect(skillQueries(s, '  DeFi news ')).toEqual(['defi news', 'write short digest', 'web research', 'crypto market']);
    expect(skillQueries(xlmDrop().spec)).toEqual(['xlm sharply cheaper']);
  });
});

describe('boundedFetch', () => {
  it('refuses a body over the cap, declared or streamed', async () => {
    const big = boundedFetch((async () => new Response('x'.repeat(100))) as unknown as typeof fetch, { timeoutMs: 1000, maxBytes: 50 });
    await expect(big('https://x.example')).rejects.toThrow('response_too_large');
    const ok = boundedFetch((async () => new Response('hello', { status: 201 })) as unknown as typeof fetch, { timeoutMs: 1000, maxBytes: 50 });
    const r = await ok('https://x.example');
    expect([r.status, await r.text()]).toEqual([201, 'hello']);
  });
});

describe('skill catalog', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
  });
  afterAll(() => drop());

  async function agent(spec: AgentSpec = dailyDigest().spec) {
    const a = await activeAgent(sql);
    const { name: _n, spec: _s, ...view } = dailyDigest();
    const v = await specs.saveDraft(a.userId, a.agentId, spec, undefined, view);
    await specs.approve(a.userId, a.agentId, v);
    return { ...a, version: v };
  }
  const catalog = (net = fakeNet()) => ({ net, cat: createSkillCatalog({ sql, fetch: net.fetch, now: () => new Date('2026-10-17T18:00:00Z') }) as SkillCatalog });

  it('suggests GitHub skills found by the agent’s own searches, drops tiny and unpinnable ones, and caches per version', async () => {
    const a = await agent();
    const { net, cat } = catalog();
    const out = await cat.suggestions(a.userId, a.agentId);
    expect(out.version).toBe(a.version);
    expect(out.queries).toEqual(['write short digest', 'web research', 'crypto market']);
    expect(out.suggestions).toEqual([{ id: 'acme/skills/defi-digest', name: 'defi-digest', source: 'acme/skills', installs: 500, url: 'https://skills.sh/acme/skills/defi-digest', matched: out.queries }]);
    const calls = net.state.calls;
    await cat.suggestions(a.userId, a.agentId);
    expect(net.state.calls).toBe(calls);
  });

  it('searches skills.sh for no agent: the owner\'s words, or a broad list without any, cached and rate limited on a miss', async () => {
    const { net, cat } = catalog();
    let misses = 0;
    const onMiss = () => void misses++;
    const words = await cat.search('  PDF reports ', onMiss);
    expect(net.state.searches).toEqual(['pdf reports']);
    expect(words.suggestions).toEqual([{ id: 'acme/skills/defi-digest', name: 'defi-digest', source: 'acme/skills', installs: 500, url: 'https://skills.sh/acme/skills/defi-digest', matched: ['pdf reports'] }]);
    await cat.search('pdf reports', onMiss);
    expect(misses).toBe(1);
    const broad = await cat.search(undefined, onMiss);
    expect(net.state.searches.slice(1)).toEqual([...BROWSE_SKILL_QUERIES]);
    expect(broad.suggestions.map((s) => s.name)).toEqual(['defi-digest']);
    net.state.failSearch = () => true;
    await expect(cat.search('nothing up')).rejects.toMatchObject({ status: 503 });
  });

  it('a failed search leaves only its words out, and that list is not kept; every search failing is unavailable', async () => {
    const a = await agent();
    const { net, cat } = catalog();
    net.state.failSearch = (q) => q === 'web research';
    const out = await cat.suggestions(a.userId, a.agentId);
    expect(out.suggestions.map((s) => s.id)).toEqual(['acme/skills/defi-digest']);
    expect(out.suggestions[0]!.matched).toEqual(['write short digest', 'crypto market']);
    const calls = net.state.calls;
    await cat.suggestions(a.userId, a.agentId);
    expect(net.state.calls).toBeGreaterThan(calls); // asked again
    net.state.failSearch = () => true;
    await expect(catalog(net).cat.suggestions(a.userId, a.agentId)).rejects.toMatchObject({ status: 503 });
  });

  it('a cached answer never calls onMiss; a fresh read calls it first', async () => {
    const a = await agent();
    const { cat } = catalog();
    let misses = 0;
    await cat.suggestions(a.userId, a.agentId, undefined, () => misses++);
    await cat.suggestions(a.userId, a.agentId, undefined, () => misses++);
    await cat.review('acme/skills/defi-digest', () => misses++);
    await cat.review('acme/skills/defi-digest', () => misses++);
    expect(misses).toBe(2);
    await expect(cat.suggestions(a.userId, a.agentId, 'other words', () => { throw new Error('limited'); })).rejects.toThrow('limited');
  });

  it('is owner-only: another user gets 404', async () => {
    const a = await agent();
    const b = await activeAgent(sql);
    await expect(catalog().cat.suggestions(b.userId, a.agentId)).rejects.toMatchObject({ status: 404 });
    await expect(catalog().cat.list(b.userId, a.agentId)).rejects.toMatchObject({ status: 404 });
  });

  it('review shows audits, our findings, the instructions, unused files and the pinned commit', async () => {
    const r = await catalog().cat.review('acme/skills/defi-digest');
    expect(r).toMatchObject({ id: 'acme/skills/defi-digest', name: 'defi-digest', verdict: 'caution', commit: C1, fits: true, unused: ['scripts/fetch.py'] });
    expect(r.instructions.startsWith('# DeFi digest')).toBe(true);
    expect(r.audits.map((x) => [x.provider, x.status])).toEqual([['Gen Agent Trust Hub', 'pass'], ['Socket', 'pass']]);
    expect(r.findings.map((x) => x.code).sort()).toEqual(['executable', 'network']);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('review refuses ids that are not owner/repo/slug', async () => {
    for (const id of ['acme/skills', '../x/y', 'example.com/x', 'a/b/C']) await expect(catalog().cat.review(id)).rejects.toMatchObject({ status: 400 });
  });

  it('approve adds the instructions as a skill through a new approved version and records where it came from', async () => {
    const a = await agent();
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    const out = await cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version });
    expect(out.version).toBe(a.version + 1);
    const active = await specs.active(a.agentId);
    expect(active!.version).toBe(out.version);
    expect(active!.spec.skills).toEqual([{ name: 'defi-digest', description: 'Writes a short digest of DeFi activity. Use when summarizing a day of on-chain events.', body: r.instructions }]);
    expect(await specs.skillBody(a.agentId, 'defi-digest')).toBe(r.instructions);
    const [row] = (await sql`select skill_id, content_hash, pin, verdict, findings, approved_by, spec_version from app.skill_approvals where agent_id = ${a.agentId}`) as Record<string, unknown>[];
    expect(row).toEqual({ skill_id: r.id, content_hash: r.contentHash, pin: { kind: 'github', repo: 'acme/skills', commit: C1, dir: 'skills/defi-digest' }, verdict: 'caution', findings: ['executable', 'network'], approved_by: a.userId, spec_version: out.version });
    const list = await cat.list(a.userId, a.agentId);
    expect(list.skills).toEqual([{ name: 'defi-digest', description: active!.spec.skills[0]!.description, source: { id: r.id, verdict: 'caution', approvedAt: '2026-10-17T18:00:00.000Z', commit: C1, edited: false } }]);
    // Already held: no longer suggested.
    expect((await catalog().cat.suggestions(a.userId, a.agentId)).suggestions).toEqual([]);
  });

  it('approve re-reads the reviewed commit and refuses a hash that does not match it (409 skill_changed)', async () => {
    const a = await agent();
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    await expect(cat.approve(a.userId, a.agentId, { id: r.id, commit: C2, contentHash: r.contentHash, version: a.version })).rejects.toMatchObject({ status: 409, code: 'skill_changed' });
    expect((await specs.active(a.agentId))!.version).toBe(a.version);
  });

  it('an upstream change after review never reaches the agent: the reviewed commit is what gets approved', async () => {
    const a = await agent();
    const net = fakeNet();
    const { cat } = catalog(net);
    const r = await cat.review('acme/skills/defi-digest');
    net.state.head = C2; // the repo moves on after the owner looked
    await cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version });
    expect((await specs.skillBody(a.agentId, 'defi-digest'))).not.toContain('GEVIL');
  });

  it('a stale screen (the description moved on) is 409 version_changed and changes nothing', async () => {
    const a = await agent();
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    await expect(cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version - 1 || 99 })).rejects.toMatchObject({ code: 'version_changed' });
    expect(((await sql`select 1 from app.skill_approvals where agent_id = ${a.agentId}`) as unknown[]).length).toBe(0);
  });

  it('a failed or HIGH-risk audit, or none at all, needs the owner to accept the risk', async () => {
    const a = await agent();
    const net = fakeNet();
    net.state.audits = [{ provider: 'Snyk', slug: 'snyk', status: 'fail', summary: 'Risk: HIGH', auditedAt: '2026-09-15T07:59:46.904821+00:00', riskLevel: 'HIGH' }];
    const { cat } = catalog(net);
    const r = await cat.review('acme/skills/defi-digest');
    expect(r.verdict).toBe('blocked');
    const ask = { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version };
    await expect(cat.approve(a.userId, a.agentId, ask)).rejects.toMatchObject({ status: 409, code: 'needs_accept_risk' });
    expect((await cat.approve(a.userId, a.agentId, { ...ask, acceptRisk: true })).version).toBe(a.version + 1);
  });

  it('refuses over an unapproved owner revision (it would be skipped over)', async () => {
    const a = await agent();
    const { name: _n, spec: _s, ...view } = dailyDigest();
    await specs.saveDraft(a.userId, a.agentId, dailyDigest().spec, undefined, view);
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    await expect(cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version })).rejects.toMatchObject({ code: 'pending_draft' });
  });

  it('a name the agent already uses is 409 skill_exists; a hand edit after approval shows as edited', async () => {
    const withSkill = parseSpec({ ...dailyDigest().spec, skills: [{ name: 'defi-digest', description: 'mine', body: 'my own' }] });
    if (!withSkill.ok) throw new Error(withSkill.problem);
    const a = await agent(withSkill.spec);
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    await expect(cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version })).rejects.toMatchObject({ code: 'skill_exists' });
    expect((await cat.list(a.userId, a.agentId)).skills).toEqual([{ name: 'defi-digest', description: 'mine', source: null }]);

    const b = await agent();
    const v = (await cat.approve(b.userId, b.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: b.version })).version;
    const cur = (await specs.active(b.agentId))!.spec;
    const edited = parseSpec({ ...cur, skills: [{ ...cur.skills[0]!, body: `${cur.skills[0]!.body}\nmore` }] });
    if (!edited.ok) throw new Error(edited.problem);
    const { name: _n, spec: _s, ...view } = dailyDigest();
    await specs.approve(b.userId, b.agentId, await specs.saveDraft(b.userId, b.agentId, edited.spec, undefined, view, v));
    expect((await cat.list(b.userId, b.agentId)).skills[0]!.source!.edited).toBe(true);
  });

  it('remove takes the skill out through a new version and drops its record', async () => {
    const a = await agent();
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    const v = (await cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version })).version;
    await expect(cat.remove(a.userId, a.agentId, 'defi-digest', v - 1)).rejects.toMatchObject({ code: 'version_changed' });
    await expect(cat.remove(a.userId, a.agentId, 'nope', v)).rejects.toMatchObject({ status: 404 });
    const out = await cat.remove(a.userId, a.agentId, 'defi-digest', v);
    expect(out.version).toBe(v + 1);
    expect((await specs.active(a.agentId))!.spec.skills).toEqual([]);
    expect(await specs.skillBody(a.agentId, 'defi-digest')).toBeNull();
    expect(((await sql`select 1 from app.skill_approvals where agent_id = ${a.agentId}`) as unknown[]).length).toBe(0);
  });

  const SERVICE = { slug: 'digest', description: 'A DeFi digest', price_usdc: '0.01', input_schema: { type: 'object' }, output_schema: { type: 'object' }, persona: 'You write digests.', skill_body: '', tools: [] };
  async function withService() {
    const spec = parseSpec({ ...dailyDigest().spec, services: [SERVICE] });
    if (!spec.ok) throw new Error(spec.problem);
    const a = await agent(spec.spec);
    const { cat } = catalog();
    const r = await cat.review('acme/skills/defi-digest');
    const v = (await cat.approve(a.userId, a.agentId, { id: r.id, commit: r.commit, contentHash: r.contentHash, version: a.version })).version;
    return { a, cat, r, v };
  }

  it('the owner picks approved skills for a paid service: the service row runs with them, the list shows them', async () => {
    const { a, cat, r, v } = await withService();
    expect((await cat.list(a.userId, a.agentId)).services).toEqual([{ slug: 'digest', description: 'A DeFi digest', skills: [] }]);
    const out = await cat.setServiceSkills(a.userId, a.agentId, 'digest', ['defi-digest'], v);
    expect(out.version).toBe(v + 1);
    expect((await specs.active(a.agentId))!.spec.services[0]!.skills).toEqual(['defi-digest']);
    expect((await specs.service(a.agentId, 'digest'))!.skills).toEqual(['defi-digest']);
    expect((await cat.list(a.userId, a.agentId)).services[0]!.skills).toEqual(['defi-digest']);
    expect(await loadServiceSkills(sql, a.agentId, ['defi-digest', 'missing'])).toEqual([
      { name: 'defi-digest', description: (await specs.active(a.agentId))!.spec.skills[0]!.description, body: r.instructions, id: r.id, contentHash: r.contentHash },
    ]);
    // Clearing leaves no key behind: the description is what it was before skills existed.
    const cleared = await cat.setServiceSkills(a.userId, a.agentId, 'digest', [], out.version);
    expect('skills' in (await specs.active(a.agentId))!.spec.services[0]!).toBe(false);
    expect((await specs.service(a.agentId, 'digest'))!.skills).toEqual([]);
    expect(cleared.version).toBe(out.version + 1);
  });

  it('only approved, unedited skills can run in a service; a stale screen and an unknown service are refused', async () => {
    const own = parseSpec({ ...dailyDigest().spec, skills: [{ name: 'mine', description: 'mine', body: 'my own' }], services: [SERVICE] });
    if (!own.ok) throw new Error(own.problem);
    const a = await agent(own.spec);
    const { cat } = catalog();
    await expect(cat.setServiceSkills(a.userId, a.agentId, 'digest', ['mine'], a.version)).rejects.toMatchObject({ status: 409, code: 'skill_not_approved' });
    await expect(cat.setServiceSkills(a.userId, a.agentId, 'nope', [], a.version)).rejects.toMatchObject({ status: 404, code: 'service_not_found' });
    await expect(cat.setServiceSkills(a.userId, a.agentId, 'digest', [], a.version - 1)).rejects.toMatchObject({ code: 'version_changed' });
    await expect(cat.setServiceSkills(a.userId, a.agentId, 'digest', ['a', 'b', 'c'], a.version)).rejects.toMatchObject({ status: 400 });

    const b = await withService();
    const cur = (await specs.active(b.a.agentId))!.spec;
    const edited = parseSpec({ ...cur, skills: [{ ...cur.skills[0]!, body: `${cur.skills[0]!.body}\nmore` }] });
    if (!edited.ok) throw new Error(edited.problem);
    const { name: _n, spec: _s, ...view } = dailyDigest();
    const v = await specs.saveDraft(b.a.userId, b.a.agentId, edited.spec, undefined, view, b.v);
    await specs.approve(b.a.userId, b.a.agentId, v);
    expect(await loadServiceSkills(sql, b.a.agentId, ['defi-digest'])).toEqual([]);
    await expect(b.cat.setServiceSkills(b.a.userId, b.a.agentId, 'digest', ['defi-digest'], v)).rejects.toMatchObject({ code: 'skill_not_approved' });
  });

  it('instructions too long for a service together are refused', async () => {
    const { a, cat, v } = await withService();
    await sql`update app.skills set body = ${'x'.repeat(MAX_SERVICE_SKILL_CHARS + 1)} where agent_id = ${a.agentId}`;
    await sql`update app.skill_approvals set body_sha256 = encode(sha256(convert_to(${'x'.repeat(MAX_SERVICE_SKILL_CHARS + 1)}, 'UTF8')), 'hex') where agent_id = ${a.agentId}`;
    await expect(cat.setServiceSkills(a.userId, a.agentId, 'digest', ['defi-digest'], v)).rejects.toMatchObject({ code: 'skills_too_long' });
  });

  it('removing a skill takes it out of every service that ran with it', async () => {
    const { a, cat, v } = await withService();
    const set = (await cat.setServiceSkills(a.userId, a.agentId, 'digest', ['defi-digest'], v)).version;
    await cat.remove(a.userId, a.agentId, 'defi-digest', set);
    const active = (await specs.active(a.agentId))!.spec;
    expect(active.skills).toEqual([]);
    expect('skills' in active.services[0]!).toBe(false);
    expect((await specs.service(a.agentId, 'digest'))!.skills).toEqual([]);
  });

  it('a description naming a skill it does not hold does not parse', () => {
    const bad = parseSpec({ ...dailyDigest().spec, services: [{ ...SERVICE, skills: ['ghost'] }] });
    expect(bad.ok).toBe(false);
  });

  it('skills.sh or GitHub down is 503 skills_unavailable, never a partial list', async () => {
    const a = await agent();
    const down = createSkillCatalog({ sql, fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    await expect(down.suggestions(a.userId, a.agentId)).rejects.toMatchObject({ status: 503, code: 'skills_unavailable' });
    await expect(down.review('acme/skills/defi-digest')).rejects.toMatchObject({ status: 503, code: 'skills_unavailable' });
  });
});
