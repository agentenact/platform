import type { AnchorHTMLAttributes } from 'react';
import { PageLink } from '@/components/page-link';
import { isOwnShellPath } from '@/lib/own-shell';

/**
 * Whether a link is a page of this app that the router can open in place (prefetched, no reload, the header stays). Not:
 * other origins, the api's /a/ paths (proxied, paid calls), downloads and static files, route handlers, sections with
 * their own shell (lib/own-shell.ts), and /draft, which is always entered with a full load (its Referrer-Policy: no-referrer and no-store headers
 * protect a claim secret in its query, and only a document load applies them).
 */
export function isAppPath(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  const path = href.split(/[?#]/, 1)[0]!;
  if (/^\/(a|api|auth|email|draft|verifier|proofs|brand|_next)(\/|$)/.test(path) || isOwnShellPath(path)) return false;
  return !/\.[a-z0-9]+$/i.test(path);
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { href: string; prefetch?: boolean | null };

/** A link that is client-side for this app's pages (`next/link`, with the page crossfade) and a plain anchor for everything else. */
export function AppLink({ href, prefetch, ...rest }: Props) {
  if (!isAppPath(href) || rest.target === '_blank' || rest.download !== undefined) return <a href={href} {...rest} />;
  return <PageLink href={href} {...(prefetch === undefined ? {} : { prefetch })} {...rest} />;
}
