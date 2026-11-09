/** An error the gateway turns into `status` + `{ error: code }`. The code is a fixed word, never user data. */
export type HttpError = Error & { status: number; code: string };

export const httpError = (status: number, code: string): HttpError => Object.assign(new Error(code), { status, code });

export const isHttpError = (e: unknown): e is HttpError =>
  e instanceof Error && typeof (e as HttpError).status === 'number' && typeof (e as HttpError).code === 'string';

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** Fixed codes libraries and the runtime set: Node/Bun socket errors, the Bun SQL driver's `ERR_POSTGRES_*`, postgres.js connection codes. */
const LIBRARY_CODE = /^(?:E[A-Z]{3,12}|ERR_[A-Z0-9_]{2,48}|CONNECTION_[A-Z_]{3,20}|CONNECT_TIMEOUT)$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/**
 * What may be logged about a caught error: its class name and a code that passes a pattern check (a Postgres SQLSTATE such as
 * `23505` or `57014`, or a fixed library code such as `ECONNRESET`). NEVER the message, stack, `cause`, `partial` or any other
 * property: those can carry keys, secrets and user data (createStellarAgent's `partial.secret` is the agent key). Spread it into
 * a log event. Not for the createStellarAgent catch, which has its own fixed failure codes.
 */
export function safeCause(e: unknown): { errName: string; errCode?: string } {
  const o = typeof e === 'object' && e !== null ? (e as { name?: unknown; errno?: unknown; code?: unknown }) : {};
  const errName = typeof o.name === 'string' && NAME.test(o.name) ? o.name : 'unknown';
  for (const c of [o.errno, o.code]) if (typeof c === 'string' && (SQLSTATE.test(c) || LIBRARY_CODE.test(c))) return { errName, errCode: c };
  return { errName };
}
