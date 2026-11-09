/**
 * `agents`: pause, resume and delete (spec §6c). Pausing stops the agent's checks and its paid services; resuming
 * restores both with no new approval and keeps cooldowns and last-fired times.
 *
 * Every other unit already reads `agents.status = 'active'` (scheduler claim, mission, chat, paid endpoint,
 * agent.json), so the status flip alone is the stop. Both calls are one guarded UPDATE: a second call, or a
 * call racing a revoke, matches no row and is told why (never a silent success).
 *
 * Resume does not replay what a pause skipped: an overdue cron trigger jumps to its next future slot, an
 * overdue condition trigger is due now (it only looks at current data). `last_fired_at`, `error_streak` and
 * `enabled` are untouched. In the same transaction as the status flip, so the scheduler never sees an
 * active agent with stale overdue triggers.
 */
import type { Db } from '../db/index.js';
import type { DraftView } from '../builder/draft-schema.js';
import type { FeeModel } from '../config.js';
import { httpError } from '../errors.js';
import { setIntoNewSpec } from '../skills/sets.js';
import { DAILY_RUNS, DAILY_TOKENS } from '../policy/index.js';
import { CLAIM_LEASE_MIN } from '../scheduler/index.js';
import { createModelDirectory, MODEL_CHOICES, type ModelDirectory } from '../loop/model-choices.js';
import { approveIn } from '../specs/index.js';
import { cronNext, type AgentSpec } from '../specs/schema.js';

/**
 * Moves the agent's overdue triggers off the past: a cron to its next future slot, a condition to now. The
 * scheduler is DB-clock driven, so slots come from the DB clock (stable inside the transaction), never the
 * process clock. Run inside the transaction that makes the agent claimable (resume, activation).
 */
export async function skipMissedSlots(tx: Db, agentId: string): Promise<void> {
  const [clock] = (await tx`select now() as t`) as { t: Date }[];
  const overdue = (await tx`select id, kind, cron_expr, cron_tz from app.triggers
                            where agent_id = ${agentId} and enabled and next_run_at <= now() for update`) as { id: string; kind: 'cron' | 'condition'; cron_expr: string | null; cron_tz: string | null }[];
  for (const r of overdue) {
    if (r.kind === 'cron') await tx`update app.triggers set next_run_at = ${cronNext(r.cron_expr!, clock!.t, r.cron_tz)} where id = ${r.id}`;
    else await tx`update app.triggers set next_run_at = now() where id = ${r.id}`;
  }
}

/**
 * How many agents one account may hold and start (Kerem, 2026-10-28; replaces plan D14's one per user). `live`
 * counts every agent that is not revoked (paused and unfinished ones hold a slot); `perDay` counts every agent the
 * account made in the last 24 hours, revoked included, because each one is a sponsored account on chain.
 * An account with app.users.agent_limit set (migration 0034) uses that as `live` and at least that as `perDay`.
 */
export interface AgentLimits {
  live: number;
  perDay: number;
}
export const AGENT_LIMITS: AgentLimits = { live: 3, perDay: 3 };

export interface Agents {
  /**
   * Creates one of the user's agents from an approved description (spec §6c): in ONE transaction the agent row (still
   * `provisioning`), the description as version 1 and its approval (skills, triggers, services). The caller starts
   * provisioning only after this returns.
   *
   * `key` makes it idempotent: the same key again answers the agent it made (`resumed`), so a browser whose answer
   * got lost asks again instead of making a second agent. Over `limits.live` is 409 agent_limit, over `limits.perDay`
   * 429 creation_limit; both leave nothing behind. Without a key (an older panel) a user who already has a live agent
   * gets 409 agent_exists, as before: that panel resumes the agent /api/me names instead of creating another.
   * Under FEE_MODEL=agent every agent is 'due': it buys its own reserves at its first funding (reserve.ts) and stays
   * paused until then. Under FEE_MODEL=sponsor the account's first live agent is the platform's to sponsor (reserve_state
   * free) and another is 'due'. Either way, while one is still due a new one is 409 reserve_due.
   *
   * `skillSet`: one of the owner's skill sets (skills/sets.ts) at the revision their screen showed, put into v1 in the
   * same transaction, each skill recorded as approved. A foreign set is 404 set_not_found, a changed one 409 set_changed.
   */
  create(userId: string, name: string, spec: AgentSpec, view?: DraftView, key?: string, skillSet?: { id: string; revision: number }): Promise<{ id: string; resumed: boolean }>;
  /** active -> paused. Unknown or foreign agent 404 not_found; any other status 409 not_active. */
  pause(userId: string, agentId: string): Promise<void>;
  /**
   * paused -> active. Unknown or foreign agent 404 not_found; any other status 409 not_paused. An agent born paused for
   * want of funds (FEE_MODEL=agent) is 409 awaiting_funds: the reserve worker resumes it once it has bought its reserves.
   */
  resume(userId: string, agentId: string): Promise<void>;
  /**
   * Deletes the agent (Kerem, 2026-10-30): status revoked, deleted_at now, close_state pending for the closer
   * (close.ts), which empties its wallet to the owner and closes it. In the same transaction its triggers stop and its
   * unsent seals are dropped (the vault seals nothing for a deleted agent). A second call answers the same.
   * Unknown or foreign agent 404 not_found; an agent being created on chain right now 409 busy (try again shortly).
   */
  remove(userId: string, agentId: string): Promise<void>;
  /** The owner's answer to "Want a short note each morning?". Stored only; nothing sends a note yet. Unknown or foreign agent 404 not_found. */
  setMorningNote(userId: string, agentId: string, on: boolean): Promise<void>;
  /**
   * The model the agent's runs use: a slug from loop/model-choices.ts, or null for the platform default. The next run picks
   * it up; a run already going keeps its model. Unknown or foreign agent 404 not_found; a slug that cannot be picked
   * (ModelDirectory.resolve) 400 bad_model.
   */
  setModel(userId: string, agentId: string, model: string | null): Promise<void>;
  /**
   * Run now (Kerem, 2026-11-04): the agent's next check is pulled forward to now and the scheduler fires it on its next
   * tick (30 s), through the same path as a scheduled fire: kill switch, paused state, the daily budget, check logs,
   * seals and delivery all apply unchanged. Only the soonest trigger moves; the schedule after it stays as it was, so a
   * cron agent still runs at its next slot too. Nothing runs inside this call.
   *
   * Unknown or foreign agent 404 not_found; paused 409 agent_paused; any other non-active status 409 agent_not_active;
   * no enabled trigger 409 no_checks; the account's daily budget spent 429 daily_limit. A check already due or in flight
   * answers `running` (a second press never makes a second fire); a condition trigger still inside its cooldown after an
   * alert answers `cooling_down` with the time it ends, because the scheduler would skip it.
   */
  runNow(userId: string, agentId: string): Promise<RunNowResult>;
}

export type RunNowResult = { state: 'queued'; at: string } | { state: 'running' } | { state: 'cooling_down'; until: string };

export function createAgents(sql: Db, o: { now?: () => Date; limits?: AgentLimits; feeModel?: FeeModel; models?: Pick<ModelDirectory, 'resolve'> & { defaultId: string } } = {}): Agents {
  const models = o.models ?? { ...createModelDirectory({ defaultId: MODEL_CHOICES[0]!.id }), defaultId: MODEL_CHOICES[0]!.id };
  const now = o.now ?? (() => new Date());
  const limits = o.limits ?? AGENT_LIMITS;
  const selfPaying = (o.feeModel ?? 'agent') === 'agent';
  async function refuse(userId: string, agentId: string, code: string): Promise<never> {
    const rows = (await sql`select 1 from app.agents where id = ${agentId} and user_id = ${userId}`) as unknown[];
    throw httpError(rows.length > 0 ? 409 : 404, rows.length > 0 ? code : 'not_found');
  }

  return {
    async create(userId, name, spec, view, key, skillSet) {
      const at = now();
      return sql.begin(async (tx) => {
        // The user row is the lock: two creates for one account count and insert one after the other.
        const [user] = (await tx`select agent_limit from app.users where id = ${userId} for update`) as { agent_limit: number | null }[];
        // An account's own ceiling (app.users.agent_limit, operator-set) replaces `live` and lifts `perDay` to match.
        const live = user?.agent_limit ?? limits.live;
        const perDay = Math.max(limits.perDay, user?.agent_limit ?? 0);
        if (key) {
          const same = (await tx`select id from app.agents where user_id = ${userId} and creation_key = ${key}`) as { id: string }[];
          if (same[0]) return { id: same[0].id, resumed: true };
        }
        const [n] = (await tx`select count(*) filter (where status <> 'revoked')::int as live,
                                     count(*) filter (where created_at > now() - interval '1 day')::int as today,
                                     count(*) filter (where status <> 'revoked' and reserve_state = 'free')::int as free,
                                     count(*) filter (where status <> 'revoked' and reserve_state = 'due'
                                                        and not (status = 'provisioning' and provision_state->>'step' = 'failed'))::int as due
                              from app.agents where user_id = ${userId}`) as { live: number; today: number; free: number; due: number }[];
        if (!key && n!.live > 0) throw httpError(409, 'agent_exists');
        if (n!.live >= live) throw httpError(409, 'agent_limit');
        if (n!.today >= perDay) throw httpError(429, 'creation_limit');
        // An agent that waits for its first funding is born on the sponsor's reserves: only one such agent at a time, so
        // the sponsor never carries more than one unfunded agent of an account (two under FEE_MODEL=sponsor, with the free one).
        if ((selfPaying || n!.free > 0) && n!.due > 0) throw httpError(409, 'reserve_due');
        const reserve = selfPaying || n!.free > 0 ? 'due' : 'free';
        const withSet = skillSet ? await setIntoNewSpec(tx as unknown as Db, userId, spec, skillSet) : null;
        const rows = (await tx`insert into app.agents (user_id, name, creation_key, reserve_state) values (${userId}, ${name}, ${key ?? null}, ${reserve}) returning id`) as { id: string }[];
        const agentId = rows[0]!.id;
        await tx`insert into app.agent_specs (agent_id, version, spec, view) values (${agentId}, 1, ${withSet?.spec ?? spec}, ${view ?? null})`;
        await approveIn(tx as unknown as Db, agentId, 1, at);
        await withSet?.record(agentId, at);
        return { id: agentId, resumed: false };
      });
    },

    async pause(userId, agentId) {
      const done = (await sql`update app.agents set status = 'paused' where id = ${agentId} and user_id = ${userId} and status = 'active' returning id`) as unknown[];
      if (done.length === 0) await refuse(userId, agentId, 'not_active');
    },

    async remove(userId, agentId) {
      await sql.begin(async (tx) => {
        // The same lock as create: which agent the platform sponsors is settled one change at a time per account.
        await tx`select 1 from app.users u where u.id = (select user_id from app.agents where id = ${agentId} and user_id = ${userId}) for update`;
        const rows = (await tx`select status, provision_state->>'step' as step from app.agents
                               where id = ${agentId} and user_id = ${userId} for update`) as { status: string; step: string | null }[];
        const a = rows[0];
        if (!a) throw httpError(404, 'not_found');
        if (a.status === 'revoked') return;
        // Mid-birth: txs may be in flight under its key. The birth ends in seconds (active or failed); then it can go.
        if (a.status === 'provisioning' && a.step === 'creating') throw httpError(409, 'busy');
        await tx`update app.agents set status = 'revoked', deleted_at = now(), close_state = 'pending', close_next_at = now(),
                        close_attempts = 0, close_error = null
                 where id = ${agentId}`;
        // The platform's free agent went: the account's oldest agent still waiting to buy its reserves takes its place.
        // Under FEE_MODEL=agent the platform sponsors no agent, so nothing takes a place.
        if (!selfPaying) await tx`update app.agents set reserve_state = 'free', reserve_next_at = null, reserve_error = null
                 where id = (select id from app.agents where user_id = ${userId} and status <> 'revoked' and reserve_state = 'due'
                             and not exists (select 1 from app.agents f where f.user_id = ${userId} and f.status <> 'revoked' and f.reserve_state = 'free')
                             order by created_at, id limit 1)`;
        await tx`update app.triggers set enabled = false where agent_id = ${agentId} and enabled`;
        await tx`update app.check_seals set status = 'failed', error = 'agent_deleted' where agent_id = ${agentId} and status = 'pending'`;
      });
    },

    async runNow(userId, agentId) {
      return sql.begin(async (tx) => {
        const [a] = (await tx`select a.status, a.active_spec_version, u.daily_tokens, u.daily_runs,
                                     u.daily_reset_at >= date_trunc('day', now(), 'UTC') as fresh
                              from app.agents a join app.users u on u.id = a.user_id
                              where a.id = ${agentId} and a.user_id = ${userId} for update of a`) as {
          status: string; active_spec_version: number | null; daily_tokens: number; daily_runs: number; fresh: boolean;
        }[];
        if (!a) throw httpError(404, 'not_found');
        if (a.status === 'paused') throw httpError(409, 'agent_paused');
        if (a.status !== 'active') throw httpError(409, 'agent_not_active');
        if (a.fresh && (Number(a.daily_tokens) >= DAILY_TOKENS || Number(a.daily_runs) >= DAILY_RUNS)) throw httpError(429, 'daily_limit');
        // The claim's lease is next_run_at = claimed_at + CLAIM_LEASE_MIN exactly (one statement, one now()): while that
        // still holds, the fire it started has not rescheduled the trigger yet, so it is in flight.
        const ts = (await tx`select id, kind, cooldown_s, last_fired_at, now() as db_now,
                                    next_run_at <= now() as due,
                                    (claimed_at is not null and next_run_at = claimed_at + make_interval(mins => ${CLAIM_LEASE_MIN}) and next_run_at > now()) as in_flight
                             from app.triggers
                             where agent_id = ${agentId} and enabled and spec_version = ${a.active_spec_version}
                             order by next_run_at, id for update`) as {
          id: string; kind: 'cron' | 'condition'; cooldown_s: number; last_fired_at: Date | null; db_now: Date; due: boolean; in_flight: boolean;
        }[];
        if (ts.length === 0) throw httpError(409, 'no_checks');
        if (ts.some((t) => t.due || t.in_flight)) return { state: 'running' } as const;
        const t = ts[0]!;
        if (t.kind === 'condition' && t.last_fired_at) {
          const until = t.last_fired_at.getTime() + Number(t.cooldown_s) * 1000;
          if (until > t.db_now.getTime()) return { state: 'cooling_down', until: new Date(until).toISOString() } as const;
        }
        await tx`update app.triggers set next_run_at = now() where id = ${t.id}`;
        return { state: 'queued', at: t.db_now.toISOString() } as const;
      });
    },

    async setModel(userId, agentId, model) {
      const pick = model === null ? null : await models.resolve(model);
      if (model !== null && !pick) throw httpError(400, 'bad_model');
      // The default is stored as null, so a later change of the platform default moves this agent too.
      const stored = model === null || model === models.defaultId ? null : model;
      const done = (await sql`update app.agents set model = ${stored} where id = ${agentId} and user_id = ${userId} and deleted_at is null returning id`) as unknown[];
      if (done.length === 0) throw httpError(404, 'not_found');
    },

    async setMorningNote(userId, agentId, on) {
      const done = (await sql`update app.agents set morning_note = ${on} where id = ${agentId} and user_id = ${userId} returning id`) as unknown[];
      if (done.length === 0) throw httpError(404, 'not_found');
    },

    async resume(userId, agentId) {
      await sql.begin(async (tx) => {
        const done = (await tx`update app.agents set status = 'active' where id = ${agentId} and user_id = ${userId} and status = 'paused'
                                 and not paused_for_funds returning id`) as unknown[];
        if (done.length === 0) {
          const [a] = (await tx`select status, paused_for_funds from app.agents where id = ${agentId} and user_id = ${userId}`) as { status: string; paused_for_funds: boolean }[];
          if (a?.status === 'paused' && a.paused_for_funds) throw httpError(409, 'awaiting_funds');
          return refuse(userId, agentId, 'not_paused');
        }
        await skipMissedSlots(tx as unknown as Db, agentId);
      });
    },
  };
}
