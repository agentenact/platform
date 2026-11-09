/**
 * `chain`: the only unit that reads SPONSOR_SECRET (sponsor.ts; in production only the vault process does). One
 * testnet sponsor sources, pays and sponsors every platform transaction. Its sequence number is guarded by a lease lock (plan D9) that the library
 * takes explicitly through `sponsorLock` (= `withSponsorLock`): one hold per sponsor-sourced tx, from the
 * account read until the submit returned or failed. The seams below are plain RPC/Horizon calls.
 */
import { Account, Address, BASE_FEE, Contract, StrKey, TransactionBuilder, nativeToScVal, rpc, xdr, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import type { SorobanSeam, StellarSigner } from 'agentenact/create';
import { TESTNET } from '../owner-client/testnet.js';
import type { RegistrationResponse } from '../owner-client/types.js';
import { DEFAULT_ACQUIRE_TIMEOUT_MS, chainBusy, createLeaseLock, type CrossLock } from './lock.js';
import { createSponsorPolicy, DEFAULT_MAX_FEE_STROOPS, sponsorFromEnv } from './sponsor.js';
import { defaultKitFactory, deployWithKit, type DeployedWallet, type KitFactory } from './wallet.js';

export interface ChainRpc {
  getAccount(id: string): Promise<Account>;
  simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getLatestLedger(): Promise<{ sequence: number }>;
  pollTransaction(hash: string, opts?: { attempts?: number }): Promise<rpc.Api.GetTransactionResponse>;
}

export interface ChainOptions {
  /** WebAuthn rp id and app origin, used by deployPasskeyWallet. */
  rpId: string;
  origin: string;
  /** Every accepted web origin (see deployWithKit: the kit's allowedOrigins). */
  origins?: readonly string[];
  env?: Record<string, string | undefined>;
  rpc?: ChainRpc;
  fetch?: typeof fetch;
  leaseMs?: number;
  /** Cap on the wait for the sponsor lock; past it a build fails with `chain_busy`. Default 120 s. */
  acquireTimeoutMs?: number;
  /** Serialises the sponsor across replicas (createAdvisoryCrossLock). Absent: this process only (tests, local dev). */
  crossLock?: CrossLock;
  /** Total-fee cap per sponsor-signed tx, in stroops. Default 1,000,000,000 (100 XLM). */
  maxFeeStroops?: bigint;
  /**
   * The sponsor as a remote signer (the vault), used when SPONSOR_PUBLIC_KEY is set. Otherwise SPONSOR_SECRET is
   * read from this process's environment (tests, local dev, and the api until the move).
   */
  remoteSponsor?: (publicKey: string) => StellarSigner;
  /** Test seam for the smart-account-kit constructor. */
  createKit?: KitFactory;
}

export interface Chain {
  readonly sponsorPublicKey: string;
  /** Whether the sponsor key is held elsewhere (the vault) rather than in this process. */
  readonly sponsorIsRemote: boolean;
  readonly sponsor: StellarSigner;
  readonly soroban: SorobanSeam;
  horizonSubmit(txXdr: string): Promise<{ hash: string }>;
  withSponsorLock<T>(fn: () => Promise<T>, leaseMs?: number): Promise<T>;
  /** Deploys the owner's passkey smart wallet, sponsor as deployer and fee payer, under the sponsor lock. */
  deployPasskeyWallet(response: RegistrationResponse, userName: string): Promise<DeployedWallet>;
  /**
   * The registry's record of agent `agentId`: its owner and wallet, or null if no such agent exists.
   * stellar-8004 sets a new agent's wallet to its owner at registration, so an unbound agent reads
   * `wallet === owner` (null only if the registry ever returns none); only another address is a bind. Throws if the registry cannot be read: never mistake "unknown" for "absent".
   * `ledger` is the ledger the answer is as fresh as: the lower `latestLedger` of the simulations behind it.
   */
  identity(agentId: string): Promise<{ owner: string; wallet: string | null; ledger: number } | null>;
  /** Whether a classic account exists, from Horizon. Throws on anything but 200/404. */
  accountExists(accountId: string): Promise<boolean>;
}

/** Lease of a wallet deploy (submit + poll, ~6-13 s on testnet). Wait cap + this < passkey STALE_CLAIM_MS. */
export const DEPLOY_LEASE_MS = 120_000;

export function createChain(opts: ChainOptions): Chain {
  const env = opts.env ?? process.env;
  const maxFee = opts.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;
  // The sponsor key lives in the vault when SPONSOR_PUBLIC_KEY names it; otherwise this process holds it.
  // Either way the same policy runs here first, so a refusal never costs a vault call.
  const remoteKey = env.SPONSOR_PUBLIC_KEY;
  if (remoteKey !== undefined && remoteKey !== '' && (!StrKey.isValidEd25519PublicKey(remoteKey) || !opts.remoteSponsor)) {
    throw new Error('chain: SPONSOR_PUBLIC_KEY must be a G-address, with the vault as signer');
  }
  const remote = remoteKey && opts.remoteSponsor ? opts.remoteSponsor(remoteKey) : null;
  const local = remote ? null : sponsorFromEnv(env, maxFee);
  const sponsorPublicKey = remote ? remoteKey! : local!.publicKey;
  const policy = local?.policy ?? createSponsorPolicy({ sponsorPublicKey, maxFeeStroops: maxFee });
  const signer: StellarSigner = remote ?? local!;
  const server: ChainRpc = opts.rpc ?? (new rpc.Server(TESTNET.rpcUrl) as unknown as ChainRpc);
  const doFetch = opts.fetch ?? fetch;
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const defaultLeaseMs = opts.leaseMs ?? 30_000;
  const lock = createLeaseLock(defaultLeaseMs, acquireTimeoutMs);
  const cross = opts.crossLock;

  const sponsor: StellarSigner = {
    publicKey: sponsorPublicKey,
    async signTransaction(txXdr, passphrase) {
      policy.check(txXdr, passphrase);
      return signer.signTransaction(txXdr, passphrase);
    },
  };

  // Plain RPC calls. Serialising the sponsor's sequence is the caller's job: provision passes
  // `withSponsorLock` to the library's `sponsorLock` option, which wraps each sponsor-sourced tx.
  const soroban: SorobanSeam = {
    getAccount: (id) => server.getAccount(id),
    async register() {
      throw new Error('chain: sponsor-mode registration is not used');
    },
    async send(tx) {
      const r = await server.sendTransaction(tx);
      if (r.status === 'ERROR' || r.status === 'TRY_AGAIN_LATER') {
        const detail = 'errorResult' in r && r.errorResult ? ` ${typeof r.errorResult === 'string' ? r.errorResult : r.errorResult.toXDR('base64')}` : '';
        throw new Error(`chain: sendTransaction returned ${r.status}${detail}`);
      }
      return { hash: r.hash };
    },
    async latestLedger() {
      return (await server.getLatestLedger()).sequence;
    },
    async prepare(tx) {
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new Error(`chain: simulation failed: ${sim.error}`);
      const prepared = rpc.assembleTransaction(tx, sim).build();
      return { prepared, auth: rpc.Api.isSimulationSuccess(sim) ? (sim.result?.auth ?? []) : [] };
    },
    async confirm(hash) {
      const done = await server.pollTransaction(hash, { attempts: 30 });
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error(`chain: transaction ${hash} did not succeed: ${done.status}`);
      return done.returnValue;
    },
  };

  async function horizonSubmit(txXdr: string) {
    const res = await doFetch(`${TESTNET.horizonUrl}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tx=${encodeURIComponent(txXdr)}`,
    });
    let j: { hash?: string; title?: string; extras?: { result_codes?: unknown } } = {};
    try {
      j = JSON.parse(await res.text());
    } catch {
      // non-JSON body (a proxy 5xx): keep the status
    }
    if (!res.ok || !j.hash) {
      throw new Error(`chain: Horizon submit failed: ${res.status} ${j.title ?? ''} ${JSON.stringify(j.extras?.result_codes ?? {})}`);
    }
    return { hash: j.hash };
  }

  async function withSponsorLock<T>(fn: () => Promise<T>, leaseMs?: number): Promise<T> {
    // Local FIFO first, then the replicas' lock. With replicas the local lease also covers the wait in Postgres, and the
    // lease ending (release or expiry) ends the cross-replica hold too.
    const started = Date.now();
    let unlock: (() => void) | undefined;
    let ended = false;
    const lease = cross ? (leaseMs ?? defaultLeaseMs) + acquireTimeoutMs : leaseMs;
    const release = await lock.acquire(lease, () => {
      ended = true;
      unlock?.();
    });
    if (cross) {
      try {
        const u = await cross.lock(Math.max(1, acquireTimeoutMs - (Date.now() - started)));
        if (ended) {
          u();
          throw chainBusy();
        }
        unlock = u;
      } catch (e) {
        release();
        throw e;
      }
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * A read-only registry view, simulated from a throwaway source account: no sequence, no lock.
   * Returns the retval, or `notFound` ONLY for the registry's AgentNotFound (`Error(Contract, #2)`).
   * Every other simulation error, and any transport failure, throws: unknown is never "absent".
   */
  const AGENT_NOT_FOUND = /^HostError: Error\(Contract, #2\)(\s|$)/;
  async function view(fn: string, agentId: number): Promise<{ retval: xdr.ScVal; ledger: number } | 'notFound'> {
    const tx = new TransactionBuilder(new Account(sponsorPublicKey, '0'), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(new Contract(TESTNET.registry).call(fn, nativeToScVal(agentId, { type: 'u32' })))
      .setTimeout(300)
      .build();
    let sim: rpc.Api.SimulateTransactionResponse;
    try {
      sim = await server.simulateTransaction(tx);
    } catch {
      throw new Error('chain: registry read failed');
    }
    if (rpc.Api.isSimulationError(sim)) {
      if (AGENT_NOT_FOUND.test(sim.error)) return 'notFound';
      throw new Error('chain: registry read failed');
    }
    if (!rpc.Api.isSimulationSuccess(sim) || !sim.result || !Number.isInteger(sim.latestLedger)) throw new Error('chain: registry read failed');
    return { retval: sim.result.retval, ledger: sim.latestLedger };
  }

  async function identity(agentId: string) {
    if (!/^\d+$/.test(agentId) || Number(agentId) > 0xffff_ffff) throw new Error('chain: bad agent id');
    const id = Number(agentId);
    // find_owner → Option<Address>: None (scvVoid) is the registry's "no such agent" (testnet, 2026-10-04).
    const o = await view('find_owner', id);
    if (o === 'notFound' || o.retval.switch() === xdr.ScValType.scvVoid()) return null;
    if (o.retval.switch() !== xdr.ScValType.scvAddress()) throw new Error('chain: registry read failed');
    const w = await view('get_agent_wallet', id);
    // The owner exists, so "not found" here is an inconsistent answer, not an absence.
    if (w === 'notFound' || (w.retval.switch() !== xdr.ScValType.scvAddress() && w.retval.switch() !== xdr.ScValType.scvVoid())) {
      throw new Error('chain: registry read failed');
    }
    return {
      owner: Address.fromScVal(o.retval).toString(),
      wallet: w.retval.switch() === xdr.ScValType.scvAddress() ? Address.fromScVal(w.retval).toString() : null,
      // Two simulations may hit nodes at different heights: the answer is only as fresh as the older one.
      ledger: Math.min(o.ledger, w.ledger),
    };
  }

  async function accountExists(accountId: string) {
    if (!StrKey.isValidEd25519PublicKey(accountId)) throw new Error('chain: bad account id');
    let res: Response;
    try {
      res = await doFetch(`${TESTNET.horizonUrl}/accounts/${accountId}`);
    } catch {
      throw new Error('chain: Horizon account read failed: network');
    }
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    throw new Error(`chain: Horizon account read failed: ${res.status}`);
  }

  const createKit = opts.createKit ?? defaultKitFactory;
  // The deploy submits and polls (~6-13 s on testnet); its lease is longer than a single build's.
  const deployPasskeyWallet = (response: RegistrationResponse, userName: string) =>
    withSponsorLock(() => deployWithKit({ deployer: sponsor, rpId: opts.rpId, origin: opts.origin, origins: opts.origins, response, userName, createKit }), DEPLOY_LEASE_MS);

  return { sponsorPublicKey, sponsorIsRemote: remote !== null, sponsor, soroban, horizonSubmit, withSponsorLock, deployPasskeyWallet, identity, accountExists };
}
