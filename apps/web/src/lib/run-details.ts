/** Pure helpers for the run details under an activity row. */
import { copy } from '@/copy';
import type { RunDetail } from '@/lib/agent-types';

export type RunOut = { ok: true; run: RunDetail } | { ok: false };

/** "Took 7 s", or "Still running" when there is no end (or an odd one). */
export function durationWords(startedAt: string, endedAt: string | null): string {
  const a = Date.parse(startedAt);
  const b = endedAt === null ? NaN : Date.parse(endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return copy.runDetails.running;
  return copy.runDetails.took(Math.max(0, Math.round((b - a) / 1000)));
}

/** "11112222-3333" -> "11112222"; with `edge`, both ends of a long value: "aaaaaaaa…aaaaaaaa". */
export function shortId(id: string, edge?: number): string {
  if (edge !== undefined) return id.length > edge * 2 + 1 ? `${id.slice(0, edge)}…${id.slice(-edge)}` : id;
  return id.slice(0, 8);
}

/** The explorer link for a settlement, only for a real lowercase 64-character hash. */
export function txUrl(tx: string | null): string | null {
  return tx !== null && /^[0-9a-f]{64}$/.test(tx) ? `https://stellar.expert/explorer/testnet/tx/${tx}` : null;
}

/** "2026-10-13T12:00:07.400Z" -> "2026-10-13 12:00:07 UTC". */
export function utcWords(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '';
}

/**
 * Asks for a run once: the answer (or the ask still in flight) is kept per run id, so a second open never asks again.
 * A failure is not kept, so "Try again" asks again; neither is a run that has not ended (its answer is stale the moment the run
 * finishes, and the live refresh makes that visible). Never throws.
 */
export function fetchOnce(cache: Map<string, Promise<RunOut>>, runId: string, ask: (runId: string) => Promise<RunOut>): Promise<RunOut> {
  const have = cache.get(runId);
  if (have) return have;
  const p = Promise.resolve()
    .then(() => ask(runId))
    .catch((): RunOut => ({ ok: false }))
    .then((out) => {
      if (!out.ok || out.run.endedAt === null) cache.delete(runId);
      return out;
    });
  cache.set(runId, p);
  return p;
}
