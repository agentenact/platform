import { z } from 'zod';
import type { ChainTransfer } from './horizon.js';
import { httpError, withRetry, type RetryOpts } from './registry.js';
import { parseUnits7 } from './units.js';

/**
 * AgentKarma's stellar-testnet payment feed: every USDC transfer leg it has indexed, in ingest order, behind an opaque
 * cursor. AgentKarma already walks Horizon for these agents, so reading its index replaces our own per-wallet polling.
 *
 *   GET {base}/api/v2/payments/stellar-testnet?cursor=…&limit=…
 *   { payments: [{ id: "<operationId>:<legIndex>", txHash, from, to, amount: "0.0010000", timestamp, success }],
 *     cursor: string | null, done: boolean }
 *
 * The row key is the same "<operationId>:<index>" pair our Horizon decoder writes. Rows are raw legs: counting rules
 * stay ours (rules.ts), applied at ingest exactly as for a Horizon page.
 */
const LEG = z.object({
  id: z.string().regex(/^\d+:\d+$/),
  txHash: z.string().regex(/^[0-9a-f]{64}$/),
  from: z.string().min(1),
  to: z.string().min(1),
  amount: z.string(),
  timestamp: z.string().refine((v) => !Number.isNaN(Date.parse(v))),
  success: z.boolean(),
});
const PAGE = z.object({ payments: z.array(z.unknown()), cursor: z.string().nullable(), done: z.boolean() });

export interface KarmaPaymentsReader {
  /** One page after `cursor` (null = from the start). Malformed rows are dropped and counted, never guessed. */
  page(cursor: string | null, limit: number): Promise<{ transfers: ChainTransfer[]; cursor: string | null; done: boolean; dropped: number }>;
}

const KARMA_TIMEOUT_MS = 30_000;

export function createKarmaPaymentsReader(o: { baseUrl: string; usdc: string; fetch?: typeof fetch; retry?: RetryOpts }): KarmaPaymentsReader {
  const base = o.baseUrl.replace(/\/$/, '');
  const doFetch = o.fetch ?? globalThis.fetch;
  return {
    async page(cursor, limit) {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (cursor) qs.set('cursor', cursor);
      const url = `${base}/api/v2/payments/stellar-testnet?${qs}`;
      const body = await withRetry(async () => {
        const res = await doFetch(url, { signal: AbortSignal.timeout(KARMA_TIMEOUT_MS) });
        if (!res.ok) throw httpError(res.status, 'AgentKarma payments read');
        return res.json();
      }, o.retry);
      const parsed = PAGE.safeParse(body);
      if (!parsed.success) throw new Error('AgentKarma payments page has an unexpected shape');
      // Without a cursor a non-empty page cannot move us forward: we would re-read it forever.
      if (parsed.data.payments.length > 0 && !parsed.data.cursor) throw new Error('AgentKarma payments page without cursor');
      const transfers: ChainTransfer[] = [];
      let dropped = 0;
      for (const raw of parsed.data.payments) {
        const t = toTransfer(raw, o.usdc);
        if (t === undefined) dropped++;
        else if (t) transfers.push(t);
      }
      return { transfers, cursor: parsed.data.cursor ?? cursor, done: parsed.data.done, dropped };
    },
  };
}

/** A leg as a transfer; null for a leg that is valid but not a payment we store (failed, zero), undefined when malformed. */
function toTransfer(raw: unknown, usdc: string): ChainTransfer | null | undefined {
  const r = LEG.safeParse(raw);
  if (!r.success) return undefined;
  const l = r.data;
  if (!l.success) return null;
  let amountUnits: bigint;
  try {
    amountUnits = parseUnits7(l.amount);
  } catch {
    return undefined;
  }
  if (amountUnits <= 0n) return null;
  const [opId, idx] = l.id.split(':') as [string, string];
  // The feed carries only issuer-pinned USDC, so the asset is ours to state, not theirs.
  return { opId, idx: Number(idx), txHash: l.txHash, from: l.from, to: l.to, amountUnits, asset: usdc, at: new Date(l.timestamp).toISOString() };
}
