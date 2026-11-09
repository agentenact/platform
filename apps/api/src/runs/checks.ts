/**
 * `checks`: the lightweight per-agent, per-day count of trigger checks (spec §6c). A quiet condition check
 * (the condition was false) is not a run, so it leaves no run row, only a count here; a fire adds to `fired`.
 * The day is the UTC day of the DATABASE clock, and one statement adds atomically, so concurrent checks
 * never lose a count.
 */
import type { Db } from '../db/index.js';

export type CheckKind = 'quiet' | 'fired';

export interface CheckDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  quiet: number;
  fired: number;
  lastAt: Date;
}

/** One logged condition check (run-readings D1): held is null when the fetch or the code failed. */
export interface CheckLogEntry {
  triggerId: string;
  held: boolean | null;
  /** The per-tool extract (src/checks/readings.ts), at most 512 bytes serialized; null when there is none. */
  reading: Record<string, number | string> | null;
}

/** Rows older than this are deleted by the scheduler, in batches of at most PRUNE_BATCH per tick. */
export const CHECK_LOG_DAYS = 7;
export const PRUNE_BATCH = 1000;

export interface Checks {
  record(agentId: string, kind: CheckKind): Promise<void>;
  /** One short, temporary row per condition check. Independent of the counters: record() does not write it. */
  log(agentId: string, e: CheckLogEntry): Promise<void>;
  /** Delete at most `limit` log rows older than 7 days (oldest first, via the (at) index); returns how many went. */
  prune(limit?: number): Promise<number>;
  /** Days on or after the UTC day of `since`, newest first. */
  days(agentId: string, since: Date): Promise<CheckDay[]>;
}

export function createChecks(sql: Db): Checks {
  return {
    async record(agentId, kind) {
      const quiet = kind === 'quiet' ? 1 : 0;
      await sql`insert into app.check_days (agent_id, day, quiet, fired, last_at)
                values (${agentId}, (now() at time zone 'utc')::date, ${quiet}, ${1 - quiet}, now())
                on conflict (agent_id, day) do update
                  set quiet = app.check_days.quiet + excluded.quiet, fired = app.check_days.fired + excluded.fired, last_at = now()`;
    },

    async log(agentId, e) {
      // The reading goes as a plain object: the driver encodes jsonb, while JSON.stringify(...)::jsonb would store a string.
      await sql`insert into app.check_log (agent_id, trigger_id, held, reading)
                values (${agentId}, ${e.triggerId}, ${e.held}, ${e.reading})`;
    },

    async prune(limit = PRUNE_BATCH) {
      const gone = (await sql`delete from app.check_log where id in (
                                select id from app.check_log where at < now() - make_interval(days => ${CHECK_LOG_DAYS}) order by at limit ${limit} for update skip locked)
                              returning id`) as unknown[];
      return gone.length;
    },

    async days(agentId, since) {
      const rows = (await sql`select to_char(day, 'YYYY-MM-DD') as day, quiet, fired, last_at from app.check_days
                              where agent_id = ${agentId} and day >= (${since}::timestamptz at time zone 'utc')::date
                              order by day desc`) as { day: string; quiet: number; fired: number; last_at: Date }[];
      return rows.map((r) => ({ day: r.day, quiet: r.quiet, fired: r.fired, lastAt: r.last_at }));
    },
  };
}
