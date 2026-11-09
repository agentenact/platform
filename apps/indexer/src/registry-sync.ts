import type { Db } from './db.js';
import type { RegistryAgent, RegistryReader } from './chain/registry.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Owner, wallet and uri changes arrive as events; the rolling refresh is only a safety net, so it reads few agents per run. */
const REFRESH_PER_RUN = 5;
/** Each read is 4 simulates (about 0.9 s): cap the backfill per tick, and insert each agent as its read completes. */
const BACKFILL_PER_TICK = 50;
/** An id whose read returned null or failed is not read again for this long. */
const RETRY_AFTER_MS = 60 * 60 * 1000;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `${publicBaseUrl}/a/<uuid>/agent.json`, exactly, with a lowercase uuid. Anything else is not ours. */
export function classifyUri(uri: string, publicBaseUrl: string): { hostedUuid: string | null } {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const m = new RegExp(`^${escapeRe(base)}/a/(${UUID})/agent\\.json$`).exec(uri);
  return { hostedUuid: m ? m[1]! : null };
}

export type ReconcileDeps = {
  sql: Db;
  reader: RegistryReader;
  publicBaseUrl: string;
  /** The registry contract id. When given, it is pinned in `meta` on the first run and a later mismatch is a chain reset. */
  registryId?: string;
  concurrency?: number;
  /** Existing agents re-read per run; defaults to REFRESH_PER_RUN. */
  refreshPerRun?: number;
  now?: () => Date;
  log?: (e: Record<string, string | number>) => void;
};

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return out;
}

/**
 * Mirror the registry by id: insert up to 50 ids below `total_agents()` we do not hold per call (backfill and new
 * agents), and re-read a rolling window of 5 existing agents so owner, wallet and uri changes are picked up. Never
 * deletes. Backfilled agents carry no tx and no feed row: the registry read is their only source.
 *
 * One failing id never blocks the others: a read that throws is logged (`registry_read_failed`, id only), skipped,
 * and not retried for an hour; so is an id whose read returns null.
 *
 * `uri` is a CLAIM, not an identity: a hosted-looking uri sets `hosted_uuid` only. `builder` stays 'external' until
 * the self-published document check (selfpub) confirms the claim; only that step sets 'hosted'.
 *
 * CHAIN RESET: `status: 'chain_reset'` means the registry no longer matches what we hold (fewer agents than our
 * highest id, a different contract id, or the highest held id gone). An owner change of the newest agent is NOT a signal:
 * ownership transfers are legitimate. Nothing is written.
 * THE CALLER MUST HALT event and payment polling and alert: continuing would attribute a new chain's events and
 * payments to old agents. Recovery is a manual decision.
 */
export async function reconcileRegistry(d: ReconcileDeps): Promise<{ added: number; refreshed: number; status: 'ok' | 'chain_reset' }> {
  const now = d.now ?? (() => new Date());
  const total = await d.reader.totalAgents();
  const top = (await d.sql`select agent_id from discovery.agents order by agent_id desc limit 1`) as Array<{ agent_id: number }>;
  const pinned = (await d.sql`select value from discovery.meta where key = 'registry_contract'`) as Array<{ value: string }>;

  const reset = await detectReset(d, total, top[0], pinned[0]?.value);
  if (reset) {
    d.log?.({ event: 'registry_chain_reset', signal: reset, total, held_max: top[0]?.agent_id ?? -1 });
    return { added: 0, refreshed: 0, status: 'chain_reset' };
  }
  if (d.registryId && !pinned[0]) {
    await d.sql`insert into discovery.meta (key, value) values ('registry_contract', ${d.registryId}) on conflict (key) do nothing`;
  }

  const refreshed = await refreshWindow(d, now);
  const added = await backfill(d, total, now);
  d.log?.({ event: 'registry_reconciled', total, added, refreshed });
  return { added, refreshed, status: 'ok' };
}

async function detectReset(d: ReconcileDeps, total: number, top: { agent_id: number } | undefined, pinned: string | undefined): Promise<string | null> {
  if (d.registryId && pinned && pinned !== d.registryId) return 'contract_changed';
  if (!top) return null;
  if (total - 1 < top.agent_id) return 'total_below_held';
  // A reset that repopulates past our highest id shows only here: that id is gone.
  try {
    const onChain = await d.reader.read(top.agent_id);
    if (!onChain) return 'top_agent_missing';
  } catch {
    d.log?.({ event: 'registry_probe_failed', id: top.agent_id }); // inconclusive: do not halt on a transient error
  }
  return null;
}

const retryAt = (now: Date) => String(now.getTime() + RETRY_AFTER_MS);

async function markSkip(d: ReconcileDeps, id: number, now: Date): Promise<void> {
  await d.sql`
    insert into discovery.meta (key, value) values (${`skip:${id}`}, ${retryAt(now)})
    on conflict (key) do update set value = excluded.value`;
}

async function backfill(d: ReconcileDeps, total: number, now: () => Date): Promise<number> {
  // Every id below the total that we do not hold and are not backing off from: new ids, and gaps left by earlier runs.
  const missing = (await d.sql`
    select g::int as id, exists (select 1 from discovery.meta m where m.key = 'skip:' || g) as had_skip
    from generate_series(0, ${total - 1}::int) g
    where not exists (select 1 from discovery.agents a where a.agent_id = g)
      and not exists (select 1 from discovery.meta m where m.key = 'skip:' || g and case when m.key like 'skip:%' then m.value::bigint end > ${now().getTime()}::bigint)
    order by g limit ${BACKFILL_PER_TICK}`) as Array<{ id: number; had_skip: boolean }>;
  const done = await pool(missing, d.concurrency ?? 2, async ({ id, had_skip }) => {
    try {
      const a = await d.reader.read(id);
      if (!a) {
        await markSkip(d, id, now());
        return 0;
      }
      const { hostedUuid } = classifyUri(a.uri, d.publicBaseUrl);
      const res = await d.sql`
        insert into discovery.agents (agent_id, owner, wallet, uri, source, builder, hosted_uuid, first_seen_at)
        values (${a.agentId}, ${a.owner}, ${a.wallet}, ${a.uri}, 'registry_read', 'external', ${hostedUuid}::uuid, ${now()})
        on conflict (agent_id) do nothing
        returning agent_id`;
      if (had_skip) await d.sql`delete from discovery.meta where key = ${`skip:${id}`}`;
      return res.length;
    } catch {
      d.log?.({ event: 'registry_read_failed', id, phase: 'backfill' });
      await markSkip(d, id, now()).catch(() => {});
      return 0;
    }
  });
  return done.reduce((n, x) => n + x, 0);
}

/** Re-read the next `refreshPerRun` agents after `meta.refresh_cursor` (id order, wrapping); the cursor moves to the last id actually processed. */
async function refreshWindow(d: ReconcileDeps, now: () => Date): Promise<number> {
  const perRun = d.refreshPerRun ?? REFRESH_PER_RUN;
  const cur = (await d.sql`select value from discovery.meta where key = 'refresh_cursor'`) as Array<{ value: string }>;
  const cursor = cur[0] ? Number(cur[0].value) : -1;
  type Row = { agent_id: number; ver: string };
  // `ver` is read BEFORE the chain read; applyRefresh writes only if it is unchanged.
  const after = (await d.sql`
    select agent_id, (extract(epoch from updated_at) * 1000000)::bigint::text as ver
    from discovery.agents where agent_id > ${cursor} order by agent_id limit ${perRun}`) as Row[];
  const rows = [...after];
  if (rows.length < perRun) {
    const wrap = (await d.sql`
      select agent_id, (extract(epoch from updated_at) * 1000000)::bigint::text as ver
      from discovery.agents where agent_id <= ${cursor} order by agent_id limit ${perRun - rows.length}`) as Row[];
    rows.push(...wrap);
  }
  if (rows.length === 0) return 0;

  const results = await pool(rows, d.concurrency ?? 2, async (r) => {
    try {
      const a = await d.reader.read(r.agent_id);
      if (!a) return { ok: true, refreshed: false };
      return { ok: true, refreshed: await applyRefresh(d, a, r.ver, now()) };
    } catch {
      d.log?.({ event: 'registry_read_failed', id: r.agent_id, phase: 'refresh' });
      return { ok: false, refreshed: false };
    }
  });
  const lastOk = results.map((x) => x.ok).lastIndexOf(true);
  if (lastOk >= 0) {
    await d.sql`
      insert into discovery.meta (key, value) values ('refresh_cursor', ${String(rows[lastOk]!.agent_id)})
      on conflict (key) do update set value = excluded.value`;
  }
  return results.filter((x) => x.refreshed).length;
}

/** Writes only if (owner, wallet, uri) has not changed since `ver` was read, so an event applied meanwhile is never overwritten. */
async function applyRefresh(d: ReconcileDeps, a: RegistryAgent, ver: string, at: Date): Promise<boolean> {
  const { hostedUuid } = classifyUri(a.uri, d.publicBaseUrl);
  const tracked = a.wallet ?? null; // mirrors the generated tracked_wallet column
  // A tracked-wallet change restarts payment polling from the beginning of the new wallet's history. History rows keep
  // their agent attribution; rebinding is recorded only here. A hosted claim, wallet or owner that changed is no longer verified.
  const res = await d.sql`
    update discovery.agents set
      payments_cursor = case when tracked_wallet is distinct from ${tracked}::text then null else payments_cursor end,
      next_poll_at    = case when tracked_wallet is distinct from ${tracked}::text then ${at} else next_poll_at end,
      owner = ${a.owner}, wallet = ${a.wallet}, uri = ${a.uri},
      builder = case when builder = 'hosted' and (hosted_uuid is distinct from ${hostedUuid}::uuid or owner is distinct from ${a.owner} or wallet is distinct from ${a.wallet}::text) then 'external' else builder end,
      hosted_uuid = ${hostedUuid}::uuid
    where agent_id = ${a.agentId} and (extract(epoch from updated_at) * 1000000)::bigint::text = ${ver}
    returning agent_id`;
  return res.length > 0;
}
