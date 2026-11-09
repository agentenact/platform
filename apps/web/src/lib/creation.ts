/**
 * Agent creation in three taps (spec §5.1), as pure orchestration: an async generator over injected doors. Nothing here
 * touches WebAuthn, the network, a clock or storage itself, so the whole flow is tested with fakes.
 *
 *   1. account key: a passkey, only when the api says the owner has none (`ownerAddress` null). Safari only opens a passkey
 *      prompt from a press, and drops the press across a network wait: so the account and the passkey options are fetched first,
 *      the step then asks (a button), and the press goes straight to `startRegistration` with nothing awaited in between;
 *   2. POST /api/agents with the approved description and this creation's key (the same key again answers the same agent, so a
 *      lost answer is asked again); an agent page that joins a creation already under way names it in `resume` and skips this;
 *   3. poll the agent and its sign requests every 2 s; every request goes through `processPending`, the only gate;
 *   4. the agent turns `active`.
 *
 * Trust: the register approval the bind depends on lives only in the browser store the gate reads. Nothing in an api
 * response is ever written there or read as an approval.
 *
 * Retry policy. The brief caps registry lag at 3 retries; the carry-forward says retry until the request expires. Both hold:
 *   - "in another tab" waits until that request's own expiry (nothing is wrong, another tab is signing it);
 *   - any other retryable result (RPC lag, "cannot read", a signature that did not arrive) backs off 2 s, 4 s, 8 s (x poll) up
 *     to 3 times per request, then reports `chain` as retryable. The request stays pending, so "Try again" resumes it;
 *   - a provision that deferred on registry lag is re-started through POST /retry, also 3 times, then `chain`.
 */
import { EXPIRY_MARGIN_MS, processPending, type OwnerWallet, type ProcessResult, type PublicSignRequest, type SigningDeps } from '@/lib/signing-flow';
import type { AgentInfo, Out, WalletInfo } from '@/server/create-actions';

export type CreationStep = 'account_key' | 'identity' | 'ready';
/** `full`: the account holds as many agents as it may. `today`: it made (or had the sponsor start) as many as it may today. */
export type CreationFailure = 'cancelled' | 'stopped' | 'refused' | 'expired' | 'chain' | 'operator' | 'full' | 'waiting' | 'today' | 'unknown';
export type CreationEvent =
  | { step: CreationStep; state: 'working' | 'asking' | 'done' }
  /** `detail` names where it failed (`create 503`, `agent chain_error`): shown only under Technical details, never decides anything. */
  | { failed: CreationFailure; retryable: boolean; detail?: string }
  /** Epoch ms by which the question now on screen must be answered (the request's expiry less a safety margin). */
  | { approveBy: number }
  /** A press that did not go through and will be asked again (the gate's `retry`); `hiccup` is the plain reason, for people only. */
  | { hiccup: string }
  | { done: { agentId: string } };

/** `skillSet`: one of the owner's skill sets at the revision the screen showed; the new agent starts with its skills. */
export interface CreationInput {
  name: string;
  spec: unknown;
  view: unknown;
  key?: string;
  skillSet?: { id: string; revision: number };
}

export interface CreationApi {
  me(): Promise<Out<{ ownerAddress: string | null; agentId: string | null }>>;
  passkeyOptions(): Promise<Out<{ optionsJSON: unknown }>>;
  passkeyRegister(response: unknown): Promise<Out<{ ownerAddress: string }>>;
  wallet(): Promise<Out<WalletInfo>>;
  createAgent(input: CreationInput): Promise<Out<{ id: string; resumed: boolean }>>;
  agent(id: string): Promise<Out<AgentInfo>>;
  retry(id: string): Promise<Out<{ id: string }>>;
}

export interface CreationDeps {
  /** `key` names this creation (a uuid kept for the draft): asking again with it never makes a second agent. */
  input: CreationInput;
  /** An agent whose creation is already under way (its own page): follow it, create nothing. */
  resume?: string;
  api: CreationApi;
  /**
   * Resolves when the owner presses "Set up your account key". Called anew each time the step asks, so a press made while
   * nothing is waiting counts for nothing.
   */
  awaitPress(): Promise<void>;
  /**
   * @simplewebauthn/browser startRegistration({ optionsJSON }); rejects with NotAllowedError when the prompt is cancelled.
   * It must call the browser's WebAuthn before its first await: it runs inside the press.
   */
  startRegistration(optionsJSON: unknown): Promise<unknown>;
  /** connectOwnerWallet, loaded on first use. */
  connectWallet(w: WalletInfo): Promise<OwnerWallet>;
  /** The gate's doors except the wallet (connected lazily). */
  signing: Omit<SigningDeps, 'wallet'>;
  /** Defaults to the real gate; tests may spy on it, never replace its decisions. */
  process?: (d: SigningDeps) => Promise<ProcessResult>;
  sleep(ms: number): Promise<void>;
  /** A cancellable timer: the owner's wait ends when the request expires. */
  after(ms: number): { done: Promise<void>; cancel(): void };
  now(): number;
  pollMs?: number;
  /** Whole-run bound; default 10 minutes. */
  timeoutMs?: number;
}

export const POLL_MS = 2000;
/** The api keeps a passkey challenge for 5 minutes (account/passkey.ts); options older than this are fetched again before a press. */
export const OPTIONS_FRESH_MS = 240_000;
/** A passkey prompt that fails faster than this never showed anything: the press did not count as a gesture, the owner did not cancel. */
const INSTANT_FAILURE_MS = 300;
/**
 * How long a lost answer is followed up through /api/me. The wallet deploy (6-13 s) and the agent insert keep running in the
 * api when the panel's call to it fails or gives up, so a 5xx is often a success the browser did not hear about.
 */
export const LOST_ANSWER_MS = 60_000;
export const LAG_RETRIES = 3;
/** Polls after our own /retry during which a stale `failed` state is not believed (the restart is asynchronous). */
const RETRY_GRACE_POLLS = 3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
export function isCancel(e: unknown): boolean {
  if (!isObj(e)) return false;
  const cause = isObj(e.cause) ? e.cause : {};
  return e.name === 'NotAllowedError' || cause.name === 'NotAllowedError' || e.code === 'ERROR_CEREMONY_ABORTED' || e.name === 'AbortError';
}

type Fail = { failed: CreationFailure; retryable: boolean; detail?: string };
const fail = (failed: CreationFailure, retryable: boolean, detail?: string): Fail => ({ failed, retryable, ...(detail ? { detail } : {}) });
/** A thrown error as a detail: its class name only, never its message (it may carry anything). */
const named = (where: string, e: unknown): string => `${where}: ${e instanceof Error ? e.name : typeof e}`;

/** An api failure as a creation failure. Traefik hides 5xx bodies, so the status decides unless a code says more. */
function failOut(o: { status: number; code?: string }, where: string): Fail {
  const detail = `${where} ${o.status}${o.code ? ` ${o.code}` : ''}`;
  if (o.code === 'wallet_deploy_failed' || o.code === 'wallet_record_failed') return fail('chain', true, detail);
  if (o.code === 'agent_limit') return fail('full', false, detail);
  if (o.code === 'reserve_due') return fail('waiting', false, detail);
  if (o.code === 'creation_limit') return fail('today', false, detail);
  if (o.status === 429 || o.status === 503 || o.status >= 500) return fail('unknown', true, detail);
  return fail('unknown', false, detail);
}

const BY_ERROR: Record<string, Fail> = {
  owner_rejected: fail('cancelled', true),
  owner_timeout: fail('expired', true),
  chain_error: fail('chain', true),
  chain_busy: fail('chain', true),
  interrupted: fail('chain', true),
  no_owner_wallet: fail('unknown', true),
  agent_limit: fail('full', false),
  sponsor_limit: fail('today', false),
  sign_request_refused: fail('operator', false),
  bound_foreign_owner: fail('operator', false),
  resume_mismatch: fail('chain', true),
};

export async function* runCreation(d: CreationDeps): AsyncGenerator<CreationEvent, void, void> {
  const poll = d.pollMs ?? POLL_MS;
  const deadline = d.now() + (d.timeoutMs ?? 600_000);
  const process = d.process ?? processPending;
  // The owner chose "Stop creating this agent" at our own dialog: the gate then rejects the request for real.
  let stopped = false;
  const signing: Omit<SigningDeps, 'wallet'> = {
    ...d.signing,
    confirm: async (kind, summary) => {
      const answer = await d.signing.confirm(kind, summary);
      if (answer === 'stop') stopped = true;
      return answer;
    },
  };
  const states = new Map<CreationStep, string>();
  const move = (step: CreationStep, state: 'working' | 'asking' | 'done'): CreationEvent[] => {
    if (states.get(step) === state) return [];
    states.set(step, state);
    return [{ step, state }];
  };

  // 1. The account key.
  yield* move('account_key', 'working');
  const me = await d.api.me();
  if (!me.ok) return void (yield failOut(me, 'me'));
  let owner = me.ownerAddress;
  if (!owner) {
    let exists = false;
    let pending = false;
    let response: unknown;
    let have = false;
    /** A 5xx from register: the deploy may still finish, so the account is looked for before this counts as a failure. */
    let lost: { status: number; code?: string } | undefined;
    options: for (;;) {
      const opts = await d.api.passkeyOptions();
      if (!opts.ok) {
        if (opts.code === 'wallet_exists') exists = true;
        else if (opts.code === 'wallet_pending') pending = true;
        else return void (yield failOut(opts, 'passkey options'));
        break;
      }
      const fetchedAt = d.now();
      for (;;) {
        yield* move('account_key', 'asking');
        const stale = d.after(Math.max(0, OPTIONS_FRESH_MS - (d.now() - fetchedAt)));
        const first = await Promise.race([d.awaitPress().then(() => 'press' as const), stale.done.then(() => 'stale' as const)]);
        stale.cancel();
        if (first === 'stale') {
          yield* move('account_key', 'working');
          continue options;
        }
        // The press: straight to the passkey. Nothing is awaited or yielded between here and the browser's prompt.
        const startedAt = d.now();
        try {
          response = await d.startRegistration(opts.optionsJSON);
          have = true;
          break options;
        } catch (e) {
          if (!isCancel(e)) return void (yield fail('unknown', true, named('passkey', e)));
          if (d.now() - startedAt >= INSTANT_FAILURE_MS) return void (yield fail('cancelled', true));
          yield { hiccup: 'the passkey prompt did not open' }; // not a cancel: press again, on the same options
        }
      }
    }
    if (have) {
      yield* move('account_key', 'working');
      const reg = await d.api.passkeyRegister(response);
      if (reg.ok) owner = reg.ownerAddress;
      else if (reg.code === 'wallet_exists') exists = true;
      else if (reg.code === 'wallet_pending') pending = true;
      else if (reg.status >= 500) lost = reg;
      else if (reg.status === 400) return void (yield fail('unknown', true, `passkey register 400${reg.code ? ` ${reg.code}` : ''}`)); // challenge expired or the response was refused: start again
      else return void (yield failOut(reg, 'passkey register'));
    }
    if (!owner && (exists || pending || lost)) {
      // The wallet exists, is being made by another tab, or was being made when the answer got lost: wait for the api to show it.
      const lostUntil = d.now() + LOST_ANSWER_MS;
      for (;;) {
        const again = await d.api.me();
        if (again.ok && again.ownerAddress) {
          owner = again.ownerAddress;
          break;
        }
        if (lost && !exists && !pending && d.now() > lostUntil) return void (yield failOut(lost, 'passkey register'));
        if (d.now() > deadline) return void (yield fail('chain', true));
        await d.sleep(poll);
      }
    }
  }
  yield* move('account_key', 'done');

  // 2. The agent: followed when this page joins one under way, created (once, by key) when not.
  yield* move('identity', 'working');
  let agentId: string | null = d.resume ?? null;
  let resumed = agentId !== null;
  if (!agentId) {
    // The insert may have committed after the answer was lost: the same key asks again and is answered the same agent.
    const lostUntil = d.now() + LOST_ANSWER_MS;
    for (;;) {
      const created = await d.api.createAgent(d.input);
      if (created.ok) {
        agentId = created.id;
        resumed = created.resumed;
        break;
      }
      if (!(created.status >= 500 && d.input.key && d.now() <= lostUntil)) return void (yield failOut(created, 'create'));
      await d.sleep(poll);
    }
  }

  // 3. Poll the agent and hand every sign request to the gate.
  let wallet: OwnerWallet | undefined;
  let lagLeft = LAG_RETRIES;
  let lagAt = 0;
  let pollNo = 0;
  let graceUntil = 0;
  let firstLook = resumed;
  const gateTries = new Map<string, number>();
  const nextAt = new Map<string, number>();
  const signedKinds = new Set<string>();
  // The last listing held a request that had already run out: if the run then ends on its time bound, say so.
  let sawExpired = false;

  for (;;) {
    pollNo++;
    if (d.now() > deadline) return void (yield sawExpired ? fail('expired', true) : fail('chain', true));

    const a = await d.api.agent(agentId);
    if (a.ok) {
      // Under FEE_MODEL=agent a new agent is born paused until its first USDC: its birth is done all the same.
      if (a.status === 'active' || (a.status === 'paused' && a.step === 'active')) {
        yield* move('identity', 'done');
        yield* move('ready', 'done');
        yield { done: { agentId } };
        return;
      }
      if (a.needsOperator) return void (yield fail('operator', false));
      if (a.step === 'failed' && pollNo > graceUntil) {
        const deferred = a.lastStart?.outcome === 'deferred' ? a.lastStart.code : undefined;
        // The api keeps its last deferral in memory and only a /retry replaces it, so a run that has just started
        // (firstLook) must post one /retry: the bind window may have closed since. Posted again within the window it
        // simply defers again (a pure read, no fee), and then this run waits (`chain`, Try again later).
        if (deferred === 'bind_window_open' && !firstLook) return void (yield fail('chain', true));
        if (deferred === 'registry_unreadable' || deferred === 'registry_no_agent') {
          if (lagLeft === 0) return void (yield fail('chain', true));
          if (d.now() >= lagAt) {
            const wait = poll * 2 ** (LAG_RETRIES - lagLeft);
            lagLeft--;
            lagAt = d.now() + wait;
            const r = await d.api.retry(agentId);
            if (!r.ok && r.status !== 409) return void (yield failOut(r, 'retry'));
            graceUntil = pollNo + RETRY_GRACE_POLLS;
          }
        } else if (firstLook) {
          // Came back to an agent that failed earlier: this is the retry.
          const r = await d.api.retry(agentId);
          if (!r.ok) return void (yield r.code === 'needs_operator' ? fail('operator', false) : failOut(r, 'retry'));
          graceUntil = pollNo + RETRY_GRACE_POLLS;
        } else {
          const known = a.error ? BY_ERROR[a.error] : undefined;
          return void (yield { ...(known ?? fail('unknown', true)), detail: `agent ${a.error ?? 'failed'}` });
        }
      }
      firstLook = false;
    } else if (a.status === 401 || a.status === 404) {
      return void (yield failOut(a, 'agent'));
    }

    // The gate.
    let listed: PublicSignRequest[] = [];
    try {
      listed = await signing.listPending();
    } catch {
      listed = []; // a poll that failed is not a refusal; the next one asks again
    }
    const byId = new Map(listed.map((r) => [r.id, r]));
    const lapsed = (id: string) => {
      const req = byId.get(id);
      return req !== undefined && d.now() >= Date.parse(req.expiresAt);
    };
        const due = listed.filter((r) => (nextAt.get(r.id) ?? 0) <= d.now());
    sawExpired = due.some((r) => lapsed(r.id));
    if (due.length > 0) {
      if (due.some((r) => r.kind === 'bind')) yield* move('identity', 'done');
      for (const r of due) yield* move(r.kind === 'register' ? 'identity' : 'ready', 'asking');
      if (!wallet) {
        const info = await d.api.wallet();
        if (!info.ok) return void (yield failOut(info, 'wallet'));
        try {
          wallet = await d.connectWallet(info);
        } catch (e) {
          return void (yield fail('unknown', true, named('wallet connect', e)));
        }
      }
      const gate: SigningDeps = {
        ...signing,
        wallet,
        listPending: async () => due,
        expiry: { now: d.now, after: d.after },
        now: d.now,
        post: async (id, xdr) => {
          await signing.post(id, xdr);
          const k = byId.get(id)?.kind;
          if (k) signedKinds.add(k);
        },
      };
      // The gate asks in list order, so the time left belongs to the first due request, the one on screen.
      const end = Date.parse(due[0]!.expiresAt) - EXPIRY_MARGIN_MS;
      if (!Number.isNaN(end)) yield { approveBy: end };
      const res = await process(gate);
      if (signedKinds.has('register')) {
        yield* move('identity', 'done');
        yield* move('ready', 'working');
      }
      for (const x of res.refused) {
        // Typed outcomes only: the reason text is for people and never decides anything.
        // The owner did not answer before the request ran out: nothing signed. Try again makes a fresh request.
        if (x.outcome === 'expired') return void (yield fail('expired', true));
        if (x.outcome === 'refused') {
          // Rejected: a policy refusal, or the owner's own "Stop".
          return void (yield stopped ? fail('stopped', true) : fail('refused', false));
        }
        // Still pending: Try again asks the same request again. No auto-retry, which would re-prompt Face ID.
        if (x.outcome === 'cancelled') return void (yield fail('cancelled', true));
        const req = byId.get(x.id);
        if (x.outcome === 'other_tab') {
          if (req && d.now() > Date.parse(req.expiresAt)) return void (yield fail('expired', true));
          continue;
        }
        // retry: the gate could not find out, or the signature did not arrive. Back off, then offer Try again.
        yield { hiccup: x.reason };
        const n = (gateTries.get(x.id) ?? 0) + 1;
        gateTries.set(x.id, n);
        if (req && d.now() > Date.parse(req.expiresAt)) return void (yield fail('expired', true));
        if (n > LAG_RETRIES) return void (yield fail('chain', true));
        nextAt.set(x.id, d.now() + poll * 2 ** (n - 1));
      }
      if (signedKinds.has('bind')) yield* move('ready', 'working');
    }
    await d.sleep(poll);
  }
}

/** What the screen shows, folded from the events. */
export interface CreateUiState {
  steps: Record<CreationStep, 'idle' | 'working' | 'asking' | 'done'>;
  failure?: { failed: CreationFailure; retryable: boolean; detail?: string };
  /** Epoch ms by which the open question must be answered; the screen turns it into plain words. */
  approveBy?: number;
  /** Why the last press did not go through (shown as "press again" plus the reason in Technical details); cleared when a step finishes. */
  lastHiccup?: string;
  done?: { agentId: string };
}
export const initialCreateUi: CreateUiState = { steps: { account_key: 'idle', identity: 'idle', ready: 'idle' } };

export function reduceCreation(s: CreateUiState, e: CreationEvent | { reset: true }): CreateUiState {
  if ('reset' in e) return initialCreateUi;
  if ('step' in e) {
    const steps = { ...s.steps, [e.step]: e.state };
    if (e.state !== 'done') return { ...s, steps };
    const { lastHiccup: _cleared, ...rest } = s;
    return { ...rest, steps };
  }
  if ('hiccup' in e) return { ...s, lastHiccup: e.hiccup };
  if ('failed' in e) {
    const { approveBy: _gone, ...rest } = s;
    return { ...rest, failure: { failed: e.failed, retryable: e.retryable, ...(e.detail ? { detail: e.detail } : {}) } };
  }
  if ('approveBy' in e) return { ...s, approveBy: e.approveBy };
  return { ...s, done: e.done };
}
