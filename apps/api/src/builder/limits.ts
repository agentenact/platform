/**
 * Builder limits (plan D5): per-visitor and global daily caps, kept in app.builder_usage so they survive a restart and
 * hold across calls. Every cap is one atomic upsert (`... on conflict do update ... where n < limit returning n`), so
 * concurrent admits cannot overshoot. An anonymous draft or trial needs room in its visitor bucket AND in the global
 * one, in a single transaction: a refusal on either side charges neither. The day is the UTC date by the DB clock.
 *
 * Worst case spend: every draft may cost up to 2x BUILDER_BUDGET (the first call plus one repair), and anonymous drafts run on
 * the cheap model (MODEL_IDS.builderAnon, by default deepseek/deepseek-v4.1-flash at $0.045/M in, $0.50/M out), so 300 global anonymous drafts a day stay small.
 */
import type { Db } from '../db/index.js';
import { ipKey } from '../gateway/rate-limit.js';

export const ANON_DRAFTS_PER_IP = 3;
export const ANON_TRIALS_PER_IP = 1;
export const ANON_EDITS_PER_IP = 20;
export const ANON_DRAFTS_GLOBAL = 300;
export const ANON_TRIALS_GLOBAL = 100;
export const USER_DRAFTS = 10;
export const USER_TRIALS = 10;
/** Signed-in drafts across all users per UTC day (Kerem, 2026-10-15). Signed-in drafts run on the top-tier model, so the sum needs its own ceiling. */
export const USER_DRAFTS_GLOBAL = 500;
export const HANDOFFS_PER_IP = 10;
export const USER_HANDOFFS = 20;
/** Selling suggestions generated per signed-in user per UTC day (Kerem, 2026-10-13). Each costs up to 2x SUGGEST_BUDGET. */
export const USER_SUGGESTS = 5;

export type UsageKind = 'draft' | 'trial' | 'edit' | 'handoff' | 'suggest';
export interface Who {
  ip: string;
  userId?: string;
}
export type Admission = { ok: true } | { ok: false; reason: 'sign_in' | 'daily' | 'capacity' };

export interface BuilderLimits {
  /** Counts one `kind` against the caller's caps. Refused means nothing was counted. */
  admit(who: Who, kind: UsageKind): Promise<Admission>;
  /** Adds tokens spent to the same buckets the call was admitted on. Call it for every outcome. */
  addTokens(who: Who, kind: UsageKind, tokens: number): Promise<void>;
}

const PER_IP: Record<UsageKind, number> = { draft: ANON_DRAFTS_PER_IP, trial: ANON_TRIALS_PER_IP, edit: ANON_EDITS_PER_IP, handoff: HANDOFFS_PER_IP, suggest: 0 }; // suggest is signed-in only: an anonymous caller has no room
const GLOBAL: Partial<Record<UsageKind, number>> = { draft: ANON_DRAFTS_GLOBAL, trial: ANON_TRIALS_GLOBAL };
/** Kinds with a ceiling across all signed-in users (scope `global:user`). */
const GLOBAL_USER: Partial<Record<UsageKind, number>> = { draft: USER_DRAFTS_GLOBAL };
const PER_USER: Partial<Record<UsageKind, number>> = { draft: USER_DRAFTS, trial: USER_TRIALS, handoff: USER_HANDOFFS, suggest: USER_SUGGESTS };

const REFUSED = Symbol('refused');
const CAPACITY = Symbol('capacity');

export function createBuilderLimits(sql: Db, o: { day?: () => string } = {}): BuilderLimits {
  const today = () => o.day?.() ?? null; // null: the DB clock decides (UTC)

  /** Count one, if the scope is under `limit`. */
  const bump = async (q: Db, scope: string, kind: UsageKind, limit: number): Promise<boolean> => {
    const rows = (await q`
      insert into app.builder_usage (scope, day, kind, n) values (${scope}, coalesce(${today()}::date, (now() at time zone 'utc')::date), ${kind}, 1)
      on conflict (scope, day, kind) do update set n = app.builder_usage.n + 1 where app.builder_usage.n < ${limit}
      returning n`) as unknown[];
    return rows.length > 0;
  };

  const spend = async (q: Db, scope: string, kind: UsageKind, tokens: number) => {
    await q`
      insert into app.builder_usage (scope, day, kind, n, tokens) values (${scope}, coalesce(${today()}::date, (now() at time zone 'utc')::date), ${kind}, 0, ${tokens})
      on conflict (scope, day, kind) do update set tokens = app.builder_usage.tokens + ${tokens}`;
  };

  return {
    async admit(who, kind) {
      if (who.userId) {
        const limit = PER_USER[kind];
        if (limit === undefined) return { ok: true }; // edits cost no model call
        const ceiling = GLOBAL_USER[kind];
        if (ceiling === undefined) return (await bump(sql, `user:${who.userId}`, kind, limit)) ? { ok: true } : { ok: false, reason: 'daily' };
        // The user's bucket and the all-users ceiling in one transaction: a refusal on either side charges neither.
        try {
          await sql.begin(async (tx) => {
            if (!(await bump(tx as unknown as Db, `user:${who.userId}`, kind, limit))) throw REFUSED;
            if (!(await bump(tx as unknown as Db, 'global:user', kind, ceiling))) throw CAPACITY;
          });
          return { ok: true };
        } catch (e) {
          if (e === REFUSED) return { ok: false, reason: 'daily' };
          if (e === CAPACITY) return { ok: false, reason: 'capacity' };
          throw e;
        }
      }
      const scope = `ip:${ipKey(who.ip)}`;
      const global = GLOBAL[kind];
      if (global === undefined) return (await bump(sql, scope, kind, PER_IP[kind])) ? { ok: true } : { ok: false, reason: 'sign_in' };
      try {
        await sql.begin(async (tx) => {
          if (!(await bump(tx as unknown as Db, scope, kind, PER_IP[kind]))) throw REFUSED;
          if (!(await bump(tx as unknown as Db, 'global', kind, global))) throw REFUSED;
        });
        return { ok: true };
      } catch (e) {
        if (e === REFUSED) return { ok: false, reason: 'sign_in' };
        throw e;
      }
    },

    async addTokens(who, kind, tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return;
      const t = Math.round(tokens);
      if (who.userId) {
        await spend(sql, `user:${who.userId}`, kind, t);
        if (GLOBAL_USER[kind] !== undefined) await spend(sql, 'global:user', kind, t);
        return;
      }
      await spend(sql, `ip:${ipKey(who.ip)}`, kind, t);
      if (GLOBAL[kind] !== undefined) await spend(sql, 'global', kind, t);
    },
  };
}
