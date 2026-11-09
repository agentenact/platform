import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';
import { recordDigest, parseRecord, type VerifyResult } from 'agentenact';
import { ingestRecords } from '../src/records.js';
import { hostedDocUrl, refreshSelfPublished } from '../src/selfpub.js';
import type { Db } from '../src/db.js';
import { freshDb } from './support/db.js';
import { OWNER, PAYER, USDC, WALLET } from './support/fake-chain.js';

const SPONSOR = Keypair.random().publicKey();
const CFG = { usdc: USDC, sponsors: [SPONSOR] };
const T0 = new Date('2026-10-12T12:00:00Z');
const SETTLED = '2026-10-12T11:59:00Z';

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  // Stand-in for P4's app.records (migration 0005): same columns, no foreign keys (the migrated table is replaced).
  await db.sql.unsafe('drop table if exists app.records');
  await db.sql.unsafe(`create table app.records (
    tx_hash text primary key check (tx_hash ~ '^[0-9a-f]{64}$'),
    agent_id uuid not null,
    run_id uuid,
    record jsonb not null,
    created_at timestamptz not null default now())`);
});
afterAll(async () => {
  await db.drop();
});

let n = 0;
const ref = () => (++n).toString(16).padStart(64, 'a');

type RecOpts = { ref?: string; agentId?: string | null; address?: string; payer?: string; amount?: string; asset?: string; nonce?: string };
function rec(o: RecOpts = {}) {
  const agent: Record<string, string> = { chain: 'stellar', address: o.address ?? WALLET };
  if (o.agentId !== null) agent.agentId = o.agentId ?? '1';
  return {
    v: '0.1',
    agent,
    input: { sha256: 'a'.repeat(64) },
    output: { sha256: 'b'.repeat(64) },
    settlement: { chain: 'stellar', ref: o.ref ?? ref(), payer: o.payer ?? PAYER, amount: o.amount ?? '0.0010000', asset: o.asset ?? USDC },
    issuedAt: '2026-10-12T12:00:00Z',
    nonce: o.nonce ?? crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''),
    sig: { alg: 'ed25519', value: 'ab'.repeat(64) },
  };
}
type Rec = ReturnType<typeof rec>;

const passes = { signature: 'pass', settlement: 'pass', timing: 'pass', identity: 'pass' } as const;
function good(r: Rec, over: Partial<{ payer: string; amount: string; asset: string; at: string }> = {}): VerifyResult {
  return {
    ok: true,
    checks: { ...passes },
    settlement: { chain: 'stellar', ref: r.settlement.ref, payer: over.payer ?? r.settlement.payer, payee: r.agent.address!, amount: over.amount ?? r.settlement.amount, asset: over.asset ?? r.settlement.asset, at: over.at ?? SETTLED },
  };
}
function bad(failure: NonNullable<VerifyResult['failure']>): VerifyResult {
  return { ok: false, checks: { signature: 'skipped', settlement: 'skipped', timing: 'skipped', identity: 'skipped' }, failure };
}

/** A fake verifier driven by a table keyed by settlement ref; unknown refs are not found. */
function verifier(table: Map<string, VerifyResult | Error>) {
  const calls: string[] = [];
  const verify = async (r: unknown): Promise<VerifyResult> => {
    const refx = (r as Rec).settlement.ref;
    calls.push(refx);
    const v = table.get(refx) ?? bad({ check: 'settlement', reason: 'not_found' });
    if (v instanceof Error) throw v;
    return v;
  };
  return { verify, calls };
}

async function reset(sql: Db = db.sql): Promise<void> {
  for (const t of ['proven_sales', 'submissions', 'record_attempts', 'agents', 'meta']) await sql.unsafe(`delete from discovery.${t}`);
  await sql.unsafe('delete from app.records').catch(() => {});
  await sql`insert into discovery.agents (agent_id, owner, wallet, source) values (1, ${OWNER}, ${WALLET}, 'event')`;
}
const submit = async (r: Rec, sql: Db = db.sql) => {
  const digest = Buffer.from(await recordDigest(parseRecord(r))).toString('hex');
  await sql`insert into discovery.submissions (digest, record) values (${digest}, ${r as unknown as Record<string, unknown>})`;
  return digest;
};
const host = (r: Rec) => db.sql`insert into app.records (tx_hash, agent_id, record) values (${r.settlement.ref}, ${crypto.randomUUID()}, ${r as unknown as Record<string, unknown>})`;
const sales = () => db.sql`select * from discovery.proven_sales order by settlement_ref`;
const attempts = () => db.sql`select digest, tries, outages, last_reason, final, next_try_at from discovery.record_attempts order by digest`;
const builder = async (id = 1) => ((await db.sql`select builder from discovery.agents where agent_id = ${id}`)[0] as { builder: string }).builder;

beforeEach(() => reset());

describe('ingestRecords', () => {
  it('counts a hosted record that verifies, with the settled time and payer from verification', async () => {
    const r = rec();
    await host(r);
    const payer = Keypair.random().publicKey();
    const v = verifier(new Map([[r.settlement.ref, good(r, { payer, amount: '0.0025000', at: '2026-10-12T11:58:30Z' })]]));
    const res = await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(res).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    const [s] = await sales();
    expect(s).toMatchObject({ settlement_ref: r.settlement.ref, agent_address: WALLET, agent_id: 1, source: 'hosted', payer, asset: USDC });
    expect(BigInt(s.amount_units)).toBe(25000n);
    expect(new Date(s.settled_at).toISOString()).toBe('2026-10-12T11:58:30.000Z');
    expect(s.digest).toBe(Buffer.from(await recordDigest(parseRecord(r))).toString('hex'));
    const [a] = await db.sql`select last_active_at from discovery.agents where agent_id = 1`;
    expect(new Date(a.last_active_at).toISOString()).toBe('2026-10-12T11:58:30.000Z');
    // counted once: a second run neither verifies nor writes it again
    await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(v.calls).toEqual([r.settlement.ref]);
    expect((await sales()).length).toBe(1);
  });

  it('counts a hosted v0.2 record (one that names the skills it used) like any other', async () => {
    const r = { ...rec(), v: '0.2', skills: [{ id: 'acme/skills/digest', sha256: 'c'.repeat(64) }] } as unknown as Rec;
    await host(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    expect((await sales())[0]).toMatchObject({ settlement_ref: r.settlement.ref, source: 'hosted' });
  });

  it('counts a submitted record and tags the agent as library', async () => {
    const r = rec();
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    expect((await sales())[0]).toMatchObject({ source: 'submitted', agent_id: 1 });
    expect(await builder()).toBe('library');
  });

  it('a forged record never counts and becomes final at once', async () => {
    const r = rec();
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, bad({ check: 'signature', reason: 'invalid_signature' })]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(await sales()).toEqual([]);
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'invalid_signature' });
    expect(await builder()).toBe('external');
    await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => new Date(T0.getTime() + 3_600_000) });
    expect(v.calls.length).toBe(1); // final: never verified again
  });

  for (const reason of ['alg_mismatch', 'chain_mismatch'] as const) {
    it(`${reason} is final at once`, async () => {
      const r = rec();
      await submit(r);
      const v = verifier(new Map([[r.settlement.ref, bad({ check: 'signature', reason })]]));
      await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
      expect((await attempts())[0]).toMatchObject({ final: true, last_reason: reason });
    });
  }

  it('an owner paying their own agent wallet and signing a record is rejected excluded_payer', async () => {
    const r = rec({ payer: OWNER });
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(await sales()).toEqual([]);
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'excluded_payer' });
  });

  it('a sponsor payer and the wallet paying itself are rejected excluded_payer', async () => {
    for (const payer of [SPONSOR, WALLET]) {
      await reset();
      const r = rec({ payer });
      await submit(r);
      const v = verifier(new Map([[r.settlement.ref, good(r)]]));
      expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
      expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'excluded_payer' });
    }
  });

  it('two records with different nonces for one settlement count once', async () => {
    const shared = ref();
    const a = rec({ ref: shared, nonce: '1'.repeat(32) });
    const b = rec({ ref: shared, nonce: '2'.repeat(32) });
    await submit(a);
    await submit(b);
    const v = verifier(new Map([[shared, good(a)]]));
    const res = await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(res.counted).toBe(1);
    expect(res.rejected).toBe(1);
    expect((await sales()).length).toBe(1);
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'duplicate_settlement' });
  });

  it('a record whose settlement is not on Horizon yet backs off from seconds to a day and is final only after about four days', async () => {
    const r = rec();
    const digest = await submit(r);
    const table = new Map<string, VerifyResult | Error>();
    const v = verifier(table);
    let now = T0;
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
    const at = async () => (await attempts())[0];
    const H = 3_600_000;
    const waits = [15_000, 60_000, 300_000, 900_000, H, 3 * H, 6 * H, 12 * H, 24 * H, 24 * H, 24 * H];

    expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 1 });
    expect(await at()).toMatchObject({ digest, tries: 1, final: false, last_reason: 'not_found' });
    now = new Date(T0.getTime() + 14_000);
    expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 0 }); // not due
    expect(v.calls.length).toBe(1);

    now = T0;
    let total = 0;
    for (let i = 0; i < waits.length; i++) {
      expect(new Date((await at()).next_try_at).getTime() - now.getTime()).toBe(waits[i]!);
      total += waits[i]!;
      now = new Date(T0.getTime() + total);
      table.set(r.settlement.ref, bad({ check: 'settlement', reason: i % 2 ? 'no_matching_payment' : 'not_found' }));
      if (i < waits.length - 1) {
        expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 1 });
        expect(await at()).toMatchObject({ tries: i + 2, final: false });
      }
    }
    expect(await run()).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(await at()).toMatchObject({ tries: 12, final: true });
    expect(total).toBeGreaterThan(3 * 24 * H);
    expect(total).toBeLessThan(5 * 24 * H);
    now = new Date(now.getTime() + 86_400_000);
    await run();
    expect(v.calls.length).toBe(12);
    expect(await sales()).toEqual([]);
  });

  it('a failure reason outside the lag set (a future library reason) keeps the 15 s, 1 m, 5 m schedule and is final on the 4th try', async () => {
    const r = rec();
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, bad({ check: 'identity', reason: 'chain_mismatch' as never })]]));
    let now = T0;
    for (let i = 0; i < 4; i++) {
      await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
      now = new Date(now.getTime() + 300_000);
    }
    expect((await attempts())[0]).toMatchObject({ tries: 4, final: true, last_reason: 'chain_mismatch' as never });
  });

  it('a settlement that appears hours late is still counted (the old 6 minute window would have rejected it)', async () => {
    const r = rec();
    await submit(r);
    const table = new Map<string, VerifyResult | Error>();
    const v = verifier(table);
    let now = T0;
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
    for (const t of [0, 15_000, 75_000, 375_000, 1_275_000]) {
      now = new Date(T0.getTime() + t);
      await run();
    }
    table.set(r.settlement.ref, good(r));
    now = new Date(T0.getTime() + 1_275_000 + 3_600_000);
    expect(await run()).toEqual({ counted: 1, rejected: 0, deferred: 0 });
  });

  it('an identity that is not bound yet is a lag too and survives past the fourth try', async () => {
    const lag = rec();
    await submit(lag);
    const table = new Map<string, VerifyResult | Error>([[lag.settlement.ref, bad({ check: 'identity', reason: 'address_not_bound' })]]);
    const v = verifier(table);
    let now = T0;
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
    for (let i = 0; i < 5; i++) {
      await run();
      now = new Date(now.getTime() + 24 * 3_600_000);
    }
    expect((await attempts())[0]).toMatchObject({ tries: 5, final: false, last_reason: 'address_not_bound' });
  });

  it('a retried record counts once Horizon has it', async () => {
    const r = rec();
    await submit(r);
    const table = new Map<string, VerifyResult | Error>();
    const v = verifier(table);
    await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    table.set(r.settlement.ref, good(r));
    const res = await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => new Date(T0.getTime() + 20_000) });
    expect(res.counted).toBe(1);
  });

  it('a thrown chain error is retried, not final, and carries no error text', async () => {
    const r = rec();
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, new Error('rpc down https://secret.example/?k=1')]]));
    const logs: Array<Record<string, string | number>> = [];
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0, log: (e) => void logs.push(e) })).toEqual({ counted: 0, rejected: 0, deferred: 1 });
    expect((await attempts())[0]).toMatchObject({ tries: 0, final: false, last_reason: 'chain_error' }); // an outage is never charged
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('a record that throws for a week of outages is parked on a daily retry, not final', async () => {
    const r = rec();
    const digest = await submit(r);
    await db.sql`insert into discovery.record_attempts (digest, tries, outages, last_reason, next_try_at, final) values (${digest}, 0, 2014, 'chain_error', ${T0}, false)`;
    const v = verifier(new Map([[r.settlement.ref, new Error('rpc down')]]));
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 1 }); // outage 2015: still on the 5 minute cap
    expect(+(await attempts())[0].next_try_at - +T0).toBeLessThanOrEqual(300_000);
    await db.sql`update discovery.record_attempts set next_try_at = ${T0}`;
    expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 1 }); // outage 2016: parked
    expect((await attempts())[0]).toMatchObject({ final: false, last_reason: 'chain_error', outages: 2016, tries: 0 });
    expect(+(await attempts())[0].next_try_at - +T0).toBe(24 * 3_600_000);
    await run();
    expect(v.calls.length).toBe(2); // not due for a day: no extra verify
  });

  it('a record parked by a long outage still counts when the chain returns within 30 days', async () => {
    const r = rec();
    const digest = await submit(r);
    await db.sql`insert into discovery.record_attempts (digest, tries, outages, last_reason, next_try_at, final) values (${digest}, 0, 2020, 'chain_error', ${T0}, false)`;
    const table = new Map<string, VerifyResult | Error>([[r.settlement.ref, new Error('rpc down')]]);
    const v = verifier(table);
    await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    table.set(r.settlement.ref, good(r));
    const res = await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => new Date(T0.getTime() + 24 * 3_600_000 + 1000) });
    expect(res.counted).toBe(1);
  });

  it('it becomes final outage_exhausted after the daily retries run out', async () => {
    const r = rec();
    const digest = await submit(r);
    await db.sql`insert into discovery.record_attempts (digest, tries, outages, last_reason, next_try_at, final) values (${digest}, 0, 2045, 'chain_error', ${T0}, false)`;
    const v = verifier(new Map([[r.settlement.ref, new Error('rpc down')]]));
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(await run()).toEqual({ counted: 0, rejected: 1, deferred: 0 }); // outage 2046: given up
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'outage_exhausted', tries: 0 });
    await run();
    expect(v.calls.length).toBe(1); // never retried again
  });

  it('fresh records are not starved behind an outage backlog', async () => {
    const t = (min: number) => new Date(T0.getTime() - min * 60_000);
    const old = [];
    for (let i = 0; i < 3; i++) {
      const r = rec();
      const digest = await submit(r);
      await db.sql`update discovery.submissions set received_at = ${t(100 - i)} where digest = ${digest}`;
      await db.sql`insert into discovery.record_attempts (digest, tries, outages, last_reason, next_try_at, final) values (${digest}, 0, 5, 'chain_error', ${t(10 - i)}, false)`;
      old.push(r);
    }
    const fresh = rec();
    const fd = await submit(fresh);
    await db.sql`update discovery.submissions set received_at = ${t(1)} where digest = ${fd}`;
    const table = new Map<string, VerifyResult | Error>([[fresh.settlement.ref, good(fresh)]]);
    for (const r of old) table.set(r.settlement.ref, new Error('rpc down'));
    const v = verifier(table);
    const res = await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0, batch: 2 });
    expect(v.calls[0]).toBe(fresh.settlement.ref);
    expect(res.counted).toBe(1);
  });

  it('verifies again itself: a submission that the api accepted but verify now refuses does not count', async () => {
    const r = rec();
    await submit(r); // stored by the api after its own successful verify
    const v = verifier(new Map([[r.settlement.ref, bad({ check: 'timing', reason: 'issued_before_settlement' })]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(v.calls).toEqual([r.settlement.ref]);
    expect(await sales()).toEqual([]);
  });

  it('works when app.records does not exist yet (submissions only)', async () => {
    const bare = await freshDb(); // migrated from scratch: no app.records
    try {
      await reset(bare.sql);
      const r = rec();
      await submit(r, bare.sql);
      const v = verifier(new Map([[r.settlement.ref, good(r)]]));
      expect(await ingestRecords({ sql: bare.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    } finally {
      await bare.drop();
    }
  });

  it('the stage updates builder to library only for non-hosted agents', async () => {
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, source, builder) values (2, ${Keypair.random().publicKey()}, ${Keypair.random().publicKey()}, 'event', 'hosted')`;
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, source) values (3, ${Keypair.random().publicKey()}, ${Keypair.random().publicKey()}, 'event')`;
    const [h] = (await db.sql`select wallet from discovery.agents where agent_id = 2`) as Array<{ wallet: string }>;
    const [e] = (await db.sql`select wallet from discovery.agents where agent_id = 3`) as Array<{ wallet: string }>;
    const hostedSubmitted = rec({ agentId: '2', address: h!.wallet });
    const extHosted = rec({ agentId: '3', address: e!.wallet });
    await submit(hostedSubmitted);
    await host(extHosted);
    const v = verifier(new Map([[hostedSubmitted.settlement.ref, good(hostedSubmitted)], [extHosted.settlement.ref, good(extHosted)]]));
    expect((await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).counted).toBe(2);
    expect(await builder(2)).toBe('hosted'); // a submitted sale never demotes a hosted agent
    expect(await builder(3)).toBe('external'); // a hosted-source sale does not make it library either
  });

  it('a hosted agent that selfpub has not verified yet is not pinned to library by a submitted sale; selfpub then promotes it', async () => {
    const BASE = 'https://agentenact.io';
    const hosted = '0b9f3c1e-2d4a-4e5f-8a6b-000000000042';
    const w = Keypair.random().publicKey();
    await db.sql`insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid)
                 values (4, ${OWNER}, ${w}, ${`${BASE}/a/${hosted}/agent.json`}, 'registry_read', 'external', ${hosted}::uuid)`;
    const r = rec({ agentId: '4', address: w });
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect((await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).counted).toBe(1);
    expect(await builder(4)).toBe('external'); // selfpub has not looked yet: the sale must not claim the agent for the library
    const doc = new Response(JSON.stringify({ name: 'Hosted', agentId: 4, agentWallet: w, services: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    const f = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(hostedDocUrl(hosted, BASE));
      return doc;
    }) as unknown as typeof fetch;
    await refreshSelfPublished({ sql: db.sql, publicBaseUrl: BASE, fetch: f, now: () => T0 });
    expect(await builder(4)).toBe('hosted');
  });

  it('a 30 minute outage never makes a record final: backoff caps at 5 minutes, then it counts', async () => {
    const r = rec();
    await submit(r);
    const table = new Map<string, VerifyResult | Error>([[r.settlement.ref, new Error('rpc down')]]);
    const v = verifier(table);
    let now = T0;
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
    const waits: number[] = [];
    const end = T0.getTime() + 30 * 60_000;
    while (now.getTime() < end) {
      expect((await run()).deferred).toBe(1);
      const [a] = await attempts();
      expect(a).toMatchObject({ final: false, tries: 0 });
      const wait = new Date(a.next_try_at).getTime() - now.getTime();
      waits.push(wait);
      now = new Date(now.getTime() + wait);
    }
    expect(waits.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(Math.max(...waits)).toBe(300_000);
    expect(waits.length).toBeGreaterThan(8);
    table.set(r.settlement.ref, good(r)); // the chain is back
    expect(await run()).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    expect((await sales()).length).toBe(1);
  });

  it('definite answers still count toward final after an outage', async () => {
    const r = rec();
    const digest = await submit(r);
    const table = new Map<string, VerifyResult | Error>([[r.settlement.ref, new Error('rpc down')]]);
    const v = verifier(table);
    let now = T0;
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => now });
    for (let i = 0; i < 6; i++) {
      await run();
      now = new Date(now.getTime() + 300_000);
    }
    table.set(r.settlement.ref, bad({ check: 'settlement', reason: 'not_found' }));
    for (let i = 0; i < 4; i++) {
      await run();
      now = new Date(now.getTime() + 300_000);
    }
    expect((await attempts())[0]).toMatchObject({ digest, tries: 4, final: false }); // a lag keeps its long schedule
  });

  it('with sales and attempts already stored, the digest filter still reads them (jsonb parameter regression)', async () => {
    const a = rec();
    const b = rec();
    await submit(a);
    await host(a); // the same record also sits in app.records
    await host(b);
    const v = verifier(new Map<string, VerifyResult | Error>([[a.settlement.ref, good(a)], [b.settlement.ref, new Error("rpc down")]]));
    const run = () => ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    await run(); // counts a (submitted), defers b
    await run();
    await run();
    expect(v.calls.filter((x) => x === a.settlement.ref).length).toBe(1);
    expect((await sales()).length).toBe(1);
  });

  it('about 5000 permanently final hosted rows ahead in scan order do not starve a new record', async () => {
    // 5200 rows older than the good one, each final in record_attempts under its tx_hash.
    await db.sql.unsafe(`
      insert into app.records (tx_hash, agent_id, record, created_at)
      select lpad(to_hex(i), 64, '0'), gen_random_uuid(), '{}'::jsonb, '2026-01-01T00:00:00Z'::timestamptz + (i || ' seconds')::interval from generate_series(1, 5200) i`);
    await db.sql.unsafe(`
      insert into discovery.record_attempts (digest, ref, tries, last_reason, next_try_at, final)
      select 'malformed:' || lpad(to_hex(i), 64, '0'), lpad(to_hex(i), 64, '0'), 1, 'malformed', now(), true from generate_series(1, 5200) i`);
    const r = rec();
    await host(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    expect(v.calls).toEqual([r.settlement.ref]);
  });

  it('a hosted malformed record is final under its tx_hash and is not read again', async () => {
    await db.sql`insert into app.records (tx_hash, agent_id, record) values (${'c'.repeat(64)}, ${crypto.randomUUID()}, ${{ junk: true }})`;
    const v = verifier(new Map());
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'malformed' });
    const [a] = await db.sql`select ref from discovery.record_attempts`;
    expect(a.ref).toBe('c'.repeat(64));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 0 });
  });

  describe('as the discovery_indexer role', () => {
    const asIndexer = (() => {
      const wrap = async <T>(fn: (tx: Db) => Promise<T>): Promise<T> =>
        db.sql.begin(async (tx: Db) => {
          await tx.unsafe('set local role discovery_indexer');
          return fn(tx);
        }) as Promise<T>;
      return Object.assign((strings: TemplateStringsArray, ...v: unknown[]) => wrap(async (tx) => (tx as unknown as (s: TemplateStringsArray, ...x: unknown[]) => Promise<unknown>)(strings, ...v)), { begin: wrap }) as unknown as Db;
    })();
    const grant = new URL('../../../migrations/0008_discovery_records_grant.sql', import.meta.url).pathname;

    it('without the grant: hosted records are skipped and records_grant_missing is logged once', async () => {
      await db.sql.unsafe('revoke select on app.records from discovery_indexer');
      const r = rec();
      await host(r);
      const v = verifier(new Map([[r.settlement.ref, good(r)]]));
      const logs: Array<Record<string, string | number>> = [];
      const run = () => ingestRecords({ sql: asIndexer, verify: v.verify, cfg: CFG, now: () => T0, log: (e) => void logs.push(e) });
      expect(await run()).toEqual({ counted: 0, rejected: 0, deferred: 0 });
      await run();
      expect(logs.filter((l) => l.event === 'records_grant_missing')).toEqual([{ event: 'records_grant_missing' }]);
      expect(v.calls).toEqual([]);
    });

    it('with migration 0008 applied: a hosted record is ingested end to end under the real role', async () => {
      await db.sql.unsafe(await Bun.file(grant).text());
      const r = rec();
      await host(r);
      const v = verifier(new Map([[r.settlement.ref, good(r)]]));
      const logs: Array<Record<string, string | number>> = [];
      expect(await ingestRecords({ sql: asIndexer, verify: v.verify, cfg: CFG, now: () => T0, log: (e) => void logs.push(e) })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
      expect(logs.filter((l) => l.event === 'records_grant_missing')).toEqual([]);
      expect((await sales())[0]).toMatchObject({ source: 'hosted', agent_id: 1 });
    });
  });

  it('a record for another asset is final wrong_asset, whatever verify says about it', async () => {
    const r = rec({ asset: 'USDC:' + Keypair.random().publicKey() });
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
    expect(await sales()).toEqual([]);
    expect((await attempts())[0]).toMatchObject({ final: true, last_reason: 'wrong_asset' });
  });

  it('a zero or malformed amount never counts', async () => {
    for (const amount of ['0', '0.0000000', 'abc']) {
      await reset();
      const r = rec({ amount });
      await submit(r);
      const v = verifier(new Map([[r.settlement.ref, good(r)]]));
      await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 });
      expect({ amount, sales: (await sales()).length, final: (await attempts())[0]?.final }).toEqual({ amount, sales: 0, final: true });
    }
  });

  it('an agent that is not indexed yet is deferred, and an agent id the signer does not belong to too', async () => {
    const ghost = rec({ agentId: '99' });
    const stranger = rec({ address: Keypair.random().publicKey() });
    await submit(ghost);
    await submit(stranger);
    const v = verifier(new Map([[ghost.settlement.ref, good(ghost)], [stranger.settlement.ref, good(stranger)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 2 });
    expect((await attempts()).every((a: { last_reason: string; final: boolean }) => a.last_reason === 'agent_not_indexed' && !a.final)).toBe(true);
  });

  it('a record without an agent id is credited by the owner or wallet address', async () => {
    const r = rec({ agentId: null, address: OWNER, payer: PAYER });
    await submit(r);
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect((await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).counted).toBe(1);
    expect((await sales())[0]).toMatchObject({ agent_id: 1, agent_address: OWNER });
  });

  it('a stored digest that is not the record digest is rejected, not counted', async () => {
    const r = rec();
    await db.sql`insert into discovery.submissions (digest, record) values (${'f'.repeat(64)}, ${r as unknown as Record<string, unknown>})`;
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(v.calls).toEqual([]);
  });

  it('a malformed stored record is final and never verified', async () => {
    await db.sql`insert into app.records (tx_hash, agent_id, record) values (${ref()}, ${crypto.randomUUID()}, ${{ nope: true } as Record<string, unknown>})`;
    const v = verifier(new Map());
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 1, deferred: 0 });
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 0 });
    expect(v.calls).toEqual([]);
  });

  it('writes nothing while the indexer is halted', async () => {
    const r = rec();
    await submit(r);
    await db.sql`insert into discovery.meta (key, value) values ('halted', 'chain_reset')`;
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 0 });
    expect(v.calls).toEqual([]);
    expect(await sales()).toEqual([]);
    expect(await attempts()).toEqual([]);
  });

  it('a halt that lands during verification stops the write', async () => {
    const r = rec();
    await submit(r);
    const verify = async (): Promise<VerifyResult> => {
      await db.sql`insert into discovery.meta (key, value) values ('halted', 'chain_reset') on conflict do nothing`;
      return good(r);
    };
    expect(await ingestRecords({ sql: db.sql, verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 1 });
    expect(await sales()).toEqual([]);
  });

  it('a deadlock or serialization failure is retried and never becomes final', async () => {
    const r = rec();
    await submit(r);
    let failures = 2;
    const flaky = new Proxy(db.sql as any, {
      get(t, k) {
        if (k === 'begin') return (cb: unknown) => (failures-- > 0 ? Promise.reject(Object.assign(new Error('deadlock detected'), { errno: failures === 0 ? '40001' : '40P01' })) : t.begin(cb));
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Db;
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: flaky, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 1, rejected: 0, deferred: 0 });
    expect(await attempts()).toEqual([]);
  });

  it('a write that keeps losing the race is deferred without charging an attempt', async () => {
    const r = rec();
    await submit(r);
    const always = new Proxy(db.sql as any, {
      get(t, k) {
        if (k === 'begin') return () => Promise.reject(Object.assign(new Error('deadlock detected'), { errno: '40P01' }));
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Db;
    const v = verifier(new Map([[r.settlement.ref, good(r)]]));
    expect(await ingestRecords({ sql: always, verify: v.verify, cfg: CFG, now: () => T0 })).toEqual({ counted: 0, rejected: 0, deferred: 1 });
    expect(await attempts()).toEqual([]);
    expect(await sales()).toEqual([]);
  });

  it('verifies at most `batch` records per run', async () => {
    const rs = Array.from({ length: 5 }, () => rec());
    for (const r of rs) await submit(r);
    const v = verifier(new Map(rs.map((r) => [r.settlement.ref, good(r)])));
    expect((await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, batch: 2, now: () => T0 })).counted).toBe(2);
    expect((await ingestRecords({ sql: db.sql, verify: v.verify, cfg: CFG, batch: 10, now: () => T0 })).counted).toBe(3);
  });
});
