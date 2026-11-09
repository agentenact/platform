import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Address, Keypair, StrKey, xdr, type FeeBumpTransaction, type Transaction } from '@stellar/stellar-sdk';
import type { AuthOwnerRemoteOptions, PartialOwnedAgent, RemoteOwnedStellarAgent, SorobanSeam } from 'agentenact/create';
import { signRequestError, type SignRequestInput } from '../src/account/sign-requests.js';
import { createSpecs } from '../src/specs/index.js';
import type { TriggerSpec } from '../src/specs/schema.js';
import { minimalSpec } from './support/specs.js';
import { createChain, type Chain } from '../src/chain/index.js';
import type { Db } from '../src/db/index.js';
import { createKeys, type Keys } from '../src/keys/index.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { createProvisioner, type ProvisionLog, type ProvisionState } from '../src/provision/index.js';
import { freshDb } from './support/db.js';
import { authEntry, b64, scv, signEntry } from './support/entries.js';
import { contractAddress, insertAgent, insertUser } from './support/fixtures.js';
import { fakeChainRpc, fakeSoroban } from './support/soroban.js';

const ownerC = contractAddress(7);
const BASE = 'https://public.example.test'; // placeholder public host (prod: https://agentenact.io)
const sponsorKp = Keypair.random();
const chainBase = { rpId: 'agentenact.io', origin: 'https://app.agentenact.io', env: { SPONSOR_SECRET: sponsorKp.secret() } };
type Create = (o: AuthOwnerRemoteOptions) => Promise<RemoteOwnedStellarAgent>;
interface AgentRow { status: string; stellar_address: string | null; agent_id: string | null; provision_state: ProvisionState }

/**
 * The agent key stays in the vault: the library only gets `agentSigner`. A partial's `secret` (which a library
 * run with a local key would carry) is played by this marker, to prove provision never logs or stores it.
 */
const MARKER_SECRET = Keypair.random().secret();
/** Set inside a sponsor-lock hold, for the async chain that holds it. */
const inHold = new AsyncLocalStorage<boolean>();
const okCreate = (calls: AuthOwnerRemoteOptions[]): Create => async (o) => {
  calls.push(o);
  return {
    publicKey: o.agentSigner.publicKey,
    agentId: '42',
    owner: o.owner.address,
    txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) },
  };
};
const failingCreate = (calls: AuthOwnerRemoteOptions[], err: Error, txs?: PartialOwnedAgent['txs'], agentId?: string): Create => async (o) => {
  calls.push(o);
  if (txs) Object.assign(err, { partial: { publicKey: o.agentSigner.publicKey, secret: MARKER_SECRET, owner: o.owner.address, txs, ...(agentId ? { agentId } : {}) } });
  throw err;
};
const noSigning = { request: async (): Promise<string> => { throw new Error('unexpected sign request'); } };
/** Stands in for the owner's browser: signs every entry it is asked for (or rejects one kind). */
const signing = (rejectKind?: 'register' | 'bind') => ({
  request: async (i: SignRequestInput) => {
    if (i.kind === rejectKind) throw signRequestError('owner_rejected');
    return b64(signEntry(xdr.SorobanAuthorizationEntry.fromXDR(i.entryXdr, 'base64'), i.validUntilLedger));
  },
});
/** True if `p` is still pending after a short wait (used only for "stays blocked" checks). */
const stillBlocked = (p: Promise<unknown>) => Promise.race([p.then(() => false), Bun.sleep(25).then(() => true)]);
const argsOf = (t: Transaction) => (t.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().args();
type Reads = Pick<Chain, 'identity' | 'accountExists'>;
/** No lock: fakes that never interleave. Tests that exercise the lock pass the real `chain.withSponsorLock`. */
const noLock: Chain['withSponsorLock'] = (fn) => fn();
/** Registry/Horizon reads for provision's recovery checks. Default: no such agent, no such account. */
const reads = (o: Partial<Reads> = {}) => ({ identity: o.identity ?? (async () => null), accountExists: o.accountExists ?? (async () => false), withSponsorLock: noLock });
const isState = (v: unknown): v is ProvisionState => !!v && typeof v === 'object' && 'step' in v && 'attempts' in v;
const isFinal = (s: ProvisionState) => s.attempts.at(-1)?.outcome !== undefined;
const callOf = (t: Transaction | FeeBumpTransaction) => fnOf('innerTransaction' in t ? t.innerTransaction : t);
const fnOf = (t: Transaction) => (t.operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract().functionName().toString();

describe('provision', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let rawKeys: Keys;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    rawKeys = createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });
    keys = localAgentKeys(createVault({ sql, keys: rawKeys }));
  });
  afterAll(() => drop());

  /** `ledger` overrides the seam's latestLedger (the library's own run then signs for ledger + 100). */
  const chainWithFakeSoroban = (r: Partial<Reads> & { ledger?: number } = {}) => {
    const f = fakeSoroban();
    const c = createChain(chainBase);
    const soroban: SorobanSeam = r.ledger === undefined ? f.soroban : { ...f.soroban, latestLedger: async () => r.ledger! };
    return { f, chain: { sponsor: c.sponsor, soroban, horizonSubmit: f.horizonSubmit, ...reads(r) } };
  };
  /** Injected Db wrapper (deterministic): a write of a provision_state matching `when` fails while `down()` holds. */
  const failingWrites = (when: (s: ProvisionState) => boolean, down: () => boolean = () => true) => {
    const guard = <T extends object>(q: T): T =>
      new Proxy(q, {
        apply(target, thisArg, args: unknown[]) {
          const st = args.slice(1).find(isState);
          if (st && when(st) && down()) return Promise.reject(new Error('db: connection lost'));
          return Reflect.apply(target as never, thisArg, args);
        },
        // The final save runs in a transaction: its statements go through the same guard.
        get(target, prop, recv) {
          if (prop === 'begin') return (fn: (tx: unknown) => unknown) => (target as never as Db).begin((tx) => fn(guard(tx)) as never);
          return Reflect.get(target, prop, recv);
        },
      });
    return guard(sql) as Db;
  };
  const spyKeys = () => {
    const destroyed: string[] = [];
    return { destroyed, keys: { ...keys, destroy: async (a: string) => (destroyed.push(a), keys.destroy(a)) } as AgentKeys };
  };
  /** The REAL chain.soroban / horizonSubmit (sequence lock included) over a testnet-shaped RPC. */
  const realChain = () => {
    const f = fakeChainRpc();
    const c = createChain({ ...chainBase, rpc: f.rpc, fetch: f.fetch });
    return { f, c, chain: { sponsor: c.sponsor, soroban: c.soroban, horizonSubmit: c.horizonSubmit, withSponsorLock: c.withSponsorLock, identity: c.identity, accountExists: c.accountExists } };
  };
  /** users.owner_address is UNIQUE: every user gets its own C-address. */
  const newAgent = async (owner: string | null = StrKey.encodeContract(randomBytes(32))) => {
    const userId = await insertUser(sql, { ownerAddress: owner });
    return { userId, owner, id: await insertAgent(sql, userId) };
  };
  const stateOf = async (id: string) =>
    ((await sql`select status, stellar_address, agent_id, provision_state from app.agents where id = ${id}`) as AgentRow[])[0]!;
  const provisioner = (create: Create | undefined, over: Partial<Parameters<typeof createProvisioner>[0]> = {}) =>
    createProvisioner({ sql, keys, chain: chainWithFakeSoroban().chain, signRequests: noSigning, publicBaseUrl: BASE, create, retryDelayMs: 1, ...over });

  it('under FEE_MODEL=agent an agent not yet funded is born paused; a funded or free one is born active', async () => {
    const due = await newAgent();
    await sql`update app.agents set reserve_state = 'due' where id = ${due.id}`;
    await provisioner(okCreate([]), { feeModel: 'agent' }).start(due.id);
    expect((await stateOf(due.id)).status).toBe('paused');
    const [flag] = (await sql`select paused_for_funds from app.agents where id = ${due.id}`) as { paused_for_funds: boolean }[];
    expect(flag!.paused_for_funds).toBe(true);
    const sponsored = await newAgent();
    await sql`update app.agents set reserve_state = 'due' where id = ${sponsored.id}`;
    await provisioner(okCreate([]), { feeModel: 'sponsor' }).start(sponsored.id);
    expect((await stateOf(sponsored.id)).status).toBe('active');
  });

  it('an agent activated after its first cron slot does not fire the missed slot', async () => {
    const { userId, id } = await newAgent();
    const specs = createSpecs(sql);
    const cron: TriggerSpec = { kind: 'cron', cron: '*/15 * * * *', mission: 'Report XLM.' };
    const condition: TriggerSpec = { kind: 'condition', fetch: { tool: 'market_price', args: { ids: ['stellar'] } }, code: 'return false', every_s: 600, cooldown_s: 3600, mission: 'Moved.' };
    await specs.approve(userId, id, await specs.saveDraft(userId, id, minimalSpec({ triggers: [cron, condition] })));
    await sql`update app.triggers set next_run_at = now() - interval '3 hours' where agent_id = ${id}`; // provisioning outlasted the slot
    await provisioner(okCreate([])).start(id);
    expect((await stateOf(id)).status).toBe('active');
    const t = (await sql`select kind, next_run_at <= now() as due, next_run_at - now() as wait from app.triggers where agent_id = ${id}`) as { kind: string; due: boolean; wait: string }[];
    const by = (k: string) => t.find((r) => r.kind === k)!;
    expect(by('cron').due).toBe(false); // jumped to the next future slot
    expect(by('condition').due).toBe(true); // condition triggers stay due immediately
  });

  it('creates the agent with the passkey owner, our sponsor, the stored key and our agentURI', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    const { id, owner } = await newAgent();
    const { chain } = chainWithFakeSoroban();
    await createProvisioner({ sql, keys, chain, signRequests: noSigning, publicBaseUrl: BASE, create: okCreate(calls) }).start(id);

    const a = await stateOf(id);
    expect([a.status, a.agent_id]).toEqual(['active', '42']);
    expect(a.stellar_address).toBe((await keys.publicKey(id))!);
    expect(a.provision_state).toEqual({
      step: 'active',
      attempts: [{ n: 1, publicKey: a.stellar_address!, startedAt: expect.any(String), outcome: 'active', agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) } }],
    });
    const o = calls[0]!;
    expect(o.network).toBe('stellar:testnet');
    expect(o.owner.address).toBe(owner!);
    expect(o.sponsor).toBe(chain.sponsor);
    // The library gets the chain's own seam; only `send` is wrapped (it notes the register tx hash and delegates).
    for (const k of Object.keys(chain.soroban) as (keyof SorobanSeam)[]) if (k !== 'send') expect(o.soroban![k]).toBe(chain.soroban[k]);
    expect(o.soroban!.send).not.toBe(chain.soroban.send);
    expect(o.agentUri).toBe(`${BASE}/a/${id}/agent.json`);
    expect(o.agentSigner.publicKey).toBe(a.stellar_address!);
    // The library gets a signer, never the key: the key stays in the vault and is the agent's address.
    expect(o.keypair).toBeUndefined();
    expect(await rawKeys.withSecret(id, async (kp) => kp.publicKey())).toBe(a.stellar_address!);
  });

  it('routes each owner auth entry to a sign request of the matching kind', async () => {
    const seen: SignRequestInput[] = [];
    const { userId, id, owner } = await newAgent();
    const ownerC = owner!;
    const create: Create = async (o) => {
      const reg = b64(authEntry({ signer: ownerC, fn: 'register_with_uri', args: [scv.addr(ownerC), scv.str(o.agentUri)] }));
      const bind = b64(authEntry({ signer: ownerC, fn: 'set_agent_wallet', args: [scv.addr(ownerC), scv.u32(42), scv.addr(o.agentSigner.publicKey)] }));
      expect(await o.owner.signAuthEntry(reg, 5100, TESTNET.passphrase)).toBe('signed-register');
      expect(await o.owner.signAuthEntry(bind, 5101, TESTNET.passphrase)).toBe('signed-bind');
      return okCreate([])(o);
    };
    const signRequests = { request: async (i: SignRequestInput) => (seen.push(i), `signed-${i.kind}`) };
    await provisioner(create, { signRequests }).start(id);
    expect(seen.map((s) => [s.kind, s.userId, s.agentId, s.validUntilLedger, s.networkPassphrase])).toEqual([
      ['register', userId, id, 5100, TESTNET.passphrase],
      ['bind', userId, id, 5101, TESTNET.passphrase],
    ]);
  });

  it('a user without a passkey wallet fails before any key exists or anything is sent', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    const { id } = await newAgent(null);
    await provisioner(okCreate(calls)).start(id);
    const a = await stateOf(id);
    expect(a.provision_state).toEqual({ step: 'failed', attempts: [], error: 'no_owner_wallet' });
    expect(await keys.publicKey(id)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('tx 1 fails → nothing landed → the retry reuses the same key', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    const { id } = await newAgent();
    await provisioner(failingCreate(calls, new Error('chain: Horizon submit failed: 400 Transaction Failed {"transaction":"tx_failed"}'))).start(id);
    let a = await stateOf(id);
    expect(a.status).toBe('provisioning');
    expect(a.provision_state.step).toBe('failed');
    expect(a.provision_state.error).toBe('chain_error');
    expect(a.provision_state.attempts[0]).toMatchObject({ n: 1, outcome: 'failed', code: 'chain_error' });
    expect(a.provision_state.attempts[0]!.txs).toBeUndefined();
    const firstKey = a.stellar_address;

    const asked: string[] = [];
    await provisioner(okCreate(calls), { chain: chainWithFakeSoroban({ accountExists: async (g) => (asked.push(g), false) }).chain }).start(id);
    a = await stateOf(id);
    expect(a.status).toBe('active');
    expect(asked).toEqual([firstKey!]); // M3: the chain was asked before the key was reused
    expect(a.stellar_address).toBe(firstKey);
    expect(calls[1]!.agentSigner.publicKey).toBe(firstKey!);
    expect(((await sql`select count(*)::int as n from keyvault.keys where agent_id = ${id}`) as { n: number }[])[0]!.n).toBe(1);
  });

  it('the owner never signs after tx 1 → the attempt records the landed account → the retry rotates the key', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    const { id } = await newAgent();
    await provisioner(failingCreate(calls, signRequestError('owner_timeout'), { account: 'a'.repeat(64) })).start(id);
    let a = await stateOf(id);
    expect(a.provision_state.error).toBe('owner_timeout');
    expect(a.provision_state.attempts[0]).toMatchObject({ code: 'owner_timeout', txs: { account: 'a'.repeat(64) } });
    const firstKey = a.stellar_address!;

    await provisioner(okCreate(calls)).start(id);
    a = await stateOf(id);
    expect(a.status).toBe('active');
    expect(a.stellar_address).not.toBe(firstKey);
    expect(calls[1]!.agentSigner.publicKey).toBe(a.stellar_address!);
    expect(a.provision_state.attempts.map((x) => x.publicKey)).toEqual([firstKey, a.stellar_address!]);
    const rows = (await sql`select public_key, destroyed_at from keyvault.keys where agent_id = ${id} order by created_at`) as { public_key: string; destroyed_at: Date | null }[];
    expect(rows.map((r) => [r.public_key, r.destroyed_at === null])).toEqual([[firstKey, false], [a.stellar_address!, true]]);
    // The abandoned key is visible on the agent row: address + landed tx hashes, never the secret.
    expect(a.provision_state.orphans).toEqual([{ publicKey: firstKey, attempt: 1, txs: { account: 'a'.repeat(64) } }]);
  });

  it('the orphan record fails to save → the old key is not destroyed, no new key, nothing is created', async () => {
    const { id } = await newAgent();
    await provisioner(failingCreate([], signRequestError('owner_timeout'), { account: 'a'.repeat(64) })).start(id);
    const oldKey = (await keys.publicKey(id))!;
    // Injected Db wrapper: any write that carries an orphan list fails (deterministic, no timing).
    const failingOrphanWrite = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        if (args.slice(1).some((v) => !!v && typeof v === 'object' && 'orphans' in v)) return Promise.reject(new Error('db: connection lost'));
        return Reflect.apply(target, thisArg, args);
      },
    }) as Db;
    const calls: AuthOwnerRemoteOptions[] = [];
    const events: Parameters<ProvisionLog>[0][] = [];
    await provisioner(okCreate(calls), { sql: failingOrphanWrite, log: (e) => events.push(e) }).start(id);
    expect(calls).toHaveLength(0);
    expect(await keys.publicKey(id)).toBe(oldKey);
    expect(((await sql`select count(*)::int as n from keyvault.keys where agent_id = ${id}`) as { n: number }[])[0]!.n).toBe(1);
    const a = await stateOf(id);
    expect([a.provision_state.step, a.provision_state.error, a.provision_state.orphans]).toEqual(['failed', 'owner_timeout', undefined]);
    expect(events).toEqual([{ event: 'provision_error', agent: id, errName: 'Error' }]);
  });

  it('registered but not bound → the attempt records the registry id and both hashes; the agent stays provisioning', async () => {
    const { id } = await newAgent();
    await provisioner(failingCreate([], signRequestError('owner_rejected'), { account: 'a'.repeat(64), register: 'b'.repeat(64) }, '42')).start(id);
    const a = await stateOf(id);
    expect([a.status, a.agent_id]).toEqual(['provisioning', null]);
    expect(a.provision_state.attempts[0]).toMatchObject({ code: 'owner_rejected', agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) } });
  });

  it('a sign request our own server refuses (a config bug) fails as sign_request_refused, not chain_error', async () => {
    for (const code of ['signer_not_owner', 'agent_not_owned', 'validity_too_long'] as const) {
      const { id } = await newAgent();
      const create: Create = async (o) => {
        const reg = b64(authEntry({ signer: o.owner.address, fn: 'register_with_uri', args: [scv.addr(o.owner.address), scv.str(o.agentUri)] }));
        try {
          await o.owner.signAuthEntry(reg, 5100, TESTNET.passphrase);
        } catch (e) {
          throw Object.assign(e as Error, { partial: { publicKey: o.agentSigner.publicKey, secret: MARKER_SECRET, owner: o.owner.address, txs: { account: 'a'.repeat(64) } } });
        }
        throw new Error('unreachable');
      };
      const signRequests = { request: async (): Promise<string> => { throw signRequestError(code); } };
      expect(await provisioner(create, { signRequests }).start(id)).toEqual({ outcome: 'failed', code: 'sign_request_refused' });
      const a = await stateOf(id);
      expect([a.provision_state.step, a.provision_state.error, a.provision_state.attempts[0]!.code]).toEqual(['failed', 'sign_request_refused', 'sign_request_refused']);
    }
    // Timing, not config: an entry already expired when asked stays a chain_error.
    const { id } = await newAgent();
    const expired = { request: async (): Promise<string> => { throw signRequestError('already_expired'); } };
    const create: Create = async (o) => o.owner.signAuthEntry(b64(authEntry({ signer: o.owner.address, fn: 'register_with_uri', args: [scv.addr(o.owner.address), scv.str(o.agentUri)] })), 5100, TESTNET.passphrase) as never;
    expect(await provisioner(create, { signRequests: expired }).start(id)).toEqual({ outcome: 'failed', code: 'chain_error' });
  });

  it('never logs or stores the error object or the secret it carries', async () => {
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => spyOn(console, m));
    const events: Parameters<ProvisionLog>[0][] = [];
    let secret = '';
    const create: Create = async (o) => {
      secret = MARKER_SECRET;
      throw Object.assign(signRequestError('owner_timeout'), {
        partial: { publicKey: o.agentSigner.publicKey, secret, owner: o.owner.address, txs: { account: 'a'.repeat(64) } },
      });
    };
    const { id } = await newAgent();
    await provisioner(create, { log: (e) => events.push(e) }).start(id);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
    expect(events).toEqual([
      { event: 'provision_started', agent: id, attempt: 1 },
      { event: 'provision_failed', agent: id, attempt: 1, code: 'owner_timeout', txs: { account: 'a'.repeat(64) } },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(await sql`select * from app.agents where id = ${id}`)).not.toContain(secret);
  });

  it('boot recovery: a provision caught mid-flight becomes failed:interrupted, its sign requests expire, the retry rotates', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    const { userId, id } = await newAgent();
    const { publicKey } = await keys.generate(id);
    const stuck: ProvisionState = { step: 'creating', attempts: [{ n: 1, publicKey, startedAt: new Date().toISOString() }] };
    // jsonb is written as a plain object (verified facts): JSON.stringify(...)::jsonb would store a string.
    await sql`update app.agents set provision_state = ${stuck}, stellar_address = ${publicKey} where id = ${id}`;
    await sql`insert into app.sign_requests (user_id, agent_id, kind, entry_xdr, valid_until_ledger, network_passphrase, expires_at)
              values (${userId}, ${id}, 'register', 'AAAA', 5100, ${TESTNET.passphrase}, ${new Date(Date.now() + 60_000)})`;
    const p = provisioner(okCreate(calls));
    expect(await p.recoverInterrupted()).toBe(1);
    let a = await stateOf(id);
    expect(a.provision_state).toEqual({ step: 'failed', error: 'interrupted', attempts: [{ ...stuck.attempts[0]!, outcome: 'failed', code: 'interrupted' }] });
    const [sr] = (await sql`select status from app.sign_requests where agent_id = ${id}`) as { status: string }[];
    expect(sr!.status).toBe('expired');
    await p.start(id);
    a = await stateOf(id);
    expect(a.status).toBe('active');
    expect(a.stellar_address).not.toBe(publicKey);
    expect(a.provision_state.orphans).toEqual([{ publicKey, attempt: 1, txs: {} }]);
  });

  it('a second start while one runs is a no-op', async () => {
    const calls: AuthOwnerRemoteOptions[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Create = async (o) => {
      calls.push(o);
      await gate;
      return okCreate([])(o);
    };
    const { id } = await newAgent();
    const p = provisioner(slow);
    const first = p.start(id);
    await p.start(id);
    release();
    await first;
    expect(calls).toHaveLength(1);
  });

  const keyCount = async (id: string) => ((await sql`select count(*)::int as n from keyvault.keys where agent_id = ${id}`) as { n: number }[])[0]!.n;

  it('a first start that died at pending (key made, key_ready never saved) is retried and completes with that key', async () => {
    const { id } = await newAgent();
    const calls: AuthOwnerRemoteOptions[] = [];
    // Deterministic: the key_ready save fails, so the row stays pending while a live key exists.
    expect(await provisioner(okCreate(calls), { sql: failingWrites((s) => s.step === 'key_ready') }).start(id)).toEqual({ outcome: 'error' });
    const live = (await keys.publicKey(id))!;
    expect((await stateOf(id)).provision_state).toEqual({ step: 'pending', attempts: [] });
    expect(calls).toHaveLength(0);

    expect(await provisioner(okCreate(calls)).start(id)).toEqual({ outcome: 'active' });
    const a = await stateOf(id);
    expect([a.status, a.stellar_address, a.provision_state.orphans]).toEqual(['active', live, undefined]);
    expect(calls[0]!.agentSigner.publicKey).toBe(live);
    expect(await keyCount(id)).toBe(1);
  });

  it('a start that died at key_ready is retried with the SAME key: no new key, no orphan', async () => {
    const { id } = await newAgent();
    const calls: AuthOwnerRemoteOptions[] = [];
    // The creating save fails: the row stays key_ready, nothing was sent.
    expect(await provisioner(okCreate(calls), { sql: failingWrites((s) => s.step === 'creating') }).start(id)).toEqual({ outcome: 'error' });
    const before = await stateOf(id);
    expect(before.provision_state).toEqual({ step: 'key_ready', attempts: [] });
    const live = before.stellar_address!;
    expect(await keys.publicKey(id)).toBe(live);
    expect(calls).toHaveLength(0);

    expect(await provisioner(okCreate(calls)).start(id)).toEqual({ outcome: 'active' });
    const a = await stateOf(id);
    expect([a.status, a.stellar_address, a.provision_state.orphans]).toEqual(['active', live, undefined]);
    expect(a.provision_state.attempts).toHaveLength(1);
    expect(calls[0]!.agentSigner.publicKey).toBe(live);
    expect(await keyCount(id)).toBe(1);
  });

  it('with the real library and a testnet-shaped seam: registers with the C owner and binds the stored key', async () => {
    const { id, owner } = await newAgent();
    const { f, chain } = chainWithFakeSoroban();
    await createProvisioner({ sql, keys, chain, signRequests: signing(), publicBaseUrl: BASE }).start(id);
    const a = await stateOf(id);
    expect([a.status, a.agent_id]).toEqual(['active', '42']);
    expect(a.provision_state.attempts[0]!.txs).toEqual({ account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) });
    expect(Address.fromScVal(argsOf(f.r.sent[0]!)[0]!).toString()).toBe(owner!);
    expect(argsOf(f.r.sent[1]!)[2] && Address.fromScVal(argsOf(f.r.sent[1]!)[2]!).toString()).toBe(a.stellar_address!);
    for (const t of f.r.sent) expect(t.source).toBe(sponsorKp.publicKey());
  });

  it('the bind request carries the register tx hash provision saw sent; the register request carries none', async () => {
    const { id } = await newAgent();
    const { chain } = chainWithFakeSoroban();
    const seen: SignRequestInput[] = [];
    const inner = signing();
    await createProvisioner({ sql, keys, chain, signRequests: { request: async (i) => (seen.push(i), inner.request(i)) }, publicBaseUrl: BASE }).start(id);
    expect((await stateOf(id)).status).toBe('active');
    expect(seen.map((i) => [i.kind, i.registerTx])).toEqual([
      ['register', undefined],
      ['bind', 'b'.repeat(64)],
    ]);
  });

  /** The real chain, with its sponsor lock observed: enter/exit counts and how many holds overlap. */
  const observedChain = () => {
    const { f, c, chain } = realChain();
    const seen = { held: 0, maxHeld: 0, holds: 0, promptsInside: 0 };
    const withSponsorLock: Chain['withSponsorLock'] = (fn, lease) =>
      c.withSponsorLock(async () => {
        seen.held++;
        return inHold.run(true, async () => {
        seen.holds++;
        seen.maxHeld = Math.max(seen.maxHeld, seen.held);
        try {
          return await fn();
        } finally {
          seen.held--;
        }
        });
      }, lease);
    return { f, c, seen, chain: { ...chain, withSponsorLock } };
  };

  it('sponsorLock: each sponsor-sourced tx is one hold; an owner prompt never happens inside one', async () => {
    const A = await newAgent();
    const B = await newAgent();
    const { f, c, seen, chain } = observedChain();
    // A's register prompt stays open until B is at its own: if a hold spanned the prompt, B could never
    // get there and this test would hang. So a slow passkey does not block other creations.
    let bAtPrompt!: () => void;
    const bReached = new Promise<void>((r) => (bAtPrompt = r));
    const owner = signing();
    const signRequests = {
      request: async (i: SignRequestInput) => {
        // Inside a hold of THIS creation's call chain (another creation's hold may legally overlap the prompt).
        if (inHold.getStore()) seen.promptsInside++;
        if (i.agentId === B.id && i.kind === 'register') bAtPrompt();
        if (i.agentId === A.id && i.kind === 'register') await bReached;
        return owner.request(i);
      },
    };
    const p = createProvisioner({ sql, keys, chain, signRequests, publicBaseUrl: BASE });
    await Promise.all([p.start(A.id), p.start(B.id)]);
    expect([(await stateOf(A.id)).status, (await stateOf(B.id)).status]).toEqual(['active', 'active']);
    expect(seen.holds).toBe(6); // per agent: account, register, bind
    expect(seen.maxHeld).toBe(1); // never two sponsor sections at once, never nested
    expect(seen.promptsInside).toBe(0);
    expect(f.r.badSeq).toBe(0);
    expect(await stillBlocked(c.withSponsorLock(async () => true))).toBe(false);
  });

  it('sponsorLock: a failed sponsor section releases the lock at once, and the next creation proceeds', async () => {
    const A = await newAgent();
    const B = await newAgent();
    const { f, c, chain } = realChain();
    // Reject the first register send (a real RPC ERROR/TRY_AGAIN_LATER surfaces as a throw here).
    let rejected = false;
    const soroban: SorobanSeam = {
      ...c.soroban,
      send: async (tx) => {
        if (!rejected && callOf(tx) === 'register_with_uri') {
          rejected = true;
          throw new Error('chain: sendTransaction returned TRY_AGAIN_LATER');
        }
        return c.soroban.send(tx);
      },
    };
    const p = createProvisioner({ sql, keys, chain: { ...chain, soroban }, signRequests: signing(), publicBaseUrl: BASE, retryDelayMs: 1 });
    await p.start(A.id);
    expect((await stateOf(A.id)).status).not.toBe('active');
    // Not waiting out the 30 s lease: the lock is free right now.
    expect(await stillBlocked(c.withSponsorLock(async () => true))).toBe(false);
    await p.start(B.id);
    expect((await stateOf(B.id)).status).toBe('active');
    expect(f.r.badSeq).toBe(0);
  });

  it('two interleaved runs through chain.soroban get consecutive sponsor sequences (plan D9, from Task 5)', async () => {
    const A = await newAgent();
    const B = await newAgent();
    const { f, c, chain } = realChain();
    // Deterministic interleave, no sleeps: A's register prompt waits until B has built and recorded its
    // own register call, so both runs' enforcing builds race for the sponsor's sequence.
    let bAtOwner!: () => void;
    const bReached = new Promise<void>((r) => (bAtOwner = r));
    const owner = signing();
    const signRequests = {
      request: async (i: SignRequestInput) => {
        if (i.agentId === B.id && i.kind === 'register') bAtOwner();
        if (i.agentId === A.id && i.kind === 'register') await bReached;
        return owner.request(i);
      },
    };
    const p = createProvisioner({ sql, keys, chain, signRequests, publicBaseUrl: BASE });
    await Promise.all([p.start(A.id), p.start(B.id)]);

    const a = await stateOf(A.id);
    const b = await stateOf(B.id);
    expect([a.status, b.status]).toEqual(['active', 'active']);
    expect(new Set([a.agent_id, b.agent_id])).toEqual(new Set(['42', '43']));
    expect(f.r.badSeq).toBe(0);
    // 2 accounts + 2 registers + 2 binds, every one sponsor-sourced on its own consecutive sequence.
    expect(f.r.accepted.map((t) => t.source)).toEqual(Array(6).fill(sponsorKp.publicKey()));
    expect(f.r.accepted.map((t) => t.sequence)).toEqual(['101', '102', '103', '104', '105', '106']);
    // Each bind carries its own agent's key, under its own registry id.
    const binds = f.r.sent.filter((t) => fnOf(t) === 'set_agent_wallet');
    expect(new Set(binds.map((t) => Address.fromScVal(argsOf(t)[2]!).toString()))).toEqual(new Set([a.stellar_address!, b.stellar_address!]));
    for (const [row, t] of [a, b].map((r) => [r, binds.find((x) => Address.fromScVal(argsOf(x)[2]!).toString() === r.stellar_address)!] as const)) {
      expect(String(argsOf(t)[1]!.u32())).toBe(row.agent_id!);
    }
    expect(await stillBlocked(c.withSponsorLock(async () => true))).toBe(false);
  });

  it('control: the same interleave on a seam WITHOUT the sponsor lock collides on the sequence', async () => {
    // Proves the interleaved test above can fail: drop only the lock (getAccount straight to RPC).
    const A = await newAgent();
    const B = await newAgent();
    const { f, c } = realChain();
    // After the gate, hold the first sponsor read until the second has also read, so both enforcing
    // builds see the same sequence before either sends (a collision every run, not a timing accident).
    let gated = false;
    let sponsorReads = 0;
    let bothRead!: () => void;
    const both = new Promise<void>((r) => (bothRead = r));
    const unlocked: SorobanSeam = {
      ...c.soroban,
      getAccount: async (who) => {
        const acc = await f.rpc.getAccount(who);
        if (gated && who === c.sponsorPublicKey) {
          if (++sponsorReads === 2) bothRead();
          await both;
        }
        return acc;
      },
    };
    let bAtOwner!: () => void;
    const bReached = new Promise<void>((r) => (bAtOwner = r));
    let aAtOwner!: () => void;
    const aReached = new Promise<void>((r) => (aAtOwner = r));
    let openGate!: () => void;
    const gateOpen = new Promise<void>((r) => (openGate = r));
    const owner = signing();
    const signRequests = {
      request: async (i: SignRequestInput) => {
        if (i.agentId === B.id && i.kind === 'register') {
          bAtOwner();
          await gateOpen;
        }
        if (i.agentId === A.id && i.kind === 'register') {
          aAtOwner();
          await bReached;
          gated = true;
          openGate();
        }
        return owner.request(i);
      },
    };
    const p = createProvisioner({ sql, keys, chain: { sponsor: c.sponsor, soroban: unlocked, horizonSubmit: c.horizonSubmit, ...reads() }, signRequests, publicBaseUrl: BASE });
    // B starts once A waits at its owner prompt, so the account txs (whose agent signature now takes a vault
    // round trip) never collide first: the collision this control proves is the gated register one.
    const startA = p.start(A.id);
    await aReached;
    await Promise.all([startA, p.start(B.id)]);
    expect(f.r.badSeq).toBeGreaterThan(0);
    const states = [await stateOf(A.id), await stateOf(B.id)];
    expect(states.filter((s) => s.provision_state.error === 'chain_error')).not.toHaveLength(0);
  });

  const guarded = async (limits: { live: number; sponsoredStartsPerDay: number }, setup: (sql: Db, userId: string) => Promise<string>) => {
    const other = await freshDb();
    try {
      const otherKeys = localAgentKeys(createVault({ sql: other.sql, keys: createKeys(other.sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }) }));
      const userId = await insertUser(other.sql, { ownerAddress: ownerC });
      const id = await setup(other.sql, userId);
      const calls: AuthOwnerRemoteOptions[] = [];
      const f = fakeSoroban();
      const c = createChain(chainBase);
      const out = await createProvisioner({
        sql: other.sql,
        keys: otherKeys,
        chain: { sponsor: c.sponsor, soroban: f.soroban, horizonSubmit: f.horizonSubmit, ...reads() },
        signRequests: noSigning,
        publicBaseUrl: BASE,
        create: okCreate(calls),
        limits,
      }).start(id);
      const [row] = (await other.sql`select status, provision_state from app.agents where id = ${id}`) as AgentRow[];
      return { out, state: row!.provision_state, key: await otherKeys.publicKey(id), calls: calls.length, chain: f.r.sent.length + f.r.submitted.length };
    } finally {
      await other.drop();
    }
  };

  it('over the account limit: an agent past it (made later) is refused before any key or chain call', async () => {
    const r = await guarded({ live: 1, sponsoredStartsPerDay: 10 }, async (sql, userId) => {
      await insertAgent(sql, userId, { status: 'active' });
      return insertAgent(sql, userId);
    });
    expect(r.out).toEqual({ outcome: 'failed', code: 'agent_limit' });
    expect(r.state).toEqual({ step: 'failed', attempts: [], error: 'agent_limit' });
    expect([r.key, r.calls, r.chain]).toEqual([null, 0, 0]);
  });

  it('under the account limit, a second agent provisions', async () => {
    const r = await guarded({ live: 2, sponsoredStartsPerDay: 10 }, async (sql, userId) => {
      await insertAgent(sql, userId, { status: 'active' });
      return insertAgent(sql, userId);
    });
    expect(r.out.outcome).toBe('active');
  });

  it('an account limit (app.users.agent_limit) lets an agent past the default ceiling provision', async () => {
    const r = await guarded({ live: 1, sponsoredStartsPerDay: 10 }, async (sql, userId) => {
      await sql`update app.users set agent_limit = 2 where id = ${userId}`;
      await insertAgent(sql, userId, { status: 'active' });
      return insertAgent(sql, userId);
    });
    expect(r.out.outcome).toBe('active');
  });

  it('the sponsor ceiling: attempts of every agent of the account in the last day count; at it, nothing is sent', async () => {
    const recent = (n: number) => ({ step: 'failed', error: 'chain_error', attempts: Array.from({ length: n }, (_, i) => ({ n: i + 1, publicKey: 'G', startedAt: new Date().toISOString(), outcome: 'failed', code: 'chain_error' })) });
    const old = { step: 'active', attempts: [{ n: 1, publicKey: 'G', startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), outcome: 'active' }] };
    const r = await guarded({ live: 5, sponsoredStartsPerDay: 3 }, async (sql, userId) => {
      const a = await insertAgent(sql, userId, { status: 'active' });
      await sql`update app.agents set provision_state = ${old} where id = ${a}`;
      const b = await insertAgent(sql, userId, { status: 'revoked' });
      await sql`update app.agents set provision_state = ${recent(2)} where id = ${b}`;
      const c = await insertAgent(sql, userId);
      await sql`update app.agents set provision_state = ${recent(1)} where id = ${c}`;
      return c;
    });
    expect(r.out).toEqual({ outcome: 'failed', code: 'sponsor_limit' });
    expect(r.state.error).toBe('sponsor_limit');
    expect([r.calls, r.chain]).toEqual([0, 0]);
  });

  it('with the real library: the owner refuses the bind → failed:owner_rejected with the registry id recorded', async () => {
    const { id } = await newAgent();
    const { f, chain } = chainWithFakeSoroban();
    await createProvisioner({ sql, keys, chain, signRequests: signing('bind'), publicBaseUrl: BASE }).start(id);
    const a = await stateOf(id);
    expect(a.provision_state.error).toBe('owner_rejected');
    expect(a.provision_state.attempts[0]).toMatchObject({ agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) } });
    expect(a.provision_state.attempts[0]!.txs!.bind).toBeUndefined();
    // Nothing after the refusal runs: only the register tx was ever sent.
    expect(f.r.sent.map(fnOf)).toEqual(['register_with_uri']);
  });

  describe('fix round 1: a bound agent never loses its key', () => {
    it('C1/C3: create succeeds, the first final save fails, a retry lands → active, key kept, nothing re-run', async () => {
      const { id } = await newAgent();
      let failures = 1;
      const flaky = failingWrites((s) => s.step === 'active', () => failures-- > 0);
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const events: Parameters<ProvisionLog>[0][] = [];
      await provisioner(okCreate(calls), { sql: flaky, keys: k, log: (e) => events.push(e) }).start(id);
      const a = await stateOf(id);
      expect([a.status, a.agent_id, a.provision_state.step]).toEqual(['active', '42', 'active']);
      expect(a.stellar_address).toBe((await keys.publicKey(id))!);
      expect([calls.length, destroyed]).toEqual([1, []]);
      expect(events.map((e) => e.event)).toEqual(['provision_started', 'provision_active']);
    });

    it('C2: provision_active is logged with every public hash and the registry id BEFORE the save', async () => {
      const { id } = await newAgent();
      const events: Parameters<ProvisionLog>[0][] = [];
      await provisioner(okCreate([]), { sql: failingWrites((s) => s.step === 'active'), log: (e) => events.push(e) }).start(id);
      expect(events).toEqual([
        { event: 'provision_started', agent: id, attempt: 1 },
        { event: 'provision_active', agent: id, attempt: 1, agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64), bind: 'c'.repeat(64) } },
        { event: 'provision_error', agent: id, errName: 'Error' },
      ]);
      expect((await stateOf(id)).provision_state.step).toBe('creating'); // DB stayed down: boot recovery's job
    });

    it('M8: provision_failed carries the register hash and the registry id', async () => {
      const { id } = await newAgent();
      const events: Parameters<ProvisionLog>[0][] = [];
      await provisioner(failingCreate([], signRequestError('owner_rejected'), { account: 'a'.repeat(64), register: 'b'.repeat(64) }, '42'), { log: (e) => events.push(e) }).start(id);
      expect(events.at(-1)).toEqual({ event: 'provision_failed', agent: id, attempt: 1, code: 'owner_rejected', agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) } });
    });

    it('C4: the registry id and the bind expiry are on the row before the owner is asked to bind', async () => {
      const { id } = await newAgent();
      const seenAtBind: [string | undefined, number | undefined][] = [];
      const owner = signing();
      const signRequests = {
        request: async (i: SignRequestInput) => {
          const last = (await stateOf(id)).provision_state.attempts.at(-1)!;
          if (i.kind === 'bind') seenAtBind.push([last.agentId, last.bindValidUntil]);
          return owner.request(i);
        },
      };
      await createProvisioner({ sql, keys, chain: chainWithFakeSoroban().chain, signRequests, publicBaseUrl: BASE }).start(id);
      expect(seenAtBind).toEqual([['42', 5100]]); // fake latestLedger 5000 + the library's 100
      expect((await stateOf(id)).status).toBe('active');
    });

    it('(d) the progress save fails → no bind sign request is created and no bind is sent', async () => {
      const { id } = await newAgent();
      const { f, chain } = chainWithFakeSoroban();
      const kinds: string[] = [];
      const owner = signing();
      const signRequests = { request: async (i: SignRequestInput) => (kinds.push(i.kind), owner.request(i)) };
      const progressDown = failingWrites((s) => s.step === 'creating' && !!s.attempts.at(-1)?.agentId);
      await createProvisioner({ sql: progressDown, keys, chain, signRequests, publicBaseUrl: BASE, retryDelayMs: 1 }).start(id);
      expect(kinds).toEqual(['register']);
      expect(f.r.sent.map(fnOf)).toEqual(['register_with_uri']);
      const a = await stateOf(id);
      expect([a.status, a.provision_state.step, a.provision_state.error]).toEqual(['provisioning', 'failed', 'chain_error']);
      expect(a.provision_state.attempts[0]).toMatchObject({ agentId: '42', txs: { account: 'a'.repeat(64), register: 'b'.repeat(64) } });
    });

    /** Real library run whose final saves all fail, then boot recovery: the row is failed:interrupted with agentId 42, bind valid until 5100. */
    const interruptedAfterBind = async () => {
      const { id, owner } = await newAgent();
      const down = failingWrites(isFinal);
      await createProvisioner({ sql: down, keys, chain: chainWithFakeSoroban().chain, signRequests: signing(), publicBaseUrl: BASE, retryDelayMs: 1 }).start(id);
      await provisioner(undefined).recoverInterrupted();
      const a = await stateOf(id);
      const last = a.provision_state.attempts.at(-1)!;
      expect([a.provision_state.error, last.agentId, last.bindValidUntil]).toEqual(['interrupted', '42', 5100]);
      return { id, owner: owner!, key: (await keys.publicKey(id))! };
    };
    /** A start that must leave the key, create nothing and log provision_deferred with `reason`. */
    const expectDeferred = async (id: string, key: string, chain: ReturnType<typeof chainWithFakeSoroban>['chain'], reason: string) => {
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const events: Parameters<ProvisionLog>[0][] = [];
      const before = (await stateOf(id)).provision_state;
      const outcome = await provisioner(okCreate(calls), { keys: k, chain, log: (e) => events.push(e) }).start(id);
      expect([destroyed, calls.length, await keys.publicKey(id)]).toEqual([[], 0, key]);
      expect(events).toEqual([{ event: 'provision_deferred', agent: id, attempt: 1, agentId: '42', code: reason }]);
      expect((await stateOf(id)).provision_state).toEqual(before); // still failed: retried later
      expect(outcome).toMatchObject({ outcome: 'deferred', code: reason }); // returned, so the gateway can surface it
      return outcome;
    };

    it('C5/C6: DB down for every final save → interrupted → the registry shows OUR key bound → active, key never destroyed', async () => {
      const { id, owner, key } = await interruptedAfterBind();
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const asked: string[] = [];
      const chain = chainWithFakeSoroban({ identity: async (agentId) => (asked.push(agentId), { owner, wallet: key, ledger: 5000 }) }).chain;
      expect(await provisioner(okCreate(calls), { keys: k, chain }).start(id)).toEqual({ outcome: 'active' });
      const a = await stateOf(id);
      expect([a.status, a.agent_id, a.stellar_address, a.provision_state.step]).toEqual(['active', '42', key, 'active']);
      expect(a.provision_state.attempts.at(-1)).toMatchObject({ n: 1, publicKey: key, outcome: 'active', agentId: '42' });
      expect(a.provision_state.orphans).toBeUndefined();
      expect([asked, destroyed, calls.length]).toEqual([['42'], [], 0]);
      expect(await keys.publicKey(id)).toBe(key);
    });

    it('(c) our key bound under ANOTHER owner → never destroyed: failed:bound_foreign_owner, left for an operator', async () => {
      const { id, key } = await interruptedAfterBind();
      const foreign = contractAddress(9);
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const events: Parameters<ProvisionLog>[0][] = [];
      const chain = chainWithFakeSoroban({ identity: async () => ({ owner: foreign, wallet: key, ledger: 9_999_999 }) }).chain;
      const p = provisioner(okCreate(calls), { keys: k, chain, log: (e) => events.push(e) });
      expect(await p.start(id)).toEqual({ outcome: 'failed', code: 'bound_foreign_owner' });
      expect(await p.start(id)).toEqual({ outcome: 'failed', code: 'bound_foreign_owner' }); // an operator case stays put on every later start
      const a = await stateOf(id);
      expect([a.status, a.provision_state.step, a.provision_state.error, a.stellar_address]).toEqual(['provisioning', 'failed', 'bound_foreign_owner', key]);
      expect(a.provision_state.orphans).toBeUndefined();
      expect([destroyed, calls.length, await keys.publicKey(id)]).toEqual([[], 0, key]);
      expect(events).toEqual([{ event: 'provision_failed', agent: id, attempt: 1, agentId: '42', code: 'bound_foreign_owner' }]);
    });

    // stellar-8004 sets a new agent's wallet to its owner at registration: that is how an unbound agent reads.
    for (const [label, walletOf] of [
      ['unbound as registered (wallet = its owner)', (o: string): string | null => o],
      ['unbound (no wallet)', (): string | null => null],
      ['bound to another key', (): string | null => Keypair.random().publicKey()],
    ] as const) {
      it(`(a) ${label}, bind entry still valid (simulated at 5100 ≤ 5100) → deferred, no destroy`, async () => {
        const { id, owner, key } = await interruptedAfterBind();
        const out = await expectDeferred(id, key, chainWithFakeSoroban({ identity: async () => ({ owner, wallet: walletOf(owner), ledger: 5100 }) }).chain, 'bind_window_open');
        expect(out).toEqual({ outcome: 'deferred', code: 'bind_window_open', retryAfterLedger: 5101 });
      });

      it(`(a) ${label}, RPC lag: the registry sim ran at 5100 but getLatestLedger says 9,999,999 → deferred, no destroy`, async () => {
        // The answer "not our key" is only as fresh as the simulation that gave it: a lagging RPC node may
        // not yet see a bind that landed at 5099. The window is judged by that sim's ledger, never a separate read.
        const { id, owner, key } = await interruptedAfterBind();
        await expectDeferred(id, key, chainWithFakeSoroban({ identity: async () => ({ owner, wallet: walletOf(owner), ledger: 5100 }), ledger: 9_999_999 }).chain, 'bind_window_open');
      });

      it(`(a) ${label}, bind entry expired (latest 5101 > 5100) → orphan first, then rotate`, async () => {
        const { id, owner, key } = await interruptedAfterBind();
        const calls: AuthOwnerRemoteOptions[] = [];
        await provisioner(okCreate(calls), { chain: chainWithFakeSoroban({ identity: async () => ({ owner, wallet: walletOf(owner), ledger: 5101 }), ledger: 5000 }).chain }).start(id);
        const a = await stateOf(id);
        expect(a.status).toBe('active');
        expect(a.stellar_address).not.toBe(key);
        expect(a.provision_state.orphans).toEqual([{ publicKey: key, attempt: 1, txs: {}, agentId: '42' }]);
        expect(calls[0]!.agentSigner.publicKey).toBe(a.stellar_address!);
      });
    }

    it('(a) no bindValidUntil on the row: deferred inside the 15 min floor, rotated after it', async () => {
      const { id, owner, key } = await interruptedAfterBind();
      const strip = async (startedAt: string) => {
        const st = (await stateOf(id)).provision_state;
        delete st.attempts[0]!.bindValidUntil;
        st.attempts[0]!.startedAt = startedAt;
        await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      };
      const unbound = chainWithFakeSoroban({ identity: async () => ({ owner, wallet: null, ledger: 9_999_999 }) }).chain;
      const startedAt = new Date(Date.now() - 14 * 60_000).toISOString();
      await strip(startedAt);
      const out = await expectDeferred(id, key, unbound, 'bind_window_open');
      expect(out).toEqual({ outcome: 'deferred', code: 'bind_window_open', retryAfter: new Date(Date.parse(startedAt) + 15 * 60_000).toISOString() });
      await strip(new Date(Date.now() - 16 * 60_000).toISOString());
      await provisioner(okCreate([]), { chain: unbound }).start(id);
      const a = await stateOf(id);
      expect([a.status, a.provision_state.orphans]).toEqual(['active', [{ publicKey: key, attempt: 1, txs: {}, agentId: '42' }]]);
    });

    it('(b) the registry knows no agent with our recorded id → deferred, no destroy', async () => {
      const { id, key } = await interruptedAfterBind();
      await expectDeferred(id, key, chainWithFakeSoroban({ identity: async () => null, ledger: 9_999_999 }).chain, 'registry_no_agent');
    });

    it('a registry read that fails → deferred; a Horizon read that fails → nothing rotates', async () => {
      const { id, key } = await interruptedAfterBind();
      await expectDeferred(id, key, chainWithFakeSoroban({ identity: async () => { throw new Error('chain: registry read failed'); } }).chain, 'registry_unreadable');

      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const t = await newAgent();
      await provisioner(failingCreate([], new Error('chain: Horizon submit failed: 504'))).start(t.id);
      const tKey = (await keys.publicKey(t.id))!;
      const horizonDown = chainWithFakeSoroban({ accountExists: async () => { throw new Error('chain: Horizon account read failed: 503'); } }).chain;
      await provisioner(okCreate(calls), { keys: k, chain: horizonDown }).start(t.id);
      expect([destroyed, calls.length, await keys.publicKey(t.id)]).toEqual([[], 0, tKey]);
    });

    it('Minor 4: sponsor contention is its own code: chain_busy', async () => {
      const { id } = await newAgent();
      const f = fakeChainRpc();
      const c = createChain({ ...chainBase, rpc: f.rpc, fetch: f.fetch, acquireTimeoutMs: 20 });
      let free!: () => void;
      const held = c.withSponsorLock(() => new Promise<void>((r) => (free = r)));
      const events: Parameters<ProvisionLog>[0][] = [];
      const out = await createProvisioner({ sql, keys, chain: { sponsor: c.sponsor, soroban: c.soroban, horizonSubmit: c.horizonSubmit, ...reads(), withSponsorLock: c.withSponsorLock }, signRequests: noSigning, publicBaseUrl: BASE, log: (e) => events.push(e) }).start(id);
      expect(out).toEqual({ outcome: 'failed', code: 'chain_busy' });
      free();
      await held;
      const a = await stateOf(id);
      expect([a.provision_state.error, a.provision_state.attempts[0]!.code, f.r.accepted.length]).toEqual(['chain_busy', 'chain_busy', 0]);
      expect(events.at(-1)).toEqual({ event: 'provision_failed', agent: id, attempt: 1, code: 'chain_busy' });
    });

    it('M3: tx 1 reported failed but the account exists on chain → orphan first, then rotate', async () => {
      const { id } = await newAgent();
      await provisioner(failingCreate([], new Error('chain: Horizon submit failed: 504'))).start(id);
      const firstKey = (await keys.publicKey(id))!;
      expect((await stateOf(id)).provision_state.attempts[0]!.txs).toBeUndefined();
      const calls: AuthOwnerRemoteOptions[] = [];
      await provisioner(okCreate(calls), { chain: chainWithFakeSoroban({ accountExists: async (g) => g === firstKey }).chain }).start(id);
      const a = await stateOf(id);
      expect(a.status).toBe('active');
      expect(a.stellar_address).not.toBe(firstKey);
      expect(a.provision_state.orphans).toEqual([{ publicKey: firstKey, attempt: 1, txs: {} }]);
    });

    it('M2: a live key that is not the last attempt\'s key is brand new and unused → reused, never destroyed', async () => {
      const { id } = await newAgent();
      const old = Keypair.random().publicKey();
      const { publicKey: fresh } = await keys.generate(id); // generated after the old key was destroyed; crash before key_ready
      const st: ProvisionState = {
        step: 'failed',
        error: 'owner_timeout',
        attempts: [{ n: 1, publicKey: old, startedAt: new Date().toISOString(), outcome: 'failed', code: 'owner_timeout', txs: { account: 'a'.repeat(64) } }],
        orphans: [{ publicKey: old, attempt: 1, txs: { account: 'a'.repeat(64) } }],
      };
      await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      await provisioner(okCreate(calls), { keys: k }).start(id);
      const a = await stateOf(id);
      expect([a.status, a.stellar_address, destroyed]).toEqual(['active', fresh, []]);
      expect(calls[0]!.agentSigner.publicKey).toBe(fresh);
      expect(a.provision_state.orphans).toEqual(st.orphans);
    });

    it('M4: codeOf reads err.code, never the message text', async () => {
      const { id } = await newAgent();
      await provisioner(failingCreate([], new Error('sign_request: owner_rejected'), { account: 'a'.repeat(64) })).start(id);
      expect((await stateOf(id)).provision_state.error).toBe('chain_error');
    });

    it('M5: an agent revoked while create runs stays revoked; the success save does not resurrect it', async () => {
      const { id } = await newAgent();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const inside = new Promise<void>((r) => (entered = r));
      const slow: Create = async (o) => {
        entered();
        await gate;
        return okCreate([])(o);
      };
      const run = provisioner(slow).start(id);
      await inside;
      await sql`update app.agents set status = 'revoked' where id = ${id}`;
      release();
      await run;
      const a = await stateOf(id);
      expect([a.status, a.agent_id]).toEqual(['revoked', null]);
    });
  });

  describe('resume: an owner stall continues with the same key', () => {
    const A = 'a'.repeat(64);
    const B = 'b'.repeat(64);
    const stalled = async (code: 'owner_timeout' | 'owner_rejected', txs: PartialOwnedAgent['txs'], agentId?: string, bindValidUntil?: number) => {
      const { id, owner } = await newAgent();
      await provisioner(failingCreate([], signRequestError(code), txs, agentId)).start(id);
      if (bindValidUntil !== undefined) {
        const st = (await stateOf(id)).provision_state;
        st.attempts[0]!.bindValidUntil = bindValidUntil;
        await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      }
      return { id, owner: owner!, key: (await keys.publicKey(id))! };
    };
    const stateOwner = async (id: string) =>
      ((await sql`select u.owner_address from app.agents a join app.users u on u.id = a.user_id where a.id = ${id}`) as { owner_address: string }[])[0]!.owner_address;
    type TestChain = ReturnType<typeof chainWithFakeSoroban>['chain'];
    const resumeStart = async (id: string, chain: TestChain, create?: Create) => {
      const { destroyed, keys: k } = spyKeys();
      const calls: AuthOwnerRemoteOptions[] = [];
      const events: Parameters<ProvisionLog>[0][] = [];
      const out = await provisioner(create ? async (o) => (calls.push(o), create(o)) : okCreate(calls), { keys: k, chain, log: (e) => events.push(e) }).start(id);
      return { calls, destroyed, events, out };
    };
    /** What the library returns for a resumed birth: only the txs it sent itself. */
    const resumedOk: Create = async (o) => ({
      publicKey: o.agentSigner.publicKey,
      agentId: '42',
      owner: o.owner.address,
      txs: { register: B, bind: 'c'.repeat(64) },
    });

    it('owner_timeout after tx 1, account on chain -> same key, resume.account, no orphan, no destroy', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const asked: string[] = [];
      const { calls, destroyed, out } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async (g) => (asked.push(g), true) }).chain, resumedOk);
      expect(out).toEqual({ outcome: 'active' });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.resume).toEqual({ account: true });
      expect(calls[0]!.agentSigner.publicKey).toBe(key);
      expect([destroyed, asked]).toEqual([[], [key]]);
      const a = await stateOf(id);
      expect([a.status, a.stellar_address, a.agent_id]).toEqual(['active', key, '42']);
      expect(a.provision_state.orphans).toBeUndefined();
      expect(a.provision_state.attempts).toHaveLength(2);
      expect(a.provision_state.attempts[0]!.resumed).toBeUndefined();
      expect(a.provision_state.attempts[1]).toMatchObject({ n: 2, publicKey: key, resumed: true, outcome: 'active', txs: { account: A, register: B, bind: 'c'.repeat(64) } }); // earlier account hash carried
      expect(await keyCount(id)).toBe(1);
    });

    it('owner_rejected after tx 1 resumes the same way', async () => {
      const { id, key } = await stalled('owner_rejected', { account: A });
      const { calls } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => true }).chain, resumedOk);
      expect([calls[0]!.resume, calls[0]!.agentSigner.publicKey]).toEqual([{ account: true }, key]);
    });

    it('owner_timeout but the account cannot be read on chain -> today\'s rule (rotate + orphan), no resume', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const { calls, destroyed } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => false }).chain);
      expect(calls[0]!.resume).toBeUndefined();
      expect(destroyed).toEqual([id]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 1, txs: { account: A } }]);
    });

    for (const [label, walletOf] of [
      ['unbound as registered (wallet = its owner)', (o: string): string | null => o],
      ['unbound (no wallet)', (): string | null => null],
    ] as const) {
      it(`owner stall after register, ${label}, bind window closed -> resume.agentId, no orphan`, async () => {
        const { id, owner, key } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
        const asked: string[] = [];
        const chain = chainWithFakeSoroban({ identity: async (n) => (asked.push(n), { owner, wallet: walletOf(owner), ledger: 5101 }) }).chain;
        const { calls, destroyed, out } = await resumeStart(id, chain, resumedOk);
        expect(out).toEqual({ outcome: 'active' });
        expect(calls[0]!.resume).toEqual({ account: true, agentId: '42' });
        expect([destroyed, asked, calls[0]!.agentSigner.publicKey]).toEqual([[], ['42'], key]);
        const a = await stateOf(id);
        expect(a.provision_state.orphans).toBeUndefined();
        expect(a.provision_state.attempts[1]).toMatchObject({ resumed: true, publicKey: key, outcome: 'active' });
      });
    }

    it('owner stall after register, bind window still open -> bind_window_open deferral, nothing created', async () => {
      const { id, owner, key } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const { calls, destroyed, events, out } = await resumeStart(id, chainWithFakeSoroban({ identity: async () => ({ owner, wallet: null, ledger: 5100 }) }).chain);
      expect(out).toEqual({ outcome: 'deferred', code: 'bind_window_open', retryAfterLedger: 5101 });
      expect([calls.length, destroyed, await keys.publicKey(id)]).toEqual([0, [], key]);
      expect(events).toEqual([{ event: 'provision_deferred', agent: id, attempt: 1, agentId: '42', code: 'bind_window_open' }]);
    });

    it('owner stall after register, identity owned by someone else -> rotate as today, never resumed', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const { calls, destroyed } = await resumeStart(id, chainWithFakeSoroban({ identity: async () => ({ owner: contractAddress(99), wallet: null, ledger: 5101 }) }).chain);
      expect(calls[0]!.resume).toBeUndefined();
      expect(destroyed).toEqual([id]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 1, txs: { account: A, register: B }, agentId: '42' }]);
    });

    it('owner stall after register, wallet bound to another key -> rotate as today', async () => {
      const { id, owner } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const { calls, destroyed } = await resumeStart(id, chainWithFakeSoroban({ identity: async () => ({ owner, wallet: Keypair.random().publicKey(), ledger: 5101 }) }).chain);
      expect([calls[0]!.resume, destroyed]).toEqual([undefined, [id]]);
    });

    it('the registry shows our key bound under the user -> recovered active, no create (unchanged)', async () => {
      const { id, owner, key } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const { calls, out } = await resumeStart(id, chainWithFakeSoroban({ identity: async () => ({ owner, wallet: key, ledger: 5101 }) }).chain);
      expect([out, calls.length]).toEqual([{ outcome: 'active' }, 0]);
    });

    it('a registry read that fails or knows no agent -> deferred (unchanged), nothing resumed', async () => {
      const { id } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const down = await resumeStart(id, chainWithFakeSoroban({ identity: async () => { throw new Error('chain: registry read failed'); } }).chain);
      expect([down.out, down.calls.length, down.destroyed]).toEqual([{ outcome: 'deferred', code: 'registry_unreadable' }, 0, []]);
      const none = await resumeStart(id, chainWithFakeSoroban({ identity: async () => null }).chain);
      expect([none.out, none.calls.length]).toEqual([{ outcome: 'deferred', code: 'registry_no_agent' }, 0]);
    });

    for (const code of ['interrupted', 'chain_error'] as const) {
      it(`${code} after tx 1 -> rotate + orphan, never resumed (even with the account on chain)`, async () => {
        const { id } = await newAgent();
        await provisioner(failingCreate([], new Error('chain: Horizon submit failed: 504'), { account: A })).start(id);
        if (code === 'interrupted') {
          const st = (await stateOf(id)).provision_state;
          st.attempts[0]!.code = 'interrupted';
          st.error = 'interrupted';
          await sql`update app.agents set provision_state = ${st} where id = ${id}`;
        }
        const key = (await keys.publicKey(id))!;
        const { calls, destroyed } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => true }).chain);
        expect(calls[0]!.resume).toBeUndefined();
        expect(destroyed).toEqual([id]);
        expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 1, txs: { account: A } }]);
      });
    }

    it('resume_mismatch -> failed with the fixed code; the next start rotates + orphans, never a second resume', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const chain = chainWithFakeSoroban({ accountExists: async () => true }).chain;
      const mismatch = Object.assign(new Error('resume: the account has no USDC trustline'), { code: 'resume_mismatch' });
      const first = await resumeStart(id, chain, async () => { throw mismatch; });
      expect(first.out).toEqual({ outcome: 'failed', code: 'resume_mismatch' });
      let a = await stateOf(id);
      expect([a.provision_state.error, a.provision_state.orphans]).toEqual(['resume_mismatch', undefined]);
      expect(a.provision_state.attempts[1]).toMatchObject({ resumed: true, outcome: 'failed', code: 'resume_mismatch' });
      expect(first.events.at(-1)).toEqual({ event: 'provision_failed', agent: id, attempt: 2, code: 'resume_mismatch', txs: { account: A } });
      expect(JSON.stringify(first.events)).not.toContain('trustline');

      const second = await resumeStart(id, chain);
      expect(second.calls[0]!.resume).toBeUndefined();
      expect(second.destroyed).toEqual([id]);
      a = await stateOf(id);
      expect(a.provision_state.orphans).toEqual([{ publicKey: key, attempt: 2, txs: { account: A } }]);
      expect(a.stellar_address).not.toBe(key);
    });

    it('a resume that stalls again keeps the same key and resumes again', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const chain = chainWithFakeSoroban({ accountExists: async () => true }).chain;
      const again = await resumeStart(id, chain, async () => { throw signRequestError('owner_timeout'); });
      expect(again.out).toEqual({ outcome: 'failed', code: 'owner_timeout' });
      const third = await resumeStart(id, chain, resumedOk);
      expect([third.out, third.calls[0]!.resume, third.destroyed]).toEqual([{ outcome: 'active' }, { account: true }, []]);
      const a = await stateOf(id);
      expect([a.stellar_address, a.provision_state.orphans, a.provision_state.attempts.map((x) => x.resumed)]).toEqual([key, undefined, [undefined, true, true]]);
    });

    it('a resume that stalls after register carries the registry id into the next attempt', async () => {
      const { id, owner } = await stalled('owner_timeout', { account: A });
      const chain = chainWithFakeSoroban({ accountExists: async () => true, identity: async () => ({ owner, wallet: owner, ledger: 9_999_999 }) }).chain;
      await resumeStart(id, chain, async (o) => {
        throw Object.assign(signRequestError('owner_timeout'), { partial: { publicKey: o.agentSigner.publicKey, secret: 'x', owner, agentId: '42', txs: { register: B } } });
      });
      const att = (await stateOf(id)).provision_state.attempts[1]!;
      expect([att.agentId, att.txs]).toEqual(['42', { account: A, register: B }]);
      const st = (await stateOf(id)).provision_state;
      st.attempts[1]!.bindValidUntil = 5100; // as noteBindProgress records it when the owner is asked to bind
      await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      const next = await resumeStart(id, chain, resumedOk);
      expect([next.out, next.calls[0]!.resume, next.destroyed]).toEqual([{ outcome: 'active' }, { account: true, agentId: '42' }, []]);
    });

    it('a register hash without a registry id is never resumed with account only -> rotate + orphan', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A, register: B });
      const { calls, destroyed } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => true }).chain);
      expect([calls[0]!.resume, destroyed]).toEqual([undefined, [id]]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 1, txs: { account: A, register: B } }]);
    });

    it('Case B: resume_mismatch -> the next start rotates + orphans, keeping the account hash and registry id', async () => {
      const { id, owner, key } = await stalled('owner_timeout', { account: A, register: B }, '42', 5100);
      const chain = chainWithFakeSoroban({ identity: async () => ({ owner, wallet: owner, ledger: 5101 }) }).chain;
      const first = await resumeStart(id, chain, async () => { throw Object.assign(new Error('resume: mismatch'), { code: 'resume_mismatch' }); });
      expect(first.out).toEqual({ outcome: 'failed', code: 'resume_mismatch' });
      expect(first.calls[0]!.resume).toEqual({ account: true, agentId: '42' });
      const second = await resumeStart(id, chain);
      expect([second.calls[0]!.resume, second.destroyed]).toEqual([undefined, [id]]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 2, txs: { account: A, register: B }, agentId: '42' }]);
    });

    it('a resumed attempt failing with chain_error after register -> the next start rotates, no second resume', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const chain = chainWithFakeSoroban({ accountExists: async () => true, identity: async (n) => ({ owner: (await stateOwner(id)), wallet: null, ledger: 9_999_999 }) }).chain;
      const first = await resumeStart(id, chain, async (o) => {
        throw Object.assign(new Error('chain: confirm failed'), { partial: { publicKey: o.agentSigner.publicKey, secret: 'x', owner: o.owner.address, agentId: '42', txs: { register: B } } });
      });
      expect(first.out).toEqual({ outcome: 'failed', code: 'chain_error' });
      const st = (await stateOf(id)).provision_state;
      st.attempts[1]!.bindValidUntil = 5100;
      await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      const second = await resumeStart(id, chain);
      expect([second.calls[0]!.resume, second.destroyed]).toEqual([undefined, [id]]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 2, txs: { account: A, register: B }, agentId: '42' }]);
    });

    it('a resumed key that is interrupted rotates (the carried account hash keeps needsFreshKey true)', async () => {
      const { id, key } = await stalled('owner_timeout', { account: A });
      const chain = chainWithFakeSoroban({ accountExists: async () => true }).chain;
      await resumeStart(id, chain, async () => { throw signRequestError('owner_timeout'); });
      const st = (await stateOf(id)).provision_state;
      st.attempts[1]!.code = 'interrupted';
      st.error = 'interrupted';
      await sql`update app.agents set provision_state = ${st} where id = ${id}`;
      const next = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => false }).chain);
      expect([next.calls[0]!.resume, next.destroyed]).toEqual([undefined, [id]]);
      expect((await stateOf(id)).provision_state.orphans).toEqual([{ publicKey: key, attempt: 2, txs: { account: A } }]);
    });

    it('a second start while a resume runs is a no-op', async () => {
      const { id } = await stalled('owner_timeout', { account: A });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const calls: AuthOwnerRemoteOptions[] = [];
      const p = provisioner(async (o) => (calls.push(o), await gate, resumedOk(o)), { chain: chainWithFakeSoroban({ accountExists: async () => true }).chain });
      const first = p.start(id);
      await Bun.sleep(50);
      expect(await p.start(id)).toEqual({ outcome: 'busy' });
      release();
      await first;
      expect(calls).toHaveLength(1);
    });

    it('never logs or stores a resumed error\'s partial or secret', async () => {
      const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => spyOn(console, m));
      const { id } = await stalled('owner_timeout', { account: A });
      let secret = '';
      const { events } = await resumeStart(id, chainWithFakeSoroban({ accountExists: async () => true }).chain, async (o) => {
        secret = MARKER_SECRET;
        throw Object.assign(signRequestError('owner_timeout'), { partial: { publicKey: o.agentSigner.publicKey, secret, owner: o.owner.address, txs: { register: B } } });
      });
      for (const s of spies) {
        expect(s).not.toHaveBeenCalled();
        s.mockRestore();
      }
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(await sql`select * from app.agents where id = ${id}`)).not.toContain(secret);
    });
  });
});
