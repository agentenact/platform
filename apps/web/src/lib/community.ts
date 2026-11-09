import { API_BASE } from '@/lib/explore';

/** One listed community template, as `/public/templates` answers it: the fields /create shows. */
export interface CommunityTemplate {
  sha256: string;
  title: string;
  summary: string;
  author: string;
  /** The author's handle in the index, if any: shown beside the address, never instead of it. */
  name: string | null;
}

const SHA = /^[0-9a-f]{64}$/;
const NAME = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null);

/** Keeps only well-formed items; an odd handle is dropped, never the template. The api's text is shown as text. */
export function parseCommunity(json: unknown): CommunityTemplate[] {
  const list = (json as { templates?: unknown } | null)?.templates;
  if (!Array.isArray(list)) return [];
  return list.flatMap((t: Record<string, unknown>) => {
    const sha256 = typeof t?.sha256 === 'string' && SHA.test(t.sha256) ? t.sha256 : null;
    const title = text(t?.title, 60);
    const summary = text(t?.summary, 160);
    const who = t?.author as { address?: unknown; name?: unknown } | undefined;
    const author = text(who?.address, 64);
    const name = typeof who?.name === 'string' && NAME.test(who.name) ? who.name : null;
    return sha256 && title && summary && author ? [{ sha256, title, summary, author, name }] : [];
  });
}

/** The newest listed community templates; [] on any failure, so /create never breaks on the index. */
export async function loadCommunity(signal?: AbortSignal, limit = 50, f: typeof fetch = fetch): Promise<CommunityTemplate[]> {
  try {
    const res = await f(`${API_BASE}/public/templates?limit=${limit}`, { signal, headers: { accept: 'application/json' } });
    return res.ok ? parseCommunity(await res.json()) : [];
  } catch {
    return [];
  }
}

/** A community plan opens in the draft flow by its hash, which says nobody here wrote or reviewed it. */
export const communityHref = (sha256: string): string => `/draft?template=c-${sha256}`;

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
/** The handle names, the address identifies: both, always together. */
export const byline = (t: Pick<CommunityTemplate, 'author' | 'name'>): string => (t.name ? `${t.name} · ${short(t.author)}` : short(t.author));
