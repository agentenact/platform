import { apiCall } from '@/server/api';
import { createSealsDownload } from '@/server/seals-download';
import { accessToken } from '@/server/session';

// The owner's proof download for one day of sealed checks. See server/seals-download.ts.
const download = createSealsDownload({ api: apiCall, token: accessToken });

export const dynamic = 'force-dynamic';
export async function GET(_req: Request, ctx: { params: Promise<{ id: string; day: string }> }) {
  const { id, day } = await ctx.params;
  return download(id, day);
}
