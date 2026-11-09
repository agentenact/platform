import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createPasskeyAccount, verifyRegistration, type WalletDeployer } from '../src/account/passkey.js';
import { getProfile, type Profile } from '../src/account/profiles.js';
import type { Db } from '../src/db/index.js';
import type { RegistrationResponse } from '../src/owner-client/types.js';
import { freshDb } from './support/db.js';
import { contractAddress, insertUser } from './support/fixtures.js';
import { softAuthenticator } from './support/soft-authenticator.js';

const RP_ID = 'agentenact.io';
const ORIGIN = 'https://app.agentenact.io';
const walletC = contractAddress(7);

let seq = 40;
function deployer(fail = false, addr = contractAddress(++seq)) {
  const calls: { response: RegistrationResponse; userName: string }[] = [];
  const d: WalletDeployer = {
    async deployPasskeyWallet(response, userName) {
      calls.push({ response, userName });
      if (fail) throw new Error(`chain: wallet deploy failed (tx ${'e'.repeat(64)}): SUBMISSION_FAILED`);
      return {
        contractId: addr,
        credentialId: response.id,
        credential: { credentialId: response.id, publicKey: 'BAQE', contractId: addr, createdAt: 1, isPrimary: true, birthConstructorArgsHash: 'ab' },
        deployTx: 'd'.repeat(64),
      };
    },
  };
  return { d, calls, addr };
}

describe('passkey registration', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  const profile = async (): Promise<Profile> => (await getProfile(sql, await insertUser(sql)))!;

  it('options: a fresh challenge for our rp id, ES256 only, user verification required', async () => {
    const acc = createPasskeyAccount({ sql, chain: deployer().d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const { optionsJSON } = await acc.options(p);
    expect(optionsJSON.rp).toEqual({ id: RP_ID, name: 'AgentEnact' });
    expect(optionsJSON.pubKeyCredParams).toEqual([{ alg: -7, type: 'public-key' }]);
    expect(optionsJSON.authenticatorSelection).toEqual({ residentKey: 'preferred', userVerification: 'required' });
    expect(optionsJSON.user).toEqual({ id: Buffer.from(p.id).toString('base64url'), name: p.email, displayName: p.email });
    expect(optionsJSON.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = (await sql`select passkey_challenge from app.users where id = ${p.id}`) as { passkey_challenge: string }[];
    expect(row!.passkey_challenge).toBe(optionsJSON.challenge);
  });

  it('register: verifies the browser response, deploys the wallet, stores the owner and credential', async () => {
    const dep = deployer(false, walletC);
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const response = await soft.webAuthn.startRegistration(await acc.options(p));
    expect(await acc.register(p, response)).toEqual({ ownerAddress: walletC });
    expect(dep.calls).toEqual([{ response, userName: p.email }]);
    const after = (await getProfile(sql, p.id))!;
    expect(after.ownerAddress).toBe(walletC);
    expect(after.credentialId).toBe(response.id);
    expect(after.credential?.birthConstructorArgsHash).toBe('ab');
    expect(acc.wallet(after)).toEqual({ contractId: walletC, credentialId: response.id, credential: after.credential! });
    const [row] = (await sql`select passkey_challenge from app.users where id = ${p.id}`) as { passkey_challenge: string | null }[];
    expect(row!.passkey_challenge).toBeNull();
    await expect(acc.options(after)).rejects.toMatchObject({ status: 409, code: 'wallet_exists' });
  });

  it('a wrong origin or challenge is refused before any deploy, and the challenge is spent', async () => {
    const dep = deployer();
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const evil = softAuthenticator({ rpId: RP_ID, origin: 'https://evil.example' });
    const opts = await acc.options(p);
    await expect(acc.register(p, await evil.webAuthn.startRegistration(opts))).rejects.toMatchObject({ status: 400, code: 'invalid_registration' });
    const good = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await expect(acc.register(p, await good.webAuthn.startRegistration(opts))).rejects.toMatchObject({ status: 400, code: 'challenge_expired' });
    await acc.options(p);
    await expect(acc.register(p, await good.webAuthn.startRegistration({ optionsJSON: { challenge: 'not-the-one' } }))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_registration',
    });
    expect(dep.calls).toHaveLength(0);
  });

  it('an expired challenge, or no options at all, is refused', async () => {
    const acc = createPasskeyAccount({ sql, chain: deployer().d, rpId: RP_ID, origin: ORIGIN, challengeTtlMs: -1 });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await expect(acc.register(p, await soft.webAuthn.startRegistration({ optionsJSON: { challenge: 'x' } }))).rejects.toMatchObject({ code: 'challenge_expired' });
    const opts = await acc.options(p);
    await expect(acc.register(p, await soft.webAuthn.startRegistration(opts))).rejects.toMatchObject({ code: 'challenge_expired' });
  });

  it('a failed deploy is a 502 and leaves the profile without a wallet', async () => {
    const acc = createPasskeyAccount({ sql, chain: deployer(true).d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await expect(acc.register(p, await soft.webAuthn.startRegistration(await acc.options(p)))).rejects.toMatchObject({
      status: 502,
      code: 'wallet_deploy_failed',
    });
    expect((await getProfile(sql, p.id))!.ownerAddress).toBeNull();
    expect(() => acc.wallet(p)).toThrow('no_wallet');
  });

  it('verifyRegistration names what is wrong', async () => {
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const ok = await soft.webAuthn.startRegistration({ optionsJSON: { challenge: 'c1' } });
    expect(verifyRegistration(ok, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBeNull();
    const asGet = { ...ok, response: { ...ok.response, clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toString('base64url') } };
    expect(verifyRegistration(asGet, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBe('not a registration');
    expect(verifyRegistration({ ...ok, response: { ...ok.response, publicKeyAlgorithm: -8 } }, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBe('not a P-256 (ES256) key');
    expect(verifyRegistration({ ...ok, rawId: 'other' }, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBe('malformed credential');
    const exp = { challenge: 'c1', origin: ORIGIN, rpId: RP_ID };
    const withAuthData = (mut: (b: Buffer) => Buffer | void) => {
      const b = Buffer.from(ok.response.authenticatorData!, 'base64url');
      return { ...ok, response: { ...ok.response, authenticatorData: (mut(b) ?? b).toString('base64url') } };
    };
    expect(verifyRegistration(withAuthData((b) => void (b[0] = b[0]! ^ 1)), exp)).toBe('rp id mismatch');
    expect(verifyRegistration(withAuthData((b) => void (b[32] = 0x41)), exp)).toBe('user verification missing');
    expect(verifyRegistration(withAuthData((b) => void (b[32] = 0x05)), exp)).toBe('no attested credential data');
    expect(verifyRegistration(withAuthData((b) => void (b[60] = b[60]! ^ 1)), exp)).toBe('credential id mismatch');
    expect(verifyRegistration(withAuthData((b) => b.subarray(0, 40)), exp)).toBe('bad authenticator data');
    const { authenticatorData: _a, ...noAuth } = ok.response;
    expect(verifyRegistration({ ...ok, response: noAuth }, exp)).toBe('no authenticator data');
    const cross = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: 'c1', origin: ORIGIN, crossOrigin: true })).toString('base64url');
    expect(verifyRegistration({ ...ok, response: { ...ok.response, clientDataJSON: cross } }, exp)).toBe('cross-origin registration');
    const { publicKey: _, ...noKey } = ok.response;
    expect(verifyRegistration({ ...ok, response: noKey }, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBe('no public key');
  });

  it('verifyRegistration with an origin list: any listed origin, never an unlisted one; the rp id stays strict', async () => {
    const listed = { challenge: 'c1', origin: ORIGIN, origins: ['https://agentenact.io', 'https://staging.agentenact.io'], rpId: RP_ID };
    for (const origin of [ORIGIN, 'https://agentenact.io', 'https://staging.agentenact.io']) {
      const r = await softAuthenticator({ rpId: RP_ID, origin }).webAuthn.startRegistration({ optionsJSON: { challenge: 'c1' } });
      expect([origin, verifyRegistration(r, listed)]).toEqual([origin, null]);
    }
    for (const origin of ['https://evil.agentenact.io', 'http://agentenact.io', 'https://agentenact.io:8443', 'https://agentenact.srvl.app']) {
      const r = await softAuthenticator({ rpId: RP_ID, origin }).webAuthn.startRegistration({ optionsJSON: { challenge: 'c1' } });
      expect([origin, verifyRegistration(r, listed)]).toEqual([origin, 'origin mismatch']);
    }
    const otherRp = await softAuthenticator({ rpId: 'staging.agentenact.io', origin: 'https://staging.agentenact.io' }).webAuthn.startRegistration({ optionsJSON: { challenge: 'c1' } });
    expect(verifyRegistration(otherRp, listed)).toBe('rp id mismatch');
    const fresh = await softAuthenticator({ rpId: RP_ID, origin: 'https://agentenact.io' }).webAuthn.startRegistration({ optionsJSON: { challenge: 'c1' } });
    expect(verifyRegistration(fresh, { challenge: 'c1', origin: ORIGIN, rpId: RP_ID })).toBe('origin mismatch'); // no list: canonical only
  });

  it('register: a passkey made on a listed origin gets its wallet; an unlisted origin is refused and deploys nothing', async () => {
    const dep = deployer();
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN, origins: ['https://agentenact.io'] });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: 'https://agentenact.io' });
    expect(await acc.register(p, await soft.webAuthn.startRegistration(await acc.options(p)))).toEqual({ ownerAddress: dep.addr });
    expect(dep.calls.length).toBe(1);

    const dep2 = deployer();
    const acc2 = createPasskeyAccount({ sql, chain: dep2.d, rpId: RP_ID, origin: ORIGIN, origins: ['https://agentenact.io'] });
    const q = await profile();
    const evil = softAuthenticator({ rpId: RP_ID, origin: 'https://staging.agentenact.io' });
    await expect(acc2.register(q, await evil.webAuthn.startRegistration(await acc2.options(q)))).rejects.toMatchObject({ status: 400, code: 'invalid_registration' });
    expect(dep2.calls.length).toBe(0);
    expect((await getProfile(sql, q.id))!.ownerAddress).toBeNull();
  });

  it('options: the timeout is the challenge ttl', async () => {
    const acc = createPasskeyAccount({ sql, chain: deployer().d, rpId: RP_ID, origin: ORIGIN, challengeTtlMs: 60_000 });
    expect((await acc.options(await profile())).optionsJSON.timeout).toBe(60_000);
  });

  it('register refuses a profile that already has a wallet', async () => {
    const dep = deployer();
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = { ...(await profile()), ownerAddress: walletC };
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await expect(acc.register(p, await soft.webAuthn.startRegistration({ optionsJSON: { challenge: 'x' } }))).rejects.toMatchObject({ status: 409, code: 'wallet_exists' });
    const uid = await insertUser(sql, { ownerAddress: contractAddress(9) });
    const real = (await getProfile(sql, uid))!;
    await expect(acc.register({ ...real, ownerAddress: null }, await soft.webAuthn.startRegistration({ optionsJSON: { challenge: 'x' } }))).rejects.toMatchObject({
      status: 409,
      code: 'wallet_exists',
    });
    expect(dep.calls).toHaveLength(0);
  });

  it('a challenge can be spent only once, even when two registers race for it', async () => {
    const dep = deployer();
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const r = await soft.webAuthn.startRegistration(await acc.options(p));
    const results = await Promise.allSettled([acc.register(p, r), acc.register(p, r)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(dep.calls).toHaveLength(1);
    const lost = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: expect.any(Number) });
  });

  it('a pending deploy claim blocks a second deploy (409 wallet_pending) and new options', async () => {
    let enter!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const pendC = contractAddress(31);
    const chain: WalletDeployer = {
      async deployPasskeyWallet(response) {
        calls.push(response.id);
        enter();
        await gate;
        return { contractId: pendC, credentialId: response.id, credential: { credentialId: response.id, publicKey: 'BAQE', contractId: pendC, createdAt: 1, isPrimary: true, birthConstructorArgsHash: 'ab' }, deployTx: 'd'.repeat(64) };
      },
    };
    const acc = createPasskeyAccount({ sql, chain, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const a = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const first = acc.register(p, await a.webAuthn.startRegistration(await acc.options(p)));
    await entered; // deploy A is in flight, its claim is held
    await expect(acc.options(p)).rejects.toMatchObject({ status: 409, code: 'wallet_pending' });
    // a second valid challenge for the same user (planted directly) still cannot start another deploy
    await sql`update app.users set passkey_challenge = 'second', passkey_challenge_expires_at = ${new Date(Date.now() + 60_000)} where id = ${p.id}`;
    const b = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    await expect(acc.register(p, await b.webAuthn.startRegistration({ optionsJSON: { challenge: 'second' } }))).rejects.toMatchObject({ status: 409, code: 'wallet_pending' });
    expect(calls).toEqual([a.credentialId]);
    release();
    expect(await first).toEqual({ ownerAddress: pendC });
  });

  it('a stale claim can be retaken', async () => {
    const dep = deployer();
    const acc = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    await sql`update app.users set passkey_credential_id = 'crashed', passkey_claimed_at = now() - interval '20 minutes' where id = ${p.id}`;
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    expect(await acc.register(p, await soft.webAuthn.startRegistration(await acc.options(p)))).toEqual({ ownerAddress: dep.addr });
    expect(dep.calls).toHaveLength(1);
  });

  it('a failed deploy releases the claim so the user can retry', async () => {
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const bad = createPasskeyAccount({ sql, chain: deployer(true).d, rpId: RP_ID, origin: ORIGIN });
    await expect(bad.register(p, await soft.webAuthn.startRegistration(await bad.options(p)))).rejects.toMatchObject({ code: 'wallet_deploy_failed' });
    const [row] = (await sql`select passkey_credential_id, passkey_claimed_at from app.users where id = ${p.id}`) as { passkey_credential_id: string | null; passkey_claimed_at: Date | null }[];
    expect(row).toEqual({ passkey_credential_id: null, passkey_claimed_at: null });
    const dep = deployer();
    const good = createPasskeyAccount({ sql, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    expect(await good.register(p, await soft.webAuthn.startRegistration(await good.options(p)))).toEqual({ ownerAddress: dep.addr });
  });

  it('deploy succeeds, the profile write fails: the error still carries contractId and deployTx and the claim stays', async () => {
    const dep = deployer();
    // Wrap the Db: the final profile write (sets owner_address) throws; everything else passes through.
    const flaky = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        const strings = args[0] as readonly string[] | undefined;
        if (Array.isArray(strings) && strings.join('?').includes('set owner_address')) throw new Error('db down');
        return Reflect.apply(target, thisArg, args);
      },
    }) as Db;
    const acc = createPasskeyAccount({ sql: flaky, chain: dep.d, rpId: RP_ID, origin: ORIGIN });
    const p = await profile();
    const soft = softAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const err = await acc.register(p, await soft.webAuthn.startRegistration(await acc.options(p))).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'wallet_record_failed', contractId: dep.addr, deployTx: 'd'.repeat(64) });
    const [row] = (await sql`select owner_address, passkey_credential_id from app.users where id = ${p.id}`) as { owner_address: string | null; passkey_credential_id: string | null }[];
    expect(row).toEqual({ owner_address: null, passkey_credential_id: soft.credentialId });
  });
});
