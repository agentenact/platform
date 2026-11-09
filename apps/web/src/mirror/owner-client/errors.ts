// GENERATED, do not edit; source apps/api/src/owner-client
/**
 * Two kinds of "no" from the gate. A refusal is final: a policy check failed or the owner declined,
 * and the caller rejects the request. A retryable error means the gate could not find out (RPC down,
 * the browser's RPC lagging behind the api): the request must stay pending so the same pass can run
 * again, because rejecting it would rotate the agent key and cost a new registration.
 * No `class`: a plain Error carrying a flag.
 */
export type RetryableError = Error & { retryable: true };

export function retryableError(reason: string): RetryableError {
  return Object.assign(new Error(`unavailable: ${reason}`), { retryable: true as const });
}

export function isRetryable(e: unknown): e is RetryableError {
  return e instanceof Error && (e as { retryable?: unknown }).retryable === true;
}

/**
 * The owner closed the passkey prompt (or it timed out). Nothing was signed and nothing is wrong, so the request
 * stays pending: rejecting it would rotate the agent's key and cost a new registration. Also what the web panel's
 * own "Not now" throws from its confirm.
 */
export type CancelledError = Error & { retryable: true; cancelled: true };

export function cancelledError(reason: string): CancelledError {
  return Object.assign(new Error(`cancelled: ${reason}`), { retryable: true as const, cancelled: true as const });
}

export function isCancelled(e: unknown): e is CancelledError {
  return e instanceof Error && (e as { cancelled?: unknown }).cancelled === true;
}

/**
 * A WebAuthn cancel or timeout. The browser throws a DOMException named NotAllowedError; @simplewebauthn wraps it in
 * an error that keeps that name (and the DOMException as `cause`). Matched by name only, never by message text.
 */
export function isPasskeyCancel(e: unknown): boolean {
  const name = (x: unknown) => (typeof x === 'object' && x !== null ? (x as { name?: unknown }).name : undefined);
  const cause = typeof e === 'object' && e !== null ? (e as { cause?: unknown }).cause : undefined;
  return name(e) === 'NotAllowedError' || name(cause) === 'NotAllowedError' || name(e) === 'AbortError' || name(cause) === 'AbortError';
}
