import { describe, expect, it } from 'bun:test';
import { createApp } from '../src/gateway/app.js';
import { clientIp } from '../src/gateway/client-ip.js';
import { PAID_PER_IP_PER_MIN } from '../src/gateway/app.js';
import { readPanelSecret, resolveClientIp } from '../src/gateway/panel.js';

const SECRET = 'panel-secret-for-tests';
const req = (h: Record<string, string>) => new Request('https://api.agentenact.io/health', { headers: h });

describe('resolveClientIp', () => {
  it('a matching secret makes x-client-ip the address', () => {
    expect(resolveClientIp(req({ 'x-panel-secret': SECRET, 'x-client-ip': '203.0.113.7' }), '10.0.0.5', SECRET)).toBe('203.0.113.7');
    expect(resolveClientIp(req({ 'x-panel-secret': SECRET, 'x-client-ip': '2001:db8::7' }), '10.0.0.5', SECRET)).toBe('2001:db8::7');
  });

  it('a wrong secret ignores the header and uses the socket address', () => {
    expect(resolveClientIp(req({ 'x-panel-secret': 'nope', 'x-client-ip': '203.0.113.7' }), '10.0.0.5', SECRET)).toBe('10.0.0.5');
    expect(resolveClientIp(req({ 'x-panel-secret': `${SECRET}x`, 'x-client-ip': '203.0.113.7' }), '10.0.0.5', SECRET)).toBe('10.0.0.5');
    expect(resolveClientIp(req({ 'x-client-ip': '203.0.113.7' }), '10.0.0.5', SECRET)).toBe('10.0.0.5');
  });

  it('no secret configured ignores the header, even an empty one sent by the caller', () => {
    expect(resolveClientIp(req({ 'x-panel-secret': SECRET, 'x-client-ip': '203.0.113.7' }), '10.0.0.5', undefined)).toBe('10.0.0.5');
    expect(resolveClientIp(req({ 'x-panel-secret': '', 'x-client-ip': '203.0.113.7' }), '10.0.0.5', undefined)).toBe('10.0.0.5');
    expect(resolveClientIp(req({ 'x-panel-secret': '', 'x-client-ip': '203.0.113.7' }), '10.0.0.5', '')).toBe('10.0.0.5');
  });

  it('an invalid IP in the header is ignored', () => {
    for (const bad of ['', 'not-an-ip', '203.0.113.7, 1.1.1.1', '999.1.1.1', '203.0.113.7:80'])
      expect(resolveClientIp(req({ 'x-panel-secret': SECRET, 'x-client-ip': bad }), '10.0.0.5', SECRET)).toBe('10.0.0.5');
  });

  it('with no socket address and no trusted header there is no address', () => {
    expect(resolveClientIp(req({}), undefined, SECRET)).toBeUndefined();
  });

  it('the order is panel header, then Cloudflare-aware address, then socket', () => {
    const cf = req({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': '203.0.113.9' });
    const own = clientIp(cf, '10.0.0.5');
    expect(own).toBe('203.0.113.9');
    expect(resolveClientIp(cf, own, SECRET)).toBe('203.0.113.9');
    const both = req({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': '203.0.113.9', 'x-panel-secret': SECRET, 'x-client-ip': '198.51.100.4' });
    expect(resolveClientIp(both, clientIp(both, '10.0.0.5'), SECRET)).toBe('198.51.100.4');
  });
});

describe('readPanelSecret (the one reader of PANEL_SECRET)', () => {
  it('is optional: unset or empty is undefined', () => {
    expect(readPanelSecret({})).toBeUndefined();
    expect(readPanelSecret({ PANEL_SECRET: '' })).toBeUndefined();
    expect(readPanelSecret({ PANEL_SECRET: SECRET })).toBe(SECRET);
  });
});

describe('the trusted address reaches the gateway limits', () => {
  const app = createApp({
    sql: {} as never,
    verify: async () => null,
    passkey: {} as never,
    signRequests: {} as never,
    provisioner: {} as never,
    appOrigin: 'https://app.agentenact.io',
  });
  // main.ts does exactly this for every request.
  const handle = (headers: Record<string, string>, socket = '10.0.0.5') => {
    const r = new Request('https://api.agentenact.io/a/00000000-0000-4000-8000-000000000000/svc', { method: 'POST', headers });
    return app(r, resolveClientIp(r, clientIp(r, socket), SECRET));
  };
  const visitor = (ip: string) => ({ 'x-panel-secret': SECRET, 'x-client-ip': ip });

  it('two visitors forwarded by the same panel server get separate buckets', async () => {
    for (let i = 0; i < PAID_PER_IP_PER_MIN; i++) expect((await handle(visitor('203.0.113.1'))).status).toBe(404);
    expect((await handle(visitor('203.0.113.1'))).status).toBe(429); // visitor A is out
    expect((await handle(visitor('203.0.113.2'))).status).toBe(404); // visitor B is not
  });

  it("the panel's own address is never used as the key when the header is trusted", async () => {
    // The socket peer is the panel server for everyone. Exhausting visitor C must not touch a plain caller from that socket.
    for (let i = 0; i < PAID_PER_IP_PER_MIN + 1; i++) await handle(visitor('203.0.113.3'));
    expect((await handle({}, '10.0.0.5')).status).toBe(404); // the socket's own bucket is untouched
    expect((await handle(visitor('203.0.113.3'))).status).toBe(429);
  });

  it('a forged header without the secret is not trusted: it cannot pick a fresh bucket', async () => {
    for (let i = 0; i < PAID_PER_IP_PER_MIN; i++) await handle({}, '10.0.0.77');
    expect((await handle({ 'x-client-ip': '203.0.113.50' }, '10.0.0.77')).status).toBe(429);
  });
});
