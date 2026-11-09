import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { isOwnShellPath } from '@/lib/own-shell';
import { legacyProfileRedirect } from '@/lib/legacy-agent-path';
import { oldHostRedirect } from '@/lib/old-host';
import { appOrigin } from '@/server/origin';
import { PUBLIC } from '@/lib/public-config';
import { isSessionFreeRequest } from '@/lib/session-free';
import { signedOutRedirect } from '@/lib/signed-out';

/**
 * Refreshes the Supabase session cookie, and answers the old host (app.agentenact.io) and the old /agent?id=<n> profile link with
 * their permanent redirects.
 * A section with its own shell (lib/own-shell.ts) has nothing to do with the customer session: it is passed through untouched (no auth-server call).
 * A GET of a public page that never reads the session (lib/session-free.ts) skips the refresh: those pages are static, and
 * the refresh still happens on the header's /api/header-me check, on the session pages and on every server action.
 */
export async function proxy(req: NextRequest) {
  // app.agentenact.io, once agentenact.io is this deployment's origin: every path moves there, permanently (308 keeps a POST a POST).
  const moved = oldHostRedirect(req.headers.get('host'), req.nextUrl.pathname, req.nextUrl.search, appOrigin());
  if (moved) return NextResponse.redirect(moved, 308);
  // The old public profile link, /agent?id=<n>: see lib/legacy-agent-path.ts for why this one is not in next.config.
  const profile = legacyProfileRedirect(req.nextUrl.pathname, req.nextUrl.search);
  if (profile) return NextResponse.redirect(new URL(profile, req.url), 308);
  if (isOwnShellPath(req.nextUrl.pathname)) return NextResponse.next();
  if (isSessionFreeRequest(req.method, req.nextUrl.pathname)) return NextResponse.next();
  // A signed-out visit to the owner's pages goes home with a plain 307, before a skeleton or an empty page can show.
  const home = req.method === 'GET' ? signedOutRedirect(req.nextUrl.pathname, req.cookies.getAll().map((c) => c.name)) : null;
  if (home) return NextResponse.redirect(new URL(home, req.url), 307);
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(PUBLIC.supabaseUrl, PUBLIC.supabaseAnonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll(list) {
        for (const c of list) req.cookies.set(c.name, c.value);
        res = NextResponse.next({ request: req });
        for (const c of list) res.cookies.set(c.name, c.value, c.options);
      },
    },
  });
  await supabase.auth.getUser();
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health|email/|a/|docs/).*)'] };
