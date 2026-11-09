import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { dailyDigest } from '../src/builder/examples.js';
import { createAgents } from '../src/agents/index.js';
import type { Db } from '../src/db/index.js';
import { createSkillCatalog, loadServiceSkills, type SkillCatalog } from '../src/skills/index.js';
import { createSkillSets, MAX_SET_SKILLS, planSet, type SetItem, type SkillSets } from '../src/skills/sets.js';
import { createSpecs, type Specs } from '../src/specs/index.js';
import { parseSpec, type AgentSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { insertUser } from './support/fixtures.js';
import { C1, C2, fakeNet } from './support/skills-net.js';
import { activeAgent, minimalSpec } from './support/specs.js';

/** contractAddress(fill) repeats one byte, and activeAgent's counter reaches every byte value across a run's files. */
const randomOwner = () => StrKey.encodeContract(randomBytes(32));

const DIGEST = 'acme/skills/defi-digest';
const CHART = 'acme/skills/chart-notes';

describe('skill sets', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
  });
  afterAll(() => drop());

  async function agent(spec: AgentSpec = dailyDigest().spec, userId?: string) {
    let a = await activeAgent(sql);
    if (userId) {
      await sql`update app.agents set user_id = ${userId} where id = ${a.agentId}`;
      a = { ...a, userId };
    }
    const { name: _n, spec: _s, ...view } = dailyDigest();
    const v = await specs.saveDraft(a.userId, a.agentId, spec, undefined, view);
    await specs.approve(a.userId, a.agentId, v);
    return { ...a, version: v };
  }
  function kit(net = fakeNet()) {
    const cat = createSkillCatalog({ sql, fetch: net.fetch, now: () => new Date('2026-10-30T18:00:00Z') }) as SkillCatalog;
    let t = Date.parse('2026-10-30T18:00:00Z');
    const sets = createSkillSets({ sql, catalog: cat, now: () => new Date((t += 1000)) }) as SkillSets;
    return { net, cat, sets };
  }
  /** A set holding both test skills, reviewed and added at the commit shown. */
  async function fullSet(k: ReturnType<typeof kit>, userId: string, name = 'Research') {
    const s = await k.sets.create(userId, name);
    const d = await k.cat.review(DIGEST);
    const c = await k.cat.review(CHART);
    let r = (await k.sets.addSkill(userId, s.id, { id: d.id, commit: d.commit, contentHash: d.contentHash, revision: s.revision })).revision;
    r = (await k.sets.addSkill(userId, s.id, { id: c.id, commit: c.commit, contentHash: c.contentHash, revision: r, acceptRisk: true })).revision;
    return { id: s.id, revision: r, d, c };
  }

  it('adding a skill re-reads the reviewed commit, keeps its pin, and needs the risk tick for an unaudited one', async () => {
    const a = await agent();
    const k = kit();
    const s = await k.sets.create(a.userId, '  Daily   notes ');
    const c = await k.cat.review(CHART);
    expect(c.verdict).toBe('unaudited');
    await expect(k.sets.addSkill(a.userId, s.id, { id: c.id, commit: c.commit, contentHash: c.contentHash, revision: s.revision })).rejects.toMatchObject({ code: 'needs_accept_risk' });
    await expect(k.sets.addSkill(a.userId, s.id, { id: c.id, commit: c.commit, contentHash: 'f'.repeat(64), revision: s.revision, acceptRisk: true })).rejects.toMatchObject({ code: 'skill_changed' });
    const r = await k.sets.addSkill(a.userId, s.id, { id: c.id, commit: c.commit, contentHash: c.contentHash, revision: s.revision, acceptRisk: true });
    expect(r.revision).toBe(s.revision + 1);
    // The screen's revision is stale now.
    const d = await k.cat.review(DIGEST);
    await expect(k.sets.addSkill(a.userId, s.id, { id: d.id, commit: d.commit, contentHash: d.contentHash, revision: s.revision })).rejects.toMatchObject({ code: 'set_changed' });
    const [view] = await k.sets.list(a.userId);
    expect(view).toMatchObject({ id: s.id, name: 'Daily notes', revision: r.revision });
    expect(view!.skills).toEqual([{ id: CHART, name: 'chart-notes', description: 'Describes a price chart in two sentences.', verdict: 'unaudited', commit: C1, addedAt: expect.any(String) }]);
  });

  it('is owner-only: another account cannot see, change or apply a set, and a foreign set costs no GitHub read', async () => {
    const a = await agent();
    const b = await agent();
    const k = kit();
    const s = await fullSet(k, a.userId);
    expect(await k.sets.list(b.userId)).toEqual([]);
    const calls = k.net.state.calls;
    await expect(k.sets.addSkill(b.userId, s.id, { id: DIGEST, commit: C1, contentHash: s.d.contentHash, revision: s.revision })).rejects.toMatchObject({ status: 404 });
    expect(k.net.state.calls).toBe(calls);
    await expect(k.sets.rename(b.userId, s.id, 'x')).rejects.toMatchObject({ status: 404 });
    await expect(k.sets.remove(b.userId, s.id)).rejects.toMatchObject({ status: 404 });
    await expect(k.sets.apply(b.userId, b.agentId, s.id, { version: b.version, revision: s.revision })).rejects.toMatchObject({ status: 404, code: 'set_not_found' });
    await expect(k.sets.apply(b.userId, a.agentId, s.id, { version: a.version, revision: s.revision })).rejects.toMatchObject({ status: 404 });
    expect((await k.sets.forAgent(b.userId, b.agentId)).sets).toEqual([]);
  });

  it('applying adds every skill through ONE new approved version, recorded as approved one by one', async () => {
    const a = await agent();
    const k = kit();
    const s = await fullSet(k, a.userId);
    const before = (await k.sets.forAgent(a.userId, a.agentId)).sets[0]!;
    expect(before).toMatchObject({ applied: null, add: ['defi-digest', 'chart-notes'], update: [], same: [], conflicts: [], fits: true });
    const out = await k.sets.apply(a.userId, a.agentId, s.id, { version: a.version, revision: s.revision });
    expect(out).toEqual({ version: a.version + 1, added: ['defi-digest', 'chart-notes'], updated: [] });
    const active = (await specs.active(a.agentId))!;
    expect(active.version).toBe(out.version);
    expect(active.spec.skills.map((x) => x.name)).toEqual(['defi-digest', 'chart-notes']);
    expect(active.spec.skills[0]!.body).toBe(s.d.instructions);
    const rows = (await sql`select name, skill_id, content_hash, verdict, approved_by, spec_version from app.skill_approvals where agent_id = ${a.agentId} order by name`) as Record<string, unknown>[];
    expect(rows).toEqual([
      { name: 'chart-notes', skill_id: CHART, content_hash: s.c.contentHash, verdict: 'unaudited', approved_by: a.userId, spec_version: out.version },
      { name: 'defi-digest', skill_id: DIGEST, content_hash: s.d.contentHash, verdict: 'caution', approved_by: a.userId, spec_version: out.version },
    ]);
    // They are usable by a paid service like one-by-one approvals.
    expect((await loadServiceSkills(sql, a.agentId, ['defi-digest'])).map((x) => x.contentHash)).toEqual([s.d.contentHash]);
    expect((await k.cat.list(a.userId, a.agentId)).skills.every((x) => x.source && !x.source.edited)).toBe(true);
    const after = (await k.sets.forAgent(a.userId, a.agentId)).sets[0]!;
    expect(after).toMatchObject({ applied: s.revision, add: [], same: ['defi-digest', 'chart-notes'] });
    // Applying again changes nothing and makes no version.
    expect(await k.sets.apply(a.userId, a.agentId, s.id, { version: out.version, revision: s.revision })).toEqual({ version: out.version, added: [], updated: [] });
  });

  it('a stale screen is refused and changes nothing: the agent moved on, or the set did', async () => {
    const a = await agent();
    const k = kit();
    const s = await fullSet(k, a.userId);
    await expect(k.sets.apply(a.userId, a.agentId, s.id, { version: a.version - 1 || 99, revision: s.revision })).rejects.toMatchObject({ code: 'version_changed' });
    await expect(k.sets.apply(a.userId, a.agentId, s.id, { version: a.version, revision: s.revision - 1 })).rejects.toMatchObject({ code: 'set_changed' });
    expect((await specs.active(a.agentId))!.version).toBe(a.version);
  });

  it('no silent updates: changing a set shows the agent as changed and reaches it only when applied again', async () => {
    const a = await agent();
    const k = kit();
    const s = await k.sets.create(a.userId, 'Digest');
    const d = await k.cat.review(DIGEST);
    const r1 = (await k.sets.addSkill(a.userId, s.id, { id: d.id, commit: d.commit, contentHash: d.contentHash, revision: s.revision })).revision;
    const v1 = (await k.sets.apply(a.userId, a.agentId, s.id, { version: a.version, revision: r1 })).version;

    // The owner re-reviews the skill at a newer commit and puts that pin in the set.
    k.net.state.head = C2;
    const net2 = fakeNet();
    net2.state.head = C2;
    const k2 = { ...k, cat: createSkillCatalog({ sql, fetch: net2.fetch }) };
    const sets2 = createSkillSets({ sql, catalog: k2.cat });
    const d2 = await k2.cat.review(DIGEST);
    expect(d2.commit).toBe(C2);
    const r2 = (await sets2.addSkill(a.userId, s.id, { id: d2.id, commit: d2.commit, contentHash: d2.contentHash, revision: r1 })).revision;

    // Nothing reached the agent.
    expect((await specs.active(a.agentId))!.version).toBe(v1);
    expect(await specs.skillBody(a.agentId, 'defi-digest')).not.toContain('GEVIL');
    expect((await sets2.forAgent(a.userId, a.agentId)).sets[0]).toMatchObject({ revision: r2, applied: r1, add: [], update: ['defi-digest'], same: [] });

    const out = await sets2.apply(a.userId, a.agentId, s.id, { version: v1, revision: r2 });
    expect(out).toEqual({ version: v1 + 1, added: [], updated: ['defi-digest'] });
    expect(await specs.skillBody(a.agentId, 'defi-digest')).toContain('GEVIL');
    const [row] = (await sql`select content_hash, pin from app.skill_approvals where agent_id = ${a.agentId}`) as { content_hash: string; pin: { commit: string } }[];
    expect([row!.content_hash, row!.pin.commit]).toEqual([d2.contentHash, C2]);

    // Taking a skill out of the set, or deleting the set, never takes it off the agent.
    const r3 = (await sets2.removeSkill(a.userId, s.id, 'defi-digest', r2)).revision;
    expect(r3).toBe(r2 + 1);
    await sets2.remove(a.userId, s.id);
    expect((await specs.active(a.agentId))!.spec.skills.map((x) => x.name)).toEqual(['defi-digest']);
    expect(((await sql`select 1 from app.agent_skill_sets where agent_id = ${a.agentId}`) as unknown[]).length).toBe(0);
  });

  it('refuses as a whole on a name another skill holds, a hand edit, or too many skills', async () => {
    const own = parseSpec({ ...dailyDigest().spec, skills: [{ name: 'chart-notes', description: 'mine', body: 'my own' }] });
    if (!own.ok) throw new Error(own.problem);
    const a = await agent(own.spec);
    const k = kit();
    const s = await fullSet(k, a.userId);
    expect((await k.sets.forAgent(a.userId, a.agentId)).sets[0]).toMatchObject({ add: ['defi-digest'], conflicts: [{ name: 'chart-notes', reason: 'name_taken' }] });
    await expect(k.sets.apply(a.userId, a.agentId, s.id, { version: a.version, revision: s.revision })).rejects.toMatchObject({ status: 409, code: 'set_conflict' });
    expect((await specs.active(a.agentId))!.version).toBe(a.version);

    // Hand-edited after approval: the set would overwrite the owner's edit, so it asks them first.
    const b = await agent(dailyDigest().spec, a.userId);
    const v = (await k.sets.apply(a.userId, b.agentId, s.id, { version: b.version, revision: s.revision })).version;
    const cur = (await specs.active(b.agentId))!.spec;
    const edited = parseSpec({ ...cur, skills: cur.skills.map((x) => (x.name === 'defi-digest' ? { ...x, body: `${x.body}\nmine` } : x)) });
    if (!edited.ok) throw new Error(edited.problem);
    const { name: _n, spec: _s, ...view } = dailyDigest();
    const v2 = await specs.saveDraft(a.userId, b.agentId, edited.spec, undefined, view, v);
    await specs.approve(a.userId, b.agentId, v2);
    expect((await k.sets.forAgent(a.userId, b.agentId)).sets[0]!.conflicts).toEqual([{ name: 'defi-digest', reason: 'edited' }]);

    // Over the agent's limit.
    const many = parseSpec({ ...dailyDigest().spec, skills: Array.from({ length: MAX_SET_SKILLS - 1 }, (_, i) => ({ name: `own-${i}`, description: 'mine', body: 'my own' })) });
    if (!many.ok) throw new Error(many.problem);
    const c = await agent(many.spec, a.userId);
    expect((await k.sets.forAgent(a.userId, c.agentId)).sets[0]!.fits).toBe(false);
    await expect(k.sets.apply(a.userId, c.agentId, s.id, { version: c.version, revision: s.revision })).rejects.toMatchObject({ code: 'too_many_skills' });
  });

  it('a set made from an agent copies only its approved, unedited skills from skills.sh', async () => {
    const own = parseSpec({ ...dailyDigest().spec, skills: [{ name: 'mine', description: 'mine', body: 'my own' }] });
    if (!own.ok) throw new Error(own.problem);
    const a = await agent(own.spec);
    const k = kit();
    const src = await fullSet(k, a.userId, 'Source');
    await k.sets.apply(a.userId, a.agentId, src.id, { version: a.version, revision: src.revision });
    const copy = await k.sets.create(a.userId, 'Copy', a.agentId);
    const view = (await k.sets.list(a.userId)).find((x) => x.id === copy.id)!;
    expect(view.skills.map((x) => [x.id, x.verdict])).toEqual([[DIGEST, 'caution'], [CHART, 'unaudited']]);
    const [item] = (await sql`select accept_risk from app.skill_set_items where set_id = ${copy.id} and name = 'chart-notes'`) as { accept_risk: boolean }[];
    expect(item!.accept_risk).toBe(true);
    const bare = await agent(dailyDigest().spec, a.userId);
    await expect(k.sets.create(a.userId, 'Empty', bare.agentId)).rejects.toMatchObject({ code: 'no_skills_to_copy' });
    expect((await k.sets.list(a.userId)).map((x) => x.name)).toEqual(['Source', 'Copy']);
    await expect(k.sets.create(a.userId, 'Copy')).rejects.toMatchObject({ status: 409, code: 'name_taken' });
    const other = await agent();
    await expect(k.sets.create(a.userId, 'Foreign', other.agentId)).rejects.toMatchObject({ status: 404 });
  });

  /** An owner with one agent holding both test skills, approved through a set, and a hand-written one. */
  async function holding(k: ReturnType<typeof kit>) {
    const own = parseSpec({ ...dailyDigest().spec, skills: [{ name: 'mine', description: 'mine', body: 'my own' }] });
    if (!own.ok) throw new Error(own.problem);
    const a = await agent(own.spec);
    const src = await fullSet(k, a.userId, 'Source');
    await k.sets.apply(a.userId, a.agentId, src.id, { version: a.version, revision: src.revision });
    const [row] = (await sql`select name from app.agents where id = ${a.agentId}`) as { name: string }[];
    return { ...a, agentName: row!.name, src };
  }
  const picks = (list: { id: string; contentHash: string }[]) => list.map(({ id, contentHash }) => ({ id, contentHash }));

  it("approved lists the owner's unedited skills from skills.sh across agents, one row per skill, nobody else's", async () => {
    const k = kit();
    const a = await holding(k);
    const calls = k.net.state.calls;
    expect(await k.sets.approved(a.userId)).toEqual([
      { id: CHART, name: 'chart-notes', description: 'Describes a price chart in two sentences.', verdict: 'unaudited', commit: C1, contentHash: a.src.c.contentHash, agents: [a.agentName] },
      { id: DIGEST, name: 'defi-digest', description: expect.any(String), verdict: 'caution', commit: C1, contentHash: a.src.d.contentHash, agents: [a.agentName] },
    ]);
    expect(k.net.state.calls).toBe(calls);
    expect(await k.sets.approved((await agent()).userId)).toEqual([]);

    // A second agent with the same pins: still one row each, naming both agents.
    const b = await agent(dailyDigest().spec, a.userId);
    await k.sets.apply(a.userId, b.agentId, a.src.id, { version: b.version, revision: a.src.revision });
    const [b2] = (await sql`select name from app.agents where id = ${b.agentId}`) as { name: string }[];
    const both = await k.sets.approved(a.userId);
    expect(both.map((x) => x.name)).toEqual(['chart-notes', 'defi-digest']);
    expect([...both[0]!.agents].sort()).toEqual([a.agentName, b2!.name].sort());

    // A hand edit on one agent leaves the other's copy; a revoked agent's skills are gone.
    const cur = (await specs.active(a.agentId))!;
    const edited = parseSpec({ ...cur.spec, skills: cur.spec.skills.map((x) => (x.name === 'chart-notes' ? { ...x, body: `${x.body}\nmine` } : x)) });
    if (!edited.ok) throw new Error(edited.problem);
    const { name: _n, spec: _s, ...view } = dailyDigest();
    const v = await specs.saveDraft(a.userId, a.agentId, edited.spec, undefined, view, cur.version);
    await specs.approve(a.userId, a.agentId, v);
    expect((await k.sets.approved(a.userId)).find((x) => x.name === 'chart-notes')!.agents).toEqual([b2!.name]);
    await sql`update app.agents set status = 'revoked' where id = ${b.agentId}`;
    expect((await k.sets.approved(a.userId)).map((x) => x.name)).toEqual(['defi-digest']);
  });

  it('a set made from picks copies the approved pins with no GitHub read, and can be given to an agent', async () => {
    const k = kit();
    const a = await holding(k);
    const list = await k.sets.approved(a.userId);
    const calls = k.net.state.calls;
    const made = await k.sets.createWith(a.userId, ' Picked ', picks(list));
    expect(k.net.state.calls).toBe(calls);
    expect(made.revision).toBe(1);
    const view = (await k.sets.list(a.userId)).find((x) => x.id === made.id)!;
    expect(view.name).toBe('Picked');
    expect(view.skills.map((x) => [x.id, x.verdict, x.commit])).toEqual([[CHART, 'unaudited', C1], [DIGEST, 'caution', C1]]);
    const rows = (await sql`select name, content_hash, accept_risk, body from app.skill_set_items where set_id = ${made.id} order by name`) as { name: string; content_hash: string; accept_risk: boolean; body: string }[];
    expect(rows.map((r) => [r.name, r.content_hash, r.accept_risk])).toEqual([['chart-notes', a.src.c.contentHash, true], ['defi-digest', a.src.d.contentHash, false]]);
    expect(rows[0]!.body).toContain('Say where the price started');

    const b = await agent(dailyDigest().spec, a.userId);
    expect((await k.sets.apply(a.userId, b.agentId, made.id, { version: b.version, revision: made.revision })).added).toEqual(['chart-notes', 'defi-digest']);
    expect((await k.sets.forAgent(a.userId, a.agentId)).sets.find((x) => x.id === made.id)).toMatchObject({ add: [], same: ['chart-notes', 'defi-digest'] });

    // Nothing picked is an empty set, ready to fill from a skill's checks.
    const empty = await k.sets.createWith(a.userId, 'Empty', []);
    expect((await k.sets.list(a.userId)).find((x) => x.id === empty.id)!.skills).toEqual([]);
  });

  it('a pick must match what the owner holds: otherwise nothing is made, and each refusal says why', async () => {
    const k = kit();
    const a = await holding(k);
    const [chart, digest] = await k.sets.approved(a.userId);
    const stale = { id: chart!.id, contentHash: 'f'.repeat(64) };
    await expect(k.sets.createWith(a.userId, 'Stale', [stale])).rejects.toMatchObject({ status: 409, code: 'skill_changed' });
    await expect(k.sets.createWith(a.userId, 'Twice', picks([chart!, chart!]))).rejects.toMatchObject({ status: 400, code: 'bad_request' });
    await expect(k.sets.createWith(a.userId, 'Many', Array.from({ length: MAX_SET_SKILLS + 1 }, (_, i) => ({ id: `acme/skills/s${i}`, contentHash: 'f'.repeat(64) })))).rejects.toMatchObject({ code: 'too_many_skills' });
    await expect(k.sets.createWith(a.userId, 'Source', picks([digest!]))).rejects.toMatchObject({ status: 409, code: 'name_taken' });

    // Another account's approved skill is not theirs to copy.
    const other = await agent();
    await expect(k.sets.createWith(other.userId, 'Foreign', picks([digest!]))).rejects.toMatchObject({ code: 'skill_changed' });
    expect(await k.sets.list(other.userId)).toEqual([]);

    // Two sources with one name cannot share a set.
    const b = await agent(dailyDigest().spec, a.userId);
    await k.sets.apply(a.userId, b.agentId, a.src.id, { version: b.version, revision: a.src.revision });
    await sql`update app.skill_approvals set skill_id = 'other/skills/chart-notes' where agent_id = ${b.agentId} and name = 'chart-notes'`;
    const clash = [picks([chart!])[0]!, { id: 'other/skills/chart-notes', contentHash: chart!.contentHash }];
    await expect(k.sets.createWith(a.userId, 'Clash', clash)).rejects.toMatchObject({ status: 409, code: 'skill_exists' });

    expect((await k.sets.list(a.userId)).map((x) => x.name)).toEqual(['Source']);
  });

  it('a set can take skills reviewed on skills.sh beside those agents hold, read again at the commit shown', async () => {
    const k = kit();
    const a = await holding(k);
    const [, digest] = await k.sets.approved(a.userId);
    await sql`delete from app.skill_approvals where agent_id = ${a.agentId} and name = 'chart-notes'`;
    const c = await k.cat.review(CHART);
    const reviewed = { id: c.id, contentHash: c.contentHash, commit: c.commit };

    // Unaudited: the owner's risk tick is required here too, and a changed file is refused. Nothing is made either way.
    await expect(k.sets.createWith(a.userId, 'No tick', [reviewed])).rejects.toMatchObject({ code: 'needs_accept_risk' });
    await expect(k.sets.createWith(a.userId, 'Moved', [{ ...reviewed, contentHash: 'f'.repeat(64), acceptRisk: true }])).rejects.toMatchObject({ code: 'skill_changed' });
    expect((await k.sets.list(a.userId)).map((x) => x.name)).toEqual(['Source']);

    const made = await k.sets.createWith(a.userId, 'Both', [{ ...reviewed, acceptRisk: true }, { id: digest!.id, contentHash: digest!.contentHash }]);
    const view = (await k.sets.list(a.userId)).find((x) => x.id === made.id)!;
    expect(view.skills.map((x) => [x.id, x.verdict, x.commit])).toEqual([[CHART, 'unaudited', C1], [DIGEST, 'caution', C1]]);
    const [row] = (await sql`select accept_risk, body from app.skill_set_items where set_id = ${made.id} and name = 'chart-notes'`) as { accept_risk: boolean; body: string }[];
    expect(row!.accept_risk).toBe(true);
    expect(row!.body).toContain('Say where the price started');

    const b = await agent(dailyDigest().spec, a.userId);
    expect((await k.sets.apply(a.userId, b.agentId, made.id, { version: b.version, revision: made.revision })).added).toEqual(['chart-notes', 'defi-digest']);
  });

  it('names are 1–60 characters; an account holds at most 20 sets', async () => {
    const userId = await insertUser(sql, { ownerAddress: randomOwner() });
    const k = kit();
    await expect(k.sets.create(userId, '   ')).rejects.toMatchObject({ status: 400 });
    await expect(k.sets.create(userId, 'x'.repeat(61))).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 20; i++) await k.sets.create(userId, `Set ${i}`);
    await expect(k.sets.create(userId, 'One more')).rejects.toMatchObject({ code: 'too_many_sets' });
  });

  it('a new agent can start with a set: v1 holds its skills, each recorded as approved', async () => {
    const userId = await insertUser(sql, { ownerAddress: randomOwner() });
    const k = kit();
    const s = await fullSet(k, userId);
    const agents = createAgents(sql);
    const spec = minimalSpec();
    await expect(agents.create(userId, 'stale', spec, undefined, crypto.randomUUID(), { id: s.id, revision: s.revision - 1 })).rejects.toMatchObject({ code: 'set_changed' });
    expect(((await sql`select 1 from app.agents where user_id = ${userId}`) as unknown[]).length).toBe(0);
    const { id } = await agents.create(userId, 'with set', spec, undefined, crypto.randomUUID(), { id: s.id, revision: s.revision });
    const [v1] = (await sql`select spec, status from app.agent_specs where agent_id = ${id} and version = 1`) as { spec: AgentSpec; status: string }[];
    expect(v1!.status).toBe('approved');
    expect(v1!.spec.skills.map((x) => x.name)).toEqual(['defi-digest', 'chart-notes']);
    const rows = (await sql`select name, spec_version from app.skill_approvals where agent_id = ${id} order by name`) as { name: string; spec_version: number }[];
    expect(rows).toEqual([{ name: 'chart-notes', spec_version: 1 }, { name: 'defi-digest', spec_version: 1 }]);
    const [link] = (await sql`select revision from app.agent_skill_sets where agent_id = ${id}`) as { revision: number }[];
    expect(link!.revision).toBe(s.revision);
    // Someone else's set is not found, and nothing is made.
    const other = await insertUser(sql, { ownerAddress: randomOwner() });
    await expect(agents.create(other, 'x', spec, undefined, crypto.randomUUID(), { id: s.id, revision: s.revision })).rejects.toMatchObject({ status: 404 });
  });

  it('planSet: same source at the same pin is left alone; same name from elsewhere conflicts', () => {
    const spec = minimalSpec({ skills: [{ name: 'a', description: 'd', body: 'b' }] });
    const item = (o: Partial<SetItem>): SetItem => ({ name: 'a', skillId: 'x/y/a', contentHash: 'h'.repeat(64), pin: { kind: 'github', repo: 'x/y', commit: C1, dir: 'a' } as never, verdict: 'clear', audits: [], findings: [], acceptRisk: false, description: 'd', body: 'b', addedAt: new Date(), ...o });
    const sha = new Bun.CryptoHasher('sha256').update('b').digest('hex');
    expect(planSet(spec, [{ name: 'a', skill_id: 'x/y/a', content_hash: 'h'.repeat(64), body_sha256: sha }], [item({})]).same).toEqual(['a']);
    expect(planSet(spec, [{ name: 'a', skill_id: 'x/y/other', content_hash: 'h'.repeat(64), body_sha256: sha }], [item({})]).conflicts).toEqual([{ name: 'a', reason: 'name_taken' }]);
    expect(planSet(spec, [], [item({})]).conflicts).toEqual([{ name: 'a', reason: 'name_taken' }]);
  });
});
