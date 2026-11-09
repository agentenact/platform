/**
 * `specs`: the agent's versioned AgentSpec and what an approval materializes (plan D8): skills and
 * triggers are replaced, services are upserted by slug (never deleted; dropped ones go 'off'), and
 * agents.active_spec_version moves. Owner calls take the caller's user id and touch only that user's agent.
 * The Builder that writes specs is P4; in P3 the owner API and tests save them.
 */
import type { Db } from '../db/index.js';
import type { DraftView } from '../builder/draft-schema.js';
import { httpError } from '../errors.js';
import type { Schema } from './json-schema.js';
import { cronNext, type AgentSpec, type ServiceToolName } from './schema.js';

export interface ServiceRow {
  id: string;
  agentId: string;
  slug: string;
  description: string;
  priceUsdc: string;
  inputSchema: Schema;
  outputSchema: Schema;
  persona: string;
  skillBody: string;
  tools: ServiceToolName[];
  /** Names of the agent's approved skills this service runs with (empty: none). */
  skills: string[];
  specVersion: number;
  status: 'off' | 'live';
  updatedAt: Date;
}

export interface SpecVersion {
  version: number;
  status: 'draft' | 'approved';
  spec: AgentSpec;
  /** The plain-words view the Builder wrote with this version; null for versions saved without one. */
  view: DraftView | null;
  createdAt: Date;
}

export interface Specs {
  /** `baseVersion`: the active version the draft was built on. If the active version moved meanwhile, 409 version_changed and nothing is saved. */
  saveDraft(userId: string, agentId: string, spec: AgentSpec, buildPrompt?: string, view?: DraftView, baseVersion?: number): Promise<number>;
  /** `createdAt`: the draft the owner saw. 409 version_changed if the stored row was created at another time (it was replaced). */
  approve(userId: string, agentId: string, version: number, createdAt?: Date): Promise<void>;
  /** Deletes one unapproved draft version of the caller's agent. 404: no such version; 409 not_discardable: approved or active. */
  discard(userId: string, agentId: string, version: number): Promise<void>;
  active(agentId: string): Promise<{ version: number; spec: AgentSpec } | null>;
  view(userId: string, agentId: string): Promise<{ active: SpecVersion | null; draft: SpecVersion | null }>;
  skillIndex(agentId: string): Promise<{ name: string; description: string }[]>;
  skillBody(agentId: string, name: string): Promise<string | null>;
  service(agentId: string, slug: string): Promise<ServiceRow | null>;
  liveServices(agentId: string): Promise<ServiceRow[]>;
}

interface ServiceDbRow {
  id: string;
  agent_id: string;
  slug: string;
  description: string;
  price_usdc: string;
  input_schema: Schema;
  output_schema: Schema;
  persona: string;
  skill_body: string;
  tools: ServiceToolName[];
  skills: string[];
  spec_version: number;
  status: 'off' | 'live';
  updated_at: Date;
}

const toService = (r: ServiceDbRow): ServiceRow => ({
  id: r.id,
  agentId: r.agent_id,
  slug: r.slug,
  description: r.description,
  priceUsdc: r.price_usdc,
  inputSchema: r.input_schema,
  outputSchema: r.output_schema,
  persona: r.persona,
  skillBody: r.skill_body,
  tools: r.tools,
  skills: r.skills ?? [],
  specVersion: r.spec_version,
  status: r.status,
  updatedAt: r.updated_at,
});

/** JSON with object keys sorted at every depth, so property order never changes the text. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * Identity of a trigger across re-approvals (spec 6c): kind + cron, or the condition's {fetch, code, every_s, params},
 * + mission. `cooldown_s` is not part of it, so changing only the cooldown keeps the firing history.
 */
export function triggerKey(t: { kind: 'cron' | 'condition'; cron_expr: string | null; cron_tz?: string | null; condition: unknown; mission: string }): string {
  // `tz` is undefined for schedules stored before time zones (and for UTC ones), so their key is unchanged.
  if (t.kind === 'cron') return stable({ kind: 'cron', cron: t.cron_expr, tz: t.cron_tz ?? undefined, mission: t.mission });
  const c = (t.condition ?? {}) as { fetch?: unknown; code?: unknown; every_s?: unknown; params?: unknown };
  // `params` is undefined for conditions stored before it existed, so their key is unchanged (stable() skips undefined).
  return stable({ kind: 'condition', condition: { fetch: c.fetch, code: c.code, every_s: c.every_s, params: c.params }, mission: t.mission });
}

/**
 * Approves version `v` inside the caller's transaction: marks it approved, moves agents.active_spec_version and
 * materializes skills, triggers (carrying cooldowns) and services. Shared by `approve` and agent creation, so the
 * two can never drift. The caller has already checked ownership and holds the agent row.
 */
export async function approveIn(tx: Db, agentId: string, v: number, at: Date): Promise<void> {
  const rows = (await tx`select spec from app.agent_specs where agent_id = ${agentId} and version = ${v}`) as { spec: AgentSpec }[];
  if (!rows[0]) throw httpError(404, 'no_such_version');
  const spec = rows[0].spec;
  await tx`update app.agent_specs set status = 'approved', approved_at = now() where agent_id = ${agentId} and version = ${v}`;
  await tx`update app.agents set active_spec_version = ${v}, updated_at = now() where id = ${agentId}`;

  await tx`delete from app.skills where agent_id = ${agentId}`;
  for (const s of spec.skills) {
    await tx`insert into app.skills (agent_id, name, description, body, version) values (${agentId}, ${s.name}, ${s.description}, ${s.body}, ${v})`;
  }

  // Re-approval keeps alert cooldowns (spec 6c): remember when each old trigger last fired, by identity.
  const old = (await tx`select kind, cron_expr, cron_tz, condition, mission, last_fired_at from app.triggers where agent_id = ${agentId}`) as {
    kind: 'cron' | 'condition';
    cron_expr: string | null;
    cron_tz: string | null;
    condition: unknown;
    mission: string;
    last_fired_at: Date | null;
  }[];
  const fired = new Map<string, Date>();
  for (const r of old) {
    if (!r.last_fired_at) continue;
    const k = triggerKey(r);
    const prev = fired.get(k);
    if (!prev || r.last_fired_at > prev) fired.set(k, r.last_fired_at);
  }
  await tx`delete from app.triggers where agent_id = ${agentId}`;
  for (const t of spec.triggers) {
    if (t.kind === 'cron') {
      const tz = t.tz ?? null;
      const last = fired.get(triggerKey({ kind: 'cron', cron_expr: t.cron, cron_tz: tz, condition: null, mission: t.mission })) ?? null;
      await tx`insert into app.triggers (agent_id, spec_version, kind, cron_expr, cron_tz, mission, next_run_at, cooldown_s, last_fired_at)
               values (${agentId}, ${v}, 'cron', ${t.cron}, ${tz}, ${t.mission}, ${cronNext(t.cron, at, tz)}, 0, ${last})`;
    } else {
      const condition = { fetch: t.fetch, code: t.code, every_s: t.every_s, ...(t.params ? { params: t.params } : {}) };
      const last = fired.get(triggerKey({ kind: 'condition', cron_expr: null, condition, mission: t.mission })) ?? null;
      await tx`insert into app.triggers (agent_id, spec_version, kind, condition, mission, next_run_at, cooldown_s, last_fired_at)
               values (${agentId}, ${v}, 'condition', ${condition}, ${t.mission}, ${at}, ${t.cooldown_s}, ${last})`;
    }
  }

  await tx`update app.services set status = 'off', updated_at = now() where agent_id = ${agentId} and status = 'live'`;
  for (const s of spec.services) {
    await tx`insert into app.services (agent_id, slug, description, input_schema, output_schema, price_usdc, persona, skill_body, tools, skills, spec_version, status)
             values (${agentId}, ${s.slug}, ${s.description}, ${s.input_schema}, ${s.output_schema}, ${s.price_usdc}, ${s.persona}, ${s.skill_body}, ${s.tools}, ${`{${(s.skills ?? []).join(',')}}`}::text[], ${v}, 'live')
             on conflict (agent_id, slug) do update set
               description = excluded.description, input_schema = excluded.input_schema, output_schema = excluded.output_schema,
               price_usdc = excluded.price_usdc, persona = excluded.persona, skill_body = excluded.skill_body, tools = excluded.tools, skills = excluded.skills,
               spec_version = excluded.spec_version, status = 'live', updated_at = now()`;
  }
}

/** Inserts the next version of `agentId` as a draft; `q` is the pool or an open transaction. A concurrent insert of the same number throws 23505. */
export async function insertVersion(q: Db, agentId: string, spec: AgentSpec, buildPrompt?: string, view?: DraftView): Promise<number> {
  const rows = (await q`insert into app.agent_specs (agent_id, version, spec, build_prompt, view)
                        select ${agentId}, coalesce(max(version), 0) + 1, ${spec}, ${buildPrompt ?? null}, ${view ?? null}
                        from app.agent_specs where agent_id = ${agentId}
                        returning version`) as { version: number }[];
  return rows[0]!.version;
}

export function createSpecs(sql: Db, o: { now?: () => Date } = {}): Specs {
  const now = o.now ?? (() => new Date());

  /** The caller's agent, or 404; a revoked agent is 409. `q` is the pool or an open transaction. */
  async function owned(q: Db, userId: string, agentId: string, lock = false): Promise<void> {
    const rows = (lock
      ? await q`select status from app.agents where id = ${agentId} and user_id = ${userId} for update`
      : await q`select status from app.agents where id = ${agentId} and user_id = ${userId}`) as { status: string }[];
    if (!rows[0]) throw httpError(404, 'not_found');
    if (rows[0].status === 'revoked') throw httpError(409, 'agent_revoked');
  }

  async function version(agentId: string, where: 'active' | 'draft'): Promise<SpecVersion | null> {
    const rows = (where === 'active'
      ? await sql`select s.version, s.status, s.spec, s.view, s.created_at from app.agent_specs s join app.agents a on a.id = s.agent_id
                  where s.agent_id = ${agentId} and s.version = a.active_spec_version`
      : await sql`select s.version, s.status, s.spec, s.view, s.created_at from app.agent_specs s join app.agents a on a.id = s.agent_id
                  where s.agent_id = ${agentId} and s.status = 'draft' and s.version > coalesce(a.active_spec_version, 0)
                  order by s.version desc limit 1`) as { version: number; status: 'draft' | 'approved'; spec: AgentSpec; view: DraftView | null; created_at: Date }[];
    const r = rows[0];
    return r ? { version: r.version, status: r.status, spec: r.spec, view: r.view ?? null, createdAt: r.created_at } : null;
  }

  return {
    async saveDraft(userId, agentId, spec, buildPrompt, view, baseVersion) {
      if (baseVersion !== undefined) {
        // The agent row is locked, so a publish (approve) cannot slip between the check and the insert.
        return sql.begin(async (t) => {
          const tx = t as unknown as Db;
          await owned(tx, userId, agentId, true);
          const rows = (await tx`select active_spec_version from app.agents where id = ${agentId}`) as { active_spec_version: number | null }[];
          if ((rows[0]?.active_spec_version ?? null) !== baseVersion) throw httpError(409, 'version_changed');
          return insertVersion(tx, agentId, spec, buildPrompt, view);
        });
      }
      await owned(sql, userId, agentId);
      for (let attempt = 0; ; attempt++) {
        try {
          return await insertVersion(sql, agentId, spec, buildPrompt, view);
        } catch (e) {
          // Two concurrent saves computed the same version: the primary key refused one. Take the next.
          if ((e as { errno?: string } | null)?.errno === '23505' && attempt < 3) continue;
          throw e;
        }
      }
    },

    async approve(userId, agentId, v, createdAt) {
      const at = now();
      await sql.begin(async (tx) => {
        await owned(tx as unknown as Db, userId, agentId, true);
        // Never move the live description backwards or sideways: a draft built on an older base (or the active one again) is stale.
        const cur = (await (tx as unknown as Db)`select active_spec_version from app.agents where id = ${agentId}`) as { active_spec_version: number | null }[];
        if (cur[0]?.active_spec_version != null && v <= cur[0].active_spec_version) throw httpError(409, 'version_changed');
        if (createdAt) {
          // The agent row is locked. The same number can hold another draft if the owner discarded and saved again meanwhile.
          const rows = (await (tx as unknown as Db)`select created_at from app.agent_specs where agent_id = ${agentId} and version = ${v}`) as { created_at: Date }[];
          if (rows[0] && new Date(rows[0].created_at).getTime() !== createdAt.getTime()) throw httpError(409, 'version_changed');
        }
        await approveIn(tx as unknown as Db, agentId, v, at);
      });
    },

    async discard(userId, agentId, v) {
      await sql.begin(async (t) => {
        const tx = t as unknown as Db;
        await owned(tx, userId, agentId, true); // the agent row is locked: an approve of this version waits, then finds it gone
        const rows = (await tx`select s.status, s.version > coalesce(a.active_spec_version, 0) as newer
                               from app.agent_specs s join app.agents a on a.id = s.agent_id
                               where s.agent_id = ${agentId} and s.version = ${v}`) as { status: string; newer: boolean }[];
        if (!rows[0]) throw httpError(404, 'no_such_version');
        if (rows[0].status !== 'draft' || !rows[0].newer) throw httpError(409, 'not_discardable');
        await tx`delete from app.agent_specs where agent_id = ${agentId} and version = ${v}`;
      });
    },

    async active(agentId) {
      const rows = (await sql`select s.version, s.spec from app.agents a join app.agent_specs s on s.agent_id = a.id and s.version = a.active_spec_version
                              where a.id = ${agentId} and a.status <> 'revoked'`) as { version: number; spec: AgentSpec }[];
      return rows[0] ? { version: rows[0].version, spec: rows[0].spec } : null;
    },

    async view(userId, agentId) {
      await owned(sql, userId, agentId);
      return { active: await version(agentId, 'active'), draft: await version(agentId, 'draft') };
    },

    async skillIndex(agentId) {
      return (await sql`select name, description from app.skills where agent_id = ${agentId} order by name`) as { name: string; description: string }[];
    },

    async skillBody(agentId, name) {
      const rows = (await sql`select body from app.skills where agent_id = ${agentId} and name = ${name}`) as { body: string }[];
      return rows[0]?.body ?? null;
    },

    async service(agentId, slug) {
      const rows = (await sql`select id, agent_id, slug, description, price_usdc::text as price_usdc, input_schema, output_schema, persona, skill_body, tools, skills, spec_version, status, updated_at
                              from app.services where agent_id = ${agentId} and slug = ${slug}`) as ServiceDbRow[];
      return rows[0] ? toService(rows[0]) : null;
    },

    async liveServices(agentId) {
      const rows = (await sql`select s.id, s.agent_id, slug, description, price_usdc::text as price_usdc, input_schema, output_schema, persona, skill_body, tools, skills, spec_version, s.status, s.updated_at
                              from app.services s
                              where s.agent_id = ${agentId} and s.status = 'live'
                                and exists (select 1 from app.agents a where a.id = s.agent_id and a.status <> 'revoked')
                              order by s.slug`) as ServiceDbRow[];
      return rows.map(toService);
    },
  };
}
