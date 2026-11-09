/**
 * The hire ledger (spec §5.7, plan D4, D5). Caps: 0.05 USDC per call, the run's mode budget per run, and
 * 1.00 USDC per agent per UTC day. A reservation is atomic: it takes a per-agent advisory transaction lock,
 * sums what counts (every decision except 'failed'), and inserts. 'unknown' (the paid request went out and
 * the call then failed) counts against the caps, failing safe.
 */
import type { Db } from '../db/index.js';

export const HIRE_PER_CALL_USDC = '0.05';
export const HIRE_PER_AGENT_DAY_USDC = '1.00';
const DECIMALS = 7;
// Two-key advisory lock: its own namespace, distinct from MEMORY_LOCK_NAMESPACE (0x41454d31) and SINGLE_REPLICA_KEY (0x41454331).
const SPEND_LOCK_NAMESPACE = 0x41455331;

export type SpendDecision = 'settled' | 'failed' | 'unknown';

export interface Spend {
  headroom(agentId: string, runId: string, runCapUsdc: string): Promise<string>;
  /** `network` defaults to stellar:testnet. Caps count every network together. */
  reserve(r: { agentId: string; runId: string; url: string; payee: string; amountUsdc: string; runCapUsdc: string; network?: string }): Promise<{ ok: true; id: string } | { ok: false; code: 'call_cap' | 'run_cap' | 'day_cap' | 'agent_not_active' | 'bad_run' }>;
  /** Returns the decision actually written (a settled claim without a valid or unique hash is demoted to 'unknown'), or null when nothing was written (the row was no longer 'reserved'). */
  complete(id: string, r: { decision: SpendDecision; txHash?: string }): Promise<SpendDecision | null>;
  /** The hire path's own status check: the runner and the Toolbox check none (P3a carry-forward). */
  agentActive(agentId: string): Promise<boolean>;
  /** Boot: every 'reserved' row becomes 'unknown'; returns how many (plan D13). */
  recoverInterrupted(): Promise<number>;
}

export const units = (decimal: string): bigint => {
  // Strict: at most 7 decimals, digits only. Never truncate: a cap check must see the exact amount.
  const m = /^(\d{1,12})(?:\.(\d{1,7}))?$/.exec(decimal);
  if (!m) throw new Error('spend: bad amount');
  return BigInt(m[1]! + (m[2] ?? '').padEnd(DECIMALS, '0'));
};
const decimal = (u: bigint): string => {
  const s = (u < 0n ? 0n : u).toString().padStart(DECIMALS + 1, '0');
  return `${s.slice(0, -DECIMALS)}.${s.slice(-DECIMALS)}`;
};

/** `instance`: this process's id (db/replica.ts), written on each reservation so recovery never touches a live replica's hire. */
export function createSpend(sql: Db, o: { instance?: number } = {}): Spend {
  async function spent(q: Db, agentId: string, runId: string): Promise<{ run: bigint; day: bigint }> {
    const [r] = (await q`select
        coalesce((select sum(amount_usdc) from app.spend where run_id = ${runId} and decision <> 'failed'), 0)::numeric(20,7)::text as run,
        coalesce((select sum(amount_usdc) from app.spend where agent_id = ${agentId} and decision <> 'failed'
                    and created_at >= date_trunc('day', now(), 'UTC')), 0)::numeric(20,7)::text as day`) as { run: string; day: string }[];
    return { run: units(r!.run), day: units(r!.day) };
  }

  return {
    async headroom(agentId, runId, runCapUsdc) {
      const s = await spent(sql, agentId, runId);
      const left = [units(HIRE_PER_CALL_USDC), units(runCapUsdc) - s.run, units(HIRE_PER_AGENT_DAY_USDC) - s.day];
      return decimal(left.reduce((a, b) => (b < a ? b : a)));
    },

    async reserve(r) {
      const amount = units(r.amountUsdc);
      if (amount <= 0n || amount > units(HIRE_PER_CALL_USDC)) return { ok: false, code: 'call_cap' };
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${SPEND_LOCK_NAMESPACE}, hashtext(${r.agentId}::text))`;
        // The runner checks no agent status (P3a carry-forward): an agent revoked during a long mission pays nothing more.
        const a = (await tx`select status from app.agents where id = ${r.agentId}`) as { status: string }[];
        if (a[0]?.status !== 'active') return { ok: false as const, code: 'agent_not_active' as const };
        // The run must be this agent's and still running: a reservation never lands on another agent's or a finished run.
        const run = (await tx`select 1 from app.runs where id = ${r.runId} and agent_id = ${r.agentId} and status = 'running'`) as unknown[];
        if (run.length === 0) return { ok: false as const, code: 'bad_run' as const };
        const s = await spent(tx as unknown as Db, r.agentId, r.runId);
        if (s.run + amount > units(r.runCapUsdc)) return { ok: false as const, code: 'run_cap' as const };
        if (s.day + amount > units(HIRE_PER_AGENT_DAY_USDC)) return { ok: false as const, code: 'day_cap' as const };
        const rows = (await tx`insert into app.spend (agent_id, run_id, url, payee, amount_usdc, network, instance)
                               values (${r.agentId}, ${r.runId}, ${r.url}, ${r.payee}, ${decimal(amount)}, ${r.network ?? 'stellar:testnet'}, ${o.instance ?? null}) returning id`) as { id: string }[];
        return { ok: true as const, id: rows[0]!.id };
      });
    },

    async complete(id, r) {
      // 'settled' without a tx hash cannot be recorded (CHECK spend_settled_needs_tx): money moved but
      // unproven, so it stays 'unknown' and keeps counting. Same for a hash that is not 64 hex or a duplicate.
      // The hash comes from a seller's receipt: anything that is not a string counts as missing.
      // An EVM hash arrives as 0x + 64 hex; it is stored without the prefix, like a Stellar one.
      // A Solana signature is base58 (case-sensitive) and stored as it came; the row's network decides (CHECK spend_tx_hash_check).
      const raw = typeof r.txHash === 'string' ? r.txHash : undefined;
      const txHash = raw === undefined ? undefined : /^(0x)?[0-9a-fA-F]{64}$/.test(raw) ? raw.toLowerCase().replace(/^0x/, '') : raw;
      const proven = r.decision === 'settled' && txHash !== undefined && (/^[0-9a-f]{64}$/.test(txHash) || /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(txHash));
      const decision = r.decision === 'settled' && !proven ? 'unknown' : r.decision;
      const write = (d: SpendDecision, tx: string | null) =>
        sql.begin(async (t) => {
          const rows = (await t`update app.spend set decision = ${d}, tx_hash = ${tx}, updated_at = now()
                                 where id = ${id} and decision = 'reserved' returning run_id, amount_usdc::text as amount`) as { run_id: string; amount: string }[];
          if (rows[0] && d === 'settled') await t`update app.runs set usdc_spent = usdc_spent + ${rows[0].amount}::numeric where id = ${rows[0].run_id}`;
          return rows.length > 0 ? d : null;
        });
      try {
        return await write(decision, decision === 'settled' ? txHash! : null);
      } catch (e) {
        // A duplicate tx hash (unique index), or one that is not this network's shape (check), must not lose the row's money state.
        const code = (e as { errno?: string }).errno;
        if (code !== '23505' && code !== '23514') throw e;
        return write('unknown', null);
      }
    },

    async agentActive(agentId) {
      return ((await sql`select 1 from app.agents where id = ${agentId} and status = 'active'`) as unknown[]).length > 0;
    },

    async recoverInterrupted() {
      // The leader's sweep: only reservations whose instance is dead (a live replica may be mid-hire). The paid request
      // may have left, so the money state is unknown, and the row keeps counting against the caps (plan D13).
      const rows = (await sql`update app.spend set decision = 'unknown', updated_at = now()
                              where decision = 'reserved' and not app.instance_alive(instance) returning id`) as unknown[];
      return rows.length;
    },
  };
}
