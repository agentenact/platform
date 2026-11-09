import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import nextConfig from '../next.config';

const app = join(import.meta.dir, '../src/app');

describe('site routes in the app', () => {
  test('/developers is a permanent redirect to the in-browser flow on /create', async () => {
    const list = await nextConfig.redirects!();
    expect(list).toContainEqual({ source: '/developers', destination: '/create#own-wallet', permanent: true });
  });
  test('/, /explore, /verify, /create and /agents/[id] are pages; the owner area is /dashboard', () => {
    for (const p of ['(site)/page.tsx', '(site)/explore/page.tsx', '(site)/market/page.tsx', '(site)/verify/page.tsx', '(site)/create/page.tsx', '(site)/agents/[id]/page.tsx', 'dashboard/(list)/page.tsx']) expect([p, existsSync(join(app, p))]).toEqual([p, true]);
  });
});

describe('/a/ stays the api\'s', () => {
  test('every /a/ path is proxied to the api before any page, with a 120 s budget', async () => {
    const { A_PROXY_TIMEOUT_MS } = await import('../next.config');
    const r = await nextConfig.rewrites!();
    expect(Array.isArray(r) ? r : r.beforeFiles).toEqual([{ source: '/a/:path*', destination: 'https://api.agentenact.io/a/:path*' }]);
    expect(A_PROXY_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
    expect(nextConfig.experimental?.proxyTimeout).toBe(A_PROXY_TIMEOUT_MS);
  });
  test('the session proxy never runs on /a/', async () => {
    const { config } = await import('../src/proxy');
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test('/a/0b1c/agent.json')).toBe(false);
    expect(re.test('/agents/13')).toBe(true);
    expect(re.test('/dashboard')).toBe(true);
  });
});

describe('/docs/ is shared by link only', () => {
  test('documents are never indexed and the session proxy skips them', async () => {
    const h = await nextConfig.headers!();
    const docs = h.find((x) => x.source === '/docs/:path*');
    expect(docs?.headers).toContainEqual({ key: 'X-Robots-Tag', value: 'noindex, nofollow' });
    const { config } = await import('../src/proxy');
    const re = new RegExp(`^${config.matcher[0]}$`);
    expect(re.test('/docs/guide.pdf')).toBe(false);
  });
});
