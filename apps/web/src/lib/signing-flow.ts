/**
 * The only door to the owner's passkey (spec §5.1). Every pending sign request the api lists goes
 * through approveSignRequest, the vendored gate: it decodes the entry, simulates it against the
 * third-party RPC this app is compiled with, shows a plain summary and only then asks the passkey.
 *
 * Trust sources: `rpc` and `uriPrefix` arrive from the app's own config (public-config.ts), never
 * from a request or an api response. The register approval a bind depends on comes only from
 * `store` (browser storage), never from the api. Nothing here fetches anything itself.
 */
import { approveSignRequest, type Approval, type OwnerRpc, type OwnerWallet } from '@/mirror/owner-client/approve';
import { cancelledError, isCancelled, isRetryable } from '@/mirror/owner-client/errors';
import type { PublicSignRequest } from '@/mirror/owner-client/types';

export type { Approval, OwnerRpc, OwnerWallet, PublicSignRequest };

export interface ApprovalStore {
  getRegistered(): { approval: Approval; txHash?: string } | null;
  setRegistered(v: { approval: Approval; txHash?: string }): void;
  /** Called once a bind has been delivered: the register approval is spent. */
  clearRegistered(): void;
}

export type ConfirmAnswer = 'yes' | 'later' | 'stop';

/** How long before a request's own expiry the owner is no longer asked: a press that late could not finish in time. */
export const EXPIRY_MARGIN_MS = 15_000;

/**
 * Optional doors that bound the owner's wait by the request's own `expiresAt`. Without them the confirm waits as long as the
 * owner takes (the gate itself still refuses an expired request). `after` is a cancellable timer, injected so tests need no clock.
 */
export interface ExpiryDeps {
  now(): number;
  after(ms: number): { done: Promise<void>; cancel(): void };
  marginMs?: number;
}

export interface SigningDeps {
  listPending(): Promise<PublicSignRequest[]>;
  /** A failure that carries the api's `status` and `code` lets the flow tell a definitive rejection from an ambiguous failure. */
  post(id: string, signedEntryXdr: string): Promise<void>;
  reject(id: string): Promise<void>;
  wallet: OwnerWallet;
  rpc: OwnerRpc;
  /**
   * `yes`: go on to the passkey. `later` ("Not now"): sign nothing and leave the request pending, like a closed
   * passkey prompt. `stop`: the owner does not want this agent; the request is rejected for real.
   */
  confirm(kind: 'register' | 'bind', technicalSummary: string): Promise<ConfirmAnswer>;
  store: ApprovalStore;
  uriPrefix: string;
  expiry?: ExpiryDeps;
  /** The gate's clock (epoch ms), for how long a passkey prompt stayed open; defaults to Date.now. Tests inject it. */
  now?: () => number;
}

/**
 * What happened to one request. Callers switch on this, never on the reason text.
 *   signed     delivered.
 *   refused    a policy check failed or the owner chose Stop: the request was rejected. Final.
 *   cancelled  the passkey prompt was closed or the owner chose "Not now": nothing signed, still pending. Ask the owner again.
 *   retry      the gate could not find out (RPC down or lagging) or the signature did not arrive: still pending, call again.
 *   other_tab  another tab is signing it: still pending, wait.
 *   expired    the owner did not answer before the request ran out (or it was already inside the safety margin): nothing
 *              signed, nothing rejected (the api expires it). The caller starts over with a fresh request.
 */
export type Outcome = 'signed' | 'refused' | 'cancelled' | 'retry' | 'other_tab' | 'expired';

export interface ProcessResult {
  signed: number;
  /** Every request that was not signed, with its typed outcome. `reason` is for people and logs only. */
  refused: { id: string; reason: string; outcome: Exclude<Outcome, 'signed'> }[];
}

/** The api said no to this exact entry (400 entry_mismatch): it was not recorded, so it can never reach a register tx. */
const isDefinitiveRejection = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 400 && (e as { code?: unknown }).code === 'entry_mismatch';

/** Thrown out of the confirm wait when the request's time ran out; identity-compared, never parsed. */
const EXPIRED = Object.freeze({ expired: true });

/** The owner's answer, or EXPIRED thrown when the request's time (less the margin) runs out first. */
async function confirmBefore(d: SigningDeps, req: PublicSignRequest, ask: () => Promise<ConfirmAnswer>): Promise<ConfirmAnswer> {
  const e = d.expiry;
  const end = Date.parse(req.expiresAt);
  if (!e || Number.isNaN(end)) return ask();
  const left = end - (e.marginMs ?? EXPIRY_MARGIN_MS) - e.now();
  if (!(left > 0)) throw EXPIRED;
  const timer = e.after(left);
  try {
    const first = await Promise.race([ask().then((answer) => ({ answer })), timer.done.then(() => undefined)]);
    if (!first) throw EXPIRED;
    return first.answer;
  } finally {
    timer.cancel();
  }
}

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : 'unknown error').replace(/^(refused|unavailable|cancelled): /, '');

/** Requests being processed right now (two tabs, or a poll overlapping a click, must not double-prompt). */
const inFlight = new Set<string>();

export async function processPending(d: SigningDeps): Promise<ProcessResult> {
  const out: ProcessResult = { signed: 0, refused: [] };
  for (const req of await d.listPending()) {
    await withRequestLock(req.id, () => processOne(d, req, out), () => out.refused.push({ id: req.id, reason: 'in another tab', outcome: 'other_tab' }));
  }
  return out;
}

/** One signer per request across tabs (Web Locks); the per-tab Set covers browsers without them. */
async function withRequestLock(id: string, run: () => Promise<void>, busy: () => void): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    let held = false;
    await locks.request(`ae-sign:${id}`, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      held = true;
      await run();
    });
    if (!held) busy();
    return;
  }
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    await run();
  } finally {
    inFlight.delete(id);
  }
}

async function processOne(d: SigningDeps, req: PublicSignRequest, out: ProcessResult): Promise<void> {
  let registered = d.store.getRegistered() ?? undefined;
  // A bind only counts the registration of its own agent, never one left over from another.
  if (req.kind === 'bind' && registered && registered.approval.call.fn === 'register_with_uri' && registered.approval.call.agentUri !== `${d.uriPrefix}${req.agentId}/agent.json`) {
    registered = undefined;
  }
  let approval: Approval;
  // The gate refuses an expired request only after reading the latest ledger, and only when that ledger has reached the
  // request's own `validUntilLedger`. Recording what it read lets us tell that refusal apart by type, never by text or clock.
  let latestSeen: number | undefined;
  const spy = new Proxy(d.rpc, {
    get(target, key) {
      const v = Reflect.get(target, key) as unknown;
      if (key === 'getLatestLedger') {
        return async () => {
          const r = await (v as OwnerRpc['getLatestLedger']).call(target);
          latestSeen = r.sequence;
          return r;
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  try {
    approval = await approveSignRequest(req, d.wallet, {
      rpc: spy,
      uriPrefix: d.uriPrefix,
      confirm: async (summary) => {
        const answer = await confirmBefore(d, req, () => d.confirm(req.kind, summary));
        // "Not now" is a cancel, not a refusal: rejecting would rotate the agent's key and cost a new registration.
        if (answer === 'later') throw cancelledError('not now');
        return answer === 'yes';
      },
      registered,
      ...(d.now ? { now: d.now } : {}),
    });
  } catch (e) {
    if (e === EXPIRED) {
      // Nothing was signed. The request is not rejected: the api lets it lapse, and Try again makes a fresh one.
      out.refused.push({ id: req.id, reason: 'expired', outcome: 'expired' });
      return;
    }
    if (isCancelled(e)) {
      // The owner backed out (closed the passkey prompt, or "Not now"). Nothing signed; leave it pending.
      out.refused.push({ id: req.id, reason: reasonOf(e), outcome: 'cancelled' });
      return;
    }
    if (isRetryable(e)) {
      // The gate could not find out (RPC down, or behind the api). Rejecting would rotate the agent's
      // key and cost a new registration, so leave it pending: the request's own TTL bounds the wait.
      out.refused.push({ id: req.id, reason: reasonOf(e), outcome: 'retry' });
      return;
    }
    if (typeof latestSeen === 'number' && latestSeen >= req.validUntilLedger) {
      // The request's ledger window closed while the owner decided. Nothing signed; an expired request needs no rejection.
      out.refused.push({ id: req.id, reason: 'expired', outcome: 'expired' });
      return;
    }
    out.refused.push({ id: req.id, reason: reasonOf(e), outcome: 'refused' });
    await d.reject(req.id).catch(() => undefined);
    return;
  }
  // Keep the register approval before sending: the bind that follows needs it even after a reload.
  let previous: { approval: Approval; txHash?: string } | null = null;
  if (approval.call.fn === 'register_with_uri') {
    try {
      previous = d.store.getRegistered();
      d.store.setRegistered({ approval });
    } catch {
      // Storage failed (quota, private mode): the bind could not be proven later, so do not send.
      out.refused.push({ id: req.id, reason: 'could not save the approval in this browser', outcome: 'retry' });
      return;
    }
  }
  try {
    await d.post(req.id, approval.signedEntryXdr);
    out.signed++;
  } catch (e) {
    // Only a definitive "this is not the entry we asked for" (400 entry_mismatch) proves the entry will never be in
    // the register tx, so only then put back what the store held. Anything else is ambiguous (network error, 5xx,
    // timeout, a lost response, a 409): the server may have recorded the signature and the register may still go out.
    // Keep the approval: the bind accepts it only if the register tx carries that exact signed entry.
    if (approval.call.fn === 'register_with_uri' && isDefinitiveRejection(e)) {
      try {
        if (previous) d.store.setRegistered(previous);
        else d.store.clearRegistered();
      } catch {
        // Best effort.
      }
    }
    // Leave the request pending so the owner can retry; do not reject it.
    out.refused.push({ id: req.id, reason: 'could not send the signature', outcome: 'retry' });
    return;
  }
  if (req.kind === 'bind') {
    try {
      d.store.clearRegistered();
    } catch {
      // Leftover approval is harmless: the bind is scoped to its agent and the registry says bound.
    }
  }
}
