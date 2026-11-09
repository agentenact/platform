/**
 * `provision`: the only unit that runs createStellarAgent (spec §5.1 step 2). State lives on
 * agents.provision_state:  pending → key_ready → creating → active | failed.
 * A start may begin from pending, key_ready or failed (the gateway's retry allows all three). Before
 * `creating` nothing of the run is on chain: a key that exists at pending/key_ready is live and unused,
 * and is reused here (the rotation check below runs only from `failed`). This is the exit for a first
 * start that errored or a process that died before `creating`; recoverInterrupted handles only `creating`.
 * NEVER log or store an error from createStellarAgent: it is a library error object (fixed codes only).
 * Failures become fixed codes plus public tx hashes.
 *
 * The agent key never enters this process: it stays in the vault (keys/vault.ts), and the library gets an
 * `agentSigner` that asks the vault to sign. The vault signs only the exact birth tx and the bind entry for
 * this agent's owner, and only while the agent is provisioning.
 *
 * A key is destroyed only when nothing live can depend on it (fix round 1):
 * - the outcome is logged (public hashes + registry id) BEFORE it is saved, and the final save is retried;
 * - the registry id is saved before the owner is asked to bind;
 * - before rotating, the registry is read: if the agent is bound to the key we hold and owned by the
 *   user's wallet, the agent is recovered as active instead; a failed read rotates nothing.
 *
 * Resume: when the last attempt failed with owner_timeout / owner_rejected (the owner never signed, so what
 * that step would have sent was never sent) and the key is the live key, the next start continues with the
 * SAME key instead of orphaning it: `resume: { account: true }` once Horizon shows the account, plus
 * `agentId` once the registry shows the identity owned by the user and still unbound with the bind window
 * closed. The library re-verifies both facts and throws `resume_mismatch` before any tx; that attempt is
 * never resumed again (the following start rotates). Every other failure code keeps the rotate-and-orphan path.
 *
 * Sponsor-lock wait: capped in chain (createLeaseLock, 120 s, `chain_busy`), which lands here as chain_error.
 */
import { xdr, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import {
  createStellarAgent,
  type AuthOwnerRemoteOptions,
  type PartialOwnedAgent,
  type RemoteOwnedStellarAgent,
  type ResumeState,
} from 'agentenact/create';
import type { SignRequestFailure, SignRequests } from '../account/sign-requests.js';
import { skipMissedSlots } from '../agents/index.js';
import type { Chain } from '../chain/index.js';
import { createMemoryLeases, type Leases } from '../db/leases.js';
import type { Db } from '../db/index.js';
import type { FeeModel } from '../config.js';
import { safeCause } from '../errors.js';
import type { AgentKeys } from '../keys/rpc.js';

export type ProvisionStep = 'pending' | 'key_ready' | 'creating' | 'active' | 'failed';
export type FailureCode =
  | 'owner_rejected'
  | 'owner_timeout'
  | 'no_owner_wallet'
  | 'agent_limit'
  /** The account started more sponsored attempts in the last 24 hours than `limits.sponsoredStartsPerDay`. Retryable later. */
  | 'sponsor_limit'
  | 'chain_error'
  /** The sponsor lock was not free in time (chain `chain_busy`): contention, visible as such. */
  | 'chain_busy'
  | 'interrupted'
  /**
   * Our own sign-request service refused the request provision made (`signer_not_owner`, `agent_not_owned`,
   * `validity_too_long`): a config or code bug, never the owner. Kept apart from chain_error so it shows.
   */
  | 'sign_request_refused'
  /** The registry shows OUR key bound under an owner that is not the user's wallet: an operator case. Never rotated. */
  | 'bound_foreign_owner'
  /** The library refused a resume because the chain did not match what we stated. Never resumed again: the next start rotates. */
  | 'resume_mismatch';

export interface Attempt {
  n: number;
  publicKey: string;
  startedAt: string;
  outcome?: 'active' | 'failed';
  code?: FailureCode;
  txs?: { account?: string; register?: string; bind?: string };
  agentId?: string;
  /** The ledger the owner's bind authorisation expires at: after it, no bind under this key can land. */
  bindValidUntil?: number;
  /** This attempt continued an earlier one with the same key (no new account); `txs` holds only what it sent itself. */
  resumed?: boolean;
}

/** An abandoned agent key and what may exist on chain under it (plan D10). Public data only. */
export interface Orphan {
  publicKey: string;
  attempt: number;
  txs: { account?: string; register?: string; bind?: string };
  agentId?: string;
}

export interface ProvisionState {
  step: ProvisionStep;
  attempts: Attempt[];
  error?: FailureCode;
  orphans?: Orphan[];
}

type Txs = { account?: string; register?: string; bind?: string };
/** Public data only: codes, tx hashes, the registry id. Never an error object, never a secret. */
export type ProvisionLog = (e: { event: string; agent: string; attempt?: number; code?: string; agentId?: string; txs?: Txs; resumed?: boolean; errName?: string; errCode?: string }) => void;

export interface ProvisionDeps {
  sql: Db;
  keys: Pick<AgentKeys, 'generate' | 'destroy' | 'publicKey' | 'agentSigner'>;
  chain: Pick<Chain, 'sponsor' | 'soroban' | 'horizonSubmit' | 'withSponsorLock' | 'identity' | 'accountExists'>;
  signRequests: Pick<SignRequests, 'request'>;
  publicBaseUrl: string;
  create?: (o: AuthOwnerRemoteOptions) => Promise<RemoteOwnedStellarAgent>;
  log?: ProvisionLog;
  /** Backoff unit between final-save retries (ms). Default 200: retries after 200, 400, 800 ms. */
  retryDelayMs?: number;
  /** Absent: PROVISION_LIMITS. */
  limits?: ProvisionLimits;
  /** One start per agent across replicas (db/leases.ts). Absent: this process only. */
  leases?: Leases;
  /** This process's instance id (db/replica.ts): written on an agent while it is `creating`, so recovery skips live work. */
  instance?: number;
  /** Who pays an agent's reserves and fees (config.ts FeeModel). Absent: 'agent'. */
  feeModel?: FeeModel;
}

/** Longer than any start (two owner prompts of up to 5 min each plus the chain); only bounds a holder that never releases. */
export const PROVISION_LEASE_MS = 30 * 60_000;

/**
 * Per account. `live` is the agents ceiling again (agents/index.ts settles it at insert; this is defence in depth).
 * `sponsoredStartsPerDay` bounds what one account makes the platform sponsor pay: every attempt of every one of its
 * agents in the last 24 hours counts (a fresh attempt is a new sponsored account, a resumed one still sends registry txs).
 * An account with app.users.agent_limit set (migration 0034) uses that as `live` and at least that as `sponsoredStartsPerDay`.
 */
export interface ProvisionLimits {
  live: number;
  sponsoredStartsPerDay: number;
}
export const PROVISION_LIMITS: ProvisionLimits = { live: 3, sponsoredStartsPerDay: 10 };

/** Why a start changed nothing: retried later. `registry_no_agent` that persists needs an operator. */
export type DeferCode = 'registry_unreadable' | 'registry_no_agent' | 'bind_window_open';

/**
 * What one `start` did, so the gateway can show it (carry-forward: deferrals save nothing).
 * `retryAfterLedger` / `retryAfter`: the bind window closes after that ledger / time; a retry before it defers again.
 */
export type StartOutcome =
  | { outcome: 'active' }
  | { outcome: 'failed'; code: FailureCode }
  | { outcome: 'deferred'; code: DeferCode; retryAfterLedger?: number; retryAfter?: string }
  /** Nothing to do: the agent is not provisioning, or a run is already creating it. */
  | { outcome: 'skipped' }
  /** A start for this agent is already running (in any replica). */
  | { outcome: 'busy' }
  /** A DB or key failure; the row shows the last saved step. */
  | { outcome: 'error' };

export interface Provisioner {
  start(agentUuid: string): Promise<StartOutcome>;
  recoverInterrupted(): Promise<number>;
}

interface Row {
  user_id: string;
  status: string;
  provision_state: ProvisionState;
  owner_address: string | null;
  agent_limit: number | null;
}

const kindOf = (entryXdr: string): 'register' | 'bind' => {
  const fn = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64').rootInvocation().function().contractFn().functionName().toString();
  if (fn === 'register_with_uri') return 'register';
  if (fn === 'set_agent_wallet') return 'bind';
  throw new Error('provision: the library asked the owner to sign an unexpected call');
};

/** The contract function a (possibly fee-bumped) single-op invoke tx calls, or null. */
const callName = (tx: Transaction | FeeBumpTransaction): string | null => {
  const inner = 'innerTransaction' in tx ? tx.innerTransaction : tx;
  const op = inner.operations[0] as { type?: string; func?: xdr.HostFunction } | undefined;
  if (inner.operations.length !== 1 || op?.type !== 'invokeHostFunction' || !op.func) return null;
  if (op.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return null;
  return op.func.invokeContract().functionName().toString();
};

/** Sign-request refusals that can only come from our own config or code, never from the owner or timing. */
const REFUSED: ReadonlySet<SignRequestFailure> = new Set<SignRequestFailure>(['signer_not_owner', 'agent_not_owned', 'validity_too_long']);

/**
 * Matched on `err.code`. The owner's outcomes and lock contention keep their own codes; a refusal of our
 * own request is sign_request_refused; everything else (already_expired, a chain failure) is chain_error.
 */
const codeOf = (e: unknown): FailureCode => {
  const code = (e as { code?: unknown } | null)?.code as SignRequestFailure | 'chain_busy' | 'resume_mismatch' | undefined;
  if (code === 'owner_rejected' || code === 'owner_timeout' || code === 'chain_busy' || code === 'resume_mismatch') return code;
  if (code !== undefined && REFUSED.has(code as SignRequestFailure)) return 'sign_request_refused';
  return 'chain_error';
};

/** set_agent_wallet(owner, agentId: u32, wallet): the registry id the owner is asked to bind. */
const bindAgentId = (entryXdr: string): string =>
  String(xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64').rootInvocation().function().contractFn().args()[1]!.u32());

const publicTxs = (t: Txs): Txs => ({
  ...(t.account ? { account: t.account } : {}),
  ...(t.register ? { register: t.register } : {}),
  ...(t.bind ? { bind: t.bind } : {}),
});

const FINAL_SAVE_RETRIES = 3;
/** Without a recorded bind expiry, an unbound attempt is rotated only this long after it started. Safe only because (d) never prompts a bind before bindValidUntil is saved. */
const BIND_TIME_FLOOR_MS = 15 * 60_000;

/** Something is known to exist on chain under the attempt's key (or may, if interrupted): never reuse it. */
const needsFreshKey = (a: Attempt) => !!a.txs?.account || a.code === 'interrupted';

export function createProvisioner(d: ProvisionDeps): Provisioner {
  const create =
    d.create ??
    ((o: AuthOwnerRemoteOptions) => createStellarAgent(o));
  const log: ProvisionLog = d.log ?? (() => undefined);
  const leases = d.leases ?? createMemoryLeases();
  const retryDelayMs = d.retryDelayMs ?? 200;
  const limits = d.limits ?? PROVISION_LIMITS;

  // jsonb params are plain objects (verified facts): JSON.stringify(...)::jsonb would store a string.
  async function save(id: string, state: ProvisionState, extra: { status?: string; stellarAddress?: string; agentId?: string } = {}) {
    await d.sql`update app.agents set
                  provision_state = ${state},
                  status = coalesce(${extra.status ?? null}, status),
                  stellar_address = coalesce(${extra.stellarAddress ?? null}, stellar_address),
                  agent_id = coalesce(${extra.agentId ?? null}, agent_id),
                  updated_at = now()
                where id = ${id}`;
  }

  /**
   * The success save: only a row still provisioning becomes live (a revoked agent stays revoked). Under FEE_MODEL=agent
   * an agent that has not bought its reserves yet is born paused: the reserve worker resumes it at its first funding.
   */
  async function saveActive(id: string, state: ProvisionState, agentId: string) {
    const waits = (d.feeModel ?? 'agent') === 'agent';
    // Same transaction as the flip, so the scheduler never claims a slot that passed while provisioning ran.
    await d.sql.begin(async (tx) => {
      const done = (await tx`update app.agents set provision_state = ${state}, agent_id = ${agentId}, updated_at = now(),
                               status = case when ${waits} and reserve_state = 'due' then 'paused' else 'active' end,
                               paused_for_funds = ${waits} and reserve_state = 'due'
                             where id = ${id} and status = 'provisioning' returning status`) as { status: string }[];
      if (done[0]?.status === 'active') await skipMissedSlots(tx as unknown as Db, id);
    });
  }

  /** A final save is retried: losing it would leave the row `creating` and the outcome unknown. */
  async function retried(write: () => Promise<void>) {
    for (let i = 0; ; i++) {
      try {
        return await write();
      } catch (e) {
        if (i >= FINAL_SAVE_RETRIES) throw e;
        await Bun.sleep(retryDelayMs * 2 ** i);
      }
    }
  }

  /**
   * True once no bind authorisation of `a` can still land. Judged by `seenAt`, the ledger of the very
   * simulation that reported "not our key" (never a separate latest-ledger read: a lagging RPC node
   * could miss a bind that landed before the window closed).
   */
  function bindWindowClosed(a: Attempt, seenAt: number): boolean {
    if (a.bindValidUntil !== undefined) return seenAt > a.bindValidUntil;
    // Valid only because (d) guarantees no bind prompt was ever sent for a row without bindValidUntil.
    return Date.now() > Date.parse(a.startedAt) + BIND_TIME_FLOOR_MS;
  }

  async function run(id: string): Promise<StartOutcome> {
    const rows = (await d.sql`select a.user_id, a.status, a.provision_state, u.owner_address, u.agent_limit
                              from app.agents a join app.users u on u.id = a.user_id where a.id = ${id}`) as Row[];
    const row = rows[0];
    if (!row || row.status !== 'provisioning') return { outcome: 'skipped' };
    const state = row.provision_state;
    if (state.step === 'active' || state.step === 'creating') return { outcome: 'skipped' };
    if (state.error === 'bound_foreign_owner') return { outcome: 'failed', code: 'bound_foreign_owner' }; // operator case: never touched automatically
    const owner = row.owner_address;
    if (!owner) {
      await save(id, { ...state, step: 'failed', error: 'no_owner_wallet' });
      return { outcome: 'failed', code: 'no_owner_wallet' };
    }
    // The account's ceiling. The create transaction normally prevents an agent over it; this guard keeps one from
    // reaching a key or a chain call regardless. Only agents made before this one count, so the newest is the one refused.
    const others = (await d.sql`select count(*)::int as n from app.agents o
                                where o.user_id = ${row.user_id} and o.id <> ${id} and o.status <> 'revoked'
                                  and (o.created_at, o.id) < (select created_at, id from app.agents where id = ${id})`) as { n: number }[];
    if (others[0]!.n >= (row.agent_limit ?? limits.live)) {
      await save(id, { ...state, step: 'failed', error: 'agent_limit' });
      return { outcome: 'failed', code: 'agent_limit' };
    }
    // What this account had the sponsor pay for today, across all its agents, before anything new is sent.
    const [started] = (await d.sql`select count(*)::int as n from app.agents a, jsonb_array_elements(a.provision_state->'attempts') e
                                   where a.user_id = ${row.user_id} and (e->>'startedAt')::timestamptz > now() - interval '1 day'`) as { n: number }[];
    if (started!.n >= Math.max(limits.sponsoredStartsPerDay, row.agent_limit ?? 0)) {
      await save(id, { ...state, step: 'failed', error: 'sponsor_limit' });
      return { outcome: 'failed', code: 'sponsor_limit' };
    }

    let publicKey = await d.keys.publicKey(id);
    const last = state.attempts.at(-1);
    // Only the key the last attempt used can have anything on chain. A live key that differs was
    // generated after that one was retired and never used: it is reused, never destroyed.
    let resume: ResumeState | undefined;
    if (publicKey && state.step === 'failed' && last && last.publicKey === publicKey) {
      // The owner never signed: nothing of that step was sent, so the key can continue. Any other code rotates as before.
      const ownerStalled = last.outcome === 'failed' && (last.code === 'owner_timeout' || last.code === 'owner_rejected');
      // The run may have gone further than the row says (a lost final save). Once a registry id is
      // known a bind may exist, so the key is rotated only on a DEFINITE answer that it is not ours.
      let rotate = needsFreshKey(last);
      if (last.agentId) {
        const defer = (code: DeferCode, when: { retryAfterLedger?: number; retryAfter?: string } = {}): StartOutcome => {
          log({ event: 'provision_deferred', agent: id, attempt: last.n, agentId: last.agentId, code });
          return { outcome: 'deferred', code, ...when };
        };
        let onChain: Awaited<ReturnType<ProvisionDeps['chain']['identity']>>;
        try {
          onChain = await d.chain.identity(last.agentId);
        } catch {
          return defer('registry_unreadable');
        }
        if (!onChain) return defer('registry_no_agent'); // we saw this id registered: an empty answer is not definite
        if (onChain.wallet === publicKey) {
          if (onChain.owner === owner) {
            last.outcome = 'active';
            delete last.code;
            delete state.error;
            state.step = 'active';
            log({ event: 'provision_recovered', agent: id, attempt: last.n, agentId: last.agentId, ...(last.txs ? { txs: publicTxs(last.txs) } : {}) });
            await retried(() => saveActive(id, state, last.agentId!));
            return { outcome: 'active' };
          }
          state.error = 'bound_foreign_owner';
          log({ event: 'provision_failed', agent: id, attempt: last.n, agentId: last.agentId, code: state.error });
          await retried(() => save(id, state));
          return { outcome: 'failed', code: 'bound_foreign_owner' };
        }
        // Not bound to our key (as of onChain.ledger): rotate only once our bind authorisation can no longer land.
        if (!bindWindowClosed(last, onChain.ledger)) {
          return defer(
            'bind_window_open',
            last.bindValidUntil !== undefined
              ? { retryAfterLedger: last.bindValidUntil + 1 }
              : { retryAfter: new Date(Date.parse(last.startedAt) + BIND_TIME_FLOOR_MS).toISOString() },
          );
        }
        // stellar-8004 sets a new identity's wallet to its owner, so "unbound" is no wallet or wallet = owner.
        if (ownerStalled && onChain.owner === owner && (onChain.wallet === null || onChain.wallet === owner)) {
          resume = { account: true, agentId: last.agentId };
          rotate = false;
        } else {
          rotate = true;
        }
      }
      let exists: boolean | undefined;
      const accountThere = async () => (exists ??= await d.chain.accountExists(publicKey!));
      // No registry id: the register step was never sent, so a Horizon-confirmed account is all there is to continue from.
      // A recorded register hash without an id is unknown territory (that resume would register again): rotate.
      if (ownerStalled && !last.agentId && !last.txs?.register && (await accountThere())) {
        resume = { account: true };
        rotate = false;
      }
      // tx 1 may have landed although its submit reported a failure: Horizon decides.
      if (!resume && (rotate || (await accountThere()))) {
        // Record the abandoned key before destroying it, so the orphan stays visible on the agent row.
        // If an earlier run saved the orphan but failed to destroy, do not record it twice.
        if (!state.orphans?.some((o) => o.publicKey === last.publicKey && o.attempt === last.n)) {
          (state.orphans ??= []).push({
            publicKey: last.publicKey,
            attempt: last.n,
            txs: last.txs ?? {},
            ...(last.agentId ? { agentId: last.agentId } : {}),
          });
          await save(id, state);
        }
        await d.keys.destroy(id);
        publicKey = null;
      }
    }
    if (!publicKey) publicKey = (await d.keys.generate(id)).publicKey;
    delete state.error;
    state.step = 'key_ready';
    await save(id, state, { stellarAddress: publicKey });

    const attempt: Attempt = {
      n: state.attempts.length + 1,
      publicKey,
      startedAt: new Date().toISOString(),
      ...(resume ? { resumed: true } : {}),
      // Earlier hashes stay on the record, so an orphan of this key still names its account tx. Display only:
      // the key is judged by the chain and by `code`, never by whether these were sent in this call.
      ...(resume && last?.txs ? { txs: publicTxs({ account: last.txs.account, register: last.txs.register }) } : {}),
      // A resumed attempt inherits the registry id and the (already closed) bind window of the one it continues.
      ...(resume?.agentId ? { agentId: resume.agentId, ...(last?.bindValidUntil !== undefined ? { bindValidUntil: last.bindValidUntil } : {}) } : {}),
    };
    state.attempts.push(attempt);
    state.step = 'creating';
    // The owner first: a `creating` row whose instance is dead is recovered as interrupted (recoverInterrupted).
    await d.sql`update app.agents set provision_instance = ${d.instance ?? null} where id = ${id}`;
    await save(id, state);
    log({ event: 'provision_started', agent: id, attempt: attempt.n, ...(resume ? { resumed: true } : {}) });

    /**
     * Before the owner is asked to bind, the registry id and the bind expiry MUST be on the row: they are
     * what later decides whether this key may ever be rotated. If that save fails, the prompt never goes
     * out: the throw happens before anything is sent, and the library attaches its partial.
     */
    const noteBindProgress = async (entryXdr: string, validUntilLedger: number) => {
      attempt.agentId = bindAgentId(entryXdr);
      attempt.bindValidUntil = validUntilLedger;
      try {
        await save(id, state);
      } catch {
        throw new Error('provision: progress_save_failed');
      }
    };

    /**
     * The register tx hash, as provision's own seam sent it: the bind request hands it to the browser,
     * which reads that tx itself to learn the registry id. Public data only.
     */
    let registerTx: string | undefined;
    const soroban = {
      ...d.chain.soroban,
      async send(tx: Parameters<typeof d.chain.soroban.send>[0]) {
        const sent = await d.chain.soroban.send(tx);
        if (callName(tx) === 'register_with_uri') registerTx = sent.hash;
        return sent;
      },
    };

    // Only the library call is inside the try: a failing save below must never be mistaken for a chain failure.
    let born: RemoteOwnedStellarAgent | undefined;
    let failure: unknown;
    try {
      born = await create({
        network: 'stellar:testnet',
        owner: {
          address: owner,
          signAuthEntry: async (entryXdr, validUntilLedger, networkPassphrase) => {
            const kind = kindOf(entryXdr);
            if (kind === 'bind') await noteBindProgress(entryXdr, validUntilLedger);
            return d.signRequests.request({
              userId: row.user_id,
              agentId: id,
              kind,
              entryXdr,
              validUntilLedger,
              networkPassphrase,
              ...(kind === 'bind' && registerTx ? { registerTx } : {}),
            });
          },
        },
        sponsor: d.chain.sponsor,
        agentUri: `${d.publicBaseUrl}/a/${id}/agent.json`,
        agentSigner: d.keys.agentSigner(id, publicKey),
        soroban,
        horizonSubmit: (x) => d.chain.horizonSubmit(x),
        // One hold per sponsor-sourced tx; the library keeps the owner's passkey wait outside it.
        sponsorLock: (work) => d.chain.withSponsorLock(work),
        ...(resume ? { resume } : {}),
      });
    } catch (err) {
      failure = err;
    }

    if (born) {
      attempt.outcome = 'active';
      attempt.txs = publicTxs({ ...attempt.txs, ...publicTxs(born.txs) });
      attempt.agentId = born.agentId;
      state.step = 'active';
      log({ event: 'provision_active', agent: id, attempt: attempt.n, agentId: born.agentId, txs: publicTxs(attempt.txs) });
      await retried(() => saveActive(id, state, born.agentId));
      return { outcome: 'active' };
    }

    // Read only the public fields of the partial. Never log, store or rethrow the error.
    const partial = (failure as { partial?: PartialOwnedAgent } | null)?.partial;
    attempt.outcome = 'failed';
    attempt.code = codeOf(failure);
    if (partial) {
      attempt.txs = publicTxs({ ...attempt.txs, ...publicTxs(partial.txs) });
      if (partial.agentId) attempt.agentId = partial.agentId;
    }
    state.step = 'failed';
    state.error = attempt.code;
    log({
      event: 'provision_failed',
      agent: id,
      attempt: attempt.n,
      code: attempt.code,
      ...(attempt.agentId ? { agentId: attempt.agentId } : {}),
      ...(attempt.txs ? { txs: attempt.txs } : {}),
    });
    await retried(() => save(id, state));
    return { outcome: 'failed', code: attempt.code };
  }

  return {
    async start(id) {
      let release: (() => Promise<void>) | null;
      try {
        release = await leases.take(`provision:${id}`, PROVISION_LEASE_MS);
      } catch (e) {
        log({ event: 'provision_error', agent: id, ...safeCause(e) });
        return { outcome: 'error' };
      }
      if (!release) return { outcome: 'busy' };
      try {
        return await run(id);
      } catch (e) {
        // DB or key failure before or after the chain call; the state shows the last saved step. Only the class name and a
        // pattern-checked code are logged (safeCause): never the error itself, which may be a createStellarAgent error with the key.
        log({ event: 'provision_error', agent: id, ...safeCause(e) });
        return { outcome: 'error' };
      } finally {
        await release().catch(() => undefined); // a failed delete still expires with the lease
      }
    },

    async recoverInterrupted() {
      const rows = (await d.sql`select id, provision_state from app.agents
                                where status = 'provisioning' and provision_state->>'step' = 'creating'
                                  and not app.instance_alive(provision_instance)`) as { id: string; provision_state: ProvisionState }[];
      for (const r of rows) {
        const s = r.provision_state;
        const last = s.attempts.at(-1);
        if (last && !last.outcome) {
          last.outcome = 'failed';
          last.code = 'interrupted';
        }
        s.step = 'failed';
        s.error = 'interrupted';
        await save(r.id, s);
        await d.sql`update app.sign_requests set status = 'expired' where agent_id = ${r.id} and status = 'pending'`;
        log({ event: 'provision_interrupted', agent: r.id });
      }
      return rows.length;
    },
  };
}
