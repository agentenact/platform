# agentenact-cloud indexer

Single-instance discovery indexer: registry, events, payments, self-published info, records.

## Chain-reset halt (operator runbook)

When the registry or events stage detects a chain reset, the indexer writes `discovery.meta` key `halted`
and stops the registry, events and payments stages. `/health` reports `halted`. The marker survives restarts:
a restarted process logs `indexer_halted` again and still runs none of those stages. An unreadable marker is treated as set.

Recovery is manual and only after you have checked the chain:

```sql
delete from discovery.meta where key = 'halted';
```

then restart the service. Nothing in the process ever clears the marker.

## Records parked by a long outage (operator runbook)

A record whose verification keeps failing on chain errors is retried every 5 minutes for about a week, then once a day for
about 30 more days, then marked final `outage_exhausted`. After a long RPC or Horizon outage, re-queue those rows:

```sql
update discovery.record_attempts set outages = 0, next_try_at = now(), final = false
 where final and last_reason = 'outage_exhausted';
```

## Records waiting on index lag (operator runbook)

A record whose settlement is not on Horizon yet, or whose agent / wallet binding is not indexed yet
(`agent_not_indexed`, `unregistered`, `address_not_bound`, `not_found`, `no_matching_payment`) is retried on a long schedule:
15 s, 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h, then daily, and only then marked final (about four days). Other failures keep
the short 15 s, 1 m, 5 m schedule and are final on the 4th try. If the registry or events stage was behind for longer than
that, or rows were finalised before this schedule existed, re-queue them:

```sql
update discovery.record_attempts set tries = 0, next_try_at = now(), final = false
 where final and last_reason in ('agent_not_indexed', 'unregistered', 'address_not_bound', 'not_found', 'no_matching_payment');
```

## Freshness and halts

`heartbeat_at` and `indexed_ledger` advance only on a successful events tick; `payments_ok_at` only on a payments tick where
no wallet was due or at least one poll succeeded (a Horizon outage that every poll swallows does not count). selfpub, records
and registry never touch them. The api reports `stale` when either is older than 5 minutes or missing, and while `halted` is set.

A chain reset is declared only when the RPC's latest ledger stays more than 100 ledgers below the stored events ledger or
cursor for 3 consecutive samples at least 15 s apart. Until then the log shows `registry_ledger_suspect` and the registry and
events ticks do nothing (and write no heartbeat). One lagging backend never halts the indexer.

## Database credentials and the role (deploy runbook)

The `infra: agentenact-supabase` link injects the database superuser credentials into the container. `entrypoint.sh`
(the image ENTRYPOINT) starts the process with an allowlisted environment (`PATH`, `HOME`, `TZ`, `NODE_ENV`, `PORT`,
`PUBLIC_BASE_URL`, `INDEXER_*`), so the indexer sees only `INDEXER_DATABASE_URL` and connects only as `discovery_indexer`.
Verify after a deploy (variable names only, never values):

```sh
servel exec agentenact-indexer -- sh -c 'tr "\0" "\n" < /proc/1/environ | cut -d= -f1 | sort'
```

Migration `0012_discovery_indexer_limits.sql` gives the role `CONNECTION LIMIT 10`, `statement_timeout = 30s`,
`idle_in_transaction_session_timeout = 60s` and default privileges for future discovery tables. A deploy does not apply
it. Order: migration, then indexer, then api:

```sh
servel infra sql @agentenact-supabase --service db ./migrations --track     # 1. 0012 (earlier files are tracked already)
cd apps/indexer && servel deploy                                             # 2. entrypoint, freshness, halt check, lag schedule
cd apps/api && servel deploy                                                 # 3. stale reads payments_ok_at; export limits
```

The indexer goes before the api: the api reports `stale` until `payments_ok_at` exists, which the new indexer writes
within seconds of its first healthy payments tick.

See `servel.yaml` for deploy notes (stop-first rollout, direct database connection).
