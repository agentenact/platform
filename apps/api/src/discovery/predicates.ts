import type { Db } from '../db/index.js';

/**
 * SQL fragments shared by the totals (stats) and the CSV exports, so a total can always be reproduced from its export.
 * Scope: the rules for payments, activity and builder live here. The agents and proven-sales totals are plain row counts of
 * discovery.agents / discovery.proven_sales in both stats and export, with no filter to share.
 * Change a rule here and both move together.
 */
export function predicates(sql: Db) {
  const paymentActivity = sql`kind in ('received', 'sent', 'sale')`;
  return {
    /** payments that count towards "USDC paid to agents" (agents registered = every discovery.agents row; proven = every proven_sales row). */
    countedPayment: sql`counted`,
    /**
     * discovery.activity rows that are money moving: a counted payment received ('received') or sent ('sent'), or a proven
     * sale ('sale'). Registrations, uri updates, wallet binds and owner changes are activity too, but not payment activity.
     */
    paymentActivity,
    /** "working in the last hour": payment/sale rows of discovery.activity inside the rolling window (registrations and binds do not count). */
    activeWindow: (nowIso: string) => sql`${paymentActivity} and at > ${nowIso}::timestamptz - interval '1 hour'`,
    // builder as readers must show it: 'hosted' only while its last verification (selfpub.fetched_at) is fresh.
    // `a` is discovery.agents and `sp` is discovery.selfpub (left join) in every query that uses it.
    builderOf: (nowIso: string) =>
      sql`case when a.builder = 'hosted' and (sp.fetched_at is null or sp.fetched_at < ${nowIso}::timestamptz - interval '1 hour') then 'external' else a.builder end`,
    // The ONLY place a hosted uuid leaves the index: it is a spoofable uri claim, so it counts only while the agent reads as
    // 'hosted' (verified and fresh). Same predicate as builderOf.
    hostedUuidOf: (nowIso: string) =>
      sql`case when a.builder = 'hosted' and sp.fetched_at is not null and sp.fetched_at >= ${nowIso}::timestamptz - interval '1 hour' then a.hosted_uuid::text else null end`,
  };
}
