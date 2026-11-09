import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Asset, hash, Keypair, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { recordDigest, type UnsignedEnactmentRecord } from 'agentenact';
import type { Db } from '../src/db/index.js';
import { createKeys, type Keys } from '../src/keys/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { createVaultHandler, localAgentKeys, vaultClient, type AgentKeys } from '../src/keys/rpc.js';
import { createVault, VAULT_PER_AGENT_DAY_UNITS, VAULT_PER_CALL_UNITS, type Vault } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { HIRE_PER_AGENT_DAY_USDC, HIRE_PER_CALL_USDC, units } from '../src/policy/spend.js';
import { freshDb } from './support/db.js';
import { invocation, scv } from './support/entries.js';
import { insertAgent, insertUser } from './support/fixtures.js';

const TOKEN = 'v'.repeat(40);
const [USDC_CODE, USDC_ISSUER] = TESTNET.usdc.split(':') as [string, string];

/** A SEP-43 auth-entry preimage as the x402 Stellar client hands it to signAuthEntry. */
const preimage = (contract: string, fn: string, args: xdr.ScVal[], passphrase: string = TESTNET.passphrase) =>
  xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(passphrase)),
      nonce: new xdr.Int64(Math.floor(Math.random() * 1e9)),
      signatureExpirationLedger: 5000,
      invocation: invocation(contract, fn, args),
    }),
  ).toXDR('base64');
const transfer = (from: string, to: string, amount: bigint, contract: string = TESTNET.usdcSac) =>
  preimage(contract, 'transfer', [scv.addr(from), scv.addr(to), scv.i128(amount)]);
const verifies = (address: string, pre: string, sigB64: string) =>
  Keypair.fromPublicKey(address).verify(hash(Buffer.from(pre, 'base64')), Buffer.from(sigB64, 'base64'));

const birthTx = (agent: string, o: { extra?: boolean; source?: string } = {}) => {
  const sponsor = o.source ?? Keypair.random().publicKey();
  const b = new TransactionBuilder(new Account(sponsor, '1'), { fee: '100', networkPassphrase: TESTNET.passphrase })
    .addOperation(Operation.beginSponsoringFutureReserves({ sponsoredId: agent }))
    .addOperation(Operation.createAccount({ destination: agent, startingBalance: '0' }))
    .addOperation(Operation.changeTrust({ asset: new Asset(USDC_CODE, USDC_ISSUER), source: agent }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: agent }));
  if (o.extra) b.addOperation(Operation.payment({ destination: sponsor, asset: Asset.native(), amount: '1', source: agent }));
  return b.setTimeout(0).build();
};

const hex = (n = 32) => randomBytes(n).toString('hex');
const record = (address: string, over: Partial<UnsignedEnactmentRecord['settlement']> & { issuedAt?: string; agentId?: string } = {}): UnsignedEnactmentRecord => ({
  v: '0.1',
  agent: { chain: 'stellar', address, agentId: over.agentId ?? '77' },
  input: { sha256: hex(), mediaType: 'application/json' },
  output: { sha256: hex(), mediaType: 'application/json' },
  settlement: { chain: 'stellar', ref: over.ref ?? hex(), payer: over.payer ?? Keypair.random().publicKey(), amount: '0.0100000', asset: over.asset ?? TESTNET.usdc },
  issuedAt: over.issuedAt ?? new Date().toISOString(),
  nonce: hex(16),
});

const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : (e as { reason?: string } | null)?.reason ?? 'no error';
};

describe('keyvault', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let raw: Keys;
  let vault: Vault;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    raw = createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });
    vault = createVault({ sql, keys: raw });
    keys = localAgentKeys(vault);
  });
  afterAll(() => drop());

  /** An agent with a live key; `owner` is its user's owner wallet (a C-address). */
  const agent = async (status = 'active') => {
    const owner = StrKey.encodeContract(randomBytes(32));
    const userId = await insertUser(sql, { ownerAddress: owner });
    const id = await insertAgent(sql, userId, { status });
    await sql`update app.agents set agent_id = '77' where id = ${id}`;
    const { publicKey } = await keys.generate(id);
    return { id, owner, address: publicKey };
  };
  const rows = async (id: string, kind: string) =>
    ((await sql`select count(*)::int as n from keyvault.signatures where agent_id = ${id} and kind = ${kind}`) as { n: number }[])[0]!.n;

  it('its caps equal the api hire caps (a backstop, not a second policy)', () => {
    expect([VAULT_PER_CALL_UNITS, VAULT_PER_AGENT_DAY_UNITS]).toEqual([units(HIRE_PER_CALL_USDC), units(HIRE_PER_AGENT_DAY_USDC)]);
  });

  describe('payments', () => {
    it('signs a pinned-USDC transfer from the agent, verifiably, and counts it', async () => {
      const a = await agent();
      const pre = transfer(a.address, Keypair.random().publicKey(), 100_000n);
      const s = await keys.paySigner(a.id, a.address).signAuthEntry(pre);
      expect(s.signerAddress).toBe(a.address);
      expect(verifies(a.address, pre, s.signedAuthEntry)).toBe(true);
      const [row] = (await sql`select payee, amount_units::text as amount, digest from keyvault.signatures where agent_id = ${a.id}`) as { payee: string; amount: string; digest: string }[];
      expect(row!.amount).toBe('100000');
      expect(row!.digest).toBe(hash(Buffer.from(pre, 'base64')).toString('hex'));
    });

    it('refuses what is not this agent paying pinned USDC within the caps', async () => {
      const a = await agent();
      const seller = Keypair.random().publicKey();
      const pay = (pre: string) => reasonOf(keys.paySigner(a.id, a.address).signAuthEntry(pre));
      expect(await pay(transfer(Keypair.random().publicKey(), seller, 1n))).toBe('wrong_wallet');
      expect(await pay(transfer(a.address, a.address, 1n))).toBe('bad_payload');
      expect(await pay(transfer(a.address, seller, VAULT_PER_CALL_UNITS + 1n))).toBe('over_call_cap');
      expect(await pay(transfer(a.address, seller, 1n, StrKey.encodeContract(randomBytes(32))))).toBe('bad_payload'); // not the USDC SAC
      expect(await pay(preimage(TESTNET.usdcSac, 'approve', [scv.addr(a.address), scv.addr(seller), scv.i128(1n)]))).toBe('bad_payload');
      expect(await pay(preimage(TESTNET.usdcSac, 'transfer', [scv.addr(a.address), scv.addr(seller), scv.i128(1n)], 'Public Global Stellar Network ; September 2015'))).toBe('bad_payload');
      expect(await pay('AAAA')).toBe('bad_payload');
      // A raw 32-byte digest (what a tx hash looks like) is never signed.
      expect(await pay(randomBytes(32).toString('base64'))).toBe('bad_payload');
      expect(await rows(a.id, 'payment')).toBe(0);
    });

    it('stops at the per-agent day cap, counting every signature (used or not), under concurrency', async () => {
      const a = await agent();
      const seller = Keypair.random().publicKey();
      const signer = keys.paySigner(a.id, a.address);
      const asks = Array.from({ length: 25 }, () => signer.signAuthEntry(transfer(a.address, seller, VAULT_PER_CALL_UNITS)).then(() => 'ok', (e) => (e as { reason: string }).reason));
      const out = await Promise.all(asks);
      expect(out.filter((r) => r === 'ok')).toHaveLength(20); // 20 × 0.05 = 1.00
      expect(out.filter((r) => r === 'over_day_cap')).toHaveLength(5);
      const [sum] = (await sql`select sum(amount_units)::text as s from keyvault.signatures where agent_id = ${a.id} and kind = 'payment'`) as { s: string }[];
      expect(BigInt(sum!.s)).toBe(VAULT_PER_AGENT_DAY_UNITS);
    });

    it('a paused, revoked or keyless agent pays nothing', async () => {
      for (const status of ['paused', 'revoked', 'provisioning']) {
        const a = await agent(status);
        expect(await reasonOf(keys.paySigner(a.id, a.address).signAuthEntry(transfer(a.address, Keypair.random().publicKey(), 1n)))).toBe('not_active');
      }
      const a = await agent();
      await keys.destroy(a.id);
      expect(await reasonOf(keys.paySigner(a.id, a.address).signAuthEntry(transfer(a.address, Keypair.random().publicKey(), 1n)))).toBe('no_key');
    });
  });

  describe('records', () => {
    it('signs this agent\'s record once per settlement; the signature verifies over the record digest', async () => {
      const a = await agent();
      const u = record(a.address);
      const signed = await keys.recordSigner(a.id)(u);
      expect(signed.sig.alg).toBe('ed25519');
      expect(Keypair.fromPublicKey(a.address).verify(Buffer.from(await recordDigest(u)), Buffer.from(signed.sig.value, 'hex'))).toBe(true);
      // A second record for the same payment would be a second claim about what it bought.
      expect(await reasonOf(keys.recordSigner(a.id)({ ...record(a.address), settlement: u.settlement }))).toBe('record_exists');
    });

    it('refuses another agent\'s address, a foreign asset, a self-payment, a stale clock, another agentId, a bad shape', async () => {
      const a = await agent();
      const sign = (u: unknown) => reasonOf(keys.recordSigner(a.id)(u as UnsignedEnactmentRecord));
      expect(await sign(record(Keypair.random().publicKey()))).toBe('wrong_wallet');
      expect(await sign(record(a.address, { asset: 'XLM' }))).toBe('bad_payload');
      expect(await sign(record(a.address, { payer: a.address }))).toBe('bad_payload');
      expect(await sign(record(a.address, { issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() }))).toBe('bad_payload');
      expect(await sign(record(a.address, { agentId: '78' }))).toBe('bad_payload');
      expect(await sign({ v: '0.1' })).toBe('bad_payload');
      expect(await rows(a.id, 'record')).toBe(0);
    });

    it('a paused agent still signs the record of a paid call; a revoked one does not', async () => {
      const p = await agent('paused');
      expect((await keys.recordSigner(p.id)(record(p.address))).sig.alg).toBe('ed25519');
      const r = await agent('revoked');
      expect(await reasonOf(keys.recordSigner(r.id)(record(r.address)))).toBe('not_active');
    });
  });

  describe('birth and bind', () => {
    it('signs the exact birth tx while provisioning, and nothing else', async () => {
      const a = await agent('provisioning');
      const signer = keys.agentSigner(a.id, a.address);
      const tx = birthTx(a.address);
      const sig = await signer.signTransaction(tx.toXDR(), TESTNET.passphrase);
      expect(Keypair.fromPublicKey(a.address).verify(tx.hash(), Buffer.from(sig, 'base64'))).toBe(true);
      expect(await reasonOf(signer.signTransaction(birthTx(a.address, { extra: true }).toXDR(), TESTNET.passphrase))).toBe('bad_payload');
      expect(await reasonOf(signer.signTransaction(birthTx(a.address, { source: a.address }).toXDR(), TESTNET.passphrase))).toBe('bad_payload');
      expect(await reasonOf(signer.signTransaction(tx.toXDR(), 'Public Global Stellar Network ; September 2015'))).toBe('wrong_network');
      const live = await agent('active');
      expect(await reasonOf(keys.agentSigner(live.id, live.address).signTransaction(birthTx(live.address).toXDR(), TESTNET.passphrase))).toBe('not_provisioning');
    });

    it('signs set_agent_wallet only for the agent\'s own owner and wallet', async () => {
      const a = await agent('provisioning');
      const signer = keys.agentSigner(a.id, a.address);
      const bind = (owner: string, wallet: string, contract: string = TESTNET.registry) => preimage(contract, 'set_agent_wallet', [scv.addr(owner), scv.u32(42), scv.addr(wallet)]);
      const ok = bind(a.owner, a.address);
      expect(verifies(a.address, ok, await signer.signAuthEntry(ok))).toBe(true);
      expect(await reasonOf(signer.signAuthEntry(bind(StrKey.encodeContract(randomBytes(32)), a.address)))).toBe('wrong_owner');
      expect(await reasonOf(signer.signAuthEntry(bind(a.owner, Keypair.random().publicKey())))).toBe('bad_payload');
      expect(await reasonOf(signer.signAuthEntry(bind(a.owner, a.address, StrKey.encodeContract(randomBytes(32)))))).toBe('bad_payload');
      // A transfer is not a bind, even while provisioning.
      expect(await reasonOf(signer.signAuthEntry(transfer(a.address, Keypair.random().publicKey(), 1n)))).toBe('bad_payload');
      expect([await rows(a.id, 'bind'), await rows(a.id, 'birth')]).toEqual([1, 0]);
    });
  });

  describe('http', () => {
    const client = (fetch: typeof globalThis.fetch, token = TOKEN) => vaultClient({ env: { VAULT_URL: 'http://vault.internal:8081', VAULT_TOKEN: token }, fetch });
    const via = (h: (r: Request) => Promise<Response>, seen?: Request[]) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const r = new Request(input, init);
        seen?.push(r.clone());
        return h(r);
      }) as typeof globalThis.fetch;

    it('refuses to build without a strong token or a URL', () => {
      expect(() => createVaultHandler(vault, { env: { VAULT_TOKEN: 'short' } })).toThrow('VAULT_TOKEN');
      expect(() => vaultClient({ env: { VAULT_TOKEN: TOKEN } })).toThrow('VAULT_URL');
    });

    it('carries signatures and refusals over the wire; a wrong token gets nothing', async () => {
      const h = createVaultHandler(vault, { env: { VAULT_TOKEN: TOKEN } });
      const seen: Request[] = [];
      const remote = client(via(h, seen));
      const a = await agent();
      expect(await remote.publicKey(a.id)).toBe(a.address);
      const pre = transfer(a.address, Keypair.random().publicKey(), 1n);
      expect(verifies(a.address, pre, (await remote.paySigner(a.id, a.address).signAuthEntry(pre)).signedAuthEntry)).toBe(true);
      expect(await reasonOf(remote.paySigner(a.id, a.address).signAuthEntry(transfer(a.address, a.address, 1n)))).toBe('bad_payload');
      expect(seen.every((r) => r.headers.get('authorization') === `Bearer ${TOKEN}` && new URL(r.url).pathname === '/v1/call')).toBe(true);
      // The request carries the payload and the token, never a key.
      for (const r of seen) expect(await r.text()).not.toMatch(/"S[A-Z2-7]{55}"/);
      expect(await reasonOf(client(via(h), 'w'.repeat(40)).publicKey(a.id))).toBe('unauthorized');
      const bare = await h(new Request('http://vault/v1/call', { method: 'POST', body: '{}' }));
      expect([bare.status, await bare.json()]).toEqual([401, { ok: false, reason: 'unauthorized' }]);
    });

    it('answers nothing that came through a proxy, not even health: the vault is internal only', async () => {
      const h = createVaultHandler(vault, { env: { VAULT_TOKEN: TOKEN } });
      for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded']) {
        const health = await h(new Request('http://vault/health', { headers: { [header]: '203.0.113.7' } }));
        const call = await h(new Request('http://vault/v1/call', { method: 'POST', headers: { [header]: '203.0.113.7', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ op: 'publicKey', args: { agentId: crypto.randomUUID() } }) }));
        expect([header, health.status, call.status, await call.text()]).toEqual([header, 404, 404, 'not found']);
      }
      expect((await h(new Request('http://vault/health'))).status).toBe(200);
    });

    it('answers bad requests and unknown ops with 400 and internal errors with a bare 500', async () => {
      const h = createVaultHandler(vault, { env: { VAULT_TOKEN: TOKEN } });
      const call = (body: string) => h(new Request('http://vault/v1/call', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body }));
      expect((await call('not json')).status).toBe(400);
      expect((await call(JSON.stringify({ op: 'withSecret', args: { agentId: crypto.randomUUID() } }))).status).toBe(400);
      expect((await call(JSON.stringify({ op: 'publicKey', args: { agentId: 'x' } }))).status).toBe(400);
      const broken = createVaultHandler({ ...vault, publicKey: async () => Promise.reject(new Error('db: password=hunter2')) }, { env: { VAULT_TOKEN: TOKEN } });
      const r = await broken(new Request('http://vault/v1/call', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ op: 'publicKey', args: { agentId: crypto.randomUUID() } }) }));
      expect([r.status, await r.text()]).toEqual([500, JSON.stringify({ ok: false, reason: 'failed' })]);
    });

    it('caches webhook secrets: one vault call per agent, same value as the key unit derives', async () => {
      const h = createVaultHandler(vault, { env: { VAULT_TOKEN: TOKEN } });
      const seen: Request[] = [];
      const remote = client(via(h, seen));
      const id = crypto.randomUUID();
      expect(await remote.webhookSecret(id)).toBe(raw.webhookSecret(id));
      await remote.webhookSecret(id);
      expect(seen).toHaveLength(1);
    });
  });
});
