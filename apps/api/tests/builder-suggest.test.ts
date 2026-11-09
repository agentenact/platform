import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createBuilderLimits, USER_SUGGESTS } from '../src/builder/limits.js';
import { xlmDrop } from '../src/builder/examples.js';
import { bannedWord } from '../src/builder/words.js';
import { createSuggest, SUGGEST_MIN_DAYS, SUGGEST_TOOLS, suggestPrice, type Suggest } from '../src/builder/suggest.js';
import type { Db } from '../src/db/index.js';
import { createChecks } from '../src/runs/checks.js';
import { createSpecs, type Specs } from '../src/specs/index.js';
import { parseSpec, ServiceSpec, type AgentSpec } from '../src/specs/schema.js';
import { freshDb } from './support/db.js';
import { failingModel, scriptedModel } from './support/models.js';
import { activeAgent } from './support/specs.js';

setDefaultTimeout(30_000);

const suggestion = (over: Record<string, unknown> = {}) => ({
  label: 'Sell my XLM price checks to other agents',
  slug: 'xlm-drop-check',
  description: 'Tells another agent whether XLM fell sharply recently.',
  price_usdc: '0.02',
  input_schema: { type: 'object', properties: { window_s: { type: 'number' } }, required: [] },
  output_schema: { type: 'object', properties: { fell: { type: 'boolean' } }, required: ['fell'] },
  tools: ['stellar_price_change'],
  ...over,
});
const answer = (over: Record<string, unknown> = {}) => ({ text: JSON.stringify(suggestion(over)) });

describe('builder suggest (Task 19)', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql);
  });
  afterAll(() => drop());

  const build = (model: ReturnType<typeof scriptedModel>, o: { now?: () => Date } = {}): Suggest =>
    createSuggest({ sql, specs, checks: createChecks(sql), model, limits: createBuilderLimits(sql), ...o });
  const view = () => {
    const { name: _n, spec: _s, ...v } = xlmDrop();
    return v;
  };
  const ownerSpec = (): AgentSpec => {
    const r = parseSpec({
      ...xlmDrop().spec,
      tools: [...xlmDrop().spec.tools, 'send_webhook', 'hire_agent'],
      hire_targets: [{ url: 'https://hired.example/agent', max_usdc: '0.05' }],
      skills: [{ name: 'owner-skill', description: 'a skill', body: 'owner skill body' }],
      suggested_plan: ['owner plan step'],
      delivery: { email: true, webhook_url: 'https://hooks.example/owner-hook' },
    });
    if (!r.ok) throw new Error(r.problem);
    return r.spec;
  };
  /** An active agent with an approved description and `days` days of checks. */
  async function agent(o: { days?: number; spec?: AgentSpec; status?: string } = {}) {
    const a = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, o.spec ?? ownerSpec(), undefined, view());
    await specs.approve(a.userId, a.agentId, v);
    for (let i = 0; i < (o.days ?? SUGGEST_MIN_DAYS); i++) {
      await sql`insert into app.check_days (agent_id, day, quiet, fired) values (${a.agentId}, (now() at time zone 'utc')::date - ${i}::int, 5, 0)`;
    }
    if (o.status) await sql`update app.agents set status = ${o.status} where id = ${a.agentId}`;
    return a;
  }
  const versions = async (id: string) => (await sql`select version, status from app.agent_specs where agent_id = ${id} order by version`) as { version: number; status: string }[];
  const live = async (id: string) => (await sql`select slug, price_usdc::text as price, status from app.services where agent_id = ${id} order by slug`) as { slug: string; price: string; status: string }[];

  it('not eligible with 2 days; eligible with 3', async () => {
    const m = scriptedModel([answer()]);
    const s = build(m);
    const two = await agent({ days: SUGGEST_MIN_DAYS - 1 });
    expect(await s.get(two.userId, two.agentId)).toEqual({ eligible: false });
    expect(m.calls()).toBe(0);
    const three = await agent();
    const r = await s.get(three.userId, three.agentId);
    expect(r).toMatchObject({ eligible: true, suggestion: { label: 'Sell my XLM price checks to other agents' } });
  });

  it('not eligible with a live service', async () => {
    const m = scriptedModel([answer()]);
    const spec = parseSpec({ ...ownerSpec(), services: [{ ...(({ label: _l, ...rest }) => rest)(suggestion()), persona: 'p', skill_body: '' }] });
    // owned spec carries a service of its own
    const a = await agent({ spec: (spec as { spec: AgentSpec }).spec });
    expect(await live(a.agentId)).toHaveLength(1);
    expect(await build(m).get(a.userId, a.agentId)).toEqual({ eligible: false });
    expect(m.calls()).toBe(0);
  });

  it('not eligible while paused or provisioning (or revoked)', async () => {
    const m = scriptedModel([answer()]);
    for (const status of ['paused', 'provisioning', 'revoked']) {
      const a = await agent({ status });
      expect(await build(m).get(a.userId, a.agentId)).toEqual({ eligible: false });
    }
    expect(m.calls()).toBe(0);
  });

  it('another user\'s agent is 404 on get and publish', async () => {
    const a = await agent();
    const b = await activeAgent(sql);
    const s = build(scriptedModel([answer()]));
    await expect(s.get(b.userId, a.agentId)).rejects.toMatchObject({ status: 404 });
    await expect(s.publish(b.userId, a.agentId, 1)).rejects.toMatchObject({ status: 404 });
  });

  it('is generated once per version: a second get makes no model call; the model call is metered to the user', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    const first = await s.get(a.userId, a.agentId);
    const second = await s.get(a.userId, a.agentId);
    expect(second).toEqual(first);
    expect(m.calls()).toBe(1);
    await expect(build(m).get(a.userId, a.agentId)).resolves.toEqual(first); // a fresh instance reads the stored one
    expect(m.calls()).toBe(1);
    const stored = (await sql`select service_suggestion from app.agent_specs where agent_id = ${a.agentId} and version = 1`) as { service_suggestion: { label: string } }[];
    expect(stored[0]!.service_suggestion.label).toBe('Sell my XLM price checks to other agents');
    const usage = (await sql`select kind, n, tokens::int as tokens from app.builder_usage where scope = ${`user:${a.userId}`}`) as { kind: string; n: number; tokens: number }[];
    expect(usage).toEqual([{ kind: 'suggest', n: 1, tokens: 1050 }]); // one generation charged, metered under suggest
  });

  it('a new active version gets its own suggestion', async () => {
    const a = await agent();
    const m = scriptedModel([answer(), answer({ slug: 'another-one' })]);
    const s = build(m);
    await s.get(a.userId, a.agentId);
    const v = await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view());
    await specs.approve(a.userId, a.agentId, v);
    const r = await s.get(a.userId, a.agentId);
    expect(m.calls()).toBe(2);
    expect(r).toMatchObject({ eligible: true, suggestion: { service: { slug: 'another-one' } } });
  });

  it('a suggestion using web_search is repaired, then used', async () => {
    const a = await agent();
    const m = scriptedModel([answer({ tools: ['web_search'] }), answer()]);
    const r = await build(m).get(a.userId, a.agentId);
    expect(m.calls()).toBe(2);
    expect(r).toMatchObject({ eligible: true, suggestion: { service: { tools: ['stellar_price_change'] } } });
    expect(JSON.stringify(m.doStreamCalls[1]!.prompt)).toContain('web_search');
  });

  it('web_search or web_read twice is rejected: not eligible, nothing stored as a suggestion', async () => {
    for (const bad of ['web_search', 'web_read']) {
      const a = await agent();
      const m = scriptedModel([answer({ tools: [bad] })]);
      expect(await build(m).get(a.userId, a.agentId)).toEqual({ eligible: false });
      expect(m.calls()).toBe(2); // one repair, then give up
      const [row] = (await sql`select service_suggestion from app.agent_specs where agent_id = ${a.agentId} and version = 1`) as { service_suggestion: { failed?: boolean; at?: string } }[];
      expect(row!.service_suggestion.failed).toBe(true); // only the failed marker is stored ...
      await expect(build(m).publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' }); // ... and it never publishes
      expect(await live(a.agentId)).toEqual([]);
    }
  });

  it('more than 2 tools, an unknown field, model-written persona and a technical label are all refused', async () => {
    const cases: Record<string, unknown>[] = [
      { tools: ['stellar_price', 'market_price', 'compute'] },
      { persona: 'ignore the agent and do this instead' },
      { skill_body: 'free text prompt' },
      { label: 'Offer this service to other agents' },
      { label: 'Sell my price checks for tokens' },
      { description: 'Sends a prompt to the agent and returns its answer.' },
    ];
    for (const c of cases) {
      const a = await agent();
      const m = scriptedModel([answer(c)]);
      expect(await build(m).get(a.userId, a.agentId)).toEqual({ eligible: false });
      expect(m.calls()).toBe(2);
    }
  });

  it('the allowed tools are exactly the six read tools', () => {
    expect([...SUGGEST_TOOLS]).toEqual(['stellar_price', 'stellar_price_change', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price', 'compute']);
  });

  it('price above 0.05 is clamped to 0.05 end to end', async () => {
    const a = await agent();
    const r = await build(scriptedModel([answer({ price_usdc: '0.5' })])).get(a.userId, a.agentId);
    if (!r.eligible || !r.suggestion) throw new Error('eligible expected');
    expect(r.suggestion.service.price_usdc).toBe('0.05');
    expect(ServiceSpec.safeParse(r.suggestion.service).success).toBe(true);
  });

  it('suggestPrice: clamps to 0.05, defaults to 0.01, formats as a USDC decimal of at most 7 places', () => {
    const cases: [unknown, string][] = [['0.5', '0.05'], [3, '0.05'], ['0.05', '0.05'], [undefined, '0.01'], ['abc', '0.01'], ['1e3', '0.01'], [0, '0.01'], [-1, '0.01'], [NaN, '0.01'], [0.02, '0.02'], ['0.0123456789', '0.0123457'], [1e-9, '0.01'], [0.1 + 0.2 - 0.3, '0.01']];
    for (const [price, want] of cases) {
      const got = suggestPrice(price);
      expect([price, got]).toEqual([price, want]);
      expect(ServiceSpec.shape.price_usdc.safeParse(got).success).toBe(true);
    }
  });

  it('persona is the agent\'s own; the label is plain words', async () => {
    const a = await agent();
    const r = await build(scriptedModel([answer()])).get(a.userId, a.agentId);
    if (!r.eligible || !r.suggestion) throw new Error('eligible expected');
    expect(r.suggestion.service.persona).toBe(ownerSpec().persona);
    expect(bannedWord(r.suggestion.label)).toBeNull();
  });

  it('the slug is made unique against the agent\'s existing service slugs, off ones included', async () => {
    const a = await agent();
    await sql`insert into app.services (agent_id, slug, description, input_schema, output_schema, price_usdc, persona, skill_body, tools, spec_version, status)
              values (${a.agentId}, 'xlm-drop-check', 'old', ${{ type: 'object' }}, ${{ type: 'object' }}, 0.01, 'p', '', ${[]}, 1, 'off')`;
    const r = await build(scriptedModel([answer()])).get(a.userId, a.agentId);
    expect(r).toMatchObject({ eligible: true, suggestion: { service: { slug: 'xlm-drop-check-2' } } });
  });

  it('a model failure is not stored forever: not eligible now, retried after an hour', async () => {
    const a = await agent();
    let t = Date.now();
    const bad = failingModel();
    expect(await build(bad as never, { now: () => new Date(t) }).get(a.userId, a.agentId)).toEqual({ eligible: false });
    expect(await build(bad as never, { now: () => new Date(t) }).get(a.userId, a.agentId)).toEqual({ eligible: false });
    expect(bad.calls()).toBe(1); // no retry storm
    t += 61 * 60_000;
    const good = scriptedModel([answer()]);
    expect(await build(good, { now: () => new Date(t) }).get(a.userId, a.agentId)).toMatchObject({ eligible: true });
  });

  it('publish creates a new approved version with the service live; triggers keep last_fired_at; owner fields stay; the old version is kept', async () => {
    const a = await agent();
    await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
    const s = build(scriptedModel([answer({ price_usdc: '0.5' })]));
    await s.get(a.userId, a.agentId);
    await s.publish(a.userId, a.agentId, 1);
    expect(await versions(a.agentId)).toEqual([{ version: 1, status: 'approved' }, { version: 2, status: 'approved' }]);
    expect(await live(a.agentId)).toEqual([{ slug: 'xlm-drop-check', price: '0.0500000', status: 'live' }]);
    const t = (await sql`select last_fired_at, spec_version from app.triggers where agent_id = ${a.agentId}`) as { last_fired_at: Date | null; spec_version: number }[];
    expect(t.map((x) => [x.last_fired_at, x.spec_version])).toEqual([[new Date('2026-10-05T09:00:00Z'), 2]]);
    const shown = await specs.view(a.userId, a.agentId);
    expect(shown.active!.version).toBe(2);
    expect(shown.active!.view).toEqual(view()); // the view is carried over
    const before = ownerSpec();
    expect({ ...shown.active!.spec, services: [] } as AgentSpec).toEqual(before); // owner-added fields intact, nothing else changed
    expect(shown.active!.spec.services).toHaveLength(1);
    expect(shown.active!.spec.services[0]!.persona).toBe(before.persona);
    expect(((await sql`select body from app.skills where agent_id = ${a.agentId}`) as unknown[]).length).toBe(1);
    // and it is no longer offered
    expect(await s.get(a.userId, a.agentId)).toEqual({ eligible: false });
  });

  it('publish twice is 409 not_eligible', async () => {
    const a = await agent();
    const s = build(scriptedModel([answer()]));
    await s.get(a.userId, a.agentId);
    await s.publish(a.userId, a.agentId, 1);
    await expect(s.publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(await versions(a.agentId)).toHaveLength(2);
  });

  it('concurrent publishes: exactly one succeeds', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    await s.get(a.userId, a.agentId);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => build(m).publish(a.userId, a.agentId, 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ status: 409, code: 'not_eligible' });
    expect(await versions(a.agentId)).toHaveLength(2);
    expect(await live(a.agentId)).toHaveLength(1);
  });

  it('publish refuses when no longer eligible (paused, too few days), and never calls the model for a ineligible agent', async () => {
    const m = scriptedModel([answer()]);
    const few = await agent({ days: 1 });
    await expect(build(m).publish(few.userId, few.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    const paused = await agent();
    const s = build(m);
    await s.get(paused.userId, paused.agentId);
    await sql`update app.agents set status = 'paused' where id = ${paused.agentId}`;
    await expect(s.publish(paused.userId, paused.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(await live(paused.agentId)).toEqual([]);
    expect(m.calls()).toBe(1);
  });

  it('publish never calls the model: without a stored suggestion it is 409 and creates nothing', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    await expect(build(m).publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(m.calls()).toBe(0);
    expect(await live(a.agentId)).toEqual([]);
    expect(await versions(a.agentId)).toHaveLength(1);
  });

  it('a suggestion shown for an older version cannot be published after the active version changed', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    await s.get(a.userId, a.agentId); // shown for version 1
    const v = await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view());
    await specs.approve(a.userId, a.agentId, v); // version 2 is active and has no suggestion yet
    await expect(s.publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(m.calls()).toBe(1);
    expect(await live(a.agentId)).toEqual([]);
  });

  it('publish needs the version the card showed: a stale or wrong echo is 409 even when the new version has its own suggestion', async () => {
    const a = await agent();
    const m = scriptedModel([answer(), answer({ slug: 'second-offer' })]);
    const s = build(m);
    const first = await s.get(a.userId, a.agentId);
    expect(first).toMatchObject({ eligible: true, suggestion: { version: 1 } });
    const v = await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view());
    await specs.approve(a.userId, a.agentId, v); // version 2 active
    const second = await s.get(a.userId, a.agentId);
    expect(second).toMatchObject({ eligible: true, suggestion: { version: 2, service: { slug: 'second-offer' } } });
    for (const shown of [1, 3, 0]) await expect(s.publish(a.userId, a.agentId, shown)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(await live(a.agentId)).toEqual([]);
    await s.publish(a.userId, a.agentId, 2);
    expect((await live(a.agentId)).map((x) => x.slug)).toEqual(['second-offer']);
  });

  it('a pending owner draft: not offered, and publish refuses rather than hide it', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    await s.get(a.userId, a.agentId);
    await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view()); // a revision the owner has not approved yet
    await expect(s.publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    expect(await s.get(a.userId, a.agentId)).toEqual({ eligible: false });
    expect(await live(a.agentId)).toEqual([]);
    expect(await versions(a.agentId)).toEqual([{ version: 1, status: 'approved' }, { version: 2, status: 'draft' }]);
  });

  it(`daily cap: the ${USER_SUGGESTS + 1}th new generation of a UTC day makes no model call, stores nothing, and is a plain daily_limit`, async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    await s.get(a.userId, a.agentId);
    for (let i = 1; i < USER_SUGGESTS; i++) {
      const v = await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view());
      await specs.approve(a.userId, a.agentId, v);
      expect(await s.get(a.userId, a.agentId)).toMatchObject({ eligible: true, suggestion: { label: expect.any(String) } });
    }
    expect(m.calls()).toBe(USER_SUGGESTS);
    const v = await specs.saveDraft(a.userId, a.agentId, ownerSpec(), undefined, view());
    await specs.approve(a.userId, a.agentId, v);
    const tokensBefore = (await sql`select tokens::int as t from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'suggest'`) as { t: number }[];
    for (let i = 0; i < 3; i++) expect(await s.get(a.userId, a.agentId)).toEqual({ eligible: true, suggestion: null, reason: 'daily_limit' });
    expect(m.calls()).toBe(USER_SUGGESTS); // no model call
    const [row] = (await sql`select service_suggestion from app.agent_specs where agent_id = ${a.agentId} and version = ${v}`) as { service_suggestion: unknown }[];
    expect(row!.service_suggestion).toBeNull(); // no failed marker, so tomorrow's get can generate
    const usage = (await sql`select n, tokens::int as t from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'suggest'`) as { n: number; t: number }[];
    expect(usage).toEqual([{ n: USER_SUGGESTS, t: tokensBefore[0]!.t }]);
    await expect(s.publish(a.userId, a.agentId, 1)).rejects.toMatchObject({ status: 409, code: 'not_eligible' });
    // another user is unaffected
    const b = await agent();
    expect(await build(m).get(b.userId, b.agentId)).toMatchObject({ eligible: true, suggestion: { label: expect.any(String) } });
    // the next UTC day charges again
    await sql`update app.builder_usage set day = day - 1 where scope = ${`user:${a.userId}`} and kind = 'suggest'`;
    expect(await s.get(a.userId, a.agentId)).toMatchObject({ eligible: true, suggestion: { label: expect.any(String) } });
  });

  it('concurrent gets of one version charge the cap once and call the model once', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const s = build(m);
    await Promise.all(Array.from({ length: 4 }, () => s.get(a.userId, a.agentId)));
    expect(m.calls()).toBe(1);
    const [row] = (await sql`select n from app.builder_usage where scope = ${`user:${a.userId}`} and kind = 'suggest'`) as { n: number }[];
    expect(row!.n).toBe(1);
  });

  it('a metering fault after the write does not lose the suggestion (no regeneration loop)', async () => {
    const a = await agent();
    const m = scriptedModel([answer()]);
    const real = createBuilderLimits(sql);
    const flaky = createSuggest({ sql, specs, checks: createChecks(sql), model: m, limits: { admit: real.admit, addTokens: async () => { throw new Error('meter down'); } } });
    await expect(flaky.get(a.userId, a.agentId)).rejects.toThrow('meter down');
    expect(await build(m).get(a.userId, a.agentId)).toMatchObject({ eligible: true });
    expect(m.calls()).toBe(1);
  });

  it('publish makes the slug unique at publish time', async () => {
    const a = await agent();
    const s = build(scriptedModel([answer()]));
    await s.get(a.userId, a.agentId);
    await sql`insert into app.services (agent_id, slug, description, input_schema, output_schema, price_usdc, persona, skill_body, tools, spec_version, status)
              values (${a.agentId}, 'xlm-drop-check', 'old', ${{ type: 'object' }}, ${{ type: 'object' }}, 0.01, 'p', '', ${[]}, 1, 'off')`;
    await s.publish(a.userId, a.agentId, 1);
    expect((await live(a.agentId)).filter((x) => x.status === 'live').map((x) => x.slug)).toEqual(['xlm-drop-check-2']);
  });
});
