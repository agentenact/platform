import { describe, expect, it } from 'bun:test';
import { createRateLimiter, ipKey } from '../src/gateway/rate-limit.js';

describe('rate limiter', () => {
  it('allows `limit` hits per key per window, reports seconds left, and resets with the window', () => {
    let t = 1_000_000;
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t });
    expect([rl.hit('a'), rl.hit('a'), rl.hit('b')]).toEqual([0, 0, 0]);
    t += 15_000;
    expect(rl.hit('a')).toBe(45);
    t += 44_999;
    expect(rl.hit('a')).toBe(1);
    t += 1;
    expect([rl.hit('a'), rl.hit('a'), rl.hit('a')]).toEqual([0, 0, 60]);
  });

  it('a hard cap: at maxKeys the oldest key is evicted, never a full reset', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0, maxKeys: 3 });
    for (const k of ['a', 'b', 'c']) rl.hit(k);
    expect(rl.size()).toBe(3);
    expect(rl.hit('d')).toBe(0); // evicts 'a', the oldest
    expect(rl.size()).toBe(3);
    expect([rl.hit('b'), rl.hit('c'), rl.hit('d')]).toEqual([60, 60, 60]); // still limited: not evicted
    expect(rl.hit('a')).toBe(0); // 'a' was forgotten (and now evicts 'b')
    expect(rl.size()).toBe(3);
  });

  it('pruning is incremental: one hit removes a bounded number of expired keys, not all of them', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    for (let i = 0; i < 5_000; i++) rl.hit(`k${i}`);
    t = 2_000; // every window is over
    rl.hit('fresh');
    const afterOne = rl.size();
    expect(afterOne).toBeGreaterThan(5_000 - 10); // no full scan on the hit path
    for (let i = 0; i < 5_000; i++) rl.hit('fresh'); // later hits keep draining the expired ones
    expect(rl.size()).toBe(1);
  });
});

describe('ipKey', () => {
  it('keys IPv4 by address and IPv6 by its /64 prefix, in any spelling', () => {
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    const k = ipKey('2001:db8:1:2::1');
    expect(k).toBe('2001:db8:1:2::/64');
    for (const same of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:0DB8:0001:0002:0:0:0:abcd', '2001:db8:1:2::abcd%eth0', '[2001:db8:1:2::9]']) {
      expect(ipKey(same)).toBe(k);
    }
    expect(ipKey('2001:db8:1:3::1')).not.toBe(k);
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::ffff:203.0.113.9')).toBe('203.0.113.9'); // IPv4-mapped is the IPv4 address
    expect(ipKey('fe80::')).toBe('fe80:0:0:0::/64');
  });
});
