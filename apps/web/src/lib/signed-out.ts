/**
 * Supabase keeps the session in `sb-<project>-auth-token` (split into `.0`, `.1`… when it is long). With none of those
 * cookies the visitor is signed out for sure, no auth-server call needed.
 */
export function hasSessionCookie(names: string[]): boolean {
  return names.some((n) => /^sb-.+-auth-token(\.\d+)?$/.test(n));
}

/**
 * The owner's pages send a signed-out visitor home. Doing it in the proxy makes it a real 307 before anything renders;
 * the pages' own redirect('/') (which stays, for a cookie whose session has expired) runs after the skeleton has
 * streamed, so the browser showed a skeleton, then an empty page, then the home page.
 */
export function signedOutRedirect(pathname: string, cookieNames: string[]): string | null {
  if (pathname !== '/dashboard' && !pathname.startsWith('/dashboard/')) return null;
  // The alert email's pause link signs the owner in on the page itself.
  if (pathname === '/dashboard/pause' || pathname.startsWith('/dashboard/pause/')) return null;
  return hasSessionCookie(cookieNames) ? null : '/';
}
