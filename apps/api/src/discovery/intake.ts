/**
 * Intake of signed Enactment Records from library users (sub-project E, task 12).
 *
 * A submitted record is never trusted: the full verifier re-checks signature, settlement, timing and
 * identity against public chain data (testnet, read-only). Only a record that passes, on the pinned USDC asset,
 * for an agent the index already holds, is stored, and only after `parseRecord` normalization (never the raw
 * body). Storing is not counting: the indexer verifies a submission itself before it becomes a proven sale
 * (the checks here only gate cost).
 *
 * Order, cheapest first, so unauthenticated junk can never spend a scarcer resource (review I1/I2):
 * pure body checks, one index read (agent known, address is its owner or wallet), duplicate digest,
 * local signature, the concurrency gate, the per-agent hourly cap, the global hourly budget, and only then the chain reads.
 * Nothing awaits between the gate and `inflight++`, and a refusal never consumes a unit of anything scarcer than itself.
 */
import { parseRecord, recordDigest, verifyRecord, type ChainAdapter, type EnactmentRecord, type VerifyCheck, type VerifyResult } from 'agentenact';
import type { Db } from '../db/index.js';
import { createRateLimiter } from '../gateway/rate-limit.js';

export type IntakeRefusal = 'malformed' | 'not_verified' | 'wrong_asset' | 'no_agent_id' | 'agent_not_indexed' | 'rate_limited' | 'busy' | 'chain_unavailable';
export type IntakeResult =
  | { status: 'accepted' | 'already_received'; digest: string }
  | { status: 'refused'; code: IntakeRefusal; check?: VerifyCheck; retryAfter?: number };

export interface Intake {
  submit(raw: unknown): Promise<IntakeResult>;
  /** The record of the first proven sale with this settlement ref, or null. */
  record(ref: string): Promise<unknown | null>;
}

/** Two stages of verification, so the cheap one can run before the global budget is charged. */
export interface Verifier {
  /** Local ed25519 check of the record's signature. No network. */
  signature(record: EnactmentRecord): Promise<boolean>;
  /** All four checks against chain data (reads Horizon and Soroban). */
  full(record: unknown): Promise<VerifyResult>;
}

export const DEFAULT_MAX_CONCURRENT = 4;
/** Chain-reading verifications across everyone, per hour. Charged only for records already signature-valid. */
export const SUBMISSIONS_PER_HOUR = 200;
/** Chain-reading verifications per agentId per hour: one registered agent can take at most 10% of the global budget (review I3). */
export const SUBMISSIONS_PER_AGENT_PER_HOUR = 20;
/** Whole units of at most 18 digits and up to 7 decimals (Stellar), with at least one non-zero digit. */
const AMOUNT = /^(?=.*[1-9])\d{1,18}(?:\.\d{1,7})?$/;
/** A u32 without leading zeros, so "031" never aliases agent 31. */
const AGENT_ID = /^(0|[1-9]\d{0,9})$/;
const TX_REF = /^[0-9a-f]{64}$/;
const U32_MAX = 0xffffffff;

/** The library's signature and full checks over one adapter. */
export function verifierFor(adapter: ChainAdapter): Verifier {
  return {
    async signature(record) {
      if (record.agent.chain !== adapter.chain || record.sig.alg !== adapter.sigAlg) return false;
      try {
        return await adapter.verify(await recordDigest(record), record.sig.value, record.agent.address);
      } catch {
        return false; // an unparseable address or signature is a bad signature
      }
    },
    full: (record) => verifyRecord(record, adapter),
  };
}

/** The default verifier: Stellar testnet (read-only). */
export function stellarTestnetVerifier(): Verifier {
  let adapter: Promise<ChainAdapter> | undefined;
  // Loaded on first use: the Stellar SDK is heavy and an intake that never verifies should not pay for it.
  const load = () =>
    (adapter ??= import('agentenact/adapters/stellar').then(
      (m) => m.createStellarAdapter({ network: 'testnet' }),
      (e) => ((adapter = undefined), Promise.reject(e)), // a failed load is retried, not cached
    ));
  return {
    signature: async (record) => verifierFor(await load()).signature(record),
    full: async (record) => verifierFor(await load()).full(record),
  };
}

export function createIntake(d: {
  sql: Db;
  verifier: Verifier;
  /** Pinned Circle USDC identity, `CODE:ISSUER`. */
  usdc: string;
  maxConcurrent?: number;
  /** Charges one chain-reading verification to the global budget: 0 if allowed, else seconds to wait. */
  budget?: () => number | Promise<number>;
  /** Charges one verification to this agentId's hourly cap: 0 if allowed, else seconds to wait. */
  agentBudget?: (agentId: string) => number | Promise<number>;
  /** Fixed event codes only: never an error message or the record. */
  log?: (e: Record<string, string | number>) => void;
}): Intake {
  const max = d.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const global = createRateLimiter({ name: 'intake.global', limit: SUBMISSIONS_PER_HOUR, windowMs: 3_600_000 });
  const budget = d.budget ?? (() => global.hit('all'));
  const perAgent = createRateLimiter({ name: 'intake.perAgent', limit: SUBMISSIONS_PER_AGENT_PER_HOUR, windowMs: 3_600_000 });
  const agentBudget = d.agentBudget ?? ((id: string) => perAgent.hit(id));
  let inflight = 0;
  const refuse = (code: IntakeRefusal, extra: { check?: VerifyCheck; retryAfter?: number } = {}): IntakeResult => ({ status: 'refused', code, ...extra });

  return {
    async submit(raw) {
      // 1. pure checks
      let record: EnactmentRecord;
      try {
        record = parseRecord(raw);
      } catch {
        return refuse('malformed');
      }
      if (record.agent.chain !== 'stellar' || record.settlement.chain !== 'stellar') return refuse('malformed');
      if (!TX_REF.test(record.settlement.ref)) return refuse('malformed');
      if (!AMOUNT.test(record.settlement.amount)) return refuse('malformed');
      const agentId = record.agent.agentId;
      if (agentId === undefined) return refuse('no_agent_id');
      if (!AGENT_ID.test(agentId) || Number(agentId) > U32_MAX) return refuse('malformed');
      if (record.settlement.asset !== d.usdc) return refuse('wrong_asset');

      // 2. one index read: the agent must be known, and the signer must be its owner or wallet (the library's identity rule)
      const known = await d.sql`select owner, wallet from discovery.agents where agent_id = ${Number(agentId)}`;
      if (known.length === 0) return refuse('agent_not_indexed');
      const address = record.agent.address;
      // not owner/wallet may be index lag after a rebind or owner change, so it is retryable (409), never a terminal 422
      if (known[0]!.owner !== address && known[0]!.wallet !== address) return refuse('agent_not_indexed');

      // 3. duplicates cost nothing further
      const digest = Buffer.from(await recordDigest(record)).toString('hex');
      if ((await d.sql`select 1 from discovery.submissions where digest = ${digest}`).length > 0) return { status: 'already_received', digest };

      // 4. local signature: only a record signed by that agent's own key can spend the global budget
      if (!(await d.verifier.signature(record))) return refuse('not_verified', { check: 'signature' });

      // 5. concurrency gate first (a busy refusal costs no budget), then the per-agent cap, then the global budget, then the chain reads
      if (inflight >= max) return refuse('busy');
      const agentWait = await agentBudget(agentId);
      if (agentWait) return refuse('rate_limited', { retryAfter: agentWait });
      const wait = await budget();
      if (wait) return refuse('rate_limited', { retryAfter: wait });
      inflight++;
      let result: VerifyResult;
      try {
        result = await d.verifier.full(record);
      } catch {
        d.log?.({ event: 'intake_chain_unavailable' });
        return refuse('chain_unavailable');
      } finally {
        inflight--;
      }
      if (!result.ok) {
        const check = result.failure?.check;
        return check && check !== 'record' ? refuse('not_verified', { check }) : refuse('malformed');
      }

      const rows = await d.sql`
        insert into discovery.submissions (digest, record) values (${digest}, ${record as unknown as Record<string, unknown>})
        on conflict (digest) do nothing returning digest`;
      return { status: rows.length === 1 ? 'accepted' : 'already_received', digest };
    },

    async record(ref) {
      const rows = await d.sql`select record from discovery.proven_sales where settlement_ref = ${ref} order by verified_at, agent_address limit 1`;
      return rows.length === 0 ? null : (rows[0].record as unknown);
    },
  };
}
