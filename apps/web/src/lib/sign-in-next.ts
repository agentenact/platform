/**
 * Where the magic link lands after sign-in (the `next` of /auth/confirm). A parked draft wins: its single-use id rides
 * along. Else a waiting handoff id, else the prompt (D16: a prompt is not personal data, so it may travel in the link and
 * /draft drafts it again), else plain /draft. `intent: 'create'` (sign-in started from "Create this agent") rides only
 * on a `/draft?h=<id>` result, so /draft opens straight into creating; nothing else can add a parameter.
 */
export function nextFor(i: { parkedId?: string | undefined; handoff?: string | undefined; prompt?: string | undefined; intent?: 'create' | undefined }): string {
  const tail = i.intent === 'create' ? '&intent=create' : '';
  if (i.parkedId) return `/draft?h=${encodeURIComponent(i.parkedId)}${tail}`;
  if (i.handoff) return `/draft?h=${encodeURIComponent(i.handoff)}${tail}`;
  const p = i.prompt?.trim();
  if (p) return `/draft?prompt=${encodeURIComponent(p)}`;
  return '/draft';
}

/**
 * Which message a failed signInWithOtp shows. GoTrue answers 429 when the same address asks again too soon or the mail
 * limit is spent; saying so tells the person to wait instead of pressing again. A 504 (GoTrue gives up after 10 s) means
 * nothing was sent, so pressing again is right. Any other 5xx, a Cloudflare 52x, or no answer at all (status 0: the
 * request never got through) is the sign-in service failing, most often GoTrue failing to reach its database
 * (2026-11-04: SASL/dial/DNS timeouts to `db`, answered as 500 unexpected_failure): `busy`, which the card retries once
 * on its own before saying so. Only what is left (a 4xx we do not know) stays generic.
 */
export type SignInFailure = 'tooSoon' | 'slow' | 'busy' | 'generic';

export function signInFailure(err: { status?: number | undefined; code?: string | undefined; name?: string | undefined }): SignInFailure {
  if (err.status === 429 || err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit') return 'tooSoon';
  if (err.status === 504 || err.code === 'request_timeout') return 'slow';
  const s = err.status;
  if ((typeof s === 'number' && (s === 0 || s >= 500)) || err.name === 'AuthRetryableFetchError' || err.code === 'unexpected_failure') return 'busy';
  return 'generic';
}

/** Whether a failure is worth one quiet automatic retry: only a fast service failure, never a 504 (it already took 10 s) or a 429. */
export const retryOnce = (why: SignInFailure): boolean => why === 'busy';
