/**
 * Publishing the selling suggestion, with the api injected for tests. The body carries the version the card showed; the api
 * answers 409 not_eligible when the description has moved on since, which is "stale", not an error. Failures carry a plain
 * sentence chosen from the status and code, never a body and never an error object.
 */
import { errorCopy } from '@/copy';
import type { OfferOut } from '../lib/sell';
import type { ApiCall } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSellActions(d: { api: ApiCall; token(): Promise<string | undefined> }) {
  return {
    async offer(agentId: string, version: number): Promise<OfferOut> {
      if (!UUID.test(agentId) || !Number.isSafeInteger(version) || version < 1) return { ok: false, stale: false, message: errorCopy('not_found') };
      try {
        const token = await d.token();
        if (!token) return { ok: false, stale: false, message: errorCopy('unauthorized') };
        const res = await d.api(`/api/agents/${agentId}/suggestion/publish`, { token, method: 'POST', body: { version } });
        if (res.status === 204) return { ok: true };
        const code = typeof (res.json as { error?: unknown } | null)?.error === 'string' ? (res.json as { error: string }).error : undefined;
        if (res.status === 409 && code === 'not_eligible') return { ok: false, stale: true };
        return { ok: false, stale: false, message: errorCopy(code, res.status) };
      } catch {
        return { ok: false, stale: false, message: errorCopy(undefined, 503) };
      }
    },
  };
}
