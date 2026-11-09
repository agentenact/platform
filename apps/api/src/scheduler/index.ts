/**
 * `scheduler` (spec §5.4, §5.5, plan D13). Every 30 s: claim due triggers of active agents on their active
 * spec version in ONE statement (FOR UPDATE SKIP LOCKED) that pushes next_run_at out by a 15-minute lease,
 * so two ticks never dispatch the same trigger and a crash re-fires after the lease. Then:
 * - cron: run the mission, schedule the next fire time;
 * A mission is judged by its `status` (never by text); a null mission (agent no longer active) is skipped.
 * - condition: inside the cooldown nothing runs (no fetch, no sandbox). Otherwise run the free read tool and
 *   the condition code by code (no model, zero tokens); only a `true` runs the mission. Three code errors in
 *   a row (an error, or a non-boolean) disable the trigger and notify the owner once. A fetch failure or a
 *   sandbox platform fault (`fault: 'platform'`: busy, unavailable, aborted, shutdown) is retried later and
 *   is not a code error; the sandbox sets `fault`, so owner code cannot fake it by throwing "busy".
 * The claim also stamps `claimed_at`: while next_run_at is still that claim's lease, a fire is in flight (Run now reads it).
 * Clocks: every scheduling decision uses the DATABASE clock (the claim's `db_now`, `now()`/`clock_timestamp()`
 * in SQL). The JS clock is never mixed in: a skewed process clock once made a cron compute a next run equal
 * to the due time it had just claimed, firing it twice.
 * Never logs an error object.
 */
import type { Db } from '../db/index.js';
import { readingOf, type Reading } from '../checks/readings.js';
import { BUDGETS } from '../loop/budgets.js';
import { cronNext, settingsNote, type ConditionFetchTool } from '../specs/schema.js';
import type { SandboxResult } from '../tools/sandbox.js';

export const TICK_MS = 30_000;
export const BATCH = 10;
export const CONCURRENCY = 4;
export const MAX_ERROR_STREAK = 3;
export const CONDITION_DATA_CHARS = 8000;
export const CONDITION_FETCH_MS = 20_000;
/** Worst case for one fire: fetch + sandbox (queue wait 15 s + 3 s hard kill) + mission wall clock + delivery (30 s allowance). */
const SANDBOX_WORST_MS = 2 * (15_000 + 3_000); // a job re-queued once after a child death gets a fresh wait + deadline
const DELIVERY_ALLOWANCE_MS = 30_000;
export const FIRE_WORST_MS = CONDITION_FETCH_MS + SANDBOX_WORST_MS + BUDGETS.mission.wallClockMs + DELIVERY_ALLOWANCE_MS; // 386 s
/** A tick drains at most BATCH fires through CONCURRENCY slots: ceil(10/4) = 3 sequential fires per slot in the worst case. */
export const TICK_WORST_MS = Math.ceil(BATCH / CONCURRENCY) * FIRE_WORST_MS; // 3 x 386 s = 19.3 min
/**
 * The claim pushes next_run_at this far out so no other tick takes a trigger that is still running, and a
 * crash re-fires after it. It must outlast the worst tick (TICK_WORST_MS = 19.3 min) with margin: 25 min.
 */
export const CLAIM_LEASE_MIN = 25;
/** Retry delay after a platform fault (sandbox busy/unavailable): not the owner's fault, so no error streak. */
export const PLATFORM_RETRY_S = 60;
/** The check log is best effort: a fire waits for its insert at most this long before returning (it never waits before firing or rescheduling). */
export const LOG_WAIT_MS = 3_000;

export interface SchedulerDeps {
  sql: Db;
  killed: () => boolean;
  mission(agentId: string, triggerId: string, text: string): Promise<{ status: string } | null>;
  conditionFetch(agentId: string, tool: ConditionFetchTool, args: unknown, signal?: AbortSignal): Promise<unknown>;
  sandbox(code: string, input: unknown, o?: { params?: Record<string, number | string | boolean> }): Promise<SandboxResult>;
  notify(agentId: string, text: string): Promise<void>;
  /** The per-day check count (spec §6c). Best effort: a throw only logs `check_record_failed`, the outcome is unchanged. */
  recordCheck?(agentId: string, kind: 'quiet' | 'fired'): Promise<void>;
  /** One short temporary row per condition check (run-readings). Best effort: a throw only logs `check_log_failed`. */
  logCheck?(agentId: string, e: { triggerId: string; held: boolean | null; reading: Reading | null }): Promise<void>;
  /** Bounded delete of old check-log rows, run at the end of every tick. Best effort: a throw only logs `check_prune_failed`. */
  pruneChecks?(): Promise<unknown>;
  log?: (e: Record<string, string | number>) => void;
}

export interface TickReport {
  claimed: number;
  missions: number;
  conditionsFalse: number;
  cooldowns: number;
  errors: number;
}

export interface Scheduler {
  tick(): Promise<TickReport>;
  start(intervalMs?: number): () => void;
  inflight(): Promise<unknown>[];
}

interface Claimed {
  id: string;
  agent_id: string;
  kind: 'cron' | 'condition';
  cron_expr: string | null;
  cron_tz: string | null;
  condition: { fetch: { tool: ConditionFetchTool; args: unknown }; code: string; every_s: number; params?: Record<string, number | string | boolean> } | null;
  mission: string;
  cooldown_s: number;
  last_fired_at: Date | null;
  error_streak: number;
  /** The due time just claimed (the row's next_run_at before the lease), and the DB clock at the claim. */
  due_at: Date;
  db_now: Date;
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

type Outcome = 'mission' | 'false' | 'cooldown' | 'error';

export function createScheduler(d: SchedulerDeps): Scheduler {
  const log = d.log ?? (() => undefined);
  let current: Promise<TickReport> | null = null;

  async function claim(): Promise<Claimed[]> {
    return (await d.sql`update app.triggers t set next_run_at = now() + make_interval(mins => ${CLAIM_LEASE_MIN}), claimed_at = now()
                        from (select tr.id, tr.next_run_at as due_at from app.triggers tr join app.agents a on a.id = tr.agent_id
                              where tr.enabled and tr.next_run_at <= now() and a.status = 'active' and a.active_spec_version = tr.spec_version
                              order by tr.next_run_at limit ${BATCH}
                              for update of tr skip locked) due
                        where t.id = due.id
                        returning t.id, t.agent_id, t.kind, t.cron_expr, t.cron_tz, t.condition, t.mission, t.cooldown_s, t.last_fired_at, t.error_streak, due.due_at, now() as db_now`) as Claimed[];
  }

  async function recordCheck(t: Claimed, kind: 'quiet' | 'fired'): Promise<void> {
    if (!d.recordCheck) return;
    try {
      await d.recordCheck(t.agent_id, kind);
    } catch {
      log({ event: 'check_record_failed', agent: t.agent_id, trigger: t.id });
    }
  }

  /** Starts the insert and returns at once; the promise never rejects. Callers keep it and `settled()` it just before returning. */
  function logCheck(t: Claimed, held: boolean | null, reading: Reading | null): Promise<void> {
    if (!d.logCheck) return Promise.resolve();
    return Promise.resolve()
      .then(() => d.logCheck!(t.agent_id, { triggerId: t.id, held, reading }))
      .catch(() => {
        log({ event: 'check_log_failed', agent: t.agent_id, trigger: t.id });
      });
  }

  /** Wait for a started log insert, but never longer than LOG_WAIT_MS (a hung insert must not hold a slot). */
  async function settled(logged: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([logged, new Promise<void>((r) => (timer = setTimeout(r, LOG_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** 'none': the callee declined (agent not active); 'threw': it threw; otherwise the run's own status. */
  async function runMission(t: Claimed, text: string): Promise<string> {
    try {
      const out = await d.mission(t.agent_id, t.id, text);
      return out ? out.status : 'none';
    } catch {
      log({ event: 'mission_failed', agent: t.agent_id, trigger: t.id });
      return 'threw';
    }
  }

  const outcomeOf = (status: string): Outcome => (status === 'done' ? 'mission' : 'error');

  async function fireCron(t: Claimed): Promise<Outcome> {
    const status = await runMission(t, t.mission);
    // From the DB clock at the end of the run, never before the due time: strictly after what was claimed, so
    // it cannot fire twice, and a run that outlasts an interval skips the slots it covered.
    const [clock] = (await d.sql`select clock_timestamp() as t`) as { t: Date }[];
    const next = cronNext(t.cron_expr!, new Date(Math.max(clock!.t.getTime(), t.due_at.getTime())), t.cron_tz);
    // A run that happened (any status, even a throw) may have spent budget: stamp it. A declined one did not.
    if (status === 'none') await d.sql`update app.triggers set next_run_at = ${next} where id = ${t.id}`;
    else await d.sql`update app.triggers set next_run_at = ${next}, last_fired_at = now(), error_streak = 0 where id = ${t.id}`;
    if (status !== 'none') await recordCheck(t, 'fired');
    return outcomeOf(status);
  }

  async function fireCondition(t: Claimed): Promise<Outcome> {
    const c = t.condition!;
    const reschedule = (streak: number, fired = false) =>
      fired
        ? d.sql`update app.triggers set next_run_at = now() + make_interval(secs => ${c.every_s}), error_streak = ${streak}, last_fired_at = now() where id = ${t.id}`
        : d.sql`update app.triggers set next_run_at = now() + make_interval(secs => ${c.every_s}), error_streak = ${streak} where id = ${t.id}`;
    if (t.last_fired_at && t.db_now.getTime() - t.last_fired_at.getTime() < t.cooldown_s * 1000) {
      await reschedule(t.error_streak); // cooling: skip the fetch and the sandbox, keep the streak as it was
      return 'cooldown';
    }
    let data: unknown;
    try {
      data = await d.conditionFetch(t.agent_id, c.fetch.tool, c.fetch.args, AbortSignal.timeout(CONDITION_FETCH_MS));
    } catch {
      log({ event: 'condition_fetch_failed', agent: t.agent_id, trigger: t.id });
      const logged = logCheck(t, null, null);
      await reschedule(t.error_streak);
      await settled(logged);
      return 'error';
    }
    const v = await d.sandbox(c.code, data, c.params && Object.keys(c.params).length > 0 ? { params: c.params } : undefined);
    if (!v.ok && v.fault === 'platform') {
      log({ event: 'sandbox_unavailable', agent: t.agent_id, trigger: t.id });
      const logged = logCheck(t, null, null);
      await d.sql`update app.triggers set next_run_at = now() + make_interval(secs => ${PLATFORM_RETRY_S}) where id = ${t.id}`;
      await settled(logged);
      return 'error';
    }
    if (!v.ok || typeof v.value !== 'boolean') {
      const logged = logCheck(t, null, null);
      const streak = t.error_streak + 1;
      if (streak >= MAX_ERROR_STREAK) {
        await d.sql`update app.triggers set enabled = false, error_streak = ${streak} where id = ${t.id}`;
        log({ event: 'trigger_disabled', agent: t.agent_id, trigger: t.id });
        try {
          await d.notify(t.agent_id, `Your agent's condition trigger was turned off after ${MAX_ERROR_STREAK} errors in a row (${v.ok ? 'the code did not return true or false' : 'the code failed'}). Fix the condition and approve the spec again to turn it back on.`);
        } catch {
          log({ event: 'notify_failed', agent: t.agent_id });
        }
      } else {
        await reschedule(streak);
      }
      await settled(logged);
      return 'error';
    }
    const { reading } = readingOf(c.fetch.tool, c.fetch.args, data);
    const logged = logCheck(t, v.value, reading);
    if (!v.value) {
      await reschedule(0);
      await recordCheck(t, 'quiet');
      await settled(logged);
      return 'false';
    }
    const seen = JSON.stringify(data) ?? 'null';
    const status = await runMission(t, `${t.mission}${settingsNote(c.params)}\n\nThe condition held. The data it was checked against (untrusted, as fetched):\n${clip(seen, CONDITION_DATA_CHARS)}`);
    await reschedule(0, status !== 'none');
    if (status !== 'none') await recordCheck(t, 'fired');
    await settled(logged);
    return outcomeOf(status);
  }

  async function fire(t: Claimed): Promise<Outcome> {
    try {
      return t.kind === 'cron' ? await fireCron(t) : await fireCondition(t);
    } catch {
      log({ event: 'trigger_failed', agent: t.agent_id, trigger: t.id });
      return 'error';
    }
  }

  async function tick(): Promise<TickReport> {
    const report: TickReport = { claimed: 0, missions: 0, conditionsFalse: 0, cooldowns: 0, errors: 0 };
    if (d.killed()) return report;
    const due = await claim();
    report.claimed = due.length;
    // A refill pool: up to CONCURRENCY fires in flight, the next one starts as each finishes.
    let next = 0;
    const slot = async (): Promise<void> => {
      while (next < due.length) {
        const o = await fire(due[next++]!);
        if (o === 'mission') report.missions++;
        else if (o === 'false') report.conditionsFalse++;
        else if (o === 'cooldown') report.cooldowns++;
        else report.errors++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, slot));
    if (d.pruneChecks) {
      // Bounded like the log: a hung delete must not stall the next tick (the pool has no statement timeout).
      await settled(
        Promise.resolve()
          .then(() => d.pruneChecks!())
          .then(
            () => undefined,
            () => log({ event: 'check_prune_failed' }),
          ),
      );
    }
    return report;
  }

  return {
    tick,
    start(intervalMs = TICK_MS) {
      let stopped = false;
      const timer = setInterval(() => {
        if (stopped || current) return; // never overlap ticks
        current = tick()
          .catch(() => {
            log({ event: 'tick_failed' });
            return { claimed: 0, missions: 0, conditionsFalse: 0, cooldowns: 0, errors: 1 };
          })
          .finally(() => {
            current = null;
          });
      }, intervalMs);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
    inflight: () => (current ? [current] : []),
  };
}
