/**
 * `policy`: checks made by code outside the model (spec §6, §14). The kill switch, per-user daily caps
 * (one atomic UPDATE, plan D12), and per-agent rate limits for delivery and egress, shared by every replica
 * (gateway/rate-limit.ts). P3b adds spend.
 */
import type { Db } from '../db/index.js';
import { createRateLimiter } from '../gateway/rate-limit.js';

export const DAILY_TOKENS = 1_500_000;
export const DAILY_RUNS = 50;
export const EMAILS_PER_DAY = 20;
export const WEBHOOKS_PER_DAY = 100;
export const EGRESS_PER_HOUR = 300;
/**
 * The OpenRouter web-search fallback is paid and not metered by token caps (web_search, 2026-10-07).
 * Window semantics (do not read these as calendar days): each limiter is a fixed 24 h window that starts at its
 * first hit. In any 24 h an agent can therefore get up to 2x its cap (end of one window, start of the next).
 * Accepted: small numbers.
 */
export const PAID_SEARCH_PER_AGENT_PER_DAY = 20;
export const PAID_SEARCH_GLOBAL_PER_DAY = 300;
/**
 * Builder trials (anonymous and signed-in) search from their own bucket, so they can never spend the hosted agents'
 * paid-search cap or starve their Tavily quota: every trial web_search counts here, whichever provider answers.
 * Same fixed-window semantics as above.
 */
export const TRIAL_SEARCH_PER_DAY = 100;
export const TRIAL_SEARCH_PER_TRIAL = 3;
const TOKEN_CLAMP = 2_000_000_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type PaidAdmission = true | 'agent' | 'global';

export interface Policy {
  readonly killed: boolean;
  /** Counts one run against the user's day; false when a cap is reached (or the user is unknown). */
  admitRun(userId: string): Promise<boolean>;
  /**
   * Charges one model step's tokens to the user's current UTC day (one atomic UPDATE; a stale day resets
   * first). Returns true while the user is still under DAILY_TOKENS after the charge; false at or over the
   * cap, or for an unknown user. Throws `policy: bad_tokens` for a non-finite or negative count, so a
   * caller bug never fails open. 0 is allowed and just reports the cap.
   */
  chargeTokens(userId: string, tokens: number): Promise<boolean>;
  delivery(agentId: string, kind: 'email' | 'webhook'): boolean | Promise<boolean>;
  egress(agentId: string): boolean | Promise<boolean>;
  /** Admits one paid (fallback) web search: `true`, or the scope of the cap that refused it. */
  paidSearch(agentId: string): PaidAdmission | Promise<PaidAdmission>;
  /** Admits one trial web_search from the trials-only daily bucket (never touches paidSearch's counters). */
  trialSearch(): boolean | Promise<boolean>;
}

/** `killSwitch` is a constant, or a function read on every `killed` access (an operator stop can flip it at runtime). */
export function createPolicy(sql: Db, o: { killSwitch: boolean | (() => boolean); now?: () => number }): Policy {
  // An injected clock (tests) keeps the counters in memory; production shares them across replicas (rate-limit.ts).
  const now = o.now ? { now: o.now } : {};
  const email = createRateLimiter({ name: 'policy.email', limit: EMAILS_PER_DAY, windowMs: DAY_MS, ...now });
  const webhook = createRateLimiter({ name: 'policy.webhook', limit: WEBHOOKS_PER_DAY, windowMs: DAY_MS, ...now });
  const egress = createRateLimiter({ name: 'policy.egress', limit: EGRESS_PER_HOUR, windowMs: HOUR_MS, ...now });
  const paidAgent = createRateLimiter({ name: 'policy.paidAgent', limit: PAID_SEARCH_PER_AGENT_PER_DAY, windowMs: DAY_MS, ...now });
  const paidGlobal = createRateLimiter({ name: 'policy.paidGlobal', limit: PAID_SEARCH_GLOBAL_PER_DAY, windowMs: DAY_MS, ...now });
  const trialSearch = createRateLimiter({ name: 'policy.trialSearch', limit: TRIAL_SEARCH_PER_DAY, windowMs: DAY_MS, ...now });
  return {
    get killed() {
      return typeof o.killSwitch === 'function' ? o.killSwitch() : o.killSwitch;
    },

    async admitRun(userId) {
      // UTC days. A new day resets both counters and admits; otherwise admit only under both caps.
      const rows = (await sql`update app.users set
                                daily_runs = case when daily_reset_at < date_trunc('day', now(), 'UTC') then 1 else daily_runs + 1 end,
                                daily_tokens = case when daily_reset_at < date_trunc('day', now(), 'UTC') then 0 else daily_tokens end,
                                daily_reset_at = greatest(daily_reset_at, date_trunc('day', now(), 'UTC'))
                              where id = ${userId}
                                and (daily_reset_at < date_trunc('day', now(), 'UTC') or (daily_runs < ${DAILY_RUNS} and daily_tokens < ${DAILY_TOKENS}))
                              returning daily_runs`) as unknown[];
      return rows.length > 0;
    },

    async chargeTokens(userId, tokens) {
      if (!Number.isFinite(tokens) || tokens < 0) throw new Error('policy: bad_tokens');
      const n = Math.min(Math.round(tokens), TOKEN_CLAMP);
      const rows = (await sql`update app.users set
                                daily_runs = case when daily_reset_at < date_trunc('day', now(), 'UTC') then 0 else daily_runs end,
                                daily_tokens = case when daily_reset_at < date_trunc('day', now(), 'UTC') then ${n}
                                                    else least(daily_tokens::bigint + ${n}, ${TOKEN_CLAMP}) end,
                                daily_reset_at = greatest(daily_reset_at, date_trunc('day', now(), 'UTC'))
                              where id = ${userId}
                              returning daily_tokens`) as { daily_tokens: number }[];
      return rows.length > 0 && Number(rows[0]!.daily_tokens) < DAILY_TOKENS;
    },

    async delivery(agentId, kind) {
      return (await (kind === 'email' ? email : webhook).hit(agentId)) === 0;
    },

    async egress(agentId) {
      return (await egress.hit(agentId)) === 0;
    },

    async paidSearch(agentId) {
      // Global first would let one noisy agent spend everyone's slots on refusals; the agent's own cap is checked
      // first, and the global counter only counts searches the agent is allowed to make.
      if ((await paidAgent.hit(agentId)) !== 0) return 'agent';
      return (await paidGlobal.hit('all')) === 0 ? true : 'global';
    },

    async trialSearch() {
      return (await trialSearch.hit('all')) === 0;
    },
  };
}
