import type { Db } from './db.js';
import { lockFeed } from './feed-lock.js';
import { isRetentionGap, type RegistryAgent, type RegistryEvent, type RegistryReader } from './chain/registry.js';
import { classifyUri, reconcileRegistry } from './registry-sync.js';

export type FollowDeps = {
  sql: Db;
  reader: RegistryReader;
  publicBaseUrl: string;
  /** Passed to the reconcile runs; pins the contract id. */
  registryId?: string;
  limit?: number;
  /** The clock for the regression streak; tests inject one. */
  now?: () => Date;
  log?: (e: Record<string, string | number>) => void;
};

const DEFAULT_LIMIT = 200;

async function getMeta(sql: Db, key: string): Promise<string | null> {
  const rows = (await sql`select value from discovery.meta where key = ${key}`) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

async function setMeta(sql: Db, key: string, value: string): Promise<void> {
  await sql`insert into discovery.meta (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
}

/** The ledger a TOID cursor (`<ledger << 32 | ...>-<n>`) points at; 0 when unparsable. */
function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split('-')[0]!) >> 32n);
  } catch {
    return 0;
  }
}

/**
 * A reset drops the RPC's ledger far below what we processed and keeps it there. A single sample proves nothing: the
 * RPC is load-balanced and a backend can answer a few ledgers behind (getEvents and simulate can hit different backends).
 * So a regression counts only when the sample is more than REGRESSION_MARGIN ledgers below, and only once
 * REGRESSION_SAMPLES consecutive samples span at least REGRESSION_MIN_MS. Any sample at or above the margin clears the streak.
 */
export const REGRESSION_MARGIN = 100;
export const REGRESSION_SAMPLES = 3;
export const REGRESSION_MIN_MS = 15_000;

/** The consecutive-regression streak per reader (the process has one), in memory: a restart just starts counting again. */
const streaks = new WeakMap<object, { since: number; n: number }>();

/**
 * 'regressed': the RPC's latest ledger has been far behind what we already processed (`events_ledger` or the cursor) for
 * long enough to be a different (reset or rolled-back) chain. 'suspect': behind right now, not yet confirmed; the caller
 * must skip this tick (do not follow or reconcile against that backend). 'ok' otherwise.
 * Reads `latestLedger`, logs `registry_ledger_suspect` / `registry_chain_reset`, writes nothing.
 * Pass the stored values, or omit them to read them from `meta`; no stored ledger means nothing to regress from.
 */
export async function ledgerCheck(d: Pick<FollowDeps, 'sql' | 'reader' | 'log' | 'now'>, storedLedger?: string | null, storedCursor?: string | null): Promise<'ok' | 'suspect' | 'regressed'> {
  const ledger = storedLedger !== undefined ? storedLedger : await getMeta(d.sql, 'events_ledger');
  if (ledger === null) return 'ok';
  const cursor = storedCursor !== undefined ? storedCursor : await getMeta(d.sql, 'events_cursor');
  const latest = await d.reader.latestLedger();
  const stored = Math.max(Number(ledger), cursor !== null ? cursorLedger(cursor) : 0);
  if (latest + REGRESSION_MARGIN >= stored) {
    streaks.delete(d.reader);
    return 'ok';
  }
  const t = (d.now ?? (() => new Date()))().getTime();
  const prev = streaks.get(d.reader);
  const streak = prev ? { since: prev.since, n: prev.n + 1 } : { since: t, n: 1 };
  streaks.set(d.reader, streak);
  if (streak.n >= REGRESSION_SAMPLES && t - streak.since >= REGRESSION_MIN_MS) {
    d.log?.({ event: 'registry_chain_reset', signal: 'ledger_regressed', latest, events_ledger: Number(ledger) });
    return 'regressed';
  }
  d.log?.({ event: 'registry_ledger_suspect', latest, events_ledger: Number(ledger), samples: streak.n });
  return 'suspect';
}

/**
 * Walk the registry's events from where we stopped and apply them. The first run records the ledger BEFORE the
 * reconcile walk, so a registration made while the walk runs is read from events (and fills in its tx hash).
 * A stale cursor or a start before the retention window reconciles instead; events inside the gap are not recovered,
 * agents still converge through reconcile's rolling refresh.
 *
 * `status: 'chain_reset'` (from reconcile, or the RPC's latest ledger falling below `events_ledger` / the cursor)
 * touches neither the ledger nor the cursor. THE CALLER MUST HALT event and payment polling and alert; see
 * `reconcileRegistry`.
 */
export async function followRegistry(d: FollowDeps): Promise<{ applied: number; status: 'ok' | 'reconciled' | 'chain_reset' | 'suspect' }> {
  const limit = d.limit ?? DEFAULT_LIMIT;
  let ledger = await getMeta(d.sql, 'events_ledger');
  let cursor = await getMeta(d.sql, 'events_cursor');

  if (ledger !== null) {
    const check = await ledgerCheck(d, ledger, cursor);
    if (check === 'regressed') return { applied: 0, status: 'chain_reset' };
    if (check === 'suspect') return { applied: 0, status: 'suspect' }; // wait for more samples; do not follow a backend that may be lagging
  }

  if (ledger === null) {
    const start = await d.reader.latestLedger();
    if ((await reconcileRegistry(d)).status === 'chain_reset') return { applied: 0, status: 'chain_reset' };
    await setMeta(d.sql, 'events_ledger', String(start));
    ledger = String(start);
    cursor = null;
  }

  let applied = 0;
  let prev = cursor;
  try {
    for (;;) {
      const page = await d.reader.events(cursor ? { cursor, limit } : { startLedger: Number(ledger), limit });
      for (const ev of page.events) if (await applyEvent(d, ev)) applied++;
      const next = page.cursor;
      if (next) {
        await setMeta(d.sql, 'events_cursor', next);
        cursor = next;
      }
      // An empty page with an advancing cursor is normal; stop only once the cursor has reached the latest ledger
      // (or stopped moving) and nothing is left in the page.
      const done = !next || next === prev || (page.events.length === 0 && cursorLedger(next) >= page.latestLedger);
      if (done) break;
      prev = next;
    }
  } catch (err) {
    if (!isRetentionGap(err)) throw err;
    const start = await d.reader.latestLedger();
    if ((await reconcileRegistry(d)).status === 'chain_reset') return { applied, status: 'chain_reset' };
    await setMeta(d.sql, 'events_ledger', String(start));
    await d.sql`delete from discovery.meta where key = 'events_cursor'`;
    d.log?.({ event: 'registry_events_gap', applied });
    return { applied, status: 'reconciled' };
  }
  return { applied, status: 'ok' };
}

const isContractError = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { kind?: unknown }).kind === 'contract';

/**
 * Apply one event in one transaction. Returns false when the event was already recorded (or skipped).
 *
 * `uri_updated` carries its value; every other kind re-reads the agent (wallet and owner are not decoded from
 * events). A `registered` event never loses its data to a lagging read: when the read returns null (getEvents and
 * simulate can hit different RPC backends) or fails in the contract, the row is created/updated from the event itself
 * (owner = topic 2, agent_uri = value) with the tx and feed line, and the next refresh fills the wallet.
 * A contract-kind read failure on any other kind skips the event with a fixed log (reconcile's refresh converges);
 * transport errors still throw so the event is retried.
 */
async function applyEvent(d: FollowDeps, ev: RegistryEvent): Promise<boolean> {
  const seen = (await d.sql`select 1 from discovery.registry_events where event_id = ${ev.id}`) as unknown[];
  if (seen.length > 0) return false;

  const heldRows = (await d.sql`select owner from discovery.agents where agent_id = ${ev.agentId}`) as Array<{ owner: string }>;
  const held = heldRows.length > 0;
  let rd: RegistryAgent | null = null;
  if (!held || ev.kind !== 'uri_updated') {
    try {
      rd = await d.reader.read(ev.agentId);
    } catch (err) {
      if (!isContractError(err)) throw err;
      d.log?.({ event: 'registry_event_read_failed', id: ev.agentId, kind: ev.kind });
      if (ev.kind !== 'registered') return false;
    }
  }
  const fromEvent: RegistryAgent | null = ev.kind === 'registered' && ev.owner ? { agentId: ev.agentId, owner: ev.owner, wallet: null, uri: ev.uri ?? '' } : null;
  const newRow = rd ?? fromEvent;
  const at = new Date(ev.at);
  // The registration-time metadata_set binds the owner's own address: recorded, but not activity.
  const inert = ev.kind === 'wallet_bound' && ev.wallet !== undefined && ev.wallet === (rd?.owner ?? heldRows[0]?.owner);

  return d.sql.begin(async (tx: Db) => {
    // Lock order: the feed lock before any row lock (see feed-lock.ts). Only `registered` writes a feed row.
    if (ev.kind === 'registered') await lockFeed(tx);
    const ins = (await tx`
      insert into discovery.registry_events (event_id, agent_id, kind, tx_hash, ledger, at, inert)
      values (${ev.id}, ${ev.agentId}, ${ev.kind}, ${ev.txHash}, ${ev.ledger}, ${at}, ${inert})
      on conflict (event_id) do nothing
      returning event_id`) as unknown[];
    if (ins.length === 0) return false;

    if (!held && newRow) {
      const { hostedUuid } = classifyUri(newRow.uri, d.publicBaseUrl);
      await tx`
        insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid, first_seen_at)
        values (${newRow.agentId}, ${newRow.owner}, ${newRow.wallet}, ${newRow.uri}, 'registry_read', 'external', ${hostedUuid}, ${at})
        on conflict (agent_id) do nothing`;
    }

    if (ev.kind === 'registered') {
      await tx`
        update discovery.agents set source = 'event', registered_tx = ${ev.txHash}, registered_ledger = ${ev.ledger}, registered_at = ${at}
        where agent_id = ${ev.agentId}`;
      await lockFeed(tx);
      await tx`
        insert into discovery.feed (kind, agent_id, tx_hash, at, source_key)
        values ('registered', ${ev.agentId}, ${ev.txHash}, ${at}, ${`reg:${ev.agentId}`})
        on conflict (source_key) do nothing`;
    }

    if (ev.kind === 'uri_updated' && ev.uri !== undefined) {
      const { hostedUuid } = classifyUri(ev.uri, d.publicBaseUrl);
      await tx`
        update discovery.agents set uri = ${ev.uri},
          builder = case when builder = 'hosted' and hosted_uuid is distinct from ${hostedUuid}::uuid then 'external' else builder end,
          hosted_uuid = ${hostedUuid}::uuid
        where agent_id = ${ev.agentId}`;
    } else if (rd && (ev.kind === 'wallet_bound' || ev.kind === 'owner_changed' || ev.kind === 'registered')) {
      const { hostedUuid } = classifyUri(rd.uri, d.publicBaseUrl);
      const tracked = rd.wallet ?? null; // mirrors the generated tracked_wallet column
      // `hosted_uuid` is only a claim: builder is never set to 'hosted' here, and a changed claim, wallet or owner drops
      // a verified one. A tracked-wallet change restarts payment polling from the new wallet's start; history keeps its attribution.
      await tx`
        update discovery.agents set
          payments_cursor = case when tracked_wallet is distinct from ${tracked}::text then null else payments_cursor end,
          next_poll_at    = case when tracked_wallet is distinct from ${tracked}::text then now() else next_poll_at end,
          builder = case when builder = 'hosted' and (hosted_uuid is distinct from ${hostedUuid}::uuid or owner is distinct from ${rd.owner} or wallet is distinct from ${rd.wallet}::text) then 'external' else builder end,
          owner = ${rd.owner}, wallet = ${rd.wallet}, uri = ${rd.uri},
          hosted_uuid = ${hostedUuid}::uuid
        where agent_id = ${ev.agentId}`;
    }

    await tx`update discovery.agents set last_active_at = greatest(last_active_at, ${at}) where agent_id = ${ev.agentId}`;
    return true;
  });
}
