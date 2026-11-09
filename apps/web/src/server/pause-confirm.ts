/**
 * Pausing from the alert email. Two parts:
 *  - /dashboard/pause (page.tsx, GET): opening the link pauses nothing, because mail scanners fetch links. A signed-in owner sees
 *    one button; a signed-out visitor sees the panel's own browser sign-in (SignInCard) whose link returns to this page.
 *    This server never sends a sign-in email itself: relaying one-time-link requests would void Supabase's per-visitor limits.
 *  - /dashboard/pause/confirm (POST only): the button. Same origin only (a null Origin falls back to Sec-Fetch-Site, as in
 *    auth-confirm.ts; the pages must not send Referrer-Policy: no-referrer or the browser sends `Origin: null`), a signed-in
 *    visitor only. Whose agent it is stays the api's call: it gets the visitor's own token and answers 404 for anyone else's.
 */
import { esc, fromThisOrigin } from './auth-confirm';
import type { PauseOut } from './agent-actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PauseDeps {
  /** The signed-in visitor's access token, or undefined. */
  token(): Promise<string | undefined>;
  /** Pauses (true) the signed-in visitor's agent through the api with their own token. */
  setPaused(agentId: string, paused: boolean): Promise<PauseOut>;
}

/** The agent id of a pause link: exactly one well-formed `agent` parameter, else null. */
export function pauseAgent(v: string | string[] | undefined): string | null {
  return typeof v === 'string' && UUID.test(v) ? v : null;
}

/** Where the sign-in link must return: this page, so the visitor presses the button once there. */
export const pauseNext = (agent: string) => `/dashboard/pause?agent=${agent}`;

export type PausePage = { kind: 'bad' } | { kind: 'signin'; agent: string; next: string } | { kind: 'confirm'; agent: string };

/** What GET /dashboard/pause shows. Decides only what to render; never pauses. */
export function pausePage(agent: string | string[] | undefined, signedIn: boolean): PausePage {
  const id = pauseAgent(agent);
  if (!id) return { kind: 'bad' };
  return signedIn ? { kind: 'confirm', agent: id } : { kind: 'signin', agent: id, next: pauseNext(id) };
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'same-origin',
  'x-robots-tag': 'noindex',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const BUTTON = 'min-height:48px;background:#8e2a22;color:#ffffff;border:0;border-radius:999px;padding:0 28px;font-size:16px;font-weight:600;cursor:pointer;';
const LINK = 'color:#2a2420;font-size:16px;';

function page(title: string, lead: string, inner = '', status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f7f2ec;color:#2a2420;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<main style="max-width:480px;margin:0 auto;padding:64px 16px;">
<img src="/brand/seal-ink-96.png" width="48" height="48" alt="AgentEnact" style="display:block;border:0;margin:0 0 20px;">
<h1 style="font-size:28px;line-height:34px;margin:0 0 12px;">${esc(title)}</h1>
<p style="font-size:16px;line-height:24px;margin:0 0 28px;">${esc(lead)}</p>
${inner}
</main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const toAgent = `<p style="margin:0;"><a href="/dashboard" style="${LINK}">Open my agent</a></p>`;
const again = (agent: string) => `<form method="post" action="/dashboard/pause/confirm"><input type="hidden" name="agent" value="${esc(agent)}"><button type="submit" style="${BUTTON}">Try again</button></form>`;

export function createPauseRoute(d: PauseDeps) {
  const back = (agent: string | null) => new Response(null, { status: 303, headers: { location: agent ? pauseNext(agent) : '/dashboard', 'cache-control': 'no-store' } });
  return {
    /** The button is a POST; a GET here (a scanner, a typed address) only goes back to the confirmation page. */
    async GET(req: Request): Promise<Response> {
      return back(pauseAgent(new URL(req.url).searchParams.get('agent') ?? undefined));
    },

    async POST(req: Request): Promise<Response> {
      if (!fromThisOrigin(req)) return page('That did not come from this page', 'Nothing was changed. Open the link from your email and press the button there.', toAgent, 403);
      let form: URLSearchParams;
      try {
        form = new URLSearchParams(await req.text());
      } catch {
        return page('This link is not right', 'Open the pause link from your agent email again.', toAgent, 400);
      }
      const agent = form.getAll('agent').length === 1 ? pauseAgent(form.get('agent') ?? undefined) : null;
      if (!agent) return page('This link is not right', 'Open the pause link from your agent email again.', toAgent, 400);
      // Signed out: no call at all. The confirmation page is where sign-in happens.
      if (!(await d.token())) return back(agent);
      const out = await d.setPaused(agent, true);
      if (out.ok) return page('Paused', 'Your agent has stopped. You can turn it back on from your agent page whenever you like.', toAgent);
      if (out.status === 401) return back(agent);
      if (out.status === 404 || out.status === 403) return page('Nothing was paused', 'This agent is not on the account you are signed in with. Sign in with the email you made it with and try again.', toAgent, 404);
      return page('Could not pause just now', 'Nothing was changed. Try again in a moment.', again(agent), 503);
    },
  };
}
