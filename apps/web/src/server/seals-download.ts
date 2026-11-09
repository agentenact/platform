/**
 * GET /dashboard/<agent>/seals/<day>: one UTC day of the agent's check seals as a JSON file, for its owner only (the api
 * answers 404 for anyone else's agent; a reading can be private). Each entry carries the exact document bytes, so
 * `sha256(document)` can be compared with the memo of the transaction it names on any Stellar explorer.
 */
import type { ApiCall } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface SealsDownloadDeps {
  token(): Promise<string | undefined>;
  api: ApiCall;
}

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });

export function createSealsDownload(d: SealsDownloadDeps) {
  return async (agentId: string, day: string): Promise<Response> => {
    if (!UUID.test(agentId) || !DAY.test(day)) return plain(404, 'Not found.');
    const token = await d.token();
    if (!token) return plain(401, 'Sign in to download your agent\'s checks.');
    const res = await d.api(`/api/agents/${agentId}/seals/${day}`, { token });
    const list = (res.json as { seals?: unknown } | null)?.seals;
    if (res.status !== 200 || !Array.isArray(list)) return plain(res.status === 401 ? 401 : 404, 'Not found.');
    const body = JSON.stringify(
      {
        about: 'Each check below was sealed on Stellar testnet: sha256(document) is the memo (hash) of the transaction named in tx, sent from your agent\'s own account. The document is the exact text that was hashed.',
        network: 'stellar:testnet',
        day,
        checks: list,
      },
      null,
      2,
    );
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="checks-${day}.json"`,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  };
}
