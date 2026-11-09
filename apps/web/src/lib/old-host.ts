import { legacyAgentPath } from './legacy-agent-path';

/** The panel's address before the merge. Every page there now lives at the same path on agentenact.io. */
export const OLD_HOST = 'app.agentenact.io';

/**
 * Where a request to the old host goes: the same path and query on this deployment's origin, with the old /agent paths
 * mapped in the same hop (legacyAgentPath). Null when the request is not for the old host, or when the old host is still
 * this deployment's own origin (before the cutover APP_ORIGIN is https://app.agentenact.io, and redirecting would loop).
 * Changing APP_ORIGIN to https://agentenact.io (with both domains on the deployment) is what turns it on.
 */
export function oldHostRedirect(host: string | null, path: string, search: string, origin: string): string | null {
  if ((host ?? '').toLowerCase().replace(/:\d+$/, '') !== OLD_HOST) return null;
  if (new URL(origin).host === OLD_HOST) return null;
  return new URL(legacyAgentPath(`${path}${search}`), origin).toString();
}
