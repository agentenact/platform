import { describe, expect, it } from 'bun:test';
import { clientIp } from '../src/gateway/client-ip.js';

const req = (h: Record<string, string>) => new Request('https://api.agentenact.io/health', { headers: h });

describe('clientIp', () => {
  it('through Cloudflare (proxy peer is a Cloudflare edge): the visitor from CF-Connecting-IP', () => {
    expect(clientIp(req({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': '203.0.113.7' }), undefined)).toBe('203.0.113.7');
    expect(clientIp(req({ 'x-forwarded-for': '2606:4700::6810:1', 'cf-connecting-ip': '2001:db8::7' }), undefined)).toBe('2001:db8::7');
  });

  it('bypassing Cloudflare: a forged CF-Connecting-IP is ignored, the proxy-seen peer is used', () => {
    expect(clientIp(req({ 'x-forwarded-for': '198.51.100.9', 'cf-connecting-ip': '203.0.113.7' }), undefined)).toBe('198.51.100.9');
  });

  it('only the last X-Forwarded-For entry counts (earlier ones are client-supplied)', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 198.51.100.9' }), undefined)).toBe('198.51.100.9');
    expect(clientIp(req({ 'x-forwarded-for': '162.158.10.1, 198.51.100.9', 'cf-connecting-ip': '203.0.113.7' }), undefined)).toBe('198.51.100.9');
  });

  it('a Cloudflare peer with a missing or malformed CF-Connecting-IP falls back to the peer', () => {
    expect(clientIp(req({ 'x-forwarded-for': '162.158.10.1' }), undefined)).toBe('162.158.10.1');
    expect(clientIp(req({ 'x-forwarded-for': '162.158.10.1', 'cf-connecting-ip': 'not-an-ip' }), undefined)).toBe('162.158.10.1');
  });

  it('no proxy header: the socket address', () => {
    expect(clientIp(req({}), '10.0.1.5')).toBe('10.0.1.5');
    expect(clientIp(req({}), undefined)).toBeUndefined();
  });
});
