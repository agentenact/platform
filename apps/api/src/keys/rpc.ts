/**
 * The api's side of the vault. `AgentKeys` is everything the api may do with agent keys: create one, read its
 * public key, and ask the vault to sign a payload the vault checks itself. It never sees a secret.
 *
 * Two transports, one wire format: `vaultClient` calls the vault over HTTP with a bearer token (production);
 * `localAgentKeys` calls a Vault in this process through the same dispatch and JSON round trip (tests, local dev).
 *
 * Wire: POST {VAULT_URL}/v1/call  {"op": "...", "args": {...}}  →  {"ok": true, "result": ...}
 *                                                              |  {"ok": false, "reason": "..."}
 */
import { timingSafeEqual } from 'node:crypto';
import type { EnactmentRecord, UnsignedEnactmentRecord } from 'agentenact';
import { TransactionBuilder } from '@stellar/stellar-sdk';
import type { AgentKeySigner, StellarSigner } from 'agentenact/create';
import type { EvmPaySigner, SolanaPaySigner, StellarPaySigner } from 'agentenact/wallet';
import { isSolanaAddress, isVaultRefusal, vaultRefusal, type Vault, type VaultRefusalCode } from './contract.js';

export interface AgentKeys {
  generate(agentId: string): Promise<{ publicKey: string }>;
  destroy(agentId: string): Promise<void>;
  publicKey(agentId: string): Promise<string | null>;
  webhookSecret(agentId: string): Promise<string>;
  /** For create's `agentSigner`: the vault signs only this agent's birth tx and bind entry, while it is provisioning. */
  agentSigner(agentId: string, publicKey: string): AgentKeySigner;
  /** For serve's `agent.signRecord`: the vault signs only a record for this agent, one per settlement, while it is active. */
  recordSigner(agentId: string): (unsigned: UnsignedEnactmentRecord) => Promise<EnactmentRecord>;
  /** For hire's `payer.signer`: the vault signs only a pinned-USDC transfer from this agent, within its caps. */
  paySigner(agentId: string, address: string): StellarPaySigner;
  /** The agent's EVM address (lowercase), or null before it has one. Never creates it. */
  evmAddress(agentId: string): Promise<string | null>;
  /** The agent's EVM wallet on an EVM testnet (lowercase); the vault creates it on the first call for an active agent. */
  evmWallet(agentId: string, network: string): Promise<string>;
  /** For hire's `payer.signer` on an EVM testnet: the vault signs only a pinned-USDC EIP-3009 authorization, within its caps. */
  evmPaySigner(agentId: string, network: string, address: string): EvmPaySigner;
  /** The agent's Solana address (base58), or null before it has one. Never creates it. */
  solanaAddress(agentId: string): Promise<string | null>;
  /** The agent's Solana devnet wallet (base58); the vault creates it on the first call for an active agent. */
  solanaWallet(agentId: string, network: string): Promise<string>;
  /** For hire's `payer.signer` on Solana devnet: the vault signs only a pinned-USDC transfer message to the offer's payTo, within its caps. */
  solanaPaySigner(agentId: string, network: string, address: string): SolanaPaySigner;
  /** For serve's `agent.signRecord` on an EVM testnet. */
  evmRecordSigner(agentId: string, network: string): (unsigned: UnsignedEnactmentRecord) => Promise<EnactmentRecord>;
  /** For the seal worker: the vault signs only this agent's own check-seal tx (seals/tx.ts), within its day count. */
  signSeal(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /** For the closer: the vault signs only a deleted agent's own close tx (agents/close-tx.ts), to its owner or the sponsor. */
  signClose(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /** For the reserve worker and the closer: the vault signs only the agent's part of a reserve tx (agents/reserve-tx.ts). */
  signReserve(agentId: string, txXdr: string, networkPassphrase: string): Promise<string>;
  /** The platform sponsor's account, as the vault holds it. */
  sponsorPublicKey(): Promise<string>;
  /** For chain's `sponsor`: the vault signs only the sponsor shapes of chain/sponsor.ts, within its day fee cap. */
  sponsorSigner(publicKey: string): StellarSigner;
}

type Op =
  | 'generate' | 'destroy' | 'publicKey' | 'webhookSecret' | 'signBirthTx' | 'signBindEntry' | 'signRecord' | 'signPayment'
  | 'evmAddress' | 'evmWallet' | 'signEvmPayment' | 'signEvmRecord' | 'solanaAddress' | 'solanaWallet' | 'signSolanaPayment' | 'signSeal' | 'signClose' | 'signReserve' | 'sponsorPublicKey' | 'signSponsorTx';
type Call = (op: Op, args: Record<string, unknown>) => Promise<unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = new Set<string>([
  'no_key', 'not_provisioning', 'not_active', 'wrong_network', 'bad_payload', 'wrong_wallet', 'wrong_owner',
  'over_call_cap', 'over_day_cap', 'record_exists', 'not_deleted', 'bad_request', 'unauthorized', 'failed',
]);
/** Wire-level reasons on top of the vault's own refusals. */
export type VaultReason = VaultRefusalCode | 'bad_request' | 'unauthorized' | 'failed';

const str = (v: unknown, max = 64 * 1024): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw badRequest();
  return v;
};
const badRequest = () => Object.assign(new Error('vault: bad request'), { reason: 'bad_request' as const });

/** Validates one call's arguments and runs it. Shared by the HTTP handler and `localAgentKeys`. */
export async function dispatch(vault: Vault, op: unknown, args: unknown): Promise<unknown> {
  if (!args || typeof args !== 'object') throw badRequest();
  const a = args as Record<string, unknown>;
  // The sponsor's ops name no agent.
  if (op === 'sponsorPublicKey') return vault.sponsorPublicKey();
  if (op === 'signSponsorTx') return vault.signSponsorTx(str(a.txXdr), str(a.networkPassphrase, 128));
  const agentId = str(a.agentId, 64);
  if (!UUID.test(agentId)) throw badRequest();
  switch (op) {
    case 'generate': return vault.generate(agentId);
    case 'destroy': return (await vault.destroy(agentId), null);
    case 'publicKey': return vault.publicKey(agentId);
    case 'webhookSecret': return vault.webhookSecret(agentId);
    case 'signBirthTx': return vault.signBirthTx(agentId, str(a.envelopeXdr), str(a.networkPassphrase, 128));
    case 'signBindEntry': return vault.signBindEntry(agentId, str(a.preimage));
    case 'signRecord': return vault.signRecord(agentId, a.unsigned as UnsignedEnactmentRecord);
    case 'signPayment': return vault.signPayment(agentId, str(a.preimage));
    case 'evmAddress': return vault.evmAddress(agentId);
    case 'evmWallet': return vault.evmWallet(agentId, str(a.network, 64));
    case 'signEvmPayment': return vault.signEvmPayment(agentId, str(a.network, 64), a.typedData);
    case 'signEvmRecord': return vault.signEvmRecord(agentId, str(a.network, 64), a.unsigned as UnsignedEnactmentRecord);
    case 'solanaAddress': return vault.solanaAddress(agentId);
    case 'solanaWallet': return vault.solanaWallet(agentId, str(a.network, 64));
    case 'signSolanaPayment': return vault.signSolanaPayment(agentId, str(a.network, 64), str(a.message, 4096), str(a.payTo, 64));
    case 'signSeal': return vault.signSeal(agentId, str(a.txXdr, 4096), str(a.networkPassphrase, 128));
    case 'signClose': return vault.signClose(agentId, str(a.txXdr, 8192), str(a.networkPassphrase, 128));
    case 'signReserve': return vault.signReserve(agentId, str(a.txXdr, 8192), str(a.networkPassphrase, 128));
    default: throw badRequest();
  }
}

const reasonOf = (e: unknown): VaultReason => {
  if (isVaultRefusal(e)) return e.reason;
  const r = (e as { reason?: unknown } | null)?.reason;
  return r === 'bad_request' ? 'bad_request' : 'failed';
};

/** A thrown vault answer on the api side: `reason` is one of VaultReason, never the vault's raw message. */
export interface VaultError extends Error {
  code: 'vault_refused' | 'vault_failed';
  reason: VaultReason;
}
const vaultError = (reason: VaultReason): VaultError =>
  isRefusalReason(reason)
    ? vaultRefusal(reason)
    : Object.assign(new Error(`vault: ${reason}`), { code: 'vault_failed' as const, reason });
const isRefusalReason = (r: VaultReason): r is VaultRefusalCode => r !== 'bad_request' && r !== 'unauthorized' && r !== 'failed';

const sigOf = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(v)) throw vaultError('failed');
  return v;
};

function agentKeysOver(call: Call): AgentKeys {
  return {
    async generate(agentId) {
      const r = (await call('generate', { agentId })) as { publicKey?: unknown } | null;
      if (typeof r?.publicKey !== 'string') throw vaultError('failed');
      return { publicKey: r.publicKey };
    },
    async destroy(agentId) {
      await call('destroy', { agentId });
    },
    async publicKey(agentId) {
      const r = await call('publicKey', { agentId });
      if (r !== null && typeof r !== 'string') throw vaultError('failed');
      return r;
    },
    async webhookSecret(agentId) {
      const r = await call('webhookSecret', { agentId });
      if (typeof r !== 'string' || !/^[0-9a-f]{64}$/.test(r)) throw vaultError('failed');
      return r;
    },
    agentSigner(agentId, publicKey) {
      return {
        publicKey,
        signTransaction: async (envelopeXdr, networkPassphrase) => sigOf(await call('signBirthTx', { agentId, envelopeXdr, networkPassphrase })),
        signAuthEntry: async (preimage) => sigOf(await call('signBindEntry', { agentId, preimage })),
      };
    },
    recordSigner(agentId) {
      // The library re-checks what comes back (same record, valid signature for the agent's address).
      return async (unsigned) => (await call('signRecord', { agentId, unsigned })) as EnactmentRecord;
    },
    paySigner(agentId, address) {
      return {
        address,
        async signAuthEntry(preimage) {
          return { signedAuthEntry: sigOf(await call('signPayment', { agentId, preimage })), signerAddress: address };
        },
      };
    },
    async evmAddress(agentId) {
      const r = await call('evmAddress', { agentId });
      if (r !== null && (typeof r !== 'string' || !/^0x[0-9a-f]{40}$/.test(r))) throw vaultError('failed');
      return r;
    },
    async evmWallet(agentId, network) {
      const r = await call('evmWallet', { agentId, network });
      if (typeof r !== 'string' || !/^0x[0-9a-f]{40}$/.test(r)) throw vaultError('failed');
      return r;
    },
    evmPaySigner(agentId, network, address) {
      return {
        address: address as `0x${string}`,
        async signTypedData(typedData) {
          // bigints travel as decimal strings; the vault rebuilds the typed data from the fields it checked.
          const wire = JSON.parse(JSON.stringify(typedData, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
          const r = await call('signEvmPayment', { agentId, network, typedData: wire });
          if (typeof r !== 'string' || !/^0x[0-9a-f]{130}$/i.test(r)) throw vaultError('failed');
          return r as `0x${string}`;
        },
      };
    },
    async solanaAddress(agentId) {
      const r = await call('solanaAddress', { agentId });
      if (r !== null && !isSolanaAddress(r)) throw vaultError('failed');
      return r;
    },
    async solanaWallet(agentId, network) {
      const r = await call('solanaWallet', { agentId, network });
      if (!isSolanaAddress(r)) throw vaultError('failed');
      return r;
    },
    solanaPaySigner(agentId, network, address) {
      return {
        address,
        async signSolanaMessage(message, payTo) {
          const r = await call('signSolanaPayment', { agentId, network, message, payTo });
          // base58 of a 64-byte ed25519 signature
          if (typeof r !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r)) throw vaultError('failed');
          return r;
        },
      };
    },
    evmRecordSigner(agentId, network) {
      return async (unsigned) => (await call('signEvmRecord', { agentId, network, unsigned })) as EnactmentRecord;
    },
    async signSeal(agentId, txXdr, networkPassphrase) {
      return sigOf(await call('signSeal', { agentId, txXdr, networkPassphrase }));
    },
    async signClose(agentId, txXdr, networkPassphrase) {
      return sigOf(await call('signClose', { agentId, txXdr, networkPassphrase }));
    },
    async signReserve(agentId, txXdr, networkPassphrase) {
      return sigOf(await call('signReserve', { agentId, txXdr, networkPassphrase }));
    },
    async sponsorPublicKey() {
      const r = await call('sponsorPublicKey', {});
      if (typeof r !== 'string' || !/^G[A-Z2-7]{55}$/.test(r)) throw vaultError('failed');
      return r;
    },
    sponsorSigner(publicKey) {
      return {
        publicKey,
        async signTransaction(txXdr, networkPassphrase) {
          const r = await call('signSponsorTx', { txXdr, networkPassphrase });
          // The same tx back, now signed: never something else to submit.
          try {
            if (typeof r !== 'string') throw new Error();
            const asked = TransactionBuilder.fromXDR(txXdr, networkPassphrase);
            const got = TransactionBuilder.fromXDR(r, networkPassphrase);
            if (!got.hash().equals(asked.hash()) || got.signatures.length <= asked.signatures.length) throw new Error();
          } catch {
            throw vaultError('failed');
          }
          return r;
        },
      };
    },
  };
}

/** The vault in this process, through the same validation and a JSON round trip. Tests and local dev only. */
export function localAgentKeys(vault: Vault): AgentKeys {
  return agentKeysOver(async (op, args) => {
    try {
      const r = await dispatch(vault, op, JSON.parse(JSON.stringify(args)));
      return r === undefined ? null : JSON.parse(JSON.stringify(r));
    } catch (e) {
      throw vaultError(reasonOf(e));
    }
  });
}

export const VAULT_TOKEN_MIN_CHARS = 32;

function readToken(env: Record<string, string | undefined>): string {
  const token = env.VAULT_TOKEN;
  if (!token || token.length < VAULT_TOKEN_MIN_CHARS) throw new Error(`keys: VAULT_TOKEN must be set (>= ${VAULT_TOKEN_MIN_CHARS} chars)`);
  return token;
}

/** The api's client: VAULT_URL (an internal address, never public) and VAULT_TOKEN. Throws at construction if either is missing. */
export function vaultClient(o: { env?: Record<string, string | undefined>; fetch?: typeof fetch; timeoutMs?: number } = {}): AgentKeys {
  const env = o.env ?? process.env;
  const token = readToken(env);
  const base = env.VAULT_URL;
  if (!base || !/^https?:\/\/[^/]+/.test(base)) throw new Error('keys: VAULT_URL is not set');
  const url = `${base.replace(/\/+$/, '')}/v1/call`;
  const doFetch = o.fetch ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? 8_000;
  // Webhook secrets are derived and never change for an agent: one vault call each, then memory.
  const webhookCache = new Map<string, Promise<unknown>>();
  const post: Call = async (op, args) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op, args }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw vaultError('failed');
    }
    let body: { ok?: unknown; result?: unknown; reason?: unknown };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw vaultError('failed');
    }
    if (body?.ok === true && res.ok) return body.result ?? null;
    throw vaultError(typeof body?.reason === 'string' && REASONS.has(body.reason) ? (body.reason as VaultReason) : 'failed');
  };
  const call: Call = (op, args) => {
    if (op !== 'webhookSecret') return post(op, args);
    const key = String(args.agentId).toLowerCase();
    let p = webhookCache.get(key);
    if (!p) {
      if (webhookCache.size >= 10_000) webhookCache.clear();
      p = post(op, args);
      webhookCache.set(key, p);
      p.catch(() => webhookCache.delete(key));
    }
    return p;
  };
  return agentKeysOver(call);
}

const MAX_BODY_BYTES = 64 * 1024;
/** Headers a reverse proxy sets: their presence means the request was routed in from outside. */
const FORWARDED = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded'];

/**
 * The vault's HTTP handler. Every request needs the bearer token; anything else is 401 with no detail. A refusal
 * is 403 with its reason; an internal error is 500 'failed' (the message never leaves the vault).
 */
export function createVaultHandler(vault: Vault, o: { env?: Record<string, string | undefined>; log?: (e: Record<string, string>) => void } = {}): (req: Request) => Promise<Response> {
  const expected = Buffer.from(`Bearer ${readToken(o.env ?? process.env)}`);
  const log = o.log ?? (() => undefined);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const authorized = (req: Request) => {
    const got = Buffer.from(req.headers.get('authorization') ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  return async (req) => {
    // Internal only. The api calls the vault directly; a request that came through a proxy (Traefik adds these
    // headers to everything it routes) is from outside, so the vault answers it as if nothing were here.
    if (FORWARDED.some((h) => req.headers.has(h))) return new Response('not found', { status: 404 });
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && path === '/health') return json(200, { ok: true });
    if (!authorized(req)) return json(401, { ok: false, reason: 'unauthorized' });
    if (req.method !== 'POST' || path !== '/v1/call') return json(404, { ok: false, reason: 'bad_request' });
    const raw = await req.arrayBuffer().catch(() => null);
    if (!raw || raw.byteLength > MAX_BODY_BYTES) return json(400, { ok: false, reason: 'bad_request' });
    let body: { op?: unknown; args?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
    } catch {
      return json(400, { ok: false, reason: 'bad_request' });
    }
    try {
      const result = await dispatch(vault, body?.op, body?.args);
      log({ event: 'vault_call', op: String(body.op) });
      return json(200, { ok: true, result: result ?? null });
    } catch (e) {
      const reason = reasonOf(e);
      log({ event: reason === 'failed' ? 'vault_failed' : 'vault_refused', op: String(body?.op).slice(0, 32), reason });
      return json(reason === 'failed' ? 500 : reason === 'bad_request' ? 400 : 403, { ok: false, reason });
    }
  };
}
