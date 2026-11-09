import type { HorizonReader } from './chain/horizon.js';
import type { KarmaPaymentsReader } from './chain/karma.js';
import type { RegistryReader } from './chain/registry.js';
import type { IndexerConfig } from './config.js';
import type { VerifyResult } from 'agentenact';
import type { Db } from './db.js';
import type { StageName } from './loop.js';
import { pollKarmaPayments } from './karma-payments.js';
import { pollPayments } from './payments.js';
import { ingestRecords } from './records.js';
import { followRegistry, ledgerCheck } from './registry-events.js';
import { reconcileRegistry } from './registry-sync.js';
import { refreshSelfPublished } from './selfpub.js';

export type StageDeps = {
  sql: Db;
  reader: RegistryReader;
  horizon: HorizonReader;
  /** Set when payments come from AgentKarma's feed; our own Horizon polling is then off. */
  karma?: KarmaPaymentsReader;
  config: Pick<IndexerConfig, 'registry' | 'publicBaseUrl' | 'usdc' | 'sponsors'>;
  /** The library's four checks over the testnet adapter (see chain/verify.ts); records are re-verified here, never trusted. */
  verify: (record: unknown) => Promise<VerifyResult>;
  now?: () => Date;
  log: (e: Record<string, string | number>) => void;
};

/**
 * The loop's stages, wired to the pinned config. The registry id and `publicBaseUrl` come from fixed config, never from
 * data; the registry id pins the contract so a different one reads as a chain reset.
 */
export function buildStages(d: StageDeps): Record<StageName, () => Promise<unknown>> {
  const base = { sql: d.sql, reader: d.reader, publicBaseUrl: d.config.publicBaseUrl, registryId: d.config.registry, now: d.now, log: d.log };
  return {
    // The ledger check goes first: a stored ledger far above the chain's latest, persistently, means a different chain, and
    // reconcile must not write agent rows from it. Same check as followRegistry (shared streak), so a halt lost on shutdown
    // re-detects here. A suspect sample skips the tick: no reconcile against a backend that may be lagging.
    registry: async () => {
      const check = await ledgerCheck(base);
      if (check === 'regressed') return { added: 0, refreshed: 0, status: 'chain_reset' as const };
      if (check === 'suspect') return { added: 0, refreshed: 0, status: 'suspect' as const };
      return reconcileRegistry(base);
    },
    events: () => followRegistry(base),
    payments: () => {
      const karma = d.karma;
      return karma
        ? pollKarmaPayments({ sql: d.sql, karma, cfg: d.config, now: d.now, log: d.log })
        : pollPayments({ sql: d.sql, horizon: d.horizon, cfg: d.config, log: d.log });
    },
    selfpub: () => refreshSelfPublished({ sql: d.sql, publicBaseUrl: d.config.publicBaseUrl }),
    records: () => ingestRecords({ sql: d.sql, verify: d.verify, cfg: d.config, log: d.log }),
  };
}
