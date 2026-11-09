import path from 'node:path';
import type { NextConfig } from 'next';
import { LEGACY_AGENT_REDIRECTS } from './src/lib/legacy-agent-path';
import { PUBLIC } from './src/lib/public-config';

/** How long a proxied /a/ call may take; see rewrites() below. */
export const A_PROXY_TIMEOUT_MS = 120_000;

const nextConfig: NextConfig = {
  output: 'standalone',
  // /agent moved: the public profile is /agents/<id>, the owner's area /dashboard. See src/lib/legacy-agent-path.ts.
  async redirects() {
    return [
      ...LEGACY_AGENT_REDIRECTS,
      // The site's old developer page; its in-browser flow lives on /create now.
      { source: '/developers', destination: '/create#own-wallet', permanent: true },
    ];
  },
  // On-chain agentURIs and paid x402 calls live under https://agentenact.io/a/ and must never move: they are the api's.
  // A paid call can run ~73 s AFTER the buyer has paid, so the proxy waits 120 s (Next's default is 30 s; cutting it
  // loses an output that was already paid for). Headers and status pass through untouched.
  async rewrites() {
    return { beforeFiles: [{ source: '/a/:path*', destination: `${PUBLIC.apiUrl}/a/:path*` }] };
  },
  experimental: {
    proxyTimeout: A_PROXY_TIMEOUT_MS,
  },
  async headers() {
    return [
      // /draft?h=<id> carries a single-use claim secret: keep it out of Referer headers and caches.
      { source: '/draft', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }, { key: 'Cache-Control', value: 'no-store' }] },
      // Documents shared by link only (public/docs/): kept out of search engines, and cached briefly because a file is updated in place.
      {
        source: '/docs/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Cache-Control', value: 'public, max-age=300' },
        ],
      },
    ];
  },
  // The repo has other lockfiles; pin the root so Next does not infer the wrong one.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
