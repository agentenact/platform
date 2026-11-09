import { getHeaderMe } from '@/server/account';

export const dynamic = 'force-dynamic';

/**
 * The header's account island on static pages asks here once per tab: the visitor's own email and agent name, or null.
 * Same-origin only (no CORS headers), never cached. The proxy has refreshed the session cookie before this runs.
 */
export async function GET() {
  return Response.json(await getHeaderMe(), { headers: { 'Cache-Control': 'private, no-store' } });
}
