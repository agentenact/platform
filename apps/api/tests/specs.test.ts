import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createAgents } from '../src/agents/index.js';
import { xlmDrop } from '../src/builder/examples.js';
import type { Db } from '../src/db/index.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createSpecs, triggerKey, type Specs } from '../src/specs/index.js';
import { freshDb } from './support/db.js';
import { contractAddress, insertUser } from './support/fixtures.js';
import { activeAgent, minimalSpec } from './support/specs.js';

const NOW = new Date('2026-10-05T10:07:00Z');
const svc = (slug: string, price = '0.01') => ({
  slug,
  description: `service ${slug}`,
  price_usdc: price,
  input_schema: { type: 'object' as const, properties: { q: { type: 'string' as const } }, required: ['q'] },
  output_schema: { type: 'object' as const, properties: { a: { type: 'string' as const } } },
  persona: `persona ${slug}`,
  skill_body: `skill ${slug}`,
  tools: ['web_read' as const],
});

describe('specs', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql, { now: () => NOW });
  });
  afterAll(() => drop());

  it('versions drafts per agent, owner only', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    expect(await specs.saveDraft(a.userId, a.agentId, minimalSpec(), 'watch xlm')).toBe(1);
    expect(await specs.saveDraft(a.userId, a.agentId, minimalSpec())).toBe(2);
    await expect(specs.saveDraft(b.userId, a.agentId, minimalSpec())).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const [row] = (await sql`select build_prompt, status from app.agent_specs where agent_id = ${a.agentId} and version = 1`) as { build_prompt: string; status: string }[];
    expect(row).toEqual({ build_prompt: 'watch xlm', status: 'draft' });
  });

  it('refuses drafts for a revoked agent', async () => {
    const a = await activeAgent(sql);
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    await expect(specs.saveDraft(a.userId, a.agentId, minimalSpec())).rejects.toMatchObject({ status: 409, code: 'agent_revoked' });
  });

  it('approve materializes skills, triggers and services and sets the active version', async () => {
    const a = await activeAgent(sql);
    const spec = minimalSpec({
      skills: [{ name: 'style', description: 'Report style', body: '# Short' }],
      triggers: [
        { kind: 'cron', cron: '*/15 * * * *', mission: 'Report.' },
        { kind: 'condition', fetch: { tool: 'stellar_price', args: { symbol: 'XLM' } }, code: 'return true', every_s: 600, cooldown_s: 60, mission: 'Alert.' },
      ],
      services: [svc('summary')],
    });
    const v = await specs.saveDraft(a.userId, a.agentId, spec);
    expect(await specs.active(a.agentId)).toBeNull();
    await specs.approve(a.userId, a.agentId, v);

    expect(await specs.active(a.agentId)).toEqual({ version: v, spec });
    expect(await specs.skillIndex(a.agentId)).toEqual([{ name: 'style', description: 'Report style' }]);
    expect(await specs.skillBody(a.agentId, 'style')).toBe('# Short');
    expect(await specs.skillBody(a.agentId, 'nope')).toBeNull();

    const trig = (await sql`select kind, cron_expr, condition, mission, next_run_at, cooldown_s, enabled, spec_version from app.triggers
                            where agent_id = ${a.agentId} order by kind`) as Record<string, unknown>[];
    expect(trig).toEqual([
      { kind: 'condition', cron_expr: null, condition: { fetch: { tool: 'stellar_price', args: { symbol: 'XLM' } }, code: 'return true', every_s: 600 }, mission: 'Alert.', next_run_at: NOW, cooldown_s: 60, enabled: true, spec_version: v },
      { kind: 'cron', cron_expr: '*/15 * * * *', condition: null, mission: 'Report.', next_run_at: new Date('2026-10-05T10:15:00Z'), cooldown_s: 0, enabled: true, spec_version: v },
    ]);

    const s = await specs.service(a.agentId, 'summary');
    expect(s).toMatchObject({ slug: 'summary', status: 'live', priceUsdc: '0.0100000', tools: ['web_read'], persona: 'persona summary', skillBody: 'skill summary', specVersion: v });
    expect(s!.inputSchema).toEqual(svc('summary').input_schema);
    expect((await specs.liveServices(a.agentId)).map((x) => x.slug)).toEqual(['summary']);
  });

  it('approve stores a schedule\'s time zone and sets its next run in that zone', async () => {
    const a = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ triggers: [{ kind: 'cron', cron: '0 8 * * *', tz: 'Europe/Istanbul', mission: 'Digest.' }] }));
    await specs.approve(a.userId, a.agentId, v);
    const [t] = (await sql`select cron_expr, cron_tz, next_run_at from app.triggers where agent_id = ${a.agentId}`) as Record<string, unknown>[];
    // 10:07Z is 13:07 in Istanbul, so 08:00 there is tomorrow at 05:00Z.
    expect(t).toEqual({ cron_expr: '0 8 * * *', cron_tz: 'Europe/Istanbul', next_run_at: new Date('2026-10-06T05:00:00Z') });
  });

  it('a later approval replaces skills and triggers and turns dropped services off, keeping their rows', async () => {
    const a = await activeAgent(sql);
    const v1 = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ skills: [{ name: 'old', description: 'd', body: 'b' }], triggers: [{ kind: 'cron', cron: '0 * * * *', mission: 'm' }], services: [svc('one'), svc('two')] }));
    await specs.approve(a.userId, a.agentId, v1);
    const oneId = (await specs.service(a.agentId, 'one'))!.id;
    const v2 = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ skills: [{ name: 'new', description: 'd', body: 'b' }], services: [svc('two', '0.02')] }));
    await specs.approve(a.userId, a.agentId, v2);

    expect(await specs.skillIndex(a.agentId)).toEqual([{ name: 'new', description: 'd' }]);
    expect((await sql`select count(*)::int as n from app.triggers where agent_id = ${a.agentId}`)[0].n).toBe(0);
    expect(await specs.service(a.agentId, 'one')).toMatchObject({ id: oneId, status: 'off' });
    expect(await specs.service(a.agentId, 'two')).toMatchObject({ status: 'live', priceUsdc: '0.0200000', specVersion: v2 });
    expect((await specs.active(a.agentId))!.version).toBe(v2);
    const statuses = (await sql`select version, status from app.agent_specs where agent_id = ${a.agentId} order by version`) as { version: number; status: string }[];
    expect(statuses).toEqual([{ version: 1, status: 'approved' }, { version: 2, status: 'approved' }]);
  });

  it('approve refuses an unknown version and another user', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const v = await specs.saveDraft(a.userId, a.agentId, minimalSpec());
    await expect(specs.approve(a.userId, a.agentId, 99)).rejects.toMatchObject({ status: 404, code: 'no_such_version' });
    await expect(specs.approve(b.userId, a.agentId, v)).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(await specs.active(a.agentId)).toBeNull();
  });

  it('approve refuses a version at or below the active one (409 version_changed) and changes nothing', async () => {
    const a = await activeAgent(sql);
    const v1 = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ services: [svc('one')] }));
    const v2 = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ services: [svc('two')] }));
    await specs.approve(a.userId, a.agentId, v2);
    await expect(specs.approve(a.userId, a.agentId, v1)).rejects.toMatchObject({ status: 409, code: 'version_changed' }); // older
    await expect(specs.approve(a.userId, a.agentId, v2)).rejects.toMatchObject({ status: 409, code: 'version_changed' }); // the active one again
    expect((await specs.active(a.agentId))!.version).toBe(v2);
    expect((await specs.liveServices(a.agentId)).map((s) => s.slug)).toEqual(['two']);
  });

  it('saveDraft with a base version refuses 409 version_changed once the active version moved, and saves otherwise', async () => {
    const a = await activeAgent(sql);
    const v1 = await specs.saveDraft(a.userId, a.agentId, minimalSpec());
    await specs.approve(a.userId, a.agentId, v1);
    const v2 = await specs.saveDraft(a.userId, a.agentId, minimalSpec({ persona: 'Based on one.' }), undefined, undefined, v1);
    expect(v2).toBe(2);
    await specs.approve(a.userId, a.agentId, v2); // the active version is now 2
    await expect(specs.saveDraft(a.userId, a.agentId, minimalSpec({ persona: 'Still based on one.' }), undefined, undefined, v1)).rejects.toMatchObject({ status: 409, code: 'version_changed' });
    expect((await sql`select count(*)::int as n from app.agent_specs where agent_id = ${a.agentId}`)[0]!.n).toBe(2);
    expect(await specs.saveDraft(a.userId, a.agentId, minimalSpec({ persona: 'Based on two.' }), undefined, undefined, v2)).toBe(3);
  });

  it('view shows the active version and only a newer draft', async () => {
    const a = await activeAgent(sql);
    const b = await activeAgent(sql);
    const v1 = await specs.saveDraft(a.userId, a.agentId, minimalSpec());
    await specs.approve(a.userId, a.agentId, v1);
    expect(await specs.view(a.userId, a.agentId)).toMatchObject({ active: { version: 1, status: 'approved' }, draft: null });
    await specs.saveDraft(a.userId, a.agentId, minimalSpec({ persona: 'Second.' }));
    const view = await specs.view(a.userId, a.agentId);
    expect(view.draft).toMatchObject({ version: 2, status: 'draft', spec: { persona: 'Second.' } });
    await expect(specs.view(b.userId, a.agentId)).rejects.toMatchObject({ status: 404 });
  });

  it('a revoked agent has no active spec and no live services', async () => {
    const a = await activeAgent(sql);
    await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, minimalSpec({ services: [svc('x')] })));
    await sql`update app.agents set status = 'revoked' where id = ${a.agentId}`;
    expect(await specs.active(a.agentId)).toBeNull();
    expect(await specs.liveServices(a.agentId)).toEqual([]);
  });
  describe('re-approval keeps alert cooldowns', () => {
    const cond = (threshold = 0.3, cooldown_s = 3600) => ({
      kind: 'condition' as const,
      fetch: { tool: 'stellar_price' as const, args: { symbol: 'XLM' } },
      code: `return input > ${threshold}`,
      every_s: 600,
      cooldown_s,
      mission: 'Alert.',
    });
    type Row = { last_fired_at: Date | null; enabled: boolean; error_streak: number; cooldown_s: number };
    const rows = async (agentId: string) =>
      (await sql`select last_fired_at, enabled, error_streak, cooldown_s from app.triggers where agent_id = ${agentId}`) as Row[];
    async function approveSpec(a: { userId: string; agentId: string }, spec: ReturnType<typeof minimalSpec>) {
      await specs.approve(a.userId, a.agentId, await specs.saveDraft(a.userId, a.agentId, spec));
    }

    it('triggerKey ignores property order and cooldown_s', () => {
      const a = triggerKey({ kind: 'condition', cron_expr: null, mission: 'm', condition: { fetch: { tool: 't', args: { b: 1, a: 2 } }, code: 'c', every_s: 60 } });
      const b = triggerKey({ kind: 'condition', cron_expr: null, mission: 'm', condition: { every_s: 60, code: 'c', fetch: { args: { a: 2, b: 1 }, tool: 't' }, cooldown_s: 9 } });
      expect(a).toBe(b);
    });

    it('triggerKey: params are part of the identity, and a condition without params keeps its old key', () => {
      const c = { fetch: { tool: 't', args: {} }, code: 'c', every_s: 60 };
      const key = (condition: unknown) => triggerKey({ kind: 'condition', cron_expr: null, mission: 'm', condition });
      expect(key({ ...c, params: undefined })).toBe(key(c));
      expect(key({ ...c, params: { x: 1 } })).not.toBe(key(c));
      expect(key({ ...c, params: { x: 1 } })).not.toBe(key({ ...c, params: { x: 2 } }));
      expect(key({ ...c, params: { y: 2, x: 1 } })).toBe(key({ ...c, params: { x: 1, y: 2 } }));
    });

    it('approving a second version with an identical condition trigger keeps last_fired_at', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
      await approveSpec(a, minimalSpec({ triggers: [cond()], services: [svc('new')] }));
      const r = await rows(a.agentId);
      expect(r).toHaveLength(1);
      expect(r[0]!.last_fired_at).toEqual(new Date('2026-10-05T09:00:00Z'));
    });

    it('a changed threshold is a new trigger: last_fired_at is null', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond(0.3)] }));
      await sql`update app.triggers set last_fired_at = now() where agent_id = ${a.agentId}`;
      await approveSpec(a, minimalSpec({ triggers: [cond(0.4)] }));
      expect((await rows(a.agentId))[0]!.last_fired_at).toBeNull();
    });

    it('a cooldown-only change keeps last_fired_at', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond(0.3, 3600)] }));
      await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
      await approveSpec(a, minimalSpec({ triggers: [cond(0.3, 60)] }));
      const r = await rows(a.agentId);
      expect(r[0]!.cooldown_s).toBe(60);
      expect(r[0]!.last_fired_at).toEqual(new Date('2026-10-05T09:00:00Z'));
    });

    it('error_streak resets and enabled is true again', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      await sql`update app.triggers set enabled = false, error_streak = 3, last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId}`;
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      expect((await rows(a.agentId))[0]).toMatchObject({ enabled: true, error_streak: 0, last_fired_at: new Date('2026-10-05T09:00:00Z') });
    });

    it('two old triggers with the same key carry the latest last_fired_at', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      // Force a duplicate old key (the spec schema would not normally produce one).
      await sql`insert into app.triggers (agent_id, spec_version, kind, condition, mission, next_run_at, cooldown_s, last_fired_at)
                select agent_id, spec_version, kind, condition, mission, next_run_at, cooldown_s, '2026-10-05T09:30:00Z' from app.triggers where agent_id = ${a.agentId}`;
      await sql`update app.triggers set last_fired_at = '2026-10-05T09:00:00Z' where agent_id = ${a.agentId} and last_fired_at is distinct from '2026-10-05T09:30:00Z'`;
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      expect((await rows(a.agentId))[0]!.last_fired_at).toEqual(new Date('2026-10-05T09:30:00Z'));
    });

    it('publishing a service does not make the scheduler re-fire inside the cooldown', async () => {
      const a = await activeAgent(sql);
      await approveSpec(a, minimalSpec({ triggers: [cond()] }));
      await sql`update app.triggers set last_fired_at = now() where agent_id = ${a.agentId}`;
      await approveSpec(a, minimalSpec({ triggers: [cond()], services: [svc('pub')] }));
      await sql`update app.triggers set next_run_at = now() + interval '1 day' where agent_id <> ${a.agentId}`;
      const missions: string[] = [];
      const sched = createScheduler({
        sql,
        killed: () => false,
        mission: async (_a, _t, text) => (missions.push(text), { status: 'done' }),
        conditionFetch: async () => 1,
        sandbox: async () => ({ ok: true, value: true }),
        notify: async () => undefined,
      });
      await sql`update app.triggers set next_run_at = now() - interval '1 second' where agent_id = ${a.agentId}`;
      expect(await sched.tick()).toMatchObject({ claimed: 1, cooldowns: 1, missions: 0 });
      expect(missions).toEqual([]);
    });
  });
});

describe('specs: the plain-words view', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let specs: Specs;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    specs = createSpecs(sql, { now: () => NOW });
  });
  afterAll(() => drop());
  const view = () => {
    const { name: _n, spec: _s, ...v } = xlmDrop();
    return v;
  };

  it('saveDraft stores the view and the spec view returns it', async () => {
    const a = await activeAgent(sql);
    const v1 = await specs.saveDraft(a.userId, a.agentId, xlmDrop().spec, 'watch xlm', view());
    await specs.approve(a.userId, a.agentId, v1);
    const v2 = await specs.saveDraft(a.userId, a.agentId, minimalSpec());
    const shown = await specs.view(a.userId, a.agentId);
    expect(shown.active).toMatchObject({ version: v1, view: view() });
    expect(shown.draft).toMatchObject({ version: v2, view: null });
  });

  it('agent creation stores version 1 with its view', async () => {
    const userId = await insertUser(sql, { ownerAddress: contractAddress(250) });
    const { id } = await createAgents(sql).create(userId, 'XLM drop alert', xlmDrop().spec, view());
    expect((await specs.view(userId, id)).active).toMatchObject({ version: 1, view: view() });
  });
});
