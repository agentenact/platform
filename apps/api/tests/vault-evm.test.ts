import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { recordDigest, type UnsignedEnactmentRecord } from 'agentenact';
import { createEvmAdapter } from 'agentenact/adapters/evm';
import { getAddress, recoverTypedDataAddress, verifyMessage, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Db } from '../src/db/index.js';
import { createKeys, type Keys } from '../src/keys/index.js';
import { isVaultRefusal } from '../src/keys/contract.js';
import { localAgentKeys, type AgentKeys } from '../src/keys/rpc.js';
import { createVault, EVM_TESTNETS, VAULT_PER_AGENT_DAY_UNITS, VAULT_PER_CALL_UNITS } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { invocation, scv } from './support/entries.js';
import { insertAgent, insertUser } from './support/fixtures.js';
import { hash, xdr } from '@stellar/stellar-sdk';

const NET = 'eip155:84532';
const USDC = EVM_TESTNETS[NET].usdc;
const seller = () => privateKeyToAccount(generatePrivateKey()).address;
const nowS = () => Math.floor(Date.now() / 1000);

/** EIP-3009 typed data as @x402/evm's client hands it to signTypedData (bigints, checksummed addresses). */
const authorization = (from: string, to: string, value: bigint, o: { chainId?: number; token?: string; validFor?: number; primaryType?: string } = {}) => ({
  domain: { name: 'USDC', version: '2', chainId: o.chainId ?? 84532, verifyingContract: getAddress(o.token ?? USDC) },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: o.primaryType ?? 'TransferWithAuthorization',
  message: {
    from: getAddress(from), to: getAddress(to), value, validAfter: BigInt(nowS() - 600),
    validBefore: BigInt(nowS() + (o.validFor ?? 300)), nonce: `0x${randomBytes(32).toString('hex')}`,
  },
});

const hex = (n = 32) => randomBytes(n).toString('hex');
const record = (address: string, over: { ref?: string; payer?: string; asset?: string; chain?: 'base' | 'stellar' } = {}): UnsignedEnactmentRecord => ({
  v: '0.1',
  agent: { chain: over.chain ?? 'base', address, agentId: '77' },
  input: { sha256: hex(), mediaType: 'application/json' },
  output: { sha256: hex(), mediaType: 'application/json' },
  settlement: {
    chain: over.chain ?? 'base', ref: over.ref ?? `0x${hex()}`, payer: over.payer ?? seller().toLowerCase(),
    amount: '0.010000', asset: over.asset ?? USDC,
  },
  issuedAt: new Date().toISOString(),
  nonce: hex(16),
});

const reasonOf = async (p: Promise<unknown>) => {
  const e = await p.then(() => null, (x: unknown) => x);
  return isVaultRefusal(e) ? e.reason : (e as { reason?: string } | null)?.reason ?? 'no error';
};

describe('keyvault EVM keys', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  let raw: Keys;
  let keys: AgentKeys;
  beforeAll(async () => {
    ({ sql, drop } = await freshDb());
    raw = createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') });
    keys = localAgentKeys(createVault({ sql, keys: raw }));
  });
  afterAll(() => drop());

  const agent = async (status = 'active') => {
    const userId = await insertUser(sql, { ownerAddress: StrKey.encodeContract(randomBytes(32)) });
    const id = await insertAgent(sql, userId, { status });
    await sql`update app.agents set agent_id = '77' where id = ${id}`;
    const { publicKey } = await keys.generate(id);
    return { id, stellar: publicKey };
  };
  const rows = async (id: string, kind: string) =>
    ((await sql`select count(*)::int as n from keyvault.signatures where agent_id = ${id} and kind = ${kind}`) as { n: number }[])[0]!.n;

  describe('the wallet', () => {
    it('is created on first use, stays the same, and lives beside the Stellar key', async () => {
      const a = await agent();
      expect(await raw.evmAddress(a.id)).toBeNull();
      const first = await keys.evmWallet(a.id, NET);
      expect(first).toMatch(/^0x[0-9a-f]{40}$/);
      expect(await keys.evmWallet(a.id, NET)).toBe(first);
      expect(await keys.publicKey(a.id)).toBe(a.stellar); // the Stellar key is untouched
      const live = (await sql`select chain_family from keyvault.keys where agent_id = ${a.id} and destroyed_at is null order by chain_family`) as { chain_family: string }[];
      expect(live.map((r) => r.chain_family)).toEqual(['evm', 'stellar']);
    });

    it('two first calls at once end with one key', async () => {
      const a = await agent();
      const got = await Promise.all(Array.from({ length: 6 }, () => keys.evmWallet(a.id, NET)));
      expect(new Set(got).size).toBe(1);
      const [n] = (await sql`select count(*)::int as n from keyvault.keys where agent_id = ${a.id} and chain_family = 'evm'`) as { n: number }[];
      expect(n!.n).toBe(1);
    });

    it('is made only for an active agent and only on a pinned EVM testnet', async () => {
      for (const status of ['provisioning', 'paused', 'revoked']) expect(await reasonOf(keys.evmWallet((await agent(status)).id, NET))).toBe('not_active');
      const a = await agent();
      for (const net of ['eip155:8453', 'eip155:1', 'eip155:42220', 'stellar:testnet', 'eip155:84532 ']) expect(await reasonOf(keys.evmWallet(a.id, net))).toBe('wrong_network');
      expect(await raw.evmAddress(a.id)).toBeNull();
    });

    it('a sealed EVM row does not open as another agent, or relabelled as Stellar', async () => {
      const a = await agent();
      const b = await agent();
      await keys.evmWallet(a.id, NET);
      const [row] = (await sql`select public_key, ciphertext, nonce from keyvault.keys where agent_id = ${a.id} and chain_family = 'evm'`) as { public_key: string; ciphertext: Uint8Array; nonce: Uint8Array }[];
      await sql`insert into keyvault.keys (agent_id, chain_family, public_key, ciphertext, nonce, key_version) values (${b.id}, 'evm', ${row!.public_key}, ${row!.ciphertext}, ${row!.nonce}, 1)`;
      await expect(raw.withEvmAccount(b.id, async () => 'opened')).rejects.toThrow(/cannot decrypt/);
      // Swap a's Stellar row for its EVM ciphertext: the family is in the AAD, so it does not open as Stellar either.
      await sql`update keyvault.keys set ciphertext = ${row!.ciphertext}, nonce = ${row!.nonce} where agent_id = ${a.id} and chain_family = 'stellar'`;
      await expect(raw.withSecret(a.id, async () => 'opened')).rejects.toThrow(/cannot decrypt/);
    });

    it('destroy wipes every family', async () => {
      const a = await agent();
      await keys.evmWallet(a.id, NET);
      await keys.destroy(a.id);
      expect([await keys.publicKey(a.id), await raw.evmAddress(a.id)]).toEqual([null, null]);
    });
  });

  describe('payments', () => {
    it('signs a pinned-USDC authorization from the agent, verifiably, and counts it in 7-decimal units', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      const to = seller();
      const td = authorization(address, to, 40_000n);
      const sig = await keys.evmPaySigner(a.id, NET, address).signTypedData(td);
      expect((await recoverTypedDataAddress({ ...td, signature: sig } as never)).toLowerCase()).toBe(address);
      const [row] = (await sql`select payee, amount_units::text as amount, network from keyvault.signatures where agent_id = ${a.id} and kind = 'evm_payment'`) as { payee: string; amount: string; network: string }[];
      expect(row).toEqual({ payee: to.toLowerCase(), amount: '400000', network: NET });
    });

    it('refuses what is not this agent paying pinned USDC on Base Sepolia within the caps', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      const pay = (td: unknown, net = NET) => reasonOf(keys.evmPaySigner(a.id, net, address).signTypedData(td as never));
      const to = seller();
      expect(await pay(authorization(seller(), to, 1n))).toBe('wrong_wallet');
      expect(await pay(authorization(address, address, 1n))).toBe('bad_payload');
      expect(await pay(authorization(address, `0x${'0'.repeat(40)}`, 1n))).toBe('bad_payload');
      expect(await pay(authorization(address, to, VAULT_PER_CALL_UNITS / 10n + 1n))).toBe('over_call_cap');
      expect(await pay(authorization(address, to, 0n))).toBe('over_call_cap');
      expect(await pay(authorization(address, to, 1n, { token: seller() }))).toBe('bad_payload'); // not USDC
      expect(await pay(authorization(address, to, 1n, { chainId: 8453 }))).toBe('bad_payload'); // Base mainnet id
      expect(await pay(authorization(address, to, 1n, { chainId: 8453 }), 'eip155:8453')).toBe('wrong_network');
      expect(await pay(authorization(address, to, 1n, { validFor: 3600 }))).toBe('bad_payload');
      expect(await pay(authorization(address, to, 1n, { primaryType: 'Permit' }))).toBe('bad_payload');
      expect(await pay({ domain: {}, types: {}, primaryType: 'TransferWithAuthorization', message: {} })).toBe('bad_payload');
      expect(await pay(`0x${hex()}`)).toBe('bad_payload'); // a bare digest is never signed
      expect(await rows(a.id, 'evm_payment')).toBe(0);
    });

    it('one day cap covers Stellar and EVM payments together, under concurrency', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      // Half the day on Stellar first: 10 × 0.05.
      const pre = (to: string) =>
        xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(TESTNET.passphrase)), nonce: new xdr.Int64(Math.floor(Math.random() * 1e9)), signatureExpirationLedger: 5000,
          invocation: invocation(TESTNET.usdcSac, 'transfer', [scv.addr(a.stellar), scv.addr(to), scv.i128(VAULT_PER_CALL_UNITS)]),
        })).toXDR('base64');
      for (let i = 0; i < 10; i++) await keys.paySigner(a.id, a.stellar).signAuthEntry(pre(Keypair.random().publicKey()));
      const signer = keys.evmPaySigner(a.id, NET, address);
      const out = await Promise.all(Array.from({ length: 14 }, () => signer.signTypedData(authorization(address, seller(), 50_000n)).then(() => 'ok', (e) => (e as { reason: string }).reason)));
      expect(out.filter((r) => r === 'ok')).toHaveLength(10);
      expect(out.filter((r) => r === 'over_day_cap')).toHaveLength(4);
      const [sum] = (await sql`select sum(amount_units)::text as s from keyvault.signatures where agent_id = ${a.id} and kind in ('payment', 'evm_payment')`) as { s: string }[];
      expect(BigInt(sum!.s)).toBe(VAULT_PER_AGENT_DAY_UNITS);
    });

    it('a paused or keyless agent pays nothing', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      await sql`update app.agents set status = 'paused' where id = ${a.id}`;
      expect(await reasonOf(keys.evmPaySigner(a.id, NET, address).signTypedData(authorization(address, seller(), 1n) as never))).toBe('not_active');
      const b = await agent();
      expect(await reasonOf(keys.evmPaySigner(b.id, NET, address).signTypedData(authorization(address, seller(), 1n) as never))).toBe('no_key');
    });
  });

  describe('records', () => {
    it('signs one EIP-191 record per settlement that the library EVM adapter accepts', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      const u = record(address);
      const signed = await keys.evmRecordSigner(a.id, NET)(u);
      expect(signed.sig.alg).toBe('secp256k1-eip191');
      expect(await verifyMessage({ address: address as Hex, message: { raw: await recordDigest(u) }, signature: signed.sig.value as Hex })).toBe(true);
      expect(await createEvmAdapter({ network: NET, client: {} as never }).verify(await recordDigest(u), signed.sig.value, address)).toBe(true);
      expect(await reasonOf(keys.evmRecordSigner(a.id, NET)({ ...record(address), settlement: { ...u.settlement } }))).toBe('record_exists');
    });

    it('a paused agent still signs the record of a call already paid for', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      await sql`update app.agents set status = 'paused' where id = ${a.id}`;
      expect((await keys.evmRecordSigner(a.id, NET)(record(address))).sig.alg).toBe('secp256k1-eip191');
    });

    it('refuses a record that is not this agent, Base Sepolia USDC, from another payer', async () => {
      const a = await agent();
      const address = await keys.evmWallet(a.id, NET);
      const sign = (u: UnsignedEnactmentRecord, net = NET) => reasonOf(keys.evmRecordSigner(a.id, net)(u));
      expect(await sign(record(seller().toLowerCase()))).toBe('wrong_wallet');
      expect(await sign(record(address, { chain: 'stellar' }))).toBe('wrong_network');
      expect(await sign(record(address), 'eip155:8453')).toBe('wrong_network');
      expect(await sign(record(address, { asset: seller().toLowerCase() }))).toBe('bad_payload');
      expect(await sign(record(address, { payer: address }))).toBe('bad_payload');
      expect(await sign(record(address, { payer: getAddress(seller()) }))).toBe('bad_payload'); // checksummed: records are lowercase
      expect(await sign(record(address, { ref: hex() }))).toBe('bad_payload'); // no 0x
      expect(await sign({ ...record(address), issuedAt: '2020-01-01T00:00:00Z' })).toBe('bad_payload');
      expect(await rows(a.id, 'evm_record')).toBe(0);
    });
  });
});
