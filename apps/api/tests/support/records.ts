import { Keypair } from '@stellar/stellar-sdk';
import { signRecord, type EnactmentRecord } from 'agentenact';
import { createStellarAdapter } from 'agentenact/adapters/stellar';
import { USDC_TESTNET } from './x402.js';

/** A record signed by the library's own signer with `kp`, binding `tx` as its settlement. */
export async function signedRecord(kp: Keypair, tx: string, over: { agentId?: string } = {}): Promise<EnactmentRecord> {
  const hex = (c: string) => c.repeat(64);
  return signRecord(
    {
      v: '0.1',
      agent: { chain: 'stellar', address: kp.publicKey(), agentId: over.agentId ?? '77' },
      input: { sha256: hex('a'), mediaType: 'application/json' },
      output: { sha256: hex('b'), mediaType: 'application/json', bytes: 12 },
      settlement: { chain: 'stellar', ref: tx, payer: Keypair.random().publicKey(), amount: '0.0100000', asset: USDC_TESTNET },
      issuedAt: new Date().toISOString(),
      nonce: 'c'.repeat(32),
    },
    createStellarAdapter({ network: 'testnet' }),
    kp.rawSecretKey(),
  );
}
