/**
 * The browser's whole decision for one sign request. Nothing reaches the passkey unless every step passes:
 * network → (bind: agent id from chain) → checkEntry → simulate → (ledger + signer read) → confirm → clamp → sign
 * → verify what the wallet returned.
 *
 * Carrying the registration to the bind (carry-forward, Task 10): the caller passes it back in as
 * `ctx.registered` = the register `Approval` this module returned. This module holds no state: the
 * gate is a pure function of its inputs, it is testable, and the UI can persist the approval across
 * a reload between the two approvals (module state could not). With no `registered`, a bind is
 * refused. The register tx hash comes from the bind request's `registerTx` (the server's pointer)
 * unless the caller supplies one; registry.ts accepts it only if that tx carries the owner's own
 * signed entry.
 *
 * unset_agent_wallet: PublicSignRequest has no 'unset' kind, so such an entry is refused here as a
 * kind mismatch. When that kind is added, its agent id must come from the caller's own selection
 * (a ctx field), never from the request.
 */
import { cancelledError, isPasskeyCancel, isRetryable, retryableError } from './errors.js';
import { checkEntry, type AllowedCall } from './check.js';
import { registeredAgentId, type RegistryRpc } from './registry.js';
import { simulateEntry } from './simulate.js';
import { TESTNET } from './testnet.js';
import type { PublicSignRequest } from './types.js';
import { xdr } from '@stellar/stellar-sdk';

/**
 * Signature lifetime the browser grants, in ledgers past its own latest ledger (30 × ~5 s ≈ 150 s).
 * After the owner signs, provision still has to take the sponsor lock to build the tx that carries the
 * entry: that wait is capped at 120 s (chain/lock.ts DEFAULT_ACQUIRE_TIMEOUT_MS), and the holder ahead
 * may be a wallet deploy with a 120 s lease (chain DEPLOY_LEASE_MS). 30 ledgers cover the 120 s cap
 * plus build and submit time, so a signature never expires while its tx waits in line. It stays well
 * under what the server asks for (latest + 100), and the server accepts any expiry up to that.
 */
export const MAX_SIGNATURE_LEDGERS = 30;

/**
 * The press must reach the passkey prompt without a network round trip (WebKit drops the user gesture across one), so the
 * ledger is read before the owner is asked and kept fresh while the question is open. After the press the browser only
 * extrapolates from its own clock. Ledgers close about every 5 s; 6 s per ledger under-counts, which only shortens the
 * window slightly and can never grant more than the server allows.
 */
const ASSUMED_LEDGER_MS = 6000;
/** How often the ledger is re-read while the question is open. */
const LEDGER_REFRESH_MS = 20_000;
/** A read older than this is not extrapolated from (the refreshes failed): one fresh read after the press. */
const LEDGER_TRUST_MS = 60_000;
/** A passkey prompt that fails faster than this never showed anything (Safari without a press): not a cancel by the owner. */
const INSTANT_FAILURE_MS = 300;

export interface OwnerWallet {
  /** The connected wallet (C…), as the kit verified it on chain. */
  address: string;
  /**
   * Does every network read signing needs (the signer on the wallet's context rule), so that `signEntry` itself touches no
   * network. Called before the owner is asked: Safari only lets a passkey prompt open within a moment of the press.
   */
  prepare?(): Promise<void>;
  signEntry(entryXdr: string, validUntilLedger: number): Promise<string>;
}

/** rpc.Server satisfies this structurally. */
export interface OwnerRpc extends RegistryRpc {
  getLatestLedger(): Promise<{ sequence: number }>;
}

export interface Approval {
  signedEntryXdr: string;
  summary: string;
  call: AllowedCall;
}

/**
 * Trust sources. `rpc` must be a third-party Soroban RPC endpoint the web app is compiled with,
 * never one proxied through our API: every check here is only as independent as that endpoint.
 * `registered` (the register Approval and its tx hash) must come only from the browser's own
 * storage of what this module returned, never from an API response.
 */
export interface ApproveContext {
  /** Third-party RPC, never proxied through our API. */
  rpc: OwnerRpc;
  /** Compiled into the web app, never taken from the server. */
  uriPrefix: string;
  registry?: string;
  passphrase?: string;
  /** Required: shows the plain-words summary; resolves false when the owner declines. */
  confirm: (summary: string) => Promise<boolean>;
  /**
   * For a bind: the register Approval this module returned, from browser storage only, never the API.
   * `txHash` (the tx it was submitted in) defaults to the request's `registerTx`: a pointer the
   * server may supply, accepted only if that tx carries this very approval.
   */
  registered?: { approval: Approval; txHash?: string };
  /** Epoch ms; tests inject it. */
  now?: () => number;
  /** How often the ledger is re-read while the question is open (default 20 s); tests inject a short one. */
  ledgerRefreshMs?: number;
}

async function readLatest(rpc: OwnerRpc): Promise<number> {
  let sequence: number;
  try {
    sequence = (await rpc.getLatestLedger()).sequence;
  } catch {
    throw retryableError('cannot read the latest ledger');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw retryableError('cannot read the latest ledger');
  return sequence;
}

/** smart-account-kit's `ValidationError` (errors.d.ts), matched by name like the passkey cancel: no import of the kit here. */
const isKitValidationError = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ValidationError';

export async function approveSignRequest(req: PublicSignRequest, wallet: OwnerWallet, ctx: ApproveContext): Promise<Approval> {
  const passphrase = ctx.passphrase ?? TESTNET.passphrase;
  const registry = ctx.registry ?? TESTNET.registry;
  const refuse = (reason: string) => new Error(`refused: ${reason}`);
  if (req.networkPassphrase !== passphrase) throw refuse('wrong network');
  if (!Number.isSafeInteger(req.validUntilLedger) || req.validUntilLedger <= 0) throw refuse('the request has an invalid expiry');

  let agentId: number | undefined;
  if (req.kind === 'bind') {
    const reg = ctx.registered;
    if (!reg || reg.approval.call.fn !== 'register_with_uri' || reg.approval.call.owner !== wallet.address) {
      throw refuse('there is no registration you approved to bind');
    }
    const txHash = reg.txHash ?? req.registerTx;
    if (!txHash) throw refuse('the bind names no registration tx');
    const found = await registeredAgentId(
      { signedEntryXdr: reg.approval.signedEntryXdr, agentUri: reg.approval.call.agentUri, txHash },
      { rpc: ctx.rpc, owner: wallet.address, registry, source: req.source, passphrase },
    );
    if (!found.ok) throw found.retryable ? retryableError(found.reason) : refuse(found.reason);
    agentId = found.agentId;
  }

  const checked = checkEntry(req.entryXdr, {
    owner: wallet.address,
    registry,
    uriPrefix: ctx.uriPrefix,
    agentWallet: req.agentWallet,
    ...(agentId === undefined ? {} : { agentId }),
  });
  if (!checked.ok) throw refuse(checked.reason);
  const expectedFn = req.kind === 'register' ? 'register_with_uri' : 'set_agent_wallet';
  if (checked.call.fn !== expectedFn) throw refuse(`the request says ${req.kind} but the entry is ${checked.call.fn}`);

  const sim = await simulateEntry(req.entryXdr, {
    rpc: ctx.rpc,
    source: req.source,
    passphrase,
    // A bind's simulation can fail only because the node has not seen the new agent yet: same lag, so retry.
    anyErrorRetryable: req.kind === 'bind',
  });
  if (!sim.ok) throw sim.retryable ? retryableError(sim.reason) : refuse(sim.reason);

  // Everything the passkey step needs from the network is read now, before the owner is asked, and the ledger is kept
  // fresh while the question is open. After the press there is no await on the network before the passkey prompt.
  const now = ctx.now ?? Date.now;
  let seen: { sequence: number; at: number };
  try {
    const [sequence] = await Promise.all([readLatest(ctx.rpc), wallet.prepare?.()]);
    seen = { sequence, at: now() };
  } catch (e) {
    if (isRetryable(e)) throw e;
    throw retryableError(`the wallet could not get ready (${e instanceof Error ? e.message : 'unknown error'})`);
  }
  const refresh = setInterval(() => {
    readLatest(ctx.rpc).then(
      (sequence) => {
        if (sequence >= seen.sequence) seen = { sequence, at: now() };
      },
      () => undefined, // the next tick, or the read after the press, tries again
    );
  }, ctx.ledgerRefreshMs ?? LEDGER_REFRESH_MS);
  let confirmed: boolean;
  try {
    confirmed = await ctx.confirm(checked.summary);
  } finally {
    clearInterval(refresh);
  }
  if (!confirmed) throw refuse('you declined');

  // Clamp, never refuse a long expiry: grant at most MAX_SIGNATURE_LEDGERS past the ledger the browser now believes is the
  // latest. Normally that is the last read plus what the clock says has closed since; a stale read is replaced by a fresh one.
  const closed = (at: number) => Math.floor(Math.max(0, now() - at) / ASSUMED_LEDGER_MS);
  let latest = seen.sequence + closed(seen.at);
  if (now() - seen.at > LEDGER_TRUST_MS || req.validUntilLedger <= latest) latest = await readLatest(ctx.rpc);
  const validUntilLedger = Math.min(req.validUntilLedger, latest + MAX_SIGNATURE_LEDGERS);
  if (validUntilLedger <= latest) throw refuse('the request has expired');

  // A closed passkey prompt is a cancel, not a refusal: nothing was signed, the request stays pending.
  let signedEntryXdr: string;
  const askedAt = now();
  try {
    signedEntryXdr = await wallet.signEntry(req.entryXdr, validUntilLedger);
  } catch (e) {
    if (isPasskeyCancel(e)) {
      // Refused before any prompt could have been shown: the press did not count as a gesture. Not the owner's doing.
      if (now() - askedAt < INSTANT_FAILURE_MS) throw retryableError('the passkey prompt did not open');
      throw cancelledError('the passkey prompt was closed');
    }
    // The kit's own input check (wrong account, bad entry) is final. Anything else (an RPC failure while it reads the
    // context rule, a 429, a timeout) happened before anything was signed: leave the request pending and try again.
    if (isKitValidationError(e)) throw e;
    throw retryableError(`the wallet could not sign (${e instanceof Error ? e.message : 'unknown error'})`);
  }

  // The signer crossed an SDK boundary; accept only the approved call at the approved expiry.
  let same = false;
  try {
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(signedEntryXdr, 'base64');
    const asked = xdr.SorobanAuthorizationEntry.fromXDR(req.entryXdr, 'base64');
    const c = signed.credentials().address();
    same =
      signed.rootInvocation().toXDR('base64') === asked.rootInvocation().toXDR('base64') &&
      c.address().toXDR('base64') === asked.credentials().address().address().toXDR('base64') &&
      c.nonce().toString() === asked.credentials().address().nonce().toString() &&
      c.signatureExpirationLedger() === validUntilLedger;
  } catch {
    same = false;
  }
  if (!same) throw refuse('the wallet returned a different signature than approved');

  return { signedEntryXdr, summary: checked.summary, call: checked.call };
}
