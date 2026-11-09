/** Stellar testnet constants for the platform and the browser module. Testnet only (P2). */
export const TESTNET = {
  passphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  /** stellar-8004 Identity Registry; equals agentenact NETWORKS['stellar:testnet'].identityRegistry. */
  registry: 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH',
  /** OpenZeppelin multisig account WASM used by smart-account-kit 0.8.0 (passkey spike, gate 1). */
  accountWasmHash: '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a',
  /** WebAuthn verifier contract (passkey spike, gate 1). */
  webauthnVerifier: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
  /** Circle USDC SAC on testnet (agentenact NETWORKS). Never a valid target for an owner signature. */
  usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  /** Circle USDC on testnet as a classic asset, CODE:ISSUER (agentenact NETWORKS): the only trustline the sponsor sponsors. */
  usdc: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
} as const;
