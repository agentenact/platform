/**
 * Fixed-window counters. In production every replica shares them in Postgres (app.rate_windows, migration 0027):
 * main.ts calls setRateLimitStore before any unit is built, and every limiter built after that with a `name` counts
 * there, one upsert per hit. Without a store, or with an injected clock (tests), a limiter counts in memory.
 *
 * Memory: bounded. The Map keeps insertion order, and an entry is (re)inserted only when its window starts, so the
 * first key always has the oldest window. Each hit drops at most PRUNE_PER_HIT expired keys from the front (no full
 * scan), and at `maxKeys` the oldest key is evicted. A restart resets the windows, which only lets a little more through.
 */
import type { Db } from '../db/index.js';

export interface RateLimiter {
  /** Counts one hit for `key`. Resolves to 0 if allowed, else the seconds until the window resets. */
  hit(key: string): number | Promise<number>;
  size(): number;
}

const PRUNE_PER_HIT = 4;
export const DEFAULT_MAX_KEYS = 50_000;

let store: Db | null = null;
/** Shares every named limiter built from now on through Postgres. null goes back to memory (tests). */
export function setRateLimitStore(sql: Db | null): void {
  store = sql;
}

export interface RateLimitOptions {
  /** Unique per limiter: the key prefix in the shared table. Required once a store is set. */
  name?: string;
  limit: number;
  windowMs: number;
  now?: () => number;
  maxKeys?: number;
}

export function createRateLimiter(o: RateLimitOptions): RateLimiter {
  if (store && !o.now) {
    if (!o.name) throw new Error('rate-limit: a shared limiter needs a name');
    return createDbRateLimiter(store, { name: o.name, limit: o.limit, windowMs: o.windowMs });
  }
  return createMemoryRateLimiter(o);
}

/**
 * One statement per hit: a window that has run out restarts at 1, otherwise the count goes up. The hit that finds the
 * window full still counts (harmless: the answer is already "wait"). Old rows are dropped by `pruneRateWindows`.
 */
export function createDbRateLimiter(sql: Db, o: { name: string; limit: number; windowMs: number }): RateLimiter {
  const secs = o.windowMs / 1000;
  return {
    async hit(key) {
      const k = `${o.name}:${key}`.slice(0, 300);
      const [r] = (await sql`insert into app.rate_windows as w (key, started, count) values (${k}, now(), 1)
                             on conflict (key) do update set
                               started = case when w.started <= now() - make_interval(secs => ${secs}) then now() else w.started end,
                               count = case when w.started <= now() - make_interval(secs => ${secs}) then 1 else w.count + 1 end
                             returning count, extract(epoch from (w.started + make_interval(secs => ${secs}) - now()))::float8 as left_s`) as { count: number; left_s: number }[];
      if (r!.count <= o.limit) return 0;
      return Math.max(1, Math.ceil(r!.left_s));
    },
    size: () => 0,
  };
}

/** Drops windows older than the longest limiter window (a day). The leader runs it. */
export async function pruneRateWindows(sql: Db, olderThanMs = 86_400_000): Promise<number> {
  const rows = (await sql`delete from app.rate_windows where started < now() - make_interval(secs => ${olderThanMs / 1000}) returning key`) as unknown[];
  return rows.length;
}

export function createMemoryRateLimiter(o: RateLimitOptions): RateLimiter {
  const now = o.now ?? Date.now;
  const maxKeys = o.maxKeys ?? DEFAULT_MAX_KEYS;
  const windows = new Map<string, { start: number; count: number }>();
  const oldest = () => windows.keys().next().value as string | undefined;
  return {
    hit(key) {
      const t = now();
      for (let i = 0; i < PRUNE_PER_HIT; i++) {
        const k = oldest();
        if (k === undefined || t - windows.get(k)!.start < o.windowMs) break;
        windows.delete(k);
      }
      let w = windows.get(key);
      if (w && t - w.start >= o.windowMs) {
        windows.delete(key);
        w = undefined;
      }
      if (!w) {
        if (windows.size >= maxKeys) windows.delete(oldest()!);
        w = { start: t, count: 0 };
        windows.set(key, w); // at the end: the newest window
      }
      if (w.count >= o.limit) return Math.max(1, Math.ceil((w.start + o.windowMs - t) / 1000));
      w.count++;
      return 0;
    },
    size: () => windows.size,
  };
}

/**
 * The rate-limit key for a client address. IPv4 (and IPv4-mapped IPv6) is the address; IPv6 is its
 * /64, since one client usually holds a whole /64 and could otherwise rotate addresses freely.
 */
export function ipKey(raw: string): string {
  const ip = raw.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!ip.includes(':')) return ip;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const parts = (s: string | undefined) => (s ? s.split(':') : []);
  // A dotted IPv4 tail occupies two groups.
  const groups = (s: string | undefined) => parts(s).flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const h = groups(head);
  const t = groups(tail);
  const full = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  const prefix = full.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}
