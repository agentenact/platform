/**
 * Public discovery routes (`/public/*`): read-only, no auth, ACAO *. Answers carry chain facts and
 * self-published text under its own key (see discovery/queries.ts). Also the record intake (POST) and one record by ref.
 */
import { EXPORT_NAMES, type ExportName } from '../discovery/export.js';
import { REPORT_REASONS, type CommunityIndex, type ReportReason } from '../discovery/community.js';
import type { Intake } from '../discovery/intake.js';
import { AGENT_SORTS, type AgentSort, type Discovery } from '../discovery/queries.js';
import type { Route } from './app.js';
import { createRateLimiter, ipKey } from './rate-limit.js';

export interface DiscoveryRouteDeps {
  discovery: Pick<Discovery, 'stats' | 'feed' | 'agents' | 'profile'>;
  exportCsv: (name: ExportName, o: { includeExcluded: boolean }) => Promise<{ csv: string; truncated: boolean }>;
  /** Record intake for library users (task 12). */
  intake: Pick<Intake, 'submit' | 'record'>;
  /** A sent seal's transaction from its signature (/verify). Absent: the path answers 404. */
  sealBySignature?: (signature: string) => Promise<string | null>;
  /** Community templates (push, list, read, report) and signed handle changes. Absent: those paths answer 404. */
  community?: Pick<CommunityIndex, 'submit' | 'list' | 'get' | 'report' | 'setHandle'>;
  log?: (e: Record<string, string | number>) => void;
  /** The clock for the export cache; tests inject one. */
  now?: () => number;
}

/** Reads per minute per client address. A feed tab polling every 5 s uses 12. */
export const PUBLIC_READS_PER_IP_PER_MIN = 120;
/**
 * CSV exports read up to 100k rows into memory, so they get their own small bucket (a stats read costs ~100 bytes, an
 * export megabytes), a short in-memory cache per (name, include), and a cap on builds running at once. At most
 * 4 names x 2 variants are ever cached (only payments has the second), so memory and database work are bounded
 * however many clients ask: one build per key per EXPORT_CACHE_MS, at most MAX_CONCURRENT_EXPORTS at a time.
 */
export const EXPORTS_PER_IP_PER_MIN = 6;
export const EXPORT_CACHE_MS = 30_000;
export const MAX_CONCURRENT_EXPORTS = 2;
export const MAX_Q = 64;
/** Record submissions per client address per hour, counted before the body is read. The global budget lives in the intake. */
export const SUBMISSIONS_PER_IP_PER_HOUR = 10;
export { SUBMISSIONS_PER_HOUR } from '../discovery/intake.js';
export const MAX_RECORD_BODY = 8 * 1024;
/** Template pushes per client address per hour, and reports per client address per hour. */
export const TEMPLATE_PUSHES_PER_IP_PER_HOUR = 10;
export const TEMPLATE_REPORTS_PER_IP_PER_HOUR = 20;
export const HANDLE_CHANGES_PER_IP_PER_HOUR = 10;
/** A template document is at most 32 KiB canonical; the signature and whitespace get the rest. */
export const MAX_TEMPLATE_BODY = 40 * 1024;

/** Every `/public/` answer, errors and preflights included. */
export const DISCOVERY_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'retry-after, x-truncated',
};

const num = (v: string | null): number | undefined => (v === null || v === '' ? undefined : Number(v));

export function discoveryRoutes(d: DiscoveryRouteDeps): Route[] {
  const reads = createRateLimiter({ name: 'discovery.reads', limit: PUBLIC_READS_PER_IP_PER_MIN, windowMs: 60_000 });
  const res = (status: number, body: string | null, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...DISCOVERY_HEADERS, ...extra } });
  const json = (status: number, body: unknown, cache?: string) =>
    res(status, JSON.stringify(body), { 'content-type': 'application/json', ...(cache ? { 'cache-control': cache } : {}) });

  /** Limit by client address, then run; a throw gives a plain 500 and a fixed log line (never the error). */
  const guarded = (path: string, run: (req: Request, m: RegExpExecArray) => Promise<Response>) => async (req: Request, m: RegExpExecArray, ip: string | undefined) => {
    const wait = await reads.hit(ip ? ipKey(ip) : 'unknown'); // no address: one shared bucket, never exempt
    if (wait) return res(429, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(wait) });
    try {
      return await run(req, m);
    } catch {
      d.log?.({ event: 'unhandled', path });
      return json(500, { error: 'internal' });
    }
  };

  // Exports: own bucket, a cache with in-flight sharing, and a cap on distinct builds running at once.
  const exportsByIp = createRateLimiter({ name: 'discovery.exportsByIp', limit: EXPORTS_PER_IP_PER_MIN, windowMs: 60_000 });
  const clock = d.now ?? Date.now;
  type Built = { csv: string; truncated: boolean };
  const exportCache = new Map<string, { at: number; value: Built }>();
  const exportInflight = new Map<string, Promise<Built>>();
  /** A cached or shared build, a new one, or null when MAX_CONCURRENT_EXPORTS builds are already running. */
  function buildExport(name: ExportName, includeExcluded: boolean): Promise<Built> | Built | null {
    const key = `${name}:${includeExcluded}`;
    const hit = exportCache.get(key);
    if (hit && clock() - hit.at < EXPORT_CACHE_MS) return hit.value;
    const shared = exportInflight.get(key);
    if (shared) return shared;
    if (exportInflight.size >= MAX_CONCURRENT_EXPORTS) return null;
    const p = d
      .exportCsv(name, { includeExcluded })
      .then((value) => {
        exportCache.set(key, { at: clock(), value });
        return value;
      })
      .finally(() => exportInflight.delete(key)); // a failure is neither cached nor kept in flight
    exportInflight.set(key, p);
    return p;
  }

  const subsByIp = createRateLimiter({ name: 'discovery.subsByIp', limit: SUBMISSIONS_PER_IP_PER_HOUR, windowMs: 3_600_000 });

  /** The body as text, or null when it exceeds the cap (read incrementally, so a liar's content-length costs nothing). */
  async function cappedText(req: Request, cap = MAX_RECORD_BODY): Promise<string | null> {
    if (Number(req.headers.get('content-length') ?? '0') > cap) return null;
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const submit = async (req: Request, ip: string | undefined): Promise<Response> => {
    // Limits first: no body read, parse or chain call is spent on a client that is over them.
    const wait = await subsByIp.hit(ip ? ipKey(ip) : 'unknown');
    if (wait) return res(429, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(wait) });
    try {
      const text = await cappedText(req);
      if (text === null) return json(413, { error: 'too_large' });
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return json(400, { error: 'bad_json' });
      }
      const r = await d.intake.submit(raw);
      if (r.status !== 'refused') return json(r.status === 'accepted' ? 202 : 200, { status: r.status, digest: r.digest });
      switch (r.code) {
        case 'not_verified':
          return json(422, { error: 'not_verified', ...(r.check ? { check: r.check } : {}) });
        case 'agent_not_indexed':
          return res(409, JSON.stringify({ error: 'agent_not_indexed' }), { 'content-type': 'application/json', 'retry-after': '30' });
        case 'rate_limited':
          return res(503, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(r.retryAfter ?? 60) });
        case 'busy':
          return res(503, JSON.stringify({ error: 'busy' }), { 'content-type': 'application/json', 'retry-after': '5' });
        case 'chain_unavailable':
          return res(503, JSON.stringify({ error: 'chain_unavailable' }), { 'content-type': 'application/json', 'retry-after': '60' });
        default:
          return json(400, { error: r.code }); // malformed | no_agent_id | wrong_asset
      }
    } catch {
      d.log?.({ event: 'unhandled', path: '/public/records' });
      return json(500, { error: 'internal' });
    }
  };

  const pushesByIp = createRateLimiter({ name: 'discovery.pushesByIp', limit: TEMPLATE_PUSHES_PER_IP_PER_HOUR, windowMs: 3_600_000 });
  const reportsByIp = createRateLimiter({ name: 'discovery.reportsByIp', limit: TEMPLATE_REPORTS_PER_IP_PER_HOUR, windowMs: 3_600_000 });
  const handlesByIp = createRateLimiter({ name: 'discovery.handlesByIp', limit: HANDLE_CHANGES_PER_IP_PER_HOUR, windowMs: 3_600_000 });
  const limitedBy = async (limiter: typeof pushesByIp, ip: string | undefined): Promise<Response | null> => {
    const wait = await limiter.hit(ip ? ipKey(ip) : 'unknown');
    return wait ? res(429, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(wait) }) : null;
  };
  const readJson = async (req: Request, cap: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> => {
    const text = await cappedText(req, cap);
    if (text === null) return { ok: false, response: json(413, { error: 'too_large' }) };
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch {
      return { ok: false, response: json(400, { error: 'bad_json' }) };
    }
  };

  const communityRoutes = (c: NonNullable<DiscoveryRouteDeps['community']>): Route[] => [
    // Anyone may push a signed, anchored template. Limits first: no body read or chain call for a client over them.
    ['POST', /^\/public\/templates$/, async (req, _m, ip) => {
      const over = await limitedBy(pushesByIp, ip);
      if (over) return over;
      try {
        const body = await readJson(req, MAX_TEMPLATE_BODY);
        if (!body.ok) return body.response;
        const r = await c.submit(body.value);
        if (r.status !== 'refused') return json(r.status === 'listed' ? 201 : 200, { status: r.status, sha256: r.sha256 });
        switch (r.code) {
          case 'not_verified':
            return json(422, { error: 'not_verified', ...(r.failure ? { check: r.failure.check, reason: r.failure.reason } : {}) });
          case 'bad_draft':
            return json(422, { error: 'bad_draft', ...(r.problem ? { problem: r.problem } : {}) });
          case 'not_anchored':
            return json(422, { error: 'not_anchored' });
          case 'author_limit':
            return json(409, { error: 'author_limit' });
          case 'name_taken':
            return json(409, { error: 'name_taken' });
          case 'name_reserved':
            return json(422, { error: 'name_reserved' });
          case 'rate_limited':
            return res(503, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(r.retryAfter ?? 60) });
          case 'chain_unavailable':
            return res(503, JSON.stringify({ error: 'chain_unavailable' }), { 'content-type': 'application/json', 'retry-after': '60' });
          default:
            return json(400, { error: r.code }); // malformed | wrong_network | wrong_kind
        }
      } catch {
        d.log?.({ event: 'unhandled', path: '/public/templates' });
        return json(500, { error: 'internal' });
      }
    }],

    ['GET', /^\/public\/templates$/, guarded('/public/templates', async (req) => {
      const q = new URL(req.url).searchParams;
      const text = q.get('q') ?? undefined;
      if (text !== undefined && text.length > MAX_Q) return json(400, { error: 'bad_query' });
      const limit = num(q.get('limit'));
      return json(200, { templates: await c.list({ ...(text ? { q: text } : {}), ...(limit !== undefined ? { limit } : {}) }) }, 'public, max-age=30');
    })],

    ['GET', /^\/public\/templates\/([0-9a-f]{64})$/, guarded('/public/templates/:sha', async (_req, m) => {
      const t = await c.get(m[1]!);
      return t ? json(200, t, 'public, max-age=30') : json(404, { error: 'not_found' });
    })],

    // A signed agentenact.handle/1 change: a key renames itself (or drops its handle) without publishing a template.
    ['POST', /^\/public\/authors$/, async (req, _m, ip) => {
      const over = await limitedBy(handlesByIp, ip);
      if (over) return over;
      try {
        const body = await readJson(req, 2048);
        if (!body.ok) return body.response;
        const r = await c.setHandle(body.value);
        if (r.status === 'changed') return json(200, { status: 'changed', name: r.name });
        switch (r.code) {
          case 'name_taken':
            return json(409, { error: 'name_taken' });
          case 'not_fresh':
            return json(409, { error: 'not_fresh' });
          case 'name_reserved':
          case 'not_verified':
            return json(422, { error: r.code });
          case 'chain_unavailable':
            return res(503, JSON.stringify({ error: 'chain_unavailable' }), { 'content-type': 'application/json', 'retry-after': '60' });
          default:
            return json(400, { error: r.code }); // malformed | wrong_network
        }
      } catch {
        d.log?.({ event: 'unhandled', path: '/public/authors' });
        return json(500, { error: 'internal' });
      }
    }],

    ['POST', /^\/public\/templates\/([0-9a-f]{64})\/report$/, async (req, m, ip) => {
      const over = await limitedBy(reportsByIp, ip);
      if (over) return over;
      try {
        const body = await readJson(req, 1024);
        if (!body.ok) return body.response;
        const reason = (body.value as { reason?: unknown } | null)?.reason;
        if (typeof reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(reason)) return json(400, { error: 'bad_reason' });
        const r = await c.report(m[1]!, ip ? ipKey(ip) : 'unknown', reason as ReportReason);
        return r === 'not_found' ? json(404, { error: 'not_found' }) : json(200, { status: r });
      } catch {
        d.log?.({ event: 'unhandled', path: '/public/templates/:sha/report' });
        return json(500, { error: 'internal' });
      }
    }],
  ];

  const names = EXPORT_NAMES.join('|');
  return [
    ...(d.community ? communityRoutes(d.community) : []),
    ['GET', /^\/public\/stats$/, guarded('/public/stats', async () => json(200, await d.discovery.stats(), 'public, max-age=5'))],

    ['GET', /^\/public\/feed$/, guarded('/public/feed', async (req) => {
      const q = new URL(req.url).searchParams;
      const after = num(q.get('after'));
      const limit = num(q.get('limit'));
      return json(200, await d.discovery.feed({ ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) }), 'public, max-age=2');
    })],

    ['GET', /^\/public\/agents$/, guarded('/public/agents', async (req) => {
      const q = new URL(req.url).searchParams;
      const text = q.get('q') ?? undefined;
      if (text !== undefined && text.length > MAX_Q) return json(400, { error: 'bad_query' });
      const cursor = q.get('cursor') || undefined;
      const limit = num(q.get('limit'));
      const sort = q.get('sort') || undefined;
      if (sort !== undefined && !(AGENT_SORTS as readonly string[]).includes(sort)) return json(400, { error: 'bad_sort' });
      const built = q.get('built') || undefined;
      if (built !== undefined && built !== 'agentenact' && built !== 'external') return json(400, { error: 'bad_filter' });
      const filter = { ...(built ? { built: built as 'agentenact' | 'external' } : {}), ...(q.get('sells') === '1' ? { sells: true } : {}), ...(q.get('hire') === '1' ? { hire: true } : {}), ...(q.get('paid') === '1' ? { paid: true } : {}) };
      return json(
        200,
        await d.discovery.agents({
          ...(text ? { q: text } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(sort ? { sort: sort as AgentSort } : {}),
          ...(Object.keys(filter).length ? { filter } : {}),
        }),
        'public, max-age=5',
      );
    })],

    ['GET', /^\/public\/agents\/(\d{1,10})$/, guarded('/public/agents/:id', async (_req, m) => {
      const p = await d.discovery.profile(Number(m[1]));
      return p ? json(200, p, 'public, max-age=5') : json(404, { error: 'not_found' });
    })],

    ['POST', /^\/public\/records$/, (req, _m, ip) => submit(req, ip)],

    // A seal's transaction from its signature. Base64 in a path segment would need escaping ('/' is in its alphabet), so the signature goes in the query.
    ['GET', /^\/public\/seals\/by-signature$/, guarded('/public/seals/by-signature', async (req) => {
      const sig = new URL(req.url).searchParams.get('sig') ?? '';
      if (!/^[A-Za-z0-9+/]{86}==$/.test(sig)) return json(400, { error: 'bad_signature' });
      const tx = d.sealBySignature ? await d.sealBySignature(sig) : null;
      // Not found is a 200 with tx null: the edge in front of the api turns any 404 into an html page without CORS
      // headers, which a browser can only read as a network error.
      return json(200, { tx }, tx ? 'public, max-age=300' : 'public, max-age=30');
    })],

    ['GET', /^\/public\/records\/([0-9a-f]{64})$/, guarded('/public/records/:ref', async (_req, m) => {
      const record = await d.intake.record(m[1]!);
      return record ? json(200, record, 'public, max-age=31536000, immutable') : json(404, { error: 'not_found' });
    })],

    ['GET', new RegExp(`^/public/export/(${names})\\.csv$`), async (req, m, ip) => {
      const wait = await exportsByIp.hit(ip ? ipKey(ip) : 'unknown');
      if (wait) return res(429, JSON.stringify({ error: 'rate_limited' }), { 'content-type': 'application/json', 'retry-after': String(wait) });
      const name = m[1] as ExportName;
      const includeExcluded = name === 'payments' && new URL(req.url).searchParams.get('include') === 'excluded';
      try {
        const built = buildExport(name, includeExcluded);
        if (built === null) return res(503, JSON.stringify({ error: 'busy' }), { 'content-type': 'application/json', 'retry-after': '5' });
        const { csv, truncated } = await built;
        return res(200, csv, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${name}.csv"`,
          'cache-control': 'public, max-age=60',
          ...(truncated ? { 'x-truncated': '1' } : {}),
        });
      } catch {
        d.log?.({ event: 'unhandled', path: '/public/export/:name.csv' });
        return json(500, { error: 'internal' });
      }
    }],
  ];
}
