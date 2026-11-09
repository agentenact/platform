/**
 * The pages that never read the customer session: the public site (rendered statically, the header's account is a client
 * island) and the agent profile shell. A GET or HEAD of one needs no session refresh in the proxy, so it is answered without
 * a round trip to the auth server; a POST to one (a server action, e.g. sign out from that page) still gets the refresh.
 */
const EXACT = new Set(['/', '/explore', '/market', '/verify', '/create']);

export function isSessionFreeRequest(method: string, pathname: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  return EXACT.has(pathname) || /^\/agents\/[^/]+$/.test(pathname);
}
