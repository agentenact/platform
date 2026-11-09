/**
 * /auth/confirm: turns the emailed link into a session, then sends the visitor on, to a same-origin path only.
 *
 * Opening the link (GET) signs nobody in. Mail scanners and link previewers fetch links, and a GET that consumed the
 * single-use token would burn it before the person taps; a GET that signed in would also let anyone sign a victim in as the
 * sender with a link of their own. GET shows a page with a Continue button; only that button's POST, from this origin, verifies.
 */
import { copy } from '@/copy';
import { appOrigin } from './origin';
import { legacyAgentPath } from '@/lib/legacy-agent-path';
import { safeNext } from '@/lib/safe-next';

const ALLOWED_TYPES: ReadonlySet<string> = new Set(['email', 'magiclink']);

export { safeNext };

/** Where a link's `next` sends the visitor: a same-origin path only, and a link sent before /agent moved lands on its new home. */
export const landingFor = (next: string | null) => legacyAgentPath(safeNext(next));

export interface ConfirmDeps {
  verifyOtp(a: { token_hash: string; type: 'email' | 'magiclink' }): Promise<{ error: unknown | null }>;
}

export async function confirmSignIn(url: URL, d: ConfirmDeps): Promise<Response> {
  const to = (path: string) => new Response(null, { status: 303, headers: { location: new URL(path, appOrigin()).toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  // The emailed link is `{{ .RedirectTo }}&token_hash=…&type=…`, and RedirectTo carries the requester's own query. A
  // requester could plant a token_hash of their own in it (login CSRF: the victim lands in the attacker's session).
  // GoTrue appends the real one, so any repeat of these parameters means a tampered link: refuse it outright.
  if (['token_hash', 'type', 'next'].some((k) => url.searchParams.getAll(k).length > 1)) return to('/?signin=expired');
  const hash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  if (!hash || !type || !ALLOWED_TYPES.has(type)) return to('/?signin=expired');
  try {
    const { error } = await d.verifyOtp({ token_hash: hash, type: type as 'email' | 'magiclink' });
    if (error) return to('/?signin=expired');
  } catch {
    return to('/?signin=expired');
  }
  return to(landingFor(url.searchParams.get('next')));
}

export const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const expiredRedirect = () =>
  new Response(null, { status: 303, headers: { location: new URL('/?signin=expired', appOrigin()).toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  // same-origin, not no-referrer: under no-referrer the browser sends `Origin: null` on the form POST below. The page's
  // URL (which holds the token) still never leaves this origin.
  'referrer-policy': 'same-origin',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/** GET: the Continue page for a well-formed link, or the expired redirect for a tampered or incomplete one. Verifies nothing. */
export function confirmPage(url: URL): Response {
  if (['token_hash', 'type', 'next'].some((k) => url.searchParams.getAll(k).length > 1)) return expiredRedirect();
  const hash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  if (!hash || !type || !ALLOWED_TYPES.has(type)) return expiredRedirect();
  const next = landingFor(url.searchParams.get('next'));
  const c = copy.confirm;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(c.title)}</title></head>
<body style="margin:0;background:#f7f2ec;color:#2a2420;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<main style="max-width:480px;margin:0 auto;padding:64px 16px;">
<h1 style="font-size:28px;line-height:34px;margin:0 0 12px;">${esc(c.title)}</h1>
<p style="font-size:16px;line-height:24px;margin:0 0 28px;">${esc(c.lead)}</p>
<form method="post" action="/auth/confirm">
<input type="hidden" name="token_hash" value="${esc(hash)}">
<input type="hidden" name="type" value="${esc(type)}">
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit" style="min-height:48px;background:#8e2a22;color:#ffffff;border:0;border-radius:999px;padding:0 28px;font-size:16px;font-weight:600;cursor:pointer;">${esc(c.button)}</button>
</form>
</main></body></html>`;
  return new Response(html, { status: 200, headers: PAGE_HEADERS });
}

/**
 * POST: only a form submitted from this origin counts. A real Origin must be ours. `Origin: null` (a privacy referrer
 * policy, or a browser extension's) or no Origin at all falls back to the browser's own Sec-Fetch-Site verdict, which page
 * scripts cannot set.
 */
export function fromThisOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== 'null') return origin === appOrigin();
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

/** The route's two handlers over an injected verifier, so the whole behaviour is tested without Next. */
export function createAuthConfirmRoute(getAuth: () => Promise<ConfirmDeps>) {
  return {
    async GET(req: Request): Promise<Response> {
      return confirmPage(new URL(req.url));
    },
    async POST(req: Request): Promise<Response> {
      if (!fromThisOrigin(req)) return expiredRedirect();
      let body: string;
      try {
        body = await req.text();
      } catch {
        return expiredRedirect();
      }
      // The form carries the same three parameters the link did, so the same checks (repeats, type, next) apply.
      return confirmSignIn(new URL(`/auth/confirm?${new URLSearchParams(body).toString()}`, appOrigin()), await getAuth());
    },
  };
}
