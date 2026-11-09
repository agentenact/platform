/**
 * The visitor address behind the panel server. The web panel calls this api from its own server on behalf of a
 * visitor, so the socket address is the panel's, shared by everyone. The panel forwards the visitor's address in
 * `x-client-ip` and proves it is the panel with `x-panel-secret`; without that proof the header is only a client
 * header and is ignored. This file is the only reader of PANEL_SECRET (optional: unset means the header is never trusted).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const readPanelSecret = (env: Record<string, string | undefined> = process.env): string | undefined => env.PANEL_SECRET || undefined;

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * `ownIp` is the Cloudflare-aware address (or the socket's) the caller resolved with clientIp(). Returns the panel's
 * forwarded visitor address when the secret matches and the address is a real IP, otherwise `ownIp`.
 */
export function resolveClientIp(req: Request, ownIp: string | undefined, panelSecret: string | undefined): string | undefined {
  if (!panelSecret) return ownIp;
  const given = req.headers.get('x-panel-secret');
  // Hashing first makes the compare constant-time whatever the lengths are.
  if (given === null || !timingSafeEqual(digest(given), digest(panelSecret))) return ownIp;
  const forwarded = req.headers.get('x-client-ip')?.trim();
  return forwarded && isIP(forwarded) !== 0 ? forwarded : ownIp;
}
