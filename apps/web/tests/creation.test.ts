import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { initialCreateUi, reduceCreation, runCreation, type CreationApi, type CreationDeps, type CreationEvent } from '@/lib/creation';
import { PUBLIC } from '@/lib/public-config';
import { processPending, type Approval, type ApprovalStore, type ConfirmAnswer, type PublicSignRequest } from '@/lib/signing-flow';
import type { AgentInfo, Out } from '@/server/create-actions';
import { TESTNET } from '@/mirror/owner-client/testnet';
import { authEntry, b64, contractAddress, fakeChain, REGISTER_TX, scv, walletSpy } from './support/owner-chain';

const ownerC = contractAddress(7);
const sponsor = Keypair.random().publicKey();
const agentG = Keypair.random().publicKey();
const AGENT = '0f8e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e';
const KEY = '7a1e5a52-6a3c-4d0e-9a51-1d2a3b4c5d6e';
const uri = `${PUBLIC.uriPrefix}${AGENT}/agent.json`;

const baseReq = (over: Partial<PublicSignRequest>): PublicSignRequest => ({
  id: 'r1',
  kind: 'register',
  agentId: AGENT,
  entryXdr: '',
  validUntilLedger: 5100,
  networkPassphrase: TESTNET.passphrase,
  expiresAt: new Date(10 * 60_000).toISOString(),
  source: sponsor,
  agentWallet: agentG,
  registerTx: null,
  ...over,
});
const registerReq = (over: Partial<PublicSignRequest> = {}) =>
  baseReq({ entryXdr: b64(authEntry({ signer: ownerC, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str(uri)] })), ...over });
const bindReq = (over: Partial<PublicSignRequest> = {}) =>
  baseReq({ id: 'r2', kind: 'bind', registerTx: REGISTER_TX, entryXdr: b64(authEntry({ signer: ownerC, fn: 'set_agent_wallet', args: [scv.addr(ownerC), scv.u32(42), scv.addr(agentG)] })), ...over });

const wallet = { contractId: ownerC, credentialId: 'cred', credential: { publicKey: 'x' } as never };

function memoryStore(): ApprovalStore & { sets: Approval[] } {
  let v: { approval: Approval; txHash?: string } | null = null;
  const s = {
    sets: [] as Approval[],
    getRegistered: () => v,
    setRegistered: (n: { approval: Approval; txHash?: string }) => {
      v = n;
      s.sets.push(n.approval);
    },
    clearRegistered: () => void (v = null),
  };
  return s;
}

interface Opts {
  ownerAddress?: string | null;
  existingAgent?: boolean;
  /** Fake server: what the agent row says on each poll (default: follows the signatures). */
  agent?: (s: { registerSigned: boolean; bindSigned: boolean; polls: number }) => Out<AgentInfo>;
  createAgent?: CreationApi['createAgent'];
  passkeyRegister?: (server: { owner: string | null }) => ReturnType<CreationApi['passkeyRegister']>;
  /** /api/me reports this agent id from the Nth call on (an insert whose answer got lost). */
  agentFromMeCall?: number;
  startRegistration?: () => Promise<unknown>;
  /** How long a failing passkey prompt stayed open (fake ms, default 4000). 0: it failed before showing anything. */
  promptMs?: number;
  /** The owner's press on "Set up your account key"; default: pressed at once. */
  awaitPress?: () => Promise<void>;
  firstRequests?: PublicSignRequest[];
  /** One answer for every dialog, or a queue (then 'yes'). */
  confirmAnswer?: ConfirmAnswer | ConfirmAnswer[];
  /** The passkey prompt is closed at the Nth signing (1 = register, 2 = bind). */
  cancelAt?: number;
  /** POST /sign fails for the first N deliveries. */
  postFails?: number;
  rpcWrap?: (r: ReturnType<typeof fakeChain>['rpc']) => ReturnType<typeof fakeChain>['rpc'];
  process?: CreationDeps['process'];
  /** Replaces the confirm door (e.g. one that never answers). */
  confirm?: CreationDeps['signing']['confirm'];
  forgedApproval?: Approval;
  /** The creation key the page made for this draft. */
  key?: string;
}

function rig(o: Opts = {}) {
  const log: string[] = [];
  let t = 0;
  const sleeps: number[] = [];
  const store = memoryStore();
  const server = { registerSigned: false, bindSigned: false, polls: 0, retried: 0, rejected: [] as string[], owner: o.ownerAddress === undefined ? null : o.ownerAddress };
  const chain = fakeChain({ owner: ownerC, sponsor, uri, registered: () => store.getRegistered()?.approval ?? null });
  const w = walletSpy(ownerC);
  let signings = 0;
  const afters: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  let postFailsLeft = o.postFails ?? 0;
  const answers = Array.isArray(o.confirmAnswer) ? [...o.confirmAnswer] : undefined;
  const info = (status: string, step: string): Out<AgentInfo> => ({ ok: true, status, step, error: null, needsOperator: false, lastStart: null });
  const api: CreationApi = {
    me: async () => (log.push('me'), { ok: true, ownerAddress: server.owner, agentId: o.existingAgent || (o.agentFromMeCall !== undefined && log.filter((x) => x === 'me').length >= o.agentFromMeCall) ? AGENT : null }),
    passkeyOptions: async () => (log.push('options'), { ok: true, optionsJSON: { challenge: 'c' } }),
    passkeyRegister: async () => (log.push('register'), o.passkeyRegister ? o.passkeyRegister(server) : ((server.owner = ownerC), { ok: true, ownerAddress: ownerC })),
    wallet: async () => (log.push('wallet'), { ok: true, ...wallet }),
    createAgent: o.createAgent ?? (async () => (log.push('createAgent'), { ok: true, id: AGENT, resumed: false })),
    agent: async () => {
      server.polls++;
      log.push('agent');
      if (o.agent) return o.agent({ registerSigned: server.registerSigned, bindSigned: server.bindSigned, polls: server.polls });
      const base = server.bindSigned ? info('active', 'active') : info('provisioning', 'creating');
      return o.forgedApproval && base.ok ? ({ ...base, approval: o.forgedApproval } as Out<AgentInfo>) : base;
    },
    retry: async () => (log.push('retry'), server.retried++, { ok: true, id: AGENT }),
  };
  const events: CreationEvent[] = [];
  const confirms: string[] = [];
  const deps: CreationDeps = {
    input: { name: 'XLM watcher', spec: { s: 1 }, view: { v: 1 }, ...(o.key ? { key: o.key } : {}) },
    ...(o.existingAgent ? { resume: AGENT } : {}),
    api,
    awaitPress: o.awaitPress ?? (async () => void log.push('press')),
    startRegistration: async () => {
      log.push('webauthn');
      try {
        return await (o.startRegistration ?? (async () => ({ id: 'cred' })))();
      } catch (e) {
        t += o.promptMs ?? 4000;
        throw e;
      }
    },
    connectWallet: async () => ({
      address: w.address,
      signEntry: async (x, v) => {
        if (++signings === o.cancelAt) throw ((t += 4000), Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
        return w.signEntry(x, v);
      },
    }),
    signing: {
      listPending: async () => {
        if (o.firstRequests && !server.registerSigned) return o.firstRequests;
        if (!server.registerSigned) return [registerReq()];
        if (!server.bindSigned) return [bindReq()];
        return [];
      },
      post: async (id) => {
        if (postFailsLeft-- > 0) throw new Error('503');
        log.push(`post:${id === 'r1' ? 'register' : 'bind'}`);
        if (id === 'r1') server.registerSigned = true;
        else server.bindSigned = true;
      },
      reject: async (id) => void server.rejected.push(id),
      rpc: (o.rpcWrap ? o.rpcWrap(chain.rpc) : chain.rpc) as never,
      confirm: o.confirm ?? (async (kind) => (confirms.push(kind), answers ? (answers.shift() ?? 'yes') : Array.isArray(o.confirmAnswer) ? 'yes' : (o.confirmAnswer ?? 'yes'))),
      store,
      uriPrefix: PUBLIC.uriPrefix,
    },
    ...(o.process ? { process: o.process } : {}),
    sleep: async (ms) => void (sleeps.push(ms), (t += ms)),
    after: (ms) => {
      let fire!: () => void;
      const done = new Promise<void>((r) => (fire = r));
      const a = { ms, fire, cancelled: false };
      afters.push(a);
      return { done, cancel: () => void (a.cancelled = true) };
    },
    now: () => t,
  };
  const run = async () => {
    for await (const e of runCreation(deps)) events.push(e);
    return events;
  };
  return { deps, run, log, events, sleeps, store, server, confirms, wallet: w, chain, afters };
}

const last = (e: CreationEvent[]) => e.at(-1);

describe('runCreation', () => {
  test('happy path order: options, register, create agent, sign register, sign bind, active, done', async () => {
    const r = rig();
    await r.run();
    expect(r.log.filter((x) => x !== 'agent' && x !== 'me' && x !== 'wallet')).toEqual(['options', 'press', 'webauthn', 'register', 'createAgent', 'post:register', 'post:bind']);
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    expect(r.confirms).toEqual(['register', 'bind']);
    const steps = r.events.filter((e) => 'step' in e).map((e) => `${(e as { step: string }).step}:${(e as { state: string }).state}`);
    expect(steps.indexOf('account_key:done')).toBeLessThan(steps.indexOf('identity:asking'));
    expect(steps.indexOf('identity:done')).toBeLessThan(steps.indexOf('ready:asking'));
    expect(steps.at(-1)).toBe('ready:done');
    expect(r.wallet.prompts).toBe(2);
  });

  test('a user who already has an account key skips the passkey step', async () => {
    const r = rig({ ownerAddress: ownerC });
    await r.run();
    expect(r.log).not.toContain('options');
    expect(r.log).not.toContain('webauthn');
    expect(r.log).toContain('createAgent');
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
  });

  test('a lost register answer (5xx) is followed up: the wallet that landed anyway is used, no second passkey', async () => {
    const r = rig({
      passkeyRegister: async (server) => {
        server.owner = ownerC; // the deploy finished in the api after the panel gave up
        return { ok: false, status: 503 };
      },
    });
    await r.run();
    expect(r.log.filter((x) => x === 'webauthn')).toHaveLength(1);
    expect(r.log).toContain('createAgent');
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
  });

  test('a lost register answer with no wallet behind it fails after the follow-up window, with its detail', async () => {
    const r = rig({ passkeyRegister: async () => ({ ok: false, status: 503 }) });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'unknown', retryable: true, detail: 'passkey register 503' });
    expect(r.log).not.toContain('createAgent');
  });

  test('a lost create answer (5xx) asks again with the same key and follows the agent the insert made anyway', async () => {
    const keys: (string | undefined)[] = [];
    const r = rig({
      ownerAddress: ownerC,
      key: KEY,
      createAgent: async (input) => (keys.push(input.key), keys.length < 3 ? { ok: false, status: 503 } : { ok: true, id: AGENT, resumed: true }),
    });
    await r.run();
    expect(keys).toEqual([KEY, KEY, KEY]);
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
  });

  test('the account limits are plain answers, never retried: full, and made enough today', async () => {
    for (const [code, failed] of [['agent_limit', 'full'], ['creation_limit', 'today']] as const) {
      let creates = 0;
      const r = rig({ ownerAddress: ownerC, key: KEY, createAgent: async () => (creates++, { ok: false, status: code === 'agent_limit' ? 409 : 429, code }) });
      await r.run();
      expect(creates).toBe(1);
      expect(last(r.events)).toMatchObject({ failed, retryable: false });
    }
    // The sponsor ceiling shows on the agent itself, after it was made.
    const s = rig({ ownerAddress: ownerC, key: KEY, agent: () => ({ ok: true, status: 'provisioning', step: 'failed', error: 'sponsor_limit', needsOperator: false, lastStart: null }) });
    s.deps.signing.listPending = async () => [];
    await s.run();
    expect(last(s.events)).toMatchObject({ failed: 'today', retryable: false });
  });

  test('a create the api refuses says where under its detail: retryable on 5xx, not on 4xx', async () => {
    const down = rig({ ownerAddress: ownerC, createAgent: async () => ({ ok: false, status: 503 }) });
    await down.run();
    expect(last(down.events)).toEqual({ failed: 'unknown', retryable: true, detail: 'create 503' });
    const bad = rig({ ownerAddress: ownerC, createAgent: async () => ({ ok: false, status: 400, code: 'bad_view' }) });
    await bad.run();
    expect(last(bad.events)).toEqual({ failed: 'unknown', retryable: false, detail: 'create 400 bad_view' });
  });

  test('an agent page joining its own creation follows it without a create; an agent the owner already has elsewhere is never resumed', async () => {
    const a = rig({ ownerAddress: ownerC, existingAgent: true });
    await a.run();
    expect(a.log).not.toContain('createAgent');
    expect(last(a.events)).toEqual({ done: { agentId: AGENT } });
    // /api/me naming another agent changes nothing: a new draft is a new agent.
    const b = rig({ ownerAddress: ownerC, key: KEY });
    b.deps.api.me = async () => ({ ok: true, ownerAddress: ownerC, agentId: '99999999-9999-4999-8999-999999999999' });
    await b.run();
    expect(b.log).toContain('createAgent');
    expect(last(b.events)).toEqual({ done: { agentId: AGENT } });
  });

  describe('step 1 starts from a press, with nothing awaited between the press and the passkey', () => {
    const notAllowed = () => Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' });

    test('me and the passkey options are fetched, and the step asks, before the passkey is touched; it waits for the press', async () => {
      let press!: () => void;
      const pressed = new Promise<void>((r) => (press = r));
      const r = rig({ awaitPress: () => pressed });
      const running = r.run();
      await new Promise((res) => setTimeout(res, 10));
      expect(r.log).toEqual(['me', 'options']);
      expect(r.events).toContainEqual({ step: 'account_key', state: 'asking' });
      press();
      await running;
      expect(r.log.slice(0, 4)).toEqual(['me', 'options', 'webauthn', 'register']);
      expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    });

    test('no api call and no event sits between the press and the passkey call', async () => {
      const r = rig({
        awaitPress: async () => {
          r.log.push('press');
        },
      });
      const seen: string[] = [];
      const real = r.deps.startRegistration;
      r.deps.startRegistration = (o) => (seen.push(`webauthn after ${r.events.length} events, log ${r.log.join(',')}`), real(o));
      await r.run();
      expect(seen[0]).toMatch(/log me,options,press$/);
      expect(r.log.slice(0, 4)).toEqual(['me', 'options', 'press', 'webauthn']);
    });

    test('a prompt that fails before showing anything is "press again", not "you cancelled": the same step asks again', async () => {
      let failFirst = true;
      const r = rig({
        promptMs: 0,
        startRegistration: async () => {
          if (failFirst) {
            failFirst = false;
            throw notAllowed();
          }
          return { id: 'cred' };
        },
      });
      await r.run();
      expect(r.events).toContainEqual({ hiccup: 'the passkey prompt did not open' });
      expect(r.events.some((e) => 'failed' in e)).toBe(false);
      expect(r.log.filter((x) => x === 'press')).toHaveLength(2);
      expect(r.log.filter((x) => x === 'options')).toHaveLength(1); // the same options, still fresh
      expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    });

    test('a prompt the owner closed after it was open is still "cancelled"', async () => {
      const r = rig({ promptMs: 4000, startRegistration: async () => Promise.reject(notAllowed()) });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'cancelled', retryable: true });
    });

    test('options that are about to expire are fetched again before the press counts', async () => {
      let press!: () => void;
      let calls = 0;
      const r = rig({
        awaitPress: () => (calls++ < 1 ? new Promise<void>((res) => (press = res)) : Promise.resolve()),
      });
      const running = r.run();
      await new Promise((res) => setTimeout(res, 10));
      expect(r.afters).toHaveLength(1);
      expect(r.afters[0]!.ms).toBeGreaterThan(200_000); // the api keeps the challenge for 5 minutes
      expect(r.afters[0]!.ms).toBeLessThan(300_000);
      r.afters[0]!.fire(); // nobody pressed in time
      await new Promise((res) => setTimeout(res, 10));
      expect(r.log.filter((x) => x === 'options')).toHaveLength(2);
      void press;
      await running;
      expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    });
  });

  test('cancelling the passkey prompt yields cancelled, retryable, and no agent is created', async () => {
    const r = rig({
      startRegistration: async () => {
        throw Object.assign(new Error('The operation either timed out or was not allowed'), { name: 'NotAllowedError' });
      },
    });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'cancelled', retryable: true });
    expect(r.log).not.toContain('register');
    expect(r.log).not.toContain('createAgent');
  });

  test('an account key made in another tab is waited for, not an error', async () => {
    const r = rig();
    r.deps.api.passkeyOptions = async () => ({ ok: false, status: 409, code: 'wallet_pending' });
    let mes = 0;
    r.deps.api.me = async () => ({ ok: true, ownerAddress: ++mes > 2 ? ownerC : null, agentId: null });
    await r.run();
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    expect(r.log).not.toContain('webauthn');
  });

  test('a refusal from the signing gate yields refused, and the request is rejected without a prompt', async () => {
    const transfer = registerReq({ entryXdr: b64(authEntry({ signer: ownerC, contract: TESTNET.usdcSac, fn: 'transfer', args: [scv.addr(ownerC), scv.addr(agentG), scv.i128(10_000_000n)] })) });
    const r = rig({ ownerAddress: ownerC, firstRequests: [transfer] });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'refused', retryable: false });
    expect(r.server.rejected).toEqual(['r1']);
    expect(r.wallet.prompts).toBe(0);
    expect(r.confirms).toEqual([]);
    expect(r.log).not.toContain('post:register');
  });

  test('"Not now" leaves the request pending: cancelled, no reject, no /retry, and the next run asks the same request again', async () => {
    const r = rig({ ownerAddress: ownerC, confirmAnswer: ['later'] });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'cancelled', retryable: true });
    expect(r.server.rejected).toEqual([]);
    expect(r.wallet.prompts).toBe(0);
    expect(r.log).not.toContain('retry');
    // Try again: the agent row is still `creating` (the request was never rejected), so no /retry, and it completes.
    r.events.length = 0;
    r.deps.api.me = async () => ({ ok: true, ownerAddress: ownerC, agentId: AGENT });
    await r.run();
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    expect(r.log).not.toContain('retry');
    expect(r.server.rejected).toEqual([]);
  });

  test('"Stop creating this agent" rejects the request for real and reports stopped', async () => {
    const r = rig({ ownerAddress: ownerC, confirmAnswer: 'stop' });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'stopped', retryable: true });
    expect(r.server.rejected).toEqual(['r1']);
    expect(r.wallet.prompts).toBe(0);
  });

  for (const tap of ['register', 'bind'] as const) {
    test(`a closed Face ID prompt at the ${tap} tap is cancelled: still pending, not rejected, not auto-retried, and the next run completes`, async () => {
      const noisy = rig({ ownerAddress: ownerC, cancelAt: tap === 'register' ? 1 : 2 });
      await noisy.run();
      expect(last(noisy.events)).toEqual({ failed: 'cancelled', retryable: true });
      expect(noisy.server.rejected).toEqual([]);
      expect(noisy.log).not.toContain('retry');
      expect(noisy.confirms).toEqual(tap === 'register' ? ['register'] : ['register', 'bind']);
      noisy.events.length = 0;
      noisy.deps.api.me = async () => ({ ok: true, ownerAddress: ownerC, agentId: AGENT });
      await noisy.run();
      expect(last(noisy.events)).toEqual({ done: { agentId: AGENT } });
      expect(noisy.server.rejected).toEqual([]);
      expect(noisy.log).not.toContain('retry');
    });
  }

  test('a signature that could not be delivered is retried with backoff, then completes', async () => {
    const r = rig({ ownerAddress: ownerC, postFails: 2 });
    await r.run();
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    expect(r.server.rejected).toEqual([]);
    expect(r.log.filter((x) => x === 'post:register')).toHaveLength(1);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(6_000);
  });

  test('a press that ends in "try again" says so: a hiccup event with the plain reason, cleared once the step is done', async () => {
    const r = rig({ ownerAddress: ownerC, postFails: 1 });
    await r.run();
    expect(r.events).toContainEqual({ hiccup: 'could not send the signature' });
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    let ui = reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' });
    ui = reduceCreation(ui, { hiccup: 'could not send the signature' });
    expect(ui.lastHiccup).toBe('could not send the signature');
    expect(reduceCreation(ui, { step: 'identity', state: 'done' }).lastHiccup).toBeUndefined();
  });

  test('a signature that never gets delivered ends in chain, retryable, with nothing rejected; Try again delivers it', async () => {
    const r = rig({ ownerAddress: ownerC, postFails: 4 });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'chain', retryable: true });
    expect(r.server.rejected).toEqual([]);
    r.events.length = 0;
    r.deps.api.me = async () => ({ ok: true, ownerAddress: ownerC, agentId: AGENT });
    await r.run();
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
  });

  test('a stale bind_window_open on a resumed agent posts /retry once (the window may have closed); inside a run it waits', async () => {
    const stale: Out<AgentInfo> = { ok: true, status: 'provisioning', step: 'failed', error: 'chain_error', needsOperator: false, lastStart: { outcome: 'deferred', code: 'bind_window_open' } };
    // The api still says the same thing after the retry (deferred again): one /retry, then chain, never a loop.
    const again = rig({ ownerAddress: ownerC, existingAgent: true, agent: () => stale });
    again.deps.signing.listPending = async () => [];
    await again.run();
    expect(again.log.filter((x) => x === 'retry')).toHaveLength(1);
    expect(last(again.events)).toEqual({ failed: 'chain', retryable: true });
    // The window has closed: the retry restarts provision and the agent goes on to active.
    const closed = rig({ ownerAddress: ownerC, existingAgent: true, agent: ({ polls, bindSigned }) => (bindSigned ? { ...stale, status: 'active', step: 'active', lastStart: null } : polls < 4 ? stale : { ...stale, step: 'creating', lastStart: { outcome: 'active' } }) });
    await closed.run();
    expect(closed.log.filter((x) => x === 'retry')).toHaveLength(1);
    expect(last(closed.events)).toEqual({ done: { agentId: AGENT } });
    // A fresh run that sees the deferral appear while watching does not post /retry at all.
    let n = 0;
    const live = rig({ ownerAddress: ownerC, agent: () => (++n > 1 ? stale : { ...stale, step: 'creating', lastStart: null }) });
    live.deps.signing.listPending = async () => [];
    await live.run();
    expect(live.log).not.toContain('retry');
    expect(last(live.events)).toEqual({ failed: 'chain', retryable: true });
  });

  test('a provision failure with needsOperator is operator and not retryable', async () => {
    const r = rig({ ownerAddress: ownerC, existingAgent: true, agent: () => ({ ok: true, status: 'provisioning', step: 'failed', error: 'chain_error', needsOperator: true, lastStart: null }) });
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'operator', retryable: false });
    expect(r.log).not.toContain('retry');
  });

  test('a failed state with a retryable error offers retry, and the next run posts /retry', async () => {
    const failed: Out<AgentInfo> = { ok: true, status: 'provisioning', step: 'failed', error: 'chain_error', needsOperator: false, lastStart: null };
    // First run: the agent fails while this run is watching it.
    let calls = 0;
    const first = rig({ ownerAddress: ownerC, agent: () => (++calls > 1 ? failed : { ok: true, status: 'provisioning', step: 'creating', error: null, needsOperator: false, lastStart: null }), firstRequests: [] });
    first.deps.signing.listPending = async () => [];
    await first.run();
    expect(last(first.events)).toEqual({ failed: 'chain', retryable: true, detail: 'agent chain_error' });
    expect(first.log).not.toContain('retry');
    // Second run: back to the failed agent. It posts /retry, then watches it through to active.
    const second = rig({
      ownerAddress: ownerC,
      existingAgent: true,
      agent: ({ polls, bindSigned }) => (bindSigned ? { ok: true, status: 'active', step: 'active', error: null, needsOperator: false, lastStart: null } : polls === 1 || polls < 4 ? failed : { ok: true, status: 'provisioning', step: 'creating', error: null, needsOperator: false, lastStart: null }),
    });
    await second.run();
    expect(second.log.filter((x) => x === 'retry')).toHaveLength(1);
    expect(second.log.indexOf('retry')).toBeLessThan(second.log.indexOf('post:register'));
    expect(last(second.events)).toEqual({ done: { agentId: AGENT } });
  });

  test('registry lag on the server retries 3 times with backoff, then yields chain', async () => {
    const lag: Out<AgentInfo> = { ok: true, status: 'provisioning', step: 'failed', error: 'chain_error', needsOperator: false, lastStart: { outcome: 'deferred', code: 'registry_unreadable' } };
    const r = rig({ ownerAddress: ownerC, existingAgent: true, agent: () => lag });
    r.deps.signing.listPending = async () => [];
    await r.run();
    expect(r.log.filter((x) => x === 'retry')).toHaveLength(3);
    expect(last(r.events)).toEqual({ failed: 'chain', retryable: true });
  });

  test('registry lag in the gate leaves the request pending, retries 3 times with backoff, then yields chain and never rejects', async () => {
    const lagging = (c: ReturnType<typeof fakeChain>['rpc']) => ({ ...c, getTransaction: async (h: string) => ({ ...(await c.getTransaction(h)), status: 'NOT_FOUND' }) as never });
    const r = rig({ ownerAddress: ownerC, rpcWrap: lagging });
    let bindOffered = 0;
    r.deps.signing.listPending = async () => (r.server.registerSigned ? (bindOffered++, r.server.bindSigned ? [] : [bindReq()]) : [registerReq()]);
    await r.run();
    expect(last(r.events)).toEqual({ failed: 'chain', retryable: true });
    expect(r.server.rejected).toEqual([]);
    expect(r.confirms).toEqual(['register']);
    // One try plus 3 retries, backed off 2 s, 4 s, 8 s: the clock moved at least 14 s past the first attempt.
    expect(r.chain.txReads).toHaveLength(4);
    expect(r.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(14_000);
  });

  test('"in another tab" waits without spending retries, and gives up only at the request expiry', async () => {
    let n = 0;
    const r = rig({
      ownerAddress: ownerC,
      process: async (d) => (++n <= 5 ? { signed: 0, refused: [{ id: 'r1', reason: 'in another tab', outcome: 'other_tab' as const }] } : processPending(d)),
    });
    await r.run();
    expect(n).toBeGreaterThan(5);
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });

    const expired = rig({ ownerAddress: ownerC, firstRequests: [registerReq({ expiresAt: new Date(1000).toISOString() })], process: async () => ({ signed: 0, refused: [{ id: 'r1', reason: 'in another tab', outcome: 'other_tab' as const }] }) });
    await expired.run();
    expect(last(expired.events)).toEqual({ failed: 'expired', retryable: true });
  });

  test('registered.approval is read and written only through the store, never from an api response', async () => {
    const forged: Approval = { signedEntryXdr: 'FORGED', summary: 'forged', call: { fn: 'register_with_uri', owner: ownerC, agentUri: uri } as never };
    const r = rig({ ownerAddress: ownerC, forgedApproval: forged });
    await r.run();
    expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    // The store was written once, by the gate, with the entry the wallet really signed; the forged one never appears.
    expect(r.store.sets).toHaveLength(1);
    expect(r.store.sets[0]!.signedEntryXdr).not.toBe('FORGED');
    expect(JSON.stringify(r.store.sets)).not.toContain('FORGED');

    // A bind with an empty store is refused, whatever the api's responses carry.
    const bare = rig({ ownerAddress: ownerC, existingAgent: true, forgedApproval: forged, firstRequests: [bindReq()] });
    await bare.run();
    expect(last(bare.events)).toEqual({ failed: 'refused', retryable: false });
    expect(bare.wallet.prompts).toBe(0);
    expect(bare.store.sets).toHaveLength(0);
  });

  describe('an approval that outlives its request', () => {
    const soon = () => registerReq({ expiresAt: new Date(60_000).toISOString() });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };

    test('a confirm still waiting at the request expiry ends the flow with expired; nothing signed, nothing rejected, no retry', async () => {
      const r = rig({ ownerAddress: ownerC, firstRequests: [soon()], confirm: () => new Promise(() => {}) });
      const run = r.run();
      await settle();
      expect(r.afters).toHaveLength(1);
      expect(r.afters[0]!.ms).toBe(45_000); // 60 s expiry minus the 15 s margin
      expect(r.events.some((e) => 'failed' in e)).toBe(false);
      r.afters[0]!.fire();
      await run;
      expect(last(r.events)).toEqual({ failed: 'expired', retryable: true });
      expect(r.wallet.prompts).toBe(0);
      expect(r.server.rejected).toEqual([]);
      expect(r.log).not.toContain('retry');
      expect(r.log.some((x) => x.startsWith('post:'))).toBe(false);
    });

    test('the asking step announces when the approval ends, from the request itself', async () => {
      const r = rig({ ownerAddress: ownerC, firstRequests: [soon()], confirm: () => new Promise(() => {}) });
      const run = r.run();
      await settle();
      r.afters[0]!.fire();
      await run;
      const i = r.events.findIndex((e) => 'approveBy' in e);
      expect(r.events[i]).toEqual({ approveBy: 60_000 - 15_000 });
      expect(i).toBeLessThan(r.events.findIndex((e) => 'failed' in e));
    });

    test('Try again after an expiry asks a fresh request and completes', async () => {
      const r = rig({ ownerAddress: ownerC, firstRequests: [soon()], confirm: () => new Promise(() => {}) });
      const run = r.run();
      await settle();
      r.afters[0]!.fire();
      await run;
      r.events.length = 0;
      r.deps.signing.confirm = async () => 'yes';
      r.deps.api.me = async () => ({ ok: true, ownerAddress: ownerC, agentId: AGENT });
      r.deps.signing.listPending = async () => (r.server.registerSigned ? (r.server.bindSigned ? [] : [bindReq()]) : [registerReq()]);
      await r.run();
      expect(last(r.events)).toEqual({ done: { agentId: AGENT } });
    });

    test('the overall deadline after an expired request is expired, not chain', async () => {
      const r = rig({ ownerAddress: ownerC, firstRequests: [registerReq({ expiresAt: new Date(1000).toISOString() })], process: async () => ({ signed: 0, refused: [] }) });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'expired', retryable: true });
    });

    test('a typed refusal stays refused whatever the clock says (a tampered entry after expiresAt is not "waited too long")', async () => {
      const r = rig({ ownerAddress: ownerC, firstRequests: [registerReq({ expiresAt: new Date(0).toISOString() })], process: async () => ({ signed: 0, refused: [{ id: 'r1', reason: 'the wallet returned a different signature than approved', outcome: 'refused' as const }] }) });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'refused', retryable: false });
    });

    test('a request whose ledger window closes before its wall-clock expiry ends as expired through the real gate, rejecting nothing', async () => {
      const closed = (c: ReturnType<typeof fakeChain>['rpc']) => ({ ...c, getLatestLedger: async () => ({ sequence: 99_999 }) });
      const r = rig({ ownerAddress: ownerC, rpcWrap: closed });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'expired', retryable: true });
      expect(r.server.rejected).toEqual([]);
      expect(r.wallet.prompts).toBe(0);
    });

    test('a due, lapsed request makes the deadline say expired', async () => {
      const lapsedButNotDue = registerReq({ expiresAt: new Date(0).toISOString() });
      const r = rig({ ownerAddress: ownerC, firstRequests: [lapsedButNotDue], process: async () => ({ signed: 0, refused: [{ id: 'r1', reason: 'x', outcome: 'retry' as const }] }) });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'expired', retryable: true }); // due and lapsed: still expired
    });

    test('the same refusal on a live request stays refused', async () => {
      const r = rig({ ownerAddress: ownerC, process: async () => ({ signed: 0, refused: [{ id: 'r1', reason: 'x', outcome: 'refused' as const }] }) });
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'refused', retryable: false });
    });

    test('the api timing out an approval (owner_timeout) is expired too', async () => {
      let calls = 0;
      const info = (step: string, error: string | null): Out<AgentInfo> => ({ ok: true, status: 'provisioning', step, error, needsOperator: false, lastStart: null });
      const r = rig({ ownerAddress: ownerC, agent: () => (++calls > 1 ? info('failed', 'owner_timeout') : info('creating', null)) });
      r.deps.signing.listPending = async () => [];
      await r.run();
      expect(last(r.events)).toEqual({ failed: 'expired', retryable: true, detail: 'agent owner_timeout' });
    });
  });
});
