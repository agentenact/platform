/**
 * Every outbound HTTP request a tool makes (spec §3, §7, plan D15). Refuses non-http(s) URLs, URL
 * credentials, ports other than 80/443, IP literals and dotless or internal hostnames (servel service names
 * such as `db` and `kong` are dotless), and any host whose DNS answer includes a private, loopback,
 * link-local, CGNAT, multicast or mapped address. Redirects are followed by hand, at most 3, and every hop
 * is checked again. Bounded by a timeout (10 s default) and a body cap (1 MB default).
 * Compressed bodies are never inflated by fetch (`decompress: false`: Bun otherwise inflates ahead of the
 * reader, so a ~1 MB gzip bomb costs gigabytes of RSS before any cap fires). We decode by `content-encoding`
 * through DecompressionStream and apply the byte cap to the decompressed output as it streams.
 * Caller headers (Authorization, payment headers) go to the first hop only, never to a redirect target.
 * Residual risk (accepted on testnet, on the hardening list): DNS rebinding between our lookup and the
 * connection fetch makes; Bun's fetch cannot pin the address we checked.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Lookup = (host: string) => Promise<string[]>;

export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxRedirects?: number;
}

export interface SafeResponse {
  status: number;
  url: string;
  contentType: string;
  headers: Headers;
  body: Uint8Array;
}

export type SafeFetch = (url: string, o?: SafeFetchOptions) => Promise<SafeResponse>;
export type EgressCode = 'bad_url' | 'blocked_host' | 'blocked_port' | 'dns_failed' | 'too_many_redirects' | 'too_large' | 'timeout' | 'network';
export const egressError = (code: EgressCode) => Object.assign(new Error(`egress: ${code}`), { code });

export const DEFAULT_MAX_BYTES = 1_000_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

function v4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** true for every address a public fetch must never reach (anything that is not an IP counts as private). */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v !== 6) return true;
  // Normalize (0:0:0:0:0:0:0:1 -> ::1, ::ffff:10.0.0.1 -> ::ffff:a00:1) so no spelling dodges the matchers.
  let x: string;
  try {
    x = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return true;
  }
  if (x === '::' || x === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (x.startsWith('::')) return true; // other mapped / compatible forms
  // fc00::/7 ULA, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast, 64:ff9b::/96 NAT64,
  // 2001:db8::/32 docs, 2002::/16 6to4 and 2001:0::/32 Teredo (the last two embed a v4 address).
  return /^(fc|fd|fe[89abcdef]|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('2002:') || x.startsWith('2001:0:') || x.startsWith('2001::'); // '2001::' is Teredo with its zero group compressed
}

/** Settles with `p`, or rejects as soon as `signal` aborts (the underlying work is abandoned, not cancelled). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const ACCEPT_ENCODING = 'gzip, deflate, br';
const FORMATS: Record<string, 'gzip' | 'deflate' | 'brotli'> = { gzip: 'gzip', 'x-gzip': 'gzip', deflate: 'deflate', br: 'brotli' };

const encodingsOf = (header: string | null) => (header ?? '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => e && e !== 'identity');

/** Wraps a raw body in decoders (encodings are listed in application order, so undone in reverse). null = unsupported. */
function decode(body: ReadableStream<Uint8Array>, encodings: string[]): ReadableStream<Uint8Array> | null {
  let out = body;
  for (const e of [...encodings].reverse()) {
    const f = FORMATS[e];
    if (!f) return null;
    out = out.pipeThrough(new DecompressionStream(f as CompressionFormat) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  }
  return out;
}

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export function createSafeFetch(o: { fetch?: Fetch; lookup?: Lookup; allowLoopback?: boolean } = {}): SafeFetch {
  const doFetch: Fetch = o.fetch ?? ((input, init) => fetch(input, init));
  const lookup = o.lookup ?? defaultLookup;

  async function check(raw: string, signal: AbortSignal): Promise<URL> {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw egressError('bad_url');
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw egressError('bad_url');
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (o.allowLoopback && LOOPBACK.has(host)) return u;
    if (u.port && u.port !== '80' && u.port !== '443') throw egressError('blocked_port');
    if (isIP(host) || !host.includes('.') || /\.(local|internal|localhost)$/.test(host)) throw egressError('blocked_host');
    let addrs: string[];
    try {
      addrs = await raceAbort(lookup(host), signal);
    } catch {
      throw egressError('dns_failed');
    }
    if (addrs.length === 0) throw egressError('dns_failed');
    if (addrs.some(isPrivateAddress)) throw egressError('blocked_host');
    return u;
  }

  return async (url, opt = {}) => {
    const maxBytes = opt.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeout = AbortSignal.timeout(opt.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = opt.signal ? AbortSignal.any([timeout, opt.signal]) : timeout;
    // .slice(): a Uint8Array<ArrayBuffer>, the BodyInit TS 5.9 accepts.
    const firstBody: BodyInit | undefined = opt.body === undefined || typeof opt.body === 'string' ? opt.body : opt.body.slice();
    const baseHeaders: Record<string, string> = { accept: '*/*', 'user-agent': 'agentenact-cloud' };
    const firstHeaders: Record<string, string> = { ...baseHeaders };
    for (const [k, v] of Object.entries(opt.headers ?? {})) firstHeaders[k.toLowerCase()] = v;
    firstHeaders['accept-encoding'] = ACCEPT_ENCODING; // ours: we only decode what we ask for
    let current = url;
    for (let hop = 0; ; hop++) {
      if (hop > (opt.maxRedirects ?? DEFAULT_MAX_REDIRECTS)) throw egressError('too_many_redirects');
      let u: URL;
      try {
        u = await check(current, signal);
      } catch (e) {
        // a lookup cut short by the timeout / external abort is not a DNS verdict
        if (signal.aborted && (e as { code?: string }).code === 'dns_failed') throw egressError(timeout.aborted ? 'timeout' : 'network');
        throw e;
      }
      if (signal.aborted) throw egressError(timeout.aborted ? 'timeout' : 'network');
      let res: Response;
      try {
        res = await doFetch(u.toString(), {
          // A 307/308 after a POST deliberately continues as a bodiless GET: the body is never replayed.
          method: hop === 0 ? (opt.method ?? 'GET') : 'GET',
          // Caller headers (secrets) reach the first hop only; redirect targets get safe defaults.
          headers: hop === 0 ? firstHeaders : { ...baseHeaders, 'accept-encoding': ACCEPT_ENCODING },
          body: hop === 0 ? firstBody : undefined,
          redirect: 'manual',
          decompress: false,
          signal,
        } as RequestInit);
      } catch {
        throw egressError(timeout.aborted ? 'timeout' : 'network');
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, u).toString();
        await res.body?.cancel();
        continue;
      }
      const encodings = encodingsOf(res.headers.get('content-encoding'));
      // Content-Length of an encoded body is the compressed size; only a raw body's length bounds the output.
      if (encodings.length === 0 && Number(res.headers.get('content-length') ?? '0') > maxBytes) {
        await res.body?.cancel();
        throw egressError('too_large');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let stream: ReadableStream<Uint8Array> | null = res.body;
      if (stream && encodings.length > 0) {
        stream = decode(stream, encodings);
        if (!stream) {
          await res.body?.cancel();
          throw egressError('network');
        }
      }
      const reader = stream?.getReader();
      try {
        for (;;) {
          if (!reader) break;
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw egressError('too_large');
          }
          chunks.push(value);
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'too_large') throw e;
        throw egressError(timeout.aborted ? 'timeout' : 'network');
      }
      const body = new Uint8Array(size);
      let off = 0;
      for (const c of chunks) {
        body.set(c, off);
        off += c.byteLength;
      }
      return { status: res.status, url: u.toString(), contentType: res.headers.get('content-type') ?? '', headers: res.headers, body };
    }
  };
}

/**
 * A fetch over safeFetch, for code that needs the fetch signature: the library hire(), whose x402 client
 * calls fetch(Request). The Request's method, headers, body and signal are carried over. The response is
 * buffered, so the caps apply. Status codes pass through.
 */
export function toFetch(sf: SafeFetch, o: { timeoutMs: number; maxBytes: number; maxRedirects: number }): Fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const reqHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => (reqHeaders[k] = v));
    const method = req.method === 'POST' ? 'POST' : 'GET';
    const body = method === 'POST' ? new Uint8Array(await req.arrayBuffer()) : undefined;
    const r = await sf(req.url, { method, headers: reqHeaders, ...(body ? { body } : {}), timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, maxRedirects: o.maxRedirects, signal: req.signal });
    const empty = r.status === 204 || r.status === 304;
    // safeFetch already decoded the body: drop the headers that described the encoded one.
    const headers = new Headers(r.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(empty ? null : r.body.slice(), { status: r.status, headers });
  };
}
