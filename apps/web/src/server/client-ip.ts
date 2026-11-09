/**
 * The visitor's address, from the headers of the request that reached this panel server. Runs the api's own algorithm
 * (vendored byte for byte, see scripts/sync-owner-client.ts): the last X-Forwarded-For entry is the peer our proxy saw;
 * CF-Connecting-IP counts only when that peer is a Cloudflare edge. There is no socket here, so no header means no address.
 */
import { clientIp } from '@/mirror/gateway/client-ip';

export function visitorIp(headers: Headers): string | undefined {
  return clientIp(new Request('http://panel.invalid/', { headers }), undefined);
}
