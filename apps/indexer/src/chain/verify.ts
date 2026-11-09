import { verifyRecord, type VerifyResult } from 'agentenact';
import { CHAIN } from '../config.js';

/**
 * The library's four checks (signature, settlement, timing, identity) over the pinned testnet endpoints, read-only.
 * The adapter is loaded on first use (the Stellar SDK is heavy); a failed load is retried, not cached.
 */
export function libraryVerifier(): (record: unknown) => Promise<VerifyResult> {
  let adapter: ReturnType<typeof load> | undefined;
  const load = () =>
    import('agentenact/adapters/stellar').then((m) =>
      m.createStellarAdapter({ network: 'testnet', horizonUrl: CHAIN.horizonUrl, rpcUrl: CHAIN.rpcUrl, identityRegistry: CHAIN.registry }),
    );
  return async (record) => {
    adapter ??= load().catch((e) => ((adapter = undefined), Promise.reject(e)));
    return verifyRecord(record, await adapter);
  };
}
