import { describe, expect, it } from 'bun:test';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { contractError, createRegistryReader, isRetentionGap, retentionGap, withRetry, type RawEvent } from '../src/chain/registry.js';
import { OWNER, PASSPHRASE, REGISTRY, WALLET, addr, eventId, fakeRpc, ownerTransfer, rawEvent, registration, str, sym, u32, uriUpdated, walletBound } from './support/fake-chain.js';

const noSleep = async () => {};
const mk = (rpc: ReturnType<typeof fakeRpc>) => createRegistryReader({ rpc, registry: REGISTRY, passphrase: PASSPHRASE, retry: { sleep: noSleep } });
const bool = (b: boolean) => xdr.ScVal.scvBool(b);
const REVERT = 'HostError: Error(Contract, #2)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CDE3, topics:[error, Error(Contract, #2)]';

describe('registry reader views', () => {
  it('reads owner, wallet and uri; null when the agent does not exist', async () => {
    const rpc = fakeRpc({ views: { agent_exists: bool(true), find_owner: addr(OWNER), get_agent_wallet: addr(WALLET), agent_uri: str('data:application/json;base64,e30=') } });
    expect(await mk(rpc).read(31)).toEqual({ agentId: 31, owner: OWNER, wallet: WALLET, uri: 'data:application/json;base64,e30=' });

    const none = fakeRpc({ views: { agent_exists: bool(false) } });
    expect(await mk(none).read(999)).toBeNull();
    expect(none.simulated).toEqual(['agent_exists']); // agent_uri would revert, so it is never asked
  });

  it('an agent whose agent_uri reverts (Error(Contract, #2)) reads with an empty uri', async () => {
    const rpc = fakeRpc({ views: { agent_exists: bool(true), find_owner: addr(OWNER), get_agent_wallet: addr(WALLET), agent_uri: REVERT } });
    expect(await mk(rpc).read(14)).toEqual({ agentId: 14, owner: OWNER, wallet: WALLET, uri: '' });
    expect(rpc.simulated.filter((m) => m === 'agent_uri')).toHaveLength(1); // a revert is not retried
  });

  it('a transport error on agent_uri still throws', async () => {
    const rpc = fakeRpc({ views: { agent_exists: bool(true), find_owner: addr(OWNER), get_agent_wallet: addr(WALLET), agent_uri: str('x') } });
    const real = rpc.simulateTransaction.bind(rpc);
    rpc.simulateTransaction = async (tx) => {
      const out = await real(tx);
      if (rpc.simulated.at(-1) === 'agent_uri') throw Object.assign(new Error('Request failed with status code 503'), { status: 503 });
      return out;
    };
    await expect(createRegistryReader({ rpc, registry: REGISTRY, passphrase: PASSPHRASE, retry: { sleep: noSleep, tries: 2 } }).read(14)).rejects.toThrow('503');
  });

  it('reports an unset wallet as null (Option::None comes back void)', async () => {
    const rpc = fakeRpc({ views: { agent_exists: bool(true), find_owner: addr(OWNER), get_agent_wallet: xdr.ScVal.scvVoid(), agent_uri: str('x') } });
    expect((await mk(rpc).read(1))!.wallet).toBeNull();
  });

  it('totalAgents returns a number for a u32 result', async () => {
    const n = await mk(fakeRpc({ views: { total_agents: u32(36) } })).totalAgents();
    expect(n).toBe(36);
    expect(typeof n).toBe('number');
  });

  it('a contract revert is not retried', async () => {
    const rpc = fakeRpc({ views: { agent_exists: 'HostError: Error(Contract, #2)\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:CDE3, topics:[error, Error(Contract, #2)]' } });
    await expect(mk(rpc).read(5)).rejects.toThrow('registry agent_exists failed');
    expect(rpc.simulated).toEqual(['agent_exists']);
  });

  it('retries a simulate throttle, then succeeds', async () => {
    const rpc = fakeRpc({ views: { total_agents: u32(3) } });
    let n = 0;
    const real = rpc.simulateTransaction.bind(rpc);
    rpc.simulateTransaction = async (tx) => (n++ < 2 ? Promise.reject(Object.assign(new Error('Request failed with status code 429'), { status: 429 })) : real(tx));
    expect(await mk(rpc).totalAgents()).toBe(3);
    expect(n).toBe(3);
  });

  it('latestLedger returns the sequence', async () => {
    expect(await mk(fakeRpc({ latest: 4321 })).latestLedger()).toBe(4321);
  });
});

describe('registry reader events', () => {
  const OTHER = Keypair.random().publicKey();
  const events: RawEvent[] = [
    ...registration({ agentId: 31, uri: 'https://agentenact.io/a/x/agent.json', ledger: 500 }),
    uriUpdated({ agentId: 31, uri: 'https://agentenact.io/a/y/agent.json', ledger: 501 }),
    walletBound({ agentId: 31, wallet: WALLET, ledger: 502 }),
    walletBound({ agentId: 31, wallet: WALLET, ledger: 503, key: 'category' }),
    ownerTransfer({ agentId: 31, from: OWNER, to: OTHER, ledger: 504 }),
    { ...registration({ agentId: 32, ledger: 505 })[2]!, inSuccessfulContractCall: false },
    rawEvent({ ledger: 506, topic: [sym('uri_updated'), nativeToScVal('not-a-number', { type: 'string' }), addr(OWNER)] }),
    rawEvent({ ledger: 507, topic: [sym('ownership_transfer_started'), u32(31)] }),
  ];

  it('decodes the real registration sequence: mint is dropped, the owner-valued metadata_set is a wallet_bound the owner, registered carries the uri', async () => {
    const page = await mk(fakeRpc({ events: registration({ agentId: 44, uri: 'u', ledger: 5057946 }) })).events({ startLedger: 5057940, limit: 100 });
    expect(page.events.map((e) => [e.kind, e.agentId])).toEqual([['wallet_bound', 44], ['registered', 44]]);
    expect(page.events[0]!.wallet).toBe(OWNER);
    expect(page.events[1]).toMatchObject({ uri: 'u', id: eventId(5057946, 2), ledger: 5057946 });
  });

  it('decodes registered, uri_updated, agentWallet metadata_set and transfer; drops other keys, failed calls, bad ids and unknown topics', async () => {
    const page = await mk(fakeRpc({ events })).events({ startLedger: 400, limit: 100 });
    expect(page.events.map((e) => [e.kind, e.agentId, e.ledger])).toEqual([
      ['wallet_bound', 31, 500],
      ['registered', 31, 500],
      ['uri_updated', 31, 501],
      ['wallet_bound', 31, 502],
      ['owner_changed', 31, 504],
    ]);
    const byKind = Object.fromEntries(page.events.map((e) => [e.kind + e.ledger, e]));
    expect(byKind.registered500).toMatchObject({ owner: OWNER, uri: 'https://agentenact.io/a/x/agent.json', txHash: 'a'.repeat(64), at: '2026-10-12T10:00:05Z' });
    expect(byKind.uri_updated501!.uri).toBe('https://agentenact.io/a/y/agent.json');
    expect(byKind.wallet_bound502!.wallet).toBe(WALLET);
    expect(byKind.owner_changed504!.uri).toBeUndefined();
    expect(page.cursor).toBe('0000000012345678-0000000001');
    expect(page.latestLedger).toBe(1000);
  });

  it('asks for the registry contract only, by startLedger or by cursor, never both', async () => {
    const seen: unknown[] = [];
    const rpc = fakeRpc({ getEvents: async (req) => (seen.push(req), { events: [], cursor: 'c2', latestLedger: 9 }) });
    await mk(rpc).events({ startLedger: 400, limit: 50 });
    await mk(rpc).events({ cursor: 'c1', startLedger: 400, limit: 50 });
    const filters = [{ type: 'contract', contractIds: [REGISTRY] }];
    expect(seen).toEqual([{ filters, startLedger: 400, limit: 50 }, { filters, cursor: 'c1', limit: 50 }]);
  });

  it('refuses to guess a start: neither startLedger nor cursor throws before any request', async () => {
    let calls = 0;
    const rpc = fakeRpc({ getEvents: async () => (calls++, { events: [], cursor: '', latestLedger: 1 }) });
    await expect((mk(rpc).events as (o: unknown) => Promise<unknown>)({ limit: 5 })).rejects.toThrow('startLedger or a cursor');
    expect(calls).toBe(0);
  });

  it('returns an empty page with an advancing cursor as normal', async () => {
    const rpc = fakeRpc({ getEvents: async () => ({ events: [], cursor: eventId(5100000), latestLedger: 5156000, oldestLedger: 5035162 }) });
    expect(await mk(rpc).events({ startLedger: 5090000, limit: 10 })).toEqual({ events: [], cursor: eventId(5100000), latestLedger: 5156000 });
  });

  // The SDK rejects with a PLAIN OBJECT here, not an Error (captured from the live testnet RPC).
  const rangeError = () => ({ code: -32600, message: 'startLedger must be within the ledger range: 5035162 - 5156121' });

  it('throws RetentionGap when the start ledger is older than the oldest retained one', async () => {
    let calls = 0;
    const rpc = fakeRpc({ getEvents: async () => (calls++, Promise.reject(rangeError())) });
    const err = await mk(rpc).events({ startLedger: 10, limit: 10 }).catch((e) => e);
    expect(isRetentionGap(err)).toBe(true);
    expect(err.oldestLedger).toBe(5035162);
    expect(calls).toBe(1);
  });

  it('a stale cursor (its ledger is older than the window) is a RetentionGap too', async () => {
    const rpc = fakeRpc({ getEvents: async () => Promise.reject(rangeError()) });
    const err = await mk(rpc).events({ cursor: eventId(4000000), limit: 10 }).catch((e) => e);
    expect(isRetentionGap(err)).toBe(true);
  });

  it('a start AHEAD of the latest ledger gets the same message but is not a gap', async () => {
    const ahead = rangeError();
    const rpc = fakeRpc({ getEvents: async () => Promise.reject(ahead) });
    const err = await mk(rpc).events({ startLedger: 9999999, limit: 10 }).catch((e) => e);
    expect(isRetentionGap(err)).toBe(false);
    expect(err).toBe(ahead);
  });

  it('retries a 5xx from getEvents but not other errors', async () => {
    let n = 0;
    const rpc = fakeRpc({ getEvents: async () => (n++ === 0 ? Promise.reject(Object.assign(new Error('Bad Gateway'), { status: 502 })) : { events: [], cursor: '', latestLedger: 7 }) });
    expect(await mk(rpc).events({ startLedger: 1, limit: 1 })).toEqual({ events: [], cursor: null, latestLedger: 7 });
    expect(n).toBe(2);
    const bad = fakeRpc({ getEvents: async () => Promise.reject(new Error('invalid filter')) });
    await expect(mk(bad).events({ startLedger: 1, limit: 1 })).rejects.toThrow('invalid filter');
  });
});

describe('withRetry', () => {
  const fail = (extra: object, msg = 'x') => Object.assign(new Error(msg), extra);
  const run = async (err: unknown, o: Parameters<typeof withRetry>[1] = {}) => {
    let n = 0;
    await withRetry(async () => { n++; throw err; }, { sleep: async () => {}, ...o }).catch(() => {});
    return n;
  };

  it('backs off exponentially and defaults to 5 tries', async () => {
    const waits: number[] = [];
    let n = 0;
    await expect(withRetry(async () => { n++; throw fail({ status: 503 }); }, { baseMs: 100, random: () => 0, sleep: async (ms) => void waits.push(ms) })).rejects.toThrow('x');
    expect(n).toBe(5);
    expect(waits).toEqual([100, 200, 400, 800]);
  });

  it('adds up to 50% jitter', async () => {
    const waits: number[] = [];
    await withRetry(async () => { throw fail({ status: 503 }); }, { tries: 3, baseMs: 100, random: () => 0.999, sleep: async (ms) => void waits.push(ms) }).catch(() => {});
    expect(waits).toEqual([150, 300]);
  });

  it('honours Retry-After (header on the response, seconds or date) instead of the backoff, capped at 60 s', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    await withRetry(async () => { throw fail({ response: { status: 429, headers: { 'retry-after': '7' } } }); }, { tries: 2, sleep }).catch(() => {});
    await withRetry(async () => { throw fail({ status: 503, retryAfterMs: 1500 }); }, { tries: 2, sleep }).catch(() => {});
    await withRetry(async () => { throw fail({ status: 429, response: { headers: { 'retry-after': '3600' } } }); }, { tries: 2, sleep }).catch(() => {});
    expect(waits).toEqual([7000, 1500, 60000]);
  });

  it('retries 429, 5xx and transport codes', async () => {
    expect(await run(fail({ status: 429 }), { tries: 2 })).toBe(2);
    expect(await run(fail({ response: { status: 500 } }), { tries: 2 })).toBe(2);
    expect(await run(fail({ code: 'ECONNRESET' }), { tries: 2 })).toBe(2);
    expect(await run(fail({ name: 'TimeoutError' }), { tries: 2 })).toBe(2);
    expect(await run(new TypeError('fetch failed'), { tries: 2 })).toBe(2);
    expect(await run(fail({ cause: { code: 'ECONNRESET' } }), { tries: 2 })).toBe(2);
  });

  it('does not retry on message text, 4xx, contract reverts or retention gaps', async () => {
    expect(await run(new Error('invalid network passphrase'))).toBe(1);
    expect(await run(new Error('fee 500 stroops too low'))).toBe(1);
    expect(await run(new Error('socket hang up'))).toBe(1);
    expect(await run(fail({ status: 400 }))).toBe(1);
    expect(await run(contractError('m', 'HostError 503'))).toBe(1);
    expect(await run(retentionGap(5))).toBe(1);
  });

  it('retries plain JSON-RPC error objects only with a 5xx-like code', async () => {
    expect(await run({ code: 503, message: 'upstream unavailable' }, { tries: 2 })).toBe(2);
    expect(await run({ code: -32600, message: 'startLedger must be within the ledger range: 1 - 2' })).toBe(1);
    expect(await run({ code: -32602, message: 'invalid params 500' })).toBe(1);
  });
});
