/**
 * Passkey wallet creation (spec §5.1 step 1, plan D7): the server issues the WebAuthn options and
 * challenge, verifies the browser's clientDataJSON itself (smart-account-kit does not), then has
 * `chain` deploy the smart wallet with our sponsor as deployer. The challenge is single-use, and the
 * deploy is claimed atomically with it (`passkey_credential_id` + `passkey_claimed_at`), so one
 * profile never has two deploys in flight.
 *
 * Recovery: the wallet's contract address is derived from deployer + hash(credentialId). If the
 * deploy succeeds but the profile write fails, the claim row keeps the credential id and the error
 * carries the public contractId and deployTx, so the wallet can be recovered, never orphaned.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import type { SerializedCredential } from '../owner-client/credential.js';
import type { RegistrationResponse } from '../owner-client/types.js';
import type { Profile } from './profiles.js';

export interface CreationOptionsJSON {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { alg: number; type: 'public-key' }[];
  authenticatorSelection: { residentKey: 'preferred'; userVerification: 'required' };
  timeout: number;
  attestation: 'none';
}

export interface WalletDeployer {
  deployPasskeyWallet(
    response: RegistrationResponse,
    userName: string,
  ): Promise<{ contractId: string; credentialId: string; credential: SerializedCredential; deployTx: string }>;
}

export interface PasskeyAccount {
  options(p: Profile): Promise<{ optionsJSON: CreationOptionsJSON }>;
  register(p: Profile, response: RegistrationResponse): Promise<{ ownerAddress: string }>;
  wallet(p: Profile): { contractId: string; credentialId: string; credential: SerializedCredential };
}

const ES256 = -7;
export const STALE_CLAIM_MS = 600_000;
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

/**
 * Returns why the response is unacceptable, or null. clientDataJSON.origin must be `origin` or one of `origins` (the web
 * origins the api serves); the rp id check stays strict. The origin is never stored or put on chain: the on-chain
 * WebAuthn verifier ignores it, and the stored credential holds only the key, ids and birth fields.
 */
export function verifyRegistration(response: RegistrationResponse, expected: { challenge: string; origin: string; origins?: readonly string[]; rpId: string }): string | null {
  if (response?.type !== 'public-key' || typeof response.id !== 'string' || !response.id || response.id !== response.rawId) return 'malformed credential';
  if (!/^[A-Za-z0-9_-]+$/.test(response.id)) return 'malformed credential id';
  if (typeof response.response?.publicKey !== 'string' || !response.response.publicKey) return 'no public key';
  if (response.response.publicKeyAlgorithm !== undefined && response.response.publicKeyAlgorithm !== ES256) return 'not a P-256 (ES256) key';
  let cd: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    cd = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
  } catch {
    return 'unreadable clientDataJSON';
  }
  if (cd.type !== 'webauthn.create') return 'not a registration';
  if (cd.challenge !== expected.challenge) return 'challenge mismatch';
  if (typeof cd.origin !== 'string' || (cd.origin !== expected.origin && !expected.origins?.includes(cd.origin))) return 'origin mismatch';
  if (cd.crossOrigin === true) return 'cross-origin registration';
  // Self-lockout guard: a passkey bound to another rp id could never sign for this wallet again.
  if (typeof response.response.authenticatorData !== 'string' || !response.response.authenticatorData) return 'no authenticator data';
  const ad = Buffer.from(response.response.authenticatorData, 'base64url');
  if (ad.length < 55) return 'bad authenticator data';
  if (!ad.subarray(0, 32).equals(createHash('sha256').update(expected.rpId).digest())) return 'rp id mismatch';
  const flags = ad[32]!;
  if (!(flags & UP)) return 'user presence missing';
  if (!(flags & UV)) return 'user verification missing';
  if (!(flags & AT)) return 'no attested credential data';
  const idLen = ad.readUInt16BE(53);
  if (ad.length < 55 + idLen) return 'bad authenticator data';
  if (!ad.subarray(55, 55 + idLen).equals(Buffer.from(response.rawId, 'base64url'))) return 'credential id mismatch';
  return null;
}

export function createPasskeyAccount(d: { sql: Db; chain: WalletDeployer; rpId: string; origin: string; origins?: readonly string[]; challengeTtlMs?: number }): PasskeyAccount {
  const ttl = d.challengeTtlMs ?? 300_000;
  return {
    async options(p) {
      if (p.ownerAddress) throw httpError(409, 'wallet_exists');
      const challenge = randomBytes(32).toString('base64url');
      const now = new Date();
      const set = (await d.sql`update app.users set passkey_challenge = ${challenge}, passkey_challenge_expires_at = ${new Date(now.getTime() + ttl)}
                               where id = ${p.id} and owner_address is null
                                 and (passkey_credential_id is null or passkey_claimed_at is null or passkey_claimed_at < ${new Date(now.getTime() - STALE_CLAIM_MS)})
                               returning id`) as unknown[];
      if (set.length === 0) {
        const [row] = (await d.sql`select owner_address from app.users where id = ${p.id}`) as { owner_address: string | null }[];
        throw httpError(409, row?.owner_address ? 'wallet_exists' : 'wallet_pending');
      }
      return {
        optionsJSON: {
          challenge,
          rp: { id: d.rpId, name: 'AgentEnact' },
          user: { id: Buffer.from(p.id).toString('base64url'), name: p.email, displayName: p.email },
          pubKeyCredParams: [{ alg: ES256, type: 'public-key' }],
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
          timeout: ttl,
          attestation: 'none',
        },
      };
    },

    async register(p, response) {
      if (p.ownerAddress) throw httpError(409, 'wallet_exists');
      // The challenge the browser signed, read only to decide the claim; verifyRegistration checks it for real.
      let signed = '';
      try {
        const cd = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
        if (typeof cd.challenge === 'string') signed = cd.challenge;
      } catch {}
      const credId = typeof response?.id === 'string' ? response.id : '';
      const now = new Date();
      // ONE statement: spend the challenge (always; one attempt per challenge) and, if it is valid, matches what
      // the browser signed and no other deploy is live, claim the deploy for this credential.
      let spent: { challenge: string | null; expires_at: Date | null; claimed: boolean; owner: string | null }[];
      try {
        spent = (await d.sql`with old as (
                               select id, passkey_challenge, passkey_challenge_expires_at, owner_address,
                                 (passkey_challenge is not null and passkey_challenge_expires_at > ${now}
                                  and passkey_challenge = ${signed} and ${credId} <> '' and owner_address is null
                                  and (passkey_credential_id is null or passkey_claimed_at is null
                                       or passkey_claimed_at < ${new Date(now.getTime() - STALE_CLAIM_MS)})) as ok
                               from app.users where id = ${p.id} for update
                             )
                             update app.users u set passkey_challenge = null, passkey_challenge_expires_at = null,
                               passkey_credential_id = case when old.ok then ${credId} else u.passkey_credential_id end,
                               passkey_claimed_at = case when old.ok then ${now} else u.passkey_claimed_at end
                             from old where u.id = old.id
                             returning old.passkey_challenge as challenge, old.passkey_challenge_expires_at as expires_at,
                                       old.ok as claimed, old.owner_address as owner`) as typeof spent;
      } catch (e) {
        if ((e as { errno?: string }).errno === '23505') throw httpError(409, 'wallet_exists'); // credential id already used elsewhere
        throw e;
      }
      const c = spent[0];
      if (c?.owner) throw httpError(409, 'wallet_exists');
      if (!c?.challenge || !c.expires_at || c.expires_at.getTime() <= now.getTime()) throw httpError(400, 'challenge_expired');
      const release = () =>
        d.sql`update app.users set passkey_credential_id = null, passkey_claimed_at = null
              where id = ${p.id} and passkey_credential_id = ${credId} and owner_address is null`;
      if (verifyRegistration(response, { challenge: c.challenge, origin: d.origin, origins: d.origins, rpId: d.rpId })) {
        if (c.claimed) await release();
        throw httpError(400, 'invalid_registration');
      }
      if (!c.claimed) throw httpError(409, 'wallet_pending');

      let wallet: Awaited<ReturnType<WalletDeployer['deployPasskeyWallet']>>;
      try {
        wallet = await d.chain.deployPasskeyWallet(response, p.email);
      } catch {
        await release();
        throw httpError(502, 'wallet_deploy_failed');
      }
      // From here the wallet exists on chain. A failed write must not lose it: keep the claim, surface public ids only.
      let saved: unknown[];
      try {
        saved = (await d.sql`update app.users set owner_address = ${wallet.contractId}, passkey_credential_id = ${wallet.credentialId},
                               passkey_credential = ${wallet.credential}, passkey_claimed_at = null
                             where id = ${p.id} and owner_address is null returning id`) as unknown[];
      } catch {
        throw Object.assign(httpError(502, 'wallet_record_failed'), { contractId: wallet.contractId, deployTx: wallet.deployTx });
      }
      if (saved.length === 0) throw httpError(409, 'wallet_exists');
      return { ownerAddress: wallet.contractId };
    },

    wallet(p) {
      if (!p.ownerAddress || !p.credentialId || !p.credential) throw httpError(404, 'no_wallet');
      return { contractId: p.ownerAddress, credentialId: p.credentialId, credential: p.credential };
    },
  };
}
