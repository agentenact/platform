/** The package's own browser bundle (site/verifier/build.ts), loaded at runtime from /verifier/agentenact.js. */

export interface StellarSigner {
  publicKey: string;
  signTransaction(xdr: string, networkPassphrase: string): Promise<string>;
}

export interface CreatedAgent {
  publicKey: string;
  secret: string;
  agentId: string;
  owner: string;
  txs: { account: string; register: string; bind: string };
}

/** Attached by createStellarAgent to the error it throws once the agent account exists on chain. */
export interface PartialAgent {
  publicKey: string;
  secret: string;
  owner: string;
  agentId?: string;
  txs: { account?: string; register?: string; bind?: string };
}

interface Keypair {
  publicKey(): string;
}

interface Transaction {
  sign(...keypairs: Keypair[]): void;
  toXDR(): string;
}

export interface Bundle {
  createStellarAdapter: (opts?: { network?: 'pubnet' | 'testnet' }) => {
    resolveIdentity(agentId: string): Promise<{ owner: string; wallet: string | null } | null>;
  };
  createStellarAgent: (opts: { network: 'stellar:testnet'; owner: StellarSigner; agentUri: string }) => Promise<CreatedAgent>;
  Keypair: { random(): Keypair & { secret(): string } };
  Networks: { TESTNET: string };
  TransactionBuilder: { fromXDR(xdr: string, networkPassphrase: string): Transaction };
}

let cached: Promise<Bundle> | null = null;

export function loadBundle(src: string): Promise<Bundle> {
  cached ??= (async () => {
    // Bare global `Buffer.from(...)` calls in the adapter need a browser polyfill first (site/verifier/README.md).
    const { Buffer } = await import('buffer');
    (globalThis as unknown as { Buffer?: unknown }).Buffer ??= Buffer;
    const url = `${window.location.origin}${src}`;
    // Magic comments keep Next/Turbopack from resolving this public static asset at build time.
    return (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as Bundle;
  })().catch((err) => {
    cached = null; // let a retry re-import instead of caching the failure
    throw err;
  });
  return cached;
}
