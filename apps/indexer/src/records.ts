import { parseRecord, recordDigest, type EnactmentRecord, type VerifyResult } from 'agentenact';
import { parseUnits7 } from './chain/units.js';
import type { IndexerConfig } from './config.js';
import type { Db } from './db.js';
import { isTransientPg } from './feed-lock.js';
import { exclusionReason } from './rules.js';

export type RecordsDeps = {
  sql: Db;
  /** The library's `verifyRecord` over the testnet adapter. Run here again for every record: nothing stored is trusted. */
  verify: (record: unknown) => Promise<VerifyResult>;
  cfg: Pick<IndexerConfig, 'usdc' | 'sponsors'>;
  /** Verifications per run. */
  batch?: number;
  now?: () => Date;
  /** Fixed codes only: never a record, digest, address or error object. */
  log?: (e: Record<string, string | number>) => void;
};

/** 15 s, 1 m, 5 m, then final: index `tries - 1`. */
const BACKOFF_MS = [15_000, 60_000, 300_000];
const MAX_TRIES = 4;
/**
 * Index lag is not a verdict on the record: the settlement is not on Horizon yet, the agent or its wallet binding is not
 * indexed yet (events or registry stage behind, a rebind not read). These back off from seconds to a day and are final
 * only after about four days (15 s, 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h, then daily), so a lagging index cannot reject a real sale.
 */
const LAG_BACKOFF_MS = [15_000, 60_000, 300_000, 900_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 86_400_000, 86_400_000];
const LAG_MAX_TRIES = LAG_BACKOFF_MS.length + 1;
const LAG_REASONS: ReadonlySet<string> = new Set(['agent_not_indexed', 'unregistered', 'address_not_bound', 'not_found', 'no_matching_payment']);
/** A thrown chain error (RPC or Horizon outage, timeout, 5xx) is not an answer: it backs off to this cap and is never charged. */
const OUTAGE_BACKOFF_START_MS = 15_000;
const OUTAGE_BACKOFF_CAP_MS = 300_000;
/** About 7 days at the 5-minute cap: after this many outages in a row a record is parked on a daily retry, not dropped. */
const PARK_AFTER_OUTAGES = 2016;
const PARKED_RETRY_MS = 24 * 3_600_000;
/** About 30 more daily retries: only then is the record final `outage_exhausted`. */
const MAX_OUTAGES = PARK_AFTER_OUTAGES + 30;
const SCAN_PAGE = 200;
const MAX_SCAN = 5_000;
const TRANSIENT_RETRIES = 3;

type Source = 'hosted' | 'submitted';
type Cand = { source: Source; raw: unknown; key: string; storedDigest: string | null; /** The app.records tx_hash for a hosted record: lets SQL skip final rows without reading them. */ ref: string | null };

type Outcome = 'counted' | 'rejected' | 'deferred' | 'skipped';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * Turn stored and submitted Enactment Records into proven sales. Each candidate is verified again by this process, then
 * checked against the pinned asset, the indexed agent and the exclusion rules, and only then written, in one transaction
 * with `on conflict do nothing`, so a settlement is credited to an agent once however many records point at it.
 * A halted indexer writes nothing. The transaction inserts no `feed` row, so it needs no feed lock; a deadlock or
 * serialization failure (40P01/40001) is retried and never recorded as an attempt.
 */
export async function ingestRecords(d: RecordsDeps): Promise<{ counted: number; rejected: number; deferred: number }> {
  const out = { counted: 0, rejected: 0, deferred: 0 };
  if (await isHalted(d.sql)) return out;
  const now = d.now ?? (() => new Date());
  const batch = d.batch ?? 10;

  const [hosted, submitted] = await Promise.all([hostedCandidates(d, now(), batch), submittedCandidates(d, now(), batch)]);
  const queue: Cand[] = [];
  for (let i = 0; queue.length < batch * 2 && (i < hosted.length || i < submitted.length); i++) {
    if (hosted[i]) queue.push(hosted[i]!);
    if (submitted[i]) queue.push(submitted[i]!);
  }

  const seen = new Set<string>();
  let verified = 0;
  for (const c of queue) {
    if (verified >= batch) break;
    let r: Outcome;
    try {
      r = await processCandidate(d, c, now, seen, () => verified++);
    } catch {
      // Not the record's fault, but it must not block the candidates behind it: charge an attempt so the 4-try bound applies.
      d.log?.({ event: 'records_candidate_failed' });
      try {
        r = await defer(d, c.ref, c.key, 'internal_error', now());
      } catch {
        r = 'skipped';
      }
    }
    if (r !== 'skipped') out[r === 'counted' ? 'counted' : r === 'rejected' ? 'rejected' : 'deferred']++;
  }
  return out;
}

async function isHalted(sql: Db): Promise<boolean> {
  try {
    const rows = (await sql`select 1 as x from discovery.meta where key = 'halted'`) as unknown[];
    return rows.length > 0;
  } catch {
    return true; // an unreadable marker counts as halted
  }
}

async function submittedCandidates(d: RecordsDeps, now: Date, batch: number): Promise<Cand[]> {
  // The stored digest only narrows the scan; the real digest is recomputed from the record.
  const rows = (await d.sql`
    select s.digest, s.record from discovery.submissions s
    left join discovery.record_attempts ra on ra.digest = s.digest
    where not exists (select 1 from discovery.proven_sales p where p.digest = s.digest)
      and not exists (select 1 from discovery.record_attempts a where a.digest = s.digest and (a.final or a.next_try_at > ${now}))
    order by coalesce(ra.next_try_at, 'epoch'::timestamptz), s.received_at, s.digest
    limit ${batch}`) as Array<{ digest: string; record: unknown }>;
  return rows.map((r) => ({ source: 'submitted' as const, raw: r.record, key: r.digest, storedDigest: r.digest, ref: null }));
}

/** One `records_grant_missing` per process (the Db handle lives as long as the process). */
const grantWarned = new WeakSet<object>();

/**
 * Whether app.records exists and the indexer may read it. Absent: hosted records are skipped (P4 has not landed).
 * Present but ungranted (migration 0008 ran before the table existed, and tracking will not re-run it): skipped too,
 * but logged once, so it is never silent.
 */
async function hostedReadable(d: RecordsDeps): Promise<boolean> {
  const [row] = (await d.sql`
    select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and c.relname = 'records' and c.relkind = 'r') as present,
           has_schema_privilege('app', 'USAGE') as usage` ) as Array<{ present: boolean; usage: boolean }>;
  if (!row?.present) return false;
  let ok = row.usage;
  if (ok) {
    const [t] = (await d.sql`select has_table_privilege('app.records', 'SELECT') as ok`) as Array<{ ok: boolean }>;
    ok = t?.ok === true;
  }
  if (!ok && !grantWarned.has(d.sql)) {
    grantWarned.add(d.sql);
    d.log?.({ event: 'records_grant_missing' });
  }
  return ok;
}

async function hostedCandidates(d: RecordsDeps, now: Date, batch: number): Promise<Cand[]> {
  if (!(await hostedReadable(d))) return [];
  const out: Cand[] = [];
  let after: { ord: Date; at: Date; tx: string } | null = null;
  for (let scanned = 0; scanned < MAX_SCAN && out.length < batch; ) {
    // Keyset pages over the rows neither counted nor parked in record_attempts (final, or not due), skipped in SQL so permanently final rows never fill the scan; digests are computed here and checked against the attempts in one query.
    const rows = (await (after
      ? d.sql`select r.tx_hash, r.record, r.created_at, coalesce(ra.next_try_at, 'epoch'::timestamptz) as ord from app.records r
              left join lateral (select max(next_try_at) as next_try_at from discovery.record_attempts where ref = r.tx_hash) ra on true
              where not exists (select 1 from discovery.proven_sales p where p.settlement_ref = r.tx_hash and p.source = 'hosted')
                and not exists (select 1 from discovery.record_attempts a where a.ref = r.tx_hash and (a.final or a.next_try_at > ${now}))
                and (coalesce(ra.next_try_at, 'epoch'::timestamptz), r.created_at, r.tx_hash) > (${after.ord}, ${after.at}, ${after.tx})
              order by coalesce(ra.next_try_at, 'epoch'::timestamptz), r.created_at, r.tx_hash limit ${SCAN_PAGE}`
      : d.sql`select r.tx_hash, r.record, r.created_at, coalesce(ra.next_try_at, 'epoch'::timestamptz) as ord from app.records r
              left join lateral (select max(next_try_at) as next_try_at from discovery.record_attempts where ref = r.tx_hash) ra on true
              where not exists (select 1 from discovery.proven_sales p where p.settlement_ref = r.tx_hash and p.source = 'hosted')
                and not exists (select 1 from discovery.record_attempts a where a.ref = r.tx_hash and (a.final or a.next_try_at > ${now}))
              order by coalesce(ra.next_try_at, 'epoch'::timestamptz), r.created_at, r.tx_hash limit ${SCAN_PAGE}`)) as Array<{ tx_hash: string; record: unknown; created_at: Date; ord: Date }>;
    if (rows.length === 0) break;
    scanned += rows.length;
    const last = rows[rows.length - 1]!;
    after = { ord: last.ord, at: last.created_at, tx: last.tx_hash };

    const digests = new Map<string, string | null>();
    for (const r of rows) digests.set(r.tx_hash, await digestOf(r.record));
    const known = [...digests.values()].filter((x): x is string => x !== null);
    const blocked = new Set<string>();
    if (known.length) {
      const list = JSON.stringify(known);
      const rowsA = (await d.sql`
        select digest from discovery.record_attempts
        where digest in (select jsonb_array_elements_text((${list}::text)::jsonb)) and (final or next_try_at > ${now})`) as Array<{ digest: string }>;
      const rowsP = (await d.sql`select digest from discovery.proven_sales where digest in (select jsonb_array_elements_text((${list}::text)::jsonb))`) as Array<{ digest: string }>;
      for (const x of [...rowsA, ...rowsP]) blocked.add(x.digest);
    }
    for (const r of rows) {
      const dg = digests.get(r.tx_hash) ?? null;
      const key = dg ?? `malformed:${r.tx_hash}`;
      if (blocked.has(key)) continue;
      if (dg === null && (await attemptBlocked(d.sql, key, now))) continue;
      out.push({ source: 'hosted', raw: r.record, key, storedDigest: null, ref: r.tx_hash });
      if (out.length >= batch) break;
    }
    if (rows.length < SCAN_PAGE) break;
  }
  return out;
}

async function attemptBlocked(sql: Db, key: string, now: Date): Promise<boolean> {
  const rows = (await sql`select 1 as x from discovery.record_attempts where digest = ${key} and (final or next_try_at > ${now})`) as unknown[];
  return rows.length > 0;
}

async function digestOf(raw: unknown): Promise<string | null> {
  try {
    return hex(await recordDigest(parseRecord(raw)));
  } catch {
    return null;
  }
}

async function processCandidate(d: RecordsDeps, c: Cand, now: () => Date, seen: Set<string>, onVerify: () => void): Promise<Outcome> {
  let record: EnactmentRecord;
  let digest: string;
  try {
    record = parseRecord(c.raw);
    digest = hex(await recordDigest(record));
  } catch {
    return reject(d, c.ref, c.key, 'malformed', now());
  }
  // A stored digest that is not the record's own digest is a damaged row: never count it, never retry it.
  if (c.storedDigest !== null && c.storedDigest !== digest) return reject(d, c.ref, c.storedDigest, 'malformed', now());
  if (seen.has(digest)) return 'skipped';
  seen.add(digest);

  onVerify();
  let result: VerifyResult;
  try {
    result = await d.verify(c.raw);
  } catch {
    return deferOutage(d, c.ref, digest, now());
  }

  if (!result.ok) {
    const f = result.failure;
    if (!f) return reject(d, c.ref, digest, 'malformed', now());
    if (f.check === 'record') return reject(d, c.ref, digest, 'malformed', now());
    if (f.check === 'signature') return reject(d, c.ref, digest, f.reason, now());
    if (f.check === 'timing') return reject(d, c.ref, digest, f.reason, now());
    // not on Horizon yet (lag), or the identity not readable/bound yet: try again later
    return defer(d, c.ref, digest, f.reason, now());
  }

  const s = result.settlement;
  if (!s) return reject(d, c.ref, digest, 'malformed', now());
  if (s.asset !== d.cfg.usdc || record.settlement.asset !== d.cfg.usdc) return reject(d, c.ref, digest, 'wrong_asset', now());
  let units: bigint;
  let settledAt: Date;
  try {
    units = parseUnits7(s.amount);
    settledAt = new Date(s.at);
    if (Number.isNaN(settledAt.getTime())) throw new Error('bad time');
  } catch {
    return reject(d, c.ref, digest, 'malformed', now());
  }
  if (units <= 0n) return reject(d, c.ref, digest, 'malformed', now());

  const address = record.agent.address;
  const agent = await resolveAgent(d.sql, record.agent.agentId, address);
  if (!agent) return defer(d, c.ref, digest, 'agent_not_indexed', now());
  const wallet = agent.wallet ?? agent.owner;
  const reason = exclusionReason({ from: s.payer, to: s.payee, asset: s.asset }, { owner: agent.owner, wallet }, d.cfg);
  if (reason === 'asset') return reject(d, c.ref, digest, 'wrong_asset', now());
  if (reason !== null) return reject(d, c.ref, digest, 'excluded_payer', now());

  for (let i = 0; ; i++) {
    try {
      const res = await write(d, { record, digest, source: c.source, agentId: agent.agent_id, payer: s.payer, units, asset: s.asset, settledAt, ref: s.ref ?? record.settlement.ref }, now());
      if (res === 'counted') return 'counted';
      if (res === 'halted') return 'deferred';
      // the settlement is already credited to this agent by another record
      return reject(d, c.ref, digest, 'duplicate_settlement', now());
    } catch (e) {
      if (!isTransientPg(e)) throw e;
      if (i >= TRANSIENT_RETRIES) {
        d.log?.({ event: 'records_write_deferred' }); // lost the race every time: not the record's fault, no attempt is charged
        return 'deferred';
      }
    }
  }
}

type Agent = { agent_id: number; owner: string; wallet: string | null };

/** The indexed agent that this record's signer belongs to, or null (not indexed yet, or the index has not caught up with a rebind). */
async function resolveAgent(sql: Db, agentId: string | undefined, address: string): Promise<Agent | null> {
  if (agentId !== undefined) {
    if (!/^(0|[1-9]\d{0,9})$/.test(agentId) || Number(agentId) > 0xffffffff) return null;
    const [row] = (await sql`select agent_id, owner, wallet from discovery.agents where agent_id = ${Number(agentId)}`) as Agent[];
    return row && (row.owner === address || row.wallet === address) ? row : null;
  }
  const [row] = (await sql`
    select agent_id, owner, wallet from discovery.agents where owner = ${address} or tracked_wallet = ${address} order by agent_id limit 1`) as Agent[];
  return row ?? null;
}

type Sale = { record: EnactmentRecord; digest: string; source: Source; agentId: number; payer: string; units: bigint; asset: string; settledAt: Date; ref: string };

/** One transaction. 'duplicate': the settlement was already credited to this agent (nothing changed). */
async function write(d: RecordsDeps, sale: Sale, at: Date): Promise<'counted' | 'duplicate' | 'halted'> {
  return d.sql.begin(async (tx: Db) => {
    // Respect the halt latch inside the transaction too: nothing is written once the marker exists.
    if ((await tx`select 1 as x from discovery.meta where key = 'halted'`).length > 0) return 'halted' as const;
    const ins = (await tx`
      insert into discovery.proven_sales (settlement_ref, agent_address, agent_id, digest, record, source, payer, amount_units, asset, settled_at, verified_at)
      values (${sale.ref}, ${sale.record.agent.address}, ${sale.agentId}, ${sale.digest}, ${sale.record as unknown as Record<string, unknown>}, ${sale.source}, ${sale.payer}, ${sale.units}, ${sale.asset}, ${sale.settledAt}, ${at})
      on conflict do nothing
      returning digest`) as unknown[];
    if (ins.length === 0) return 'duplicate' as const;
    // Chain time (settled_at), not ingest time. A submitted sale makes an agent library only when nothing claims a hosted document for it (hosted_uuid is null): selfpub never promotes library to hosted, and a hosted agent is external until its first verification.
    await tx`
      update discovery.agents set
        last_active_at = greatest(last_active_at, ${sale.settledAt}),
        builder = case when ${sale.source}::text = 'submitted' and builder = 'external' and hosted_uuid is null then 'library' else builder end
      where agent_id = ${sale.agentId}`;
    return 'counted' as const;
  });
}

/** A final rejection: never retried and never shown. */
async function reject(d: RecordsDeps, ref: string | null, key: string, reason: string, at: Date): Promise<Outcome> {
  await noteAttempt(d, ref, key, reason, true, at);
  d.log?.({ event: 'record_rejected', reason });
  return 'rejected';
}

/**
 * A retryable failure. Index lag (LAG_REASONS) follows the long schedule above; anything else is 15 s, 1 m, 5 m and
 * final on the 4th try.
 */
async function defer(d: RecordsDeps, ref: string | null, key: string, reason: string, at: Date): Promise<Outcome> {
  const [row] = (await d.sql`select tries from discovery.record_attempts where digest = ${key}`) as Array<{ tries: number }>;
  const tries = (row?.tries ?? 0) + 1;
  const lag = LAG_REASONS.has(reason);
  const schedule = lag ? LAG_BACKOFF_MS : BACKOFF_MS;
  if (tries >= (lag ? LAG_MAX_TRIES : MAX_TRIES)) {
    await noteAttempt(d, ref, key, reason, true, at, tries);
    d.log?.({ event: 'record_rejected', reason });
    return 'rejected';
  }
  await noteAttempt(d, ref, key, reason, false, new Date(at.getTime() + schedule[tries - 1]!), tries);
  d.log?.({ event: 'record_deferred', reason });
  return 'deferred';
}

/**
 * A thrown chain error (outage, timeout, 5xx) says nothing about the record: back off 15 s doubling to 5 m and never
 * charge a try, so a short outage cannot make a record final. After PARK_AFTER_OUTAGES (about a week) it is parked on a daily
 * retry (one verify per record per day, ordered by next_try_at so it cannot starve fresh records); after MAX_OUTAGES (about 30
 * more days) it is given up on, so a record that throws forever cannot hold a slot for good.
 */
async function deferOutage(d: RecordsDeps, ref: string | null, key: string, at: Date): Promise<Outcome> {
  const [row] = (await d.sql`select outages from discovery.record_attempts where digest = ${key}`) as Array<{ outages: number }>;
  const outages = row?.outages ?? 0;
  if (outages + 1 >= MAX_OUTAGES) {
    await noteAttempt(d, ref, key, 'outage_exhausted', true, at, undefined, outages + 1);
    d.log?.({ event: 'record_rejected', reason: 'outage_exhausted' });
    return 'rejected';
  }
  const wait = outages + 1 >= PARK_AFTER_OUTAGES ? PARKED_RETRY_MS : Math.min(OUTAGE_BACKOFF_CAP_MS, OUTAGE_BACKOFF_START_MS * 2 ** Math.min(outages, 10));
  await noteAttempt(d, ref, key, 'chain_error', false, new Date(at.getTime() + wait), undefined, outages + 1);
  d.log?.({ event: 'record_deferred', reason: 'chain_error' });
  return 'deferred';
}

async function noteAttempt(d: RecordsDeps, ref: string | null, key: string, reason: string, final: boolean, next: Date, tries?: number, outages?: number): Promise<void> {
  // The not-exists guard keeps even this bookkeeping from writing while halted. An outage keeps `tries` as it was.
  await d.sql`
    insert into discovery.record_attempts (digest, ref, tries, outages, last_reason, next_try_at, final)
    select ${key}, ${ref}, ${tries ?? (outages === undefined ? 1 : 0)}, ${outages ?? 0}, ${reason}, ${next}, ${final}
    where not exists (select 1 from discovery.meta where key = 'halted')
    on conflict (digest) do update set
      ref = coalesce(excluded.ref, discovery.record_attempts.ref),
      tries = case when ${tries === undefined}::boolean then discovery.record_attempts.tries else excluded.tries end,
      outages = case when ${outages === undefined}::boolean then discovery.record_attempts.outages else excluded.outages end,
      last_reason = excluded.last_reason, next_try_at = excluded.next_try_at, final = excluded.final`;
}
