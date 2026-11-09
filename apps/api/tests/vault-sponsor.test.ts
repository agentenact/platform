import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Account, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { policySponsor } from '../src/chain/sponsor.js';
import type { Db } from '../src/db/index.js';
import { createKeys } from '../src/keys/index.js';
import { localAgentKeys } from '../src/keys/rpc.js';
import { createVault, VAULT_SPONSOR_DAY_FEE_STROOPS } from '../src/keys/vault.js';
import { TESTNET } from '../src/owner-client/testnet.js';
import { freshDb } from './support/db.js';
import { walletDeployTx } from './support/sponsor-txs.js';

const reasonOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e as { reason?: string }).reason ?? String(e));

describe('vault: the sponsor key', () => {
  let sql: Db;
  let drop: () => Promise<void>;
  const kp = Keypair.random();
  const sponsor = kp.publicKey();
  beforeAll(async () => ({ sql, drop } = await freshDb()));
  afterAll(() => drop());
  beforeEach(async () => void (await sql`delete from keyvault.sponsor_signatures`));

  const keysWith = (withSponsor = true) =>
    localAgentKeys(createVault({ sql, keys: createKeys(sql, { KEYS_MASTER_SECRET: randomBytes(32).toString('base64') }), sponsor: withSponsor ? policySponsor(kp) : undefined }));

  it('signs the sponsor shapes, verifiably, and counts each with its fee', async () => {
    const keys = keysWith();
    expect(await keys.sponsorPublicKey()).toBe(sponsor);
    const tx = walletDeployTx(sponsor, { fee: '250000' });
    const signed = TransactionBuilder.fromXDR(await keys.sponsorSigner(sponsor).signTransaction(tx.toXDR(), TESTNET.passphrase), TESTNET.passphrase);
    expect(kp.verify(signed.hash(), signed.signatures[0]!.signature())).toBe(true);
    const rows = await sql`select kind, tx_hash, fee_stroops::text as fee from keyvault.sponsor_signatures`;
    expect(rows).toEqual([{ kind: 'wallet', tx_hash: tx.hash().toString('hex'), fee: '250000' }]);
  });

  it('refuses any other shape, network or source, and counts nothing', async () => {
    const signer = keysWith().sponsorSigner(sponsor);
    const pay = new TransactionBuilder(new Account(sponsor, '1'), { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(await reasonOf(signer.signTransaction(pay.toXDR(), TESTNET.passphrase))).toBe('bad_payload');
    expect(await reasonOf(signer.signTransaction(walletDeployTx(Keypair.random().publicKey()).toXDR(), TESTNET.passphrase))).toBe('bad_payload');
    expect(await reasonOf(signer.signTransaction(walletDeployTx(sponsor).toXDR(), 'Public Global Stellar Network ; September 2015'))).toBe('wrong_network');
    expect(await reasonOf(signer.signTransaction('AAAA', TESTNET.passphrase))).toBe('bad_payload');
    expect(((await sql`select count(*)::int as n from keyvault.sponsor_signatures`) as { n: number }[])[0]!.n).toBe(0);
  });

  it('a vault without the sponsor key signs nothing for it', async () => {
    const keys = keysWith(false);
    expect(await reasonOf(keys.sponsorPublicKey())).toBe('no_key');
    expect(await reasonOf(keys.sponsorSigner(sponsor).signTransaction(walletDeployTx(sponsor).toXDR(), TESTNET.passphrase))).toBe('no_key');
  });

  it('stops at the day fee cap, counting every signature, under concurrency', async () => {
    const signer = keysWith().sponsorSigner(sponsor);
    const perTx = 1_000_000_000n; // the per-tx cap, 100 XLM
    const asks = Array.from({ length: 12 }, () => signer.signTransaction(walletDeployTx(sponsor, { fee: perTx.toString() }).toXDR(), TESTNET.passphrase).then(() => 'ok', (e) => (e as { reason: string }).reason));
    const out = await Promise.all(asks);
    expect(out.filter((r) => r === 'ok')).toHaveLength(Number(VAULT_SPONSOR_DAY_FEE_STROOPS / perTx));
    expect(out.filter((r) => r === 'over_day_cap')).toHaveLength(12 - Number(VAULT_SPONSOR_DAY_FEE_STROOPS / perTx));
  });
});
