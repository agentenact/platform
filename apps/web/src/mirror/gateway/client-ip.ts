// GENERATED, do not edit; source apps/api/src/gateway/client-ip.ts
/**
 * The client address for rate limits. Pure: no I/O.
 *
 * Path: visitor → Cloudflare → servel's Traefik → us. Traefik trusts no forwarded headers (no `forwardedHeaders`
 * in its config, verified 2026-10-06), so it replaces X-Forwarded-For with the TCP peer it saw: the LAST entry is
 * the one a client cannot forge. Through Cloudflare that peer is a Cloudflare edge, shared by many visitors, so
 * CF-Connecting-IP (the visitor) is used, but only when the peer really is a Cloudflare edge: the origin is
 * reachable directly, where CF-Connecting-IP is just a client header.
 */
import { BlockList, isIP } from 'node:net';

/** https://www.cloudflare.com/ips-v4 and /ips-v6, fetched 2026-10-06. */
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];

const cloudflare = new BlockList();
for (const c of CLOUDFLARE_V4) {
  const [net, bits] = c.split('/') as [string, string];
  cloudflare.addSubnet(net, Number(bits), 'ipv4');
}
for (const c of CLOUDFLARE_V6) {
  const [net, bits] = c.split('/') as [string, string];
  cloudflare.addSubnet(net, Number(bits), 'ipv6');
}

const isCloudflare = (ip: string): boolean => {
  const v = isIP(ip);
  return v !== 0 && cloudflare.check(ip, v === 4 ? 'ipv4' : 'ipv6');
};

/** `socket` is the server's view of the TCP peer, used only when no proxy header is present. */
export function clientIp(req: Request, socket: string | undefined): string | undefined {
  const peer = req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (!peer) return socket || undefined;
  if (isCloudflare(peer)) {
    const visitor = req.headers.get('cf-connecting-ip')?.trim();
    if (visitor && isIP(visitor) !== 0) return visitor;
  }
  return peer;
}
