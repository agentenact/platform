import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Networks, rpc } from '@stellar/stellar-sdk';
import { createHorizonReader, createRateLimiter } from '../../src/chain/horizon.js';
import { createRegistryReader, type RegistryReader } from '../../src/chain/registry.js';
import { CHAIN } from '../../src/config.js';
import { pollPayments } from '../../src/payments.js';
import { followRegistry } from '../../src/registry-events.js';
import { reconcileRegistry } from '../../src/registry-sync.js';
import { freshDb } from '../support/db.js';

// Opt-in: reads Soroban RPC and Horizon on TESTNET only. Nothing is signed or submitted, no secrets are needed.
const LIVE = process.env.AGENTENACT_TESTNET === '1';

const DEMO_ID = 31;
const FIRST_PAYMENT_TX = '61f7c958a9efa06bc4c671fb59e6a173ae268a7f454afd56608062ce48fc2bff';
const PUBLIC_BASE_URL = 'https://agentenact.io';

describe.skipIf(!LIVE)('indexer against Stellar testnet (live)', () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  let reader: RegistryReader;
  let total = 0;

  const logs: Array<Record<string, string | number>> = [];
  // Agents whose payments are polled: the demo agent, a contract-bound agent (C... wallet), and two unbound agents
  // (wallet = owner) that received the library e2e payments. Polling all 56 wallets takes about 5 minutes on testnet.
  const POLLED = [DEMO_ID, 36, 45, 46];

  beforeAll(async () => {
    db = await freshDb();
    reader = createRegistryReader({ rpc: new rpc.Server(CHAIN.rpcUrl), registry: CHAIN.registry, passphrase: Networks.TESTNET });
    const horizon = createHorizonReader({ horizonUrl: CHAIN.horizonUrl, limiter: createRateLimiter(3) });
    const log = (e: Record<string, string | number>) => void logs.push(e);

    total = await reader.totalAgents();
    // Backfill is capped per call (50): repeat until every id below the total is held.
    for (let i = 0; i < Math.ceil(total / 50) + 2; i++) {
      const r = await reconcileRegistry({ sql: db.sql, reader, publicBaseUrl: PUBLIC_BASE_URL, registryId: CHAIN.registry, log });
      expect(r.status).toBe('ok');
      const [{ n } = { n: -1 }] = (await db.sql`select count(*)::int as n from discovery.agents`) as Array<{ n: number }>;
      if (n >= total) break;
    }
    const later = new Date(Date.now() + 24 * 3600 * 1000);
    await db.sql`update discovery.agents set next_poll_at = ${later} where agent_id not in (select jsonb_array_elements_text(${POLLED}::jsonb)::int)`;
    for (let i = 0; i < 5; i++) {
      const r = await pollPayments({ sql: db.sql, horizon, cfg: { usdc: CHAIN.usdc, sponsors: [] }, log });
      if (r.polled === 0) break;
    }
  }, 240_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('walks the real registry and holds at least 36 agents', async () => {
    const [{ n } = { n: -1 }] = (await db.sql`select count(*)::int as n from discovery.agents`) as Array<{ n: number }>;
    expect(total).toBeGreaterThanOrEqual(36);
    expect(n).toBeGreaterThanOrEqual(36);
    const [demo] = (await db.sql`select owner, wallet from discovery.agents where agent_id = ${DEMO_ID}`) as Array<{ owner: string; wallet: string | null }>;
    expect(demo?.owner.startsWith('GABGU')).toBe(true);
    expect(demo?.wallet?.startsWith('GDO73')).toBe(true);
  });

  it('finds the first x402 payment to the demo agent as a counted payment', async () => {
    const rows = (await db.sql`
      select agent_id, amount_units::text as units, asset, counted, excluded_reason, payee
      from discovery.payments where tx_hash = ${FIRST_PAYMENT_TX}`) as Array<{ agent_id: number; units: string; asset: string; counted: boolean; excluded_reason: string | null; payee: string }>;
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.agent_id).toBe(DEMO_ID);
    expect(p.payee.startsWith('GDO73')).toBe(true);
    expect(p.units).toBe('10000');
    expect(p.asset).toBe(CHAIN.usdc);
    expect(p.counted).toBe(true);
    expect(p.excluded_reason).toBeNull();
  });

  // Plan wording was "counts nothing for unbound agents"; the data disproves it: agents 45 and 46 are unbound
  // (wallet = owner, owner mode) and rightly count third-party payments (rules.ts: Kerem accepted it, 2026-10-12).
  // The invariant that holds on real data is that nothing an agent sends to itself or its owner sends counts.
  it('never counts a payment from the agent wallet itself, or from a distinct owner', async () => {
    const bad = (await db.sql`
      select p.agent_id from discovery.payments p join discovery.agents a using (agent_id)
      where p.counted and (p.payer = a.wallet or (a.owner <> a.wallet and p.payer = a.owner))`) as unknown[];
    expect(bad).toHaveLength(0);
    const unbound = (await db.sql`
      select p.agent_id, count(*) filter (where p.counted)::int as counted from discovery.payments p join discovery.agents a using (agent_id)
      where a.wallet = a.owner and p.agent_id in (45, 46) group by 1 order by 1`) as Array<{ agent_id: number; counted: number }>;
    expect(unbound.every((r) => r.counted >= 1)).toBe(true);
  });

  it('polls a contract-bound (C...) wallet without failing and stores nothing for it', async () => {
    const [a] = (await db.sql`select wallet from discovery.agents where agent_id = 36`) as Array<{ wallet: string }>;
    expect(a?.wallet.startsWith('C')).toBe(true);
    expect(logs.filter((e) => e.event === 'payments_poll_failed')).toEqual([]);
    const [{ n } = { n: -1 }] = (await db.sql`select count(*)::int as n from discovery.payments where agent_id = 36`) as Array<{ n: number }>;
    expect(n).toBe(0);
  });

  it('followRegistry from the latest ledger returns without error', async () => {
    const r = await followRegistry({ sql: db.sql, reader, publicBaseUrl: PUBLIC_BASE_URL, registryId: CHAIN.registry });
    expect(['ok', 'reconciled']).toContain(r.status);
    // A second pass resumes from the stored cursor and must not fail either.
    const again = await followRegistry({ sql: db.sql, reader, publicBaseUrl: PUBLIC_BASE_URL, registryId: CHAIN.registry });
    expect(['ok', 'reconciled']).toContain(again.status);
  });
});
