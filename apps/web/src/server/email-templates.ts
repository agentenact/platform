/**
 * Branded sign-in emails for GoTrue (pinned supabase/gotrue v2.186.0). GoTrue fetches these pages over HTTP
 * (GOTRUE_MAILER_TEMPLATES_MAGIC_LINK / _CONFIRMATION) and fills the {{ }} variables itself.
 *   {{ .RedirectTo }} the emailRedirectTo we passed (".../auth/confirm?next=..."), so it already holds a "?"
 *   {{ .TokenHash }}  the single-use hash /auth/confirm verifies
 * type=email is the one verifyOtp type that accepts both a returning user's link and a first-time user's confirmation.
 * Inline styles only, no script, no external stylesheet; the only host in any URL is the app host.
 */
import { PUBLIC } from '@/lib/public-config';

export const MAGIC_LINK_SUBJECT = 'Your link to AgentEnact';
export const CONFIRM_SIGNUP_SUBJECT = 'Confirm your email for AgentEnact';

interface Mail {
  title: string;
  lead: string;
  button: string;
  note: string;
}

const MAGIC_LINK: Mail = {
  title: 'Sign in to AgentEnact',
  lead: 'Tap the button and you are signed in, on any device. If you were working on a draft, it opens where you left it.',
  button: 'Sign in',
  note: 'The link works once and expires soon. If you did not ask for it, you can ignore this email. Testnet, free.',
};

const CONFIRM_SIGNUP: Mail = {
  title: 'Welcome to AgentEnact',
  lead: 'One tap confirms your email and signs you in, on any device. If you were working on a draft, it opens where you left it.',
  button: 'Confirm my email',
  note: 'The link works once and expires soon. If you did not ask for it, you can ignore this email. Testnet, free.',
};

const HREF = '{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email';
// The site's Night palette (globals.css): ground, text, text-3, wax and the text that sits on wax.
const GROUND = '#0b0a09';
const TEXT = '#f3efe8';
const MUTED = '#8a847a';
const WAX = '#ff5a36';
const ON_WAX = '#0b0a09';

function render(m: Mail): string {
  // PNG, not SVG: Gmail and Outlook do not render SVG images.
  const seal = `${PUBLIC.appOrigin}/brand/seal-night-96.png`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${m.title}</title></head>
<body style="margin:0;padding:0;background:${GROUND};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${GROUND};"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">
<tr><td style="padding-bottom:24px;"><img src="${seal}" width="56" height="56" alt="AgentEnact" style="display:block;border:0;"></td></tr>
<tr><td style="font-size:24px;line-height:30px;font-weight:700;padding-bottom:12px;">${m.title}</td></tr>
<tr><td style="font-size:16px;line-height:24px;padding-bottom:28px;">${m.lead}</td></tr>
<tr><td style="padding-bottom:28px;"><a href="${HREF}" style="display:inline-block;background:${WAX};color:${ON_WAX};text-decoration:none;font-size:16px;font-weight:600;line-height:20px;padding:14px 28px;border-radius:999px;">${m.button}</a></td></tr>
<tr><td style="font-size:13px;line-height:20px;color:${MUTED};">${m.note}</td></tr>
</table></td></tr></table>
</body></html>`;
}

export const magicLinkHtml = (): string => render(MAGIC_LINK);
export const confirmSignupHtml = (): string => render(CONFIRM_SIGNUP);

export function htmlResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
