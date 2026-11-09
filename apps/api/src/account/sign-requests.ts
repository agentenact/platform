/**
 * Owner signatures for auth entries (spec §5.1 step 2c). provision awaits `request`; the owner's
 * browser lists `pending`, checks and signs each entry itself, and posts it back with `sign`.
 * The server only accepts a signature over exactly the entry it asked for.
 */
import { Address, xdr } from '@stellar/stellar-sdk';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import type { PublicSignRequest } from '../owner-client/types.js';

export interface SignRequestInput {
  userId: string;
  agentId: string;
  kind: 'register' | 'bind';
  entryXdr: string;
  validUntilLedger: number;
  networkPassphrase: string;
  /** For a bind: the register tx hash provision saw sent. Public; the browser verifies it on chain. */
  registerTx?: string;
}

/** Why `request` failed. Fixed words: callers (provision) branch on `err.code`, never on the message. */
export type SignRequestFailure = 'owner_rejected' | 'owner_timeout' | 'already_expired' | 'validity_too_long' | 'signer_not_owner' | 'agent_not_owned';
export type SignRequestError = Error & { code: SignRequestFailure };
export const signRequestError = (code: SignRequestFailure): SignRequestError => Object.assign(new Error(`sign_request: ${code}`), { code });

export interface SignRequests {
  request(input: SignRequestInput): Promise<string>;
  pending(userId: string): Promise<PublicSignRequest[]>;
  sign(userId: string, id: string, signedEntryXdr: string): Promise<void>;
  reject(userId: string, id: string): Promise<void>;
  /**
   * The leader's recovery sweep: a waiter lives in the process that asked, so a pending row whose instance is dead
   * (or that predates instances) can never be answered and is expired. Returns how many rows were expired.
   */
  expireOrphaned(): Promise<number>;
}

/** Same signer, nonce and invocation; an expiry in (0, requested] (the browser clamps it shorter); a non-void signature. */
function sameAuthorization(originalXdr: string, signedXdr: string, validUntil: number, ownerAddress: string | null): boolean {
  try {
    const a = xdr.SorobanAuthorizationEntry.fromXDR(originalXdr, 'base64');
    const b = xdr.SorobanAuthorizationEntry.fromXDR(signedXdr, 'base64');
    if (b.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return false;
    const ca = a.credentials().address();
    const cb = b.credentials().address();
    const signer = Address.fromScAddress(cb.address()).toString();
    return (
      ownerAddress !== null &&
      signer === ownerAddress &&
      signer === Address.fromScAddress(ca.address()).toString() &&
      cb.nonce().toString() === ca.nonce().toString() &&
      cb.signatureExpirationLedger() > 0 &&
      cb.signatureExpirationLedger() <= validUntil &&
      cb.signature().switch() !== xdr.ScValType.scvVoid() &&
      b.rootInvocation().toXDR().equals(a.rootInvocation().toXDR())
    );
  } catch {
    return false;
  }
}

interface PendingRow {
  id: string;
  kind: 'register' | 'bind';
  agent_id: string;
  entry_xdr: string;
  valid_until_ledger: number;
  network_passphrase: string;
  expires_at: Date;
  stellar_address: string | null;
  register_tx: string | null;
}

/**
 * Mirrors the library's unexported AUTH_VALID_LEDGERS: provision signs entries for latestLedger + 100.
 * A request may not ask for more (plus RPC_LAG_SLACK ledgers of lag between our RPC and the library's).
 */
export const MAX_VALID_LEDGERS = 100;
const RPC_LAG_SLACK = 2;
const LEDGER_MS = 5_000;

const invalidUuid = (e: unknown) => (e as { errno?: string } | null)?.errno === '22P02';

export function createSignRequests(
  sql: Db,
  o: {
    source: string;
    ttlMs?: number;
    pollMs?: number;
    /** Current ledger sequence. Required: the validity bound fails closed. */
    latestLedger: () => Promise<number>;
    /** This process's instance id (db/replica.ts), written on each request it waits for. */
    instance?: number;
  },
): SignRequests {
  const ttlMs = o.ttlMs ?? 300_000;
  const pollMs = o.pollMs ?? 1_000;

  async function owned(userId: string, id: string) {
    let rows: { entry_xdr: string; valid_until_ledger: number; status: string; live: boolean; owner_address: string | null }[];
    try {
      rows = (await sql`select s.entry_xdr, s.valid_until_ledger, s.status, s.expires_at > now() as live, u.owner_address
                        from app.sign_requests s join app.users u on u.id = s.user_id
                        where s.id = ${id} and s.user_id = ${userId}`) as typeof rows;
    } catch (e) {
      if (invalidUuid(e)) throw httpError(404, 'not_found');
      throw e;
    }
    const r = rows[0];
    if (!r) throw httpError(404, 'not_found');
    if (r.status !== 'pending' || !r.live) throw httpError(409, 'not_pending');
    return r;
  }

  function signerOf(entryXdr: string): string | null {
    try {
      const c = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64').credentials();
      if (c.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return null;
      return Address.fromScAddress(c.address().address()).toString();
    } catch {
      return null;
    }
  }

  return {
    async request(i) {
      const latest = await o.latestLedger();
      if (i.validUntilLedger <= latest) throw signRequestError('already_expired');
      if (i.validUntilLedger > latest + MAX_VALID_LEDGERS + RPC_LAG_SLACK) throw signRequestError('validity_too_long');

      // Fail fast: never wait out the TTL for a request that can not be answered correctly.
      const [who] = (await sql`select u.owner_address, exists(select 1 from app.agents a where a.id = ${i.agentId} and a.user_id = u.id) as owns_agent
                               from app.users u where u.id = ${i.userId}`) as { owner_address: string | null; owns_agent: boolean }[];
      if (!who || !who.owner_address || signerOf(i.entryXdr) !== who.owner_address) throw signRequestError('signer_not_owner');
      if (!who.owns_agent) throw signRequestError('agent_not_owned');

      // The row never outlives the entry's ledger window.
      const lifeMs = Math.min(ttlMs, (i.validUntilLedger - latest) * LEDGER_MS);
      const inserted = (await sql`insert into app.sign_requests (user_id, agent_id, kind, entry_xdr, valid_until_ledger, network_passphrase, register_tx, expires_at, instance)
                                  values (${i.userId}, ${i.agentId}, ${i.kind}, ${i.entryXdr}, ${i.validUntilLedger}, ${i.networkPassphrase}, ${i.registerTx ?? null}, now() + make_interval(secs => ${lifeMs / 1000}), ${o.instance ?? null})
                                  returning id`) as { id: string }[];
      const id = inserted[0]!.id;
      for (;;) {
        const [s] = (await sql`select status, signed_entry_xdr, expires_at <= now() as over from app.sign_requests where id = ${id}`) as {
          status: string;
          signed_entry_xdr: string | null;
          over: boolean;
        }[];
        if (s!.status === 'signed' && s!.signed_entry_xdr) return s!.signed_entry_xdr;
        if (s!.status === 'rejected') throw signRequestError('owner_rejected');
        if (s!.status === 'expired') throw signRequestError('owner_timeout');
        if (s!.over) {
          const done = (await sql`update app.sign_requests set status = 'expired' where id = ${id} and status = 'pending' returning id`) as unknown[];
          if (done.length) throw signRequestError('owner_timeout');
          continue; // signed or rejected in the meantime
        }
        await Bun.sleep(pollMs);
      }
    },

    async pending(userId) {
      const rows = (await sql`select s.id, s.kind, s.agent_id, s.entry_xdr, s.valid_until_ledger, s.network_passphrase, s.expires_at, s.register_tx, a.stellar_address
                              from app.sign_requests s join app.agents a on a.id = s.agent_id
                              where s.user_id = ${userId} and s.status = 'pending' and s.expires_at > now()
                              order by s.created_at`) as PendingRow[];
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        agentId: r.agent_id,
        entryXdr: r.entry_xdr,
        validUntilLedger: r.valid_until_ledger,
        networkPassphrase: r.network_passphrase,
        expiresAt: r.expires_at.toISOString(),
        source: o.source,
        agentWallet: r.stellar_address,
        registerTx: r.register_tx,
      }));
    },

    async sign(userId, id, signedEntryXdr) {
      const r = await owned(userId, id);
      if (!sameAuthorization(r.entry_xdr, signedEntryXdr, r.valid_until_ledger, r.owner_address)) throw httpError(400, 'entry_mismatch');
      const done = (await sql`update app.sign_requests set status = 'signed', signed_entry_xdr = ${signedEntryXdr}
                              where id = ${id} and status = 'pending' and expires_at > now() returning id`) as unknown[];
      if (!done.length) throw httpError(409, 'not_pending');
    },

    async reject(userId, id) {
      await owned(userId, id);
      const done = (await sql`update app.sign_requests set status = 'rejected' where id = ${id} and status = 'pending' and expires_at > now() returning id`) as unknown[];
      if (!done.length) throw httpError(409, 'not_pending');
    },

    async expireOrphaned() {
      const done = (await sql`update app.sign_requests set status = 'expired' where status = 'pending' and not app.instance_alive(instance) returning id`) as unknown[];
      return done.length;
    },
  };
}
