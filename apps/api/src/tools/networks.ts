/**
 * Stellar networks the read tools may query (P4 Task 3). READ-ONLY: this table feeds `tools/chain.ts` reads
 * through safeFetch and nothing else. No signer, submitter, sponsor, provision or x402 path may import it
 * (tests/invariants.test.ts); `stellar:testnet` stays the only network those paths know.
 *
 * Reflector pubnet CEX/DEX oracle (SEP-40, USD base, 14 decimals, 300 s resolution) pinned per D12:
 *   id       CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN
 *   listed   https://developers.stellar.org/docs/data/oracles/oracle-providers ("External CEXs & DEXs", Mainnet)
 *   verified 2026-10-12: simulateTransaction `assets()` on https://mainnet.sorobanrpc.com returned the same 16
 *            symbols as the testnet feed, XLM included; `decimals()` = 14, `resolution()` = 300.
 * USDC pubnet issuer copied from the agentenact library, src/networks.ts, `stellar:pubnet`.
 */
import { TESTNET } from '../owner-client/testnet.js';

export type StellarNetwork = 'testnet' | 'mainnet';

export interface StellarReadNetwork {
  horizonUrl: string;
  rpcUrl: string;
  passphrase: string;
  reflector: string;
  usdcIssuer: string;
  source: 'reflector-testnet' | 'reflector-pubnet';
}

export const STELLAR_READ: Record<StellarNetwork, StellarReadNetwork> = {
  testnet: {
    horizonUrl: TESTNET.horizonUrl,
    rpcUrl: TESTNET.rpcUrl,
    passphrase: TESTNET.passphrase,
    reflector: 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63',
    usdcIssuer: TESTNET.usdc.split(':')[1]!,
    source: 'reflector-testnet',
  },
  mainnet: {
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    passphrase: 'Public Global Stellar Network ; September 2015',
    reflector: 'CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN',
    usdcIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    source: 'reflector-pubnet',
  },
};
