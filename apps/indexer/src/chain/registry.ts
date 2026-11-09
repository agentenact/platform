import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  type rpc,
  type Transaction,
  type xdr,
} from '@stellar/stellar-sdk';

/** Valid, fund-less, never-signing source for read-only simulations (same one the library uses). */
const VIEW_SOURCE = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';

export type RegistryAgent = { agentId: number; owner: string; wallet: string | null; uri: string };
export type RegistryEvent = {
  id: string;
  /** `owner_changed` carries no payload: re-read the agent. `mint` is not a kind; `registered` covers it. */
  kind: 'registered' | 'uri_updated' | 'wallet_bound' | 'owner_changed';
  agentId: number;
  txHash: string;
  ledger: number;
  at: string;
  /** `registered` (agent_uri) and `uri_updated` (new_uri). */
  uri?: string;
  /** `registered` only: the owner in the event (topic 2). */
  owner?: string;
  /** `wallet_bound` only: the address in the event. At registration it equals the owner, which is not a bind. */
  wallet?: string;
};

/** Start point of an events read: a ledger to begin from, or the cursor of the previous page (the cursor wins). */
export type EventsFrom = { startLedger: number; cursor?: string } | { cursor: string; startLedger?: number };

export interface RegistryReader {
  totalAgents(): Promise<number>;
  read(agentId: number): Promise<RegistryAgent | null>;
  latestLedger(): Promise<number>;
  /**
   * One page of registry events. An empty page with an advancing cursor is NORMAL: the RPC scans about 10k ledgers
   * per call and returns nothing when none of them holds a registry event. Callers loop, feeding the returned cursor
   * back, until the cursor reaches `latestLedger`; an empty page is not the end.
   */
  events(o: EventsFrom & { limit: number }): Promise<{
    events: RegistryEvent[];
    cursor: string | null;
    latestLedger: number;
  }>;
}

/** The structural subset of `rpc.Server` the reader uses; test fakes satisfy it too. */
export interface SorobanRpc {
  simulateTransaction(tx: Transaction): Promise<unknown>;
  getEvents(req: rpc.Api.GetEventsRequest): Promise<{
    events: readonly RawEvent[];
    cursor: string;
    latestLedger: number;
    oldestLedger?: number;
    latestLedgerCloseTime?: string | number;
  }>;
  /** Not `getLatestLedger`: the SDK decodes the ledger header there and 15.1.0 throws on protocol 29 (seen live on testnet). */
  getHealth(): Promise<{ latestLedger: number }>;
}

/** The fields of `rpc.Api.EventResponse` the reader reads. */
export type RawEvent = {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
};

// ---- retry ----------------------------------------------------------------

export type RetryOpts = {
  tries?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); tests pass a constant. */
  random?: () => number;
};

/** A non-2xx HTTP answer. Retried only for 429 and 5xx. (Errors are tagged objects: this codebase has no classes.) */
export type HttpError = Error & { kind: 'http'; status: number; retryAfterMs?: number };
export function httpError(status: number, what: string, retryAfterMs?: number): HttpError {
  return Object.assign(new Error(`${what} failed: HTTP ${status}`), { kind: 'http' as const, status, name: 'HttpError', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
}

/** A simulated contract call that failed in the contract. Never retried. */
export type ContractError = Error & { kind: 'contract' };
export function contractError(method: string, detail: string): ContractError {
  return Object.assign(new Error(`registry ${method} failed: ${detail}`), { kind: 'contract' as const, name: 'ContractError' });
}

/** The RPC no longer holds the ledger we asked to start from. Retrying cannot help. */
export type RetentionGap = Error & { kind: 'retention_gap'; oldestLedger?: number };
export function retentionGap(oldestLedger?: number): RetentionGap {
  return Object.assign(new Error(`start ledger is outside the RPC retention window${oldestLedger ? ` (oldest ${oldestLedger})` : ''}`), {
    kind: 'retention_gap' as const,
    oldestLedger,
    name: 'RetentionGap',
  });
}
export const isRetentionGap = (e: unknown): e is RetentionGap => e instanceof Error && (e as { kind?: unknown }).kind === 'retention_gap';

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ConnectionClosed', 'ConnectionRefused', 'FailedToOpenSocket']);
const MAX_RETRY_AFTER_MS = 60_000;

const isObj = (e: unknown): e is Record<string, unknown> => typeof e === 'object' && e !== null;

/** The SDK rejects with plain `{ code, message }` objects for JSON-RPC errors, so errors are inspected structurally, not by instanceof. */
function statusOf(err: Record<string, unknown>): number | undefined {
  if (typeof err.status === 'number') return err.status;
  const res = err.response;
  if (isObj(res) && typeof res.status === 'number') return res.status;
  return undefined;
}

function retryable(err: unknown): boolean {
  if (!isObj(err)) return false;
  const kind = err.kind;
  if (kind === 'contract' || kind === 'retention_gap') return false;
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const code = err.code;
  if (typeof code === 'string') return NETWORK_CODES.has(code);
  // fetch (undici) reports transport failures as `TypeError('fetch failed', { cause })`; that exact signature, or a known cause code.
  if (err instanceof TypeError && err.message === 'fetch failed') return true;
  if (isObj(err.cause) && typeof err.cause.code === 'string' && NETWORK_CODES.has(err.cause.code)) return true;
  // A JSON-RPC error object: only a server-side 5xx-like code is transient (a -326xx request error never is).
  if (typeof code === 'number') return code >= 500 && code <= 599;
  // No message-text matching: "invalid network passphrase" or "rejected 500 stroops" must not be retried.
  return err.name === 'TimeoutError' || err.name === 'AbortError';
}

/** Retry-After in ms (delta-seconds or an HTTP date), from the error or its response headers. */
function retryAfterMs(err: unknown): number | undefined {
  if (!isObj(err)) return undefined;
  if (typeof err.retryAfterMs === 'number') return err.retryAfterMs;
  const res = err.response;
  const headers = (isObj(res) ? res.headers : undefined) ?? err.headers;
  let raw: unknown;
  if (headers instanceof Headers) raw = headers.get('retry-after');
  else if (isObj(headers)) raw = headers['retry-after'] ?? headers['Retry-After'];
  if (typeof raw === 'number') return raw * 1000;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Retry 429, 5xx and known transport errors with exponential backoff plus jitter (up to +50%); a Retry-After
 * (capped at 60 s) replaces the backoff. Anything else, including contract reverts, throws at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOpts = {}): Promise<T> {
  const tries = o.tries ?? 5;
  const baseMs = o.baseMs ?? 500;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !retryable(err)) throw err;
      const hinted = retryAfterMs(err);
      const backoff = baseMs * 2 ** (attempt - 1);
      await sleep(hinted !== undefined ? Math.min(hinted, MAX_RETRY_AFTER_MS) : Math.round(backoff * (1 + 0.5 * random())));
    }
  }
}

// ---- reader ----------------------------------------------------------------

/** The contract's event names (snake_case on chain). `mint` is deliberately absent: `registered` covers it. */
const KINDS: Record<string, RegistryEvent['kind']> = { registered: 'registered', uri_updated: 'uri_updated', metadata_set: 'wallet_bound', transfer: 'owner_changed' };

function asNumber(v: unknown): number | null {
  const n = typeof v === 'bigint' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function nativeOf(v: xdr.ScVal | undefined): unknown {
  try {
    return v ? scValToNative(v) : undefined;
  } catch {
    return undefined;
  }
}

const field = (v: unknown, key: string): unknown => (isObj(v) ? v[key] : undefined);

/** Decode one registry event; null when it is not one of ours (other topics, other metadata keys, failed calls). */
export function decodeRegistryEvent(e: RawEvent): RegistryEvent | null {
  if (e.inSuccessfulContractCall === false) return null;
  const name = nativeOf(e.topic[0]);
  if (typeof name !== 'string' || !Object.hasOwn(KINDS, name)) return null;
  const kind = KINDS[name]!;
  const value = nativeOf(e.value);
  // `transfer` has the parties in the topics ([transfer, from, to]); the token id (= agent id) is in the value.
  const agentId = asNumber(kind === 'owner_changed' ? field(value, 'token_id') : nativeOf(e.topic[1]));
  if (agentId === null) return null;
  if (kind === 'wallet_bound' && nativeOf(e.topic[2]) !== 'agentWallet') return null;
  const ev: RegistryEvent = { id: e.id, kind, agentId, txHash: e.txHash, ledger: e.ledger, at: e.ledgerClosedAt };
  if (kind === 'registered' || kind === 'uri_updated') {
    const uri = field(value, kind === 'registered' ? 'agent_uri' : 'new_uri');
    if (typeof uri === 'string') ev.uri = uri;
    if (kind === 'registered') {
      const owner = nativeOf(e.topic[2]);
      if (typeof owner !== 'string') return null; // a registration without an owner is malformed
      ev.owner = owner;
    }
  } else if (kind === 'wallet_bound') {
    const bytes = field(value, 'value');
    if (bytes instanceof Uint8Array) ev.wallet = Buffer.from(bytes).toString('ascii');
  }
  return ev;
}

/** A cursor is a TOID (`<ledger << 32 | tx/op bits>-<n>`); its ledger is what the RPC range-checks. Unparsable counts as "very old". */
function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split('-')[0]!) >> 32n);
  } catch {
    return 0;
  }
}

/** The RPC's out-of-range answer: "startLedger must be within the ledger range: <oldest> - <latest>". It arrives as a plain `{ code, message }` object. */
function ledgerRange(err: unknown): { oldest: number; latest: number } | null {
  const message = isObj(err) ? err.message : undefined;
  if (typeof message !== 'string') return null;
  const m = /ledger range: (\d+) - (\d+)/.exec(message);
  return m ? { oldest: Number(m[1]), latest: Number(m[2]) } : null;
}

export function createRegistryReader(o: { rpc: SorobanRpc; registry: string; passphrase: string; retry?: RetryOpts }): RegistryReader {
  const contract = new Contract(o.registry);

  async function simulateView(method: string, args: xdr.ScVal[]): Promise<unknown> {
    return withRetry(async () => {
      const tx = new TransactionBuilder(new Account(VIEW_SOURCE, '0'), { fee: BASE_FEE, networkPassphrase: o.passphrase })
        .addOperation(contract.call(method, ...args))
        .setTimeout(30)
        .build();
      const sim = (await o.rpc.simulateTransaction(tx)) as { error?: string; result?: { retval: xdr.ScVal } };
      if (sim.error) {
        // A throttled or failing node reports through the same field as a contract revert; only the former is retried.
        if (/\b429\b|too many requests|rate limit/i.test(sim.error)) throw httpError(429, `simulate ${method}`);
        throw contractError(method, sim.error.slice(0, 200));
      }
      if (!sim.result) throw contractError(method, 'no result');
      return scValToNative(sim.result.retval);
    }, o.retry);
  }

  const idArg = (id: number) => nativeToScVal(id, { type: 'u32' });

  return {
    async totalAgents() {
      const n = asNumber(await simulateView('total_agents', []));
      if (n === null) throw contractError('total_agents', 'unexpected result');
      return n;
    },

    async read(agentId) {
      if ((await simulateView('agent_exists', [idArg(agentId)])) !== true) return null;
      const owner = await simulateView('find_owner', [idArg(agentId)]);
      if (typeof owner !== 'string') return null;
      const wallet = await simulateView('get_agent_wallet', [idArg(agentId)]);
      // The agent exists but may have no URI: the contract then reverts (Error(Contract, #2), seen live for 18 of 56 agents).
      // That is an empty uri, not a failure. Transport errors still throw.
      const uri = await simulateView('agent_uri', [idArg(agentId)]).catch((e: unknown) => {
        if (isObj(e) && e.kind === 'contract') return '';
        throw e;
      });
      return { agentId, owner, wallet: typeof wallet === 'string' ? wallet : null, uri: typeof uri === 'string' ? uri : '' };
    },

    async latestLedger() {
      return (await withRetry(() => o.rpc.getHealth(), o.retry)).latestLedger;
    },

    async events({ startLedger, cursor, limit }) {
      const filters = [{ type: 'contract' as const, contractIds: [o.registry] }];
      if (!cursor && startLedger === undefined) throw new TypeError('events needs a startLedger or a cursor');
      const req: rpc.Api.GetEventsRequest = cursor ? { filters, cursor, limit } : { filters, startLedger: startLedger!, limit };
      const requested = cursor ? cursorLedger(cursor) : startLedger!;
      // Classify before withRetry sees the error. The same message comes back for a start AHEAD of the latest
      // ledger; that is not a gap (nothing was lost), so it passes through unchanged.
      const page = await withRetry(async () => {
        try {
          return await o.rpc.getEvents(req);
        } catch (err) {
          const range = ledgerRange(err);
          if (range && requested < range.oldest) throw retentionGap(range.oldest);
          throw err;
        }
      }, o.retry);
      const events: RegistryEvent[] = [];
      for (const raw of page.events) {
        const ev = decodeRegistryEvent(raw);
        if (ev) events.push(ev);
      }
      return { events, cursor: page.cursor || null, latestLedger: page.latestLedger };
    },
  };
}
