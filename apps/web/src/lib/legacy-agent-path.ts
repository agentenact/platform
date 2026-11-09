/**
 * The owner's area moved from /agent to /dashboard, and the public agent profile (once agentenact.io's /agent?id=<n>) is
 * /agents/<n>. Old links keep working, permanently redirected (308, so a POST to the old pause form stays a POST):
 *  - /agent?id=<n> by the proxy (src/proxy.ts, legacyProfileRedirect). Not in next.config: a config redirect always copies
 *    the source query onto the destination, so it would send /agent?id=13 to /agents/13?id=13.
 *  - /agent and /agent/... without `id` by next.config.ts (LEGACY_AGENT_REDIRECTS), query kept (/agent?run=<id> from an
 *    alert email becomes /dashboard?run=<id>).
 *  - an old `next` in a magic link sent before the move by /auth/confirm (legacyAgentPath), so it lands in one hop.
 * Imported by next.config.ts: relative imports only, no `@/` alias.
 */

/**
 * Config redirects run before the proxy, so the bare /agent rule must skip links that carry `id`. The sub-path rule takes
 * `:path+` (one or more segments), never `:path*`: `*` also matches bare /agent and would catch the profile link first.
 */
export const LEGACY_AGENT_REDIRECTS = [
  { source: '/agent', missing: [{ type: 'query' as const, key: 'id' }], destination: '/dashboard', permanent: true },
  { source: '/agent/:path+', destination: '/dashboard/:path+', permanent: true },
];

/**
 * A same-origin path with the old /agent prefix rewritten: `/agent?id=<digits>` becomes `/agents/<digits>`, any other
 * `/agent`, `/agent/...`, `/agent?...` or `/agent#...` becomes the same under /dashboard. Everything else (including
 * /agents/...) is returned unchanged. Takes a path already checked by safeNext.
 */
export function legacyAgentPath(path: string): string {
  const m = /^\/agent(?=$|[/?#])(.*)$/.exec(path);
  if (!m) return path;
  const rest = m[1] ?? '';
  if (rest.startsWith('?')) {
    const hash = rest.indexOf('#');
    const id = new URLSearchParams(hash < 0 ? rest : rest.slice(0, hash)).get('id');
    if (id !== null && /^\d+$/.test(id)) return `/agents/${id}`;
  }
  return `/dashboard${rest}`;
}

/** The proxy's half: `/agent` with an `id` query goes where legacyAgentPath says (`/agents/<n>`, or /dashboard for a non-numeric id). */
export function legacyProfileRedirect(pathname: string, search: string): string | null {
  if (pathname !== '/agent' || !new URLSearchParams(search).has('id')) return null;
  return legacyAgentPath(`${pathname}${search}`);
}
