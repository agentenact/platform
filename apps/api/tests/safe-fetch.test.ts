import { describe, expect, it } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { createSafeFetch, isPrivateAddress, type Fetch } from '../src/tools/safe-fetch.js';

const PUBLIC = '93.184.216.34';
const pub = async () => [PUBLIC];
const codeOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as { code?: string } | null)?.code;

describe('isPrivateAddress', () => {
  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip', '0:0:0:0:0:0:0:1', '0:0:0:0:0:ffff:a00:1', '2002:c000:204::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'fec0::1', 'feb0::1', '2001::1'])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });
  it.each([PUBLIC, '8.8.8.8', '172.32.0.1', '2606:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('safeFetch', () => {
  it('refuses bad schemes, credentials, ports, dotless and literal hosts before any lookup', async () => {
    const looked: string[] = [];
    const sf = createSafeFetch({ fetch: async () => new Response('x'), lookup: async (h) => (looked.push(h), [PUBLIC]) });
    for (const [url, code] of [
      ['ftp://a.example.com/', 'bad_url'],
      ['not a url', 'bad_url'],
      ['https://user:pw@a.example.com/', 'bad_url'],
      ['https://a.example.com:8443/', 'blocked_port'],
      ['http://db/', 'blocked_host'],
      ['http://kong:8000/', 'blocked_port'],
      ['http://169.254.169.254/latest', 'blocked_host'],
      ['http://[::1]/', 'blocked_host'],
      ['http://printer.local/', 'blocked_host'],
      ['http://svc.internal/', 'blocked_host'],
    ] as const) {
      expect([url, await codeOf(sf(url))]).toEqual([url, code]);
    }
    expect(looked).toEqual([]);
  });

  it('refuses a host if any resolved address is private, or none resolve', async () => {
    const sf = createSafeFetch({
      fetch: async () => new Response('x'),
      lookup: async (h) => (h === 'mixed.example.com' ? [PUBLIC, '10.0.0.5'] : h === 'empty.example.com' ? [] : Promise.reject(new Error('ENOTFOUND'))),
    });
    expect(await codeOf(sf('https://mixed.example.com/'))).toBe('blocked_host');
    expect(await codeOf(sf('https://empty.example.com/'))).toBe('dns_failed');
    expect(await codeOf(sf('https://gone.example.com/'))).toBe('dns_failed');
  });

  it('re-checks every redirect hop and caps the hops', async () => {
    const seen: string[] = [];
    const f: Fetch = async (u, init) => {
      seen.push(String(u));
      expect(init?.redirect).toBe('manual');
      const url = String(u);
      if (url.includes('to-private')) return new Response(null, { status: 302, headers: { location: 'https://inner.example.com/' } });
      if (url.includes('loop')) return new Response(null, { status: 301, headers: { location: '/loop' } });
      if (url.includes('hop')) return new Response(null, { status: 307, headers: { location: 'https://final.example.com/ok' } });
      return new Response('done', { headers: { 'content-type': 'text/plain' } });
    };
    const sf = createSafeFetch({ fetch: f, lookup: async (h) => (h === 'inner.example.com' ? ['10.1.2.3'] : [PUBLIC]) });
    expect(await codeOf(sf('https://to-private.example.com/'))).toBe('blocked_host');
    expect(await codeOf(sf('https://loop.example.com/loop'))).toBe('too_many_redirects');
    const ok = await sf('https://hop.example.com/');
    expect([ok.status, ok.url, new TextDecoder().decode(ok.body), ok.contentType]).toEqual([200, 'https://final.example.com/ok', 'done', 'text/plain']);
  });

  it('sends method, headers and body on the first hop only', async () => {
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const f: Fetch = async (u, init) => {
      calls.push({ url: String(u), method: init?.method, body: init?.body });
      return calls.length === 1 ? new Response(null, { status: 303, headers: { location: 'https://b.example.com/' } }) : new Response('{}');
    };
    const sf = createSafeFetch({ fetch: f, lookup: pub });
    await sf('https://a.example.com/', { method: 'POST', body: '{"x":1}', headers: { 'content-type': 'application/json' } });
    expect(calls).toEqual([
      { url: 'https://a.example.com/', method: 'POST', body: '{"x":1}' },
      { url: 'https://b.example.com/', method: 'GET', body: undefined },
    ]);
  });

  it('caps the body by declared length and while streaming', async () => {
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1000));
          c.close();
        },
      });
    const sf = createSafeFetch({ fetch: async () => new Response(stream()), lookup: pub });
    expect(await codeOf(sf('https://a.example.com/', { maxBytes: 5000 }))).toBe('too_large');
    expect((await sf('https://a.example.com/', { maxBytes: 50_000 })).body.byteLength).toBe(20_000);
    const declared = createSafeFetch({ fetch: async () => new Response('x', { headers: { 'content-length': '9999999' } }), lookup: pub });
    expect(await codeOf(declared('https://a.example.com/'))).toBe('too_large');
  });

  it('times out, and honours an external abort', async () => {
    const hang: Fetch = (_u, init) =>
      new Promise((_r, rej) => {
        if (init?.signal?.aborted) return rej(new Error('aborted'));
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    const sf = createSafeFetch({ fetch: hang, lookup: pub });
    expect(await codeOf(sf('https://a.example.com/', { timeoutMs: 30 }))).toBe('timeout');
    const ac = new AbortController();
    const p = sf('https://a.example.com/', { signal: ac.signal });
    ac.abort();
    expect(await codeOf(p)).toBe('network');
  });

  it('allowLoopback admits localhost on any port (tests only)', async () => {
    const sf = createSafeFetch({ fetch: async () => new Response('local'), lookup: pub, allowLoopback: true });
    expect((await sf('http://localhost:4123/x')).status).toBe(200);
    expect(await codeOf(createSafeFetch({ lookup: pub })('http://localhost:4123/x'))).toBe('blocked_port');
  });

  it('refuses loopback by default, on every port and spelling hireUrl accepts, without fetching or resolving', async () => {
    let fetched = 0;
    let looked = 0;
    const sf = createSafeFetch({ fetch: async () => (fetched++, new Response('x')), lookup: async () => (looked++, [PUBLIC]) });
    for (const url of ['http://localhost/', 'http://localhost:80/', 'http://localhost:4123/', 'http://127.0.0.1/', 'http://127.0.0.1:8080/', 'http://[::1]/', 'http://[::1]:3000/', 'http://localhost./', 'http://0x7f.1/', 'http://2130706433/', 'http://[::ffff:127.0.0.1]/']) {
      const code = await codeOf(sf(url));
      expect([url, code === 'blocked_host' || code === 'blocked_port']).toEqual([url, true]);
    }
    expect([fetched, looked]).toEqual([0, 0]);
  });

  it('allowLoopback admits 127.0.0.1 and [::1] but not other private hosts', async () => {
    const sf = createSafeFetch({ fetch: async () => new Response('x'), lookup: pub, allowLoopback: true });
    expect((await sf('http://127.0.0.1:4123/')).status).toBe(200);
    expect((await sf('http://[::1]:4123/')).status).toBe(200);
    expect(await codeOf(sf('http://10.0.0.1/'))).toBe('blocked_host');
    expect(await codeOf(sf('http://169.254.169.254/'))).toBe('blocked_host');
  });
});

const hdrs = (h: Headers) => {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k] = v));
  return o;
};
const text = (b: Uint8Array) => new TextDecoder().decode(b);
async function gzipOfZeros(mb: number): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  const chunk = new Uint8Array(1024 * 1024);
  const out = new Response(cs.readable).arrayBuffer();
  for (let i = 0; i < mb; i++) await w.write(chunk);
  await w.close();
  return new Uint8Array(await out) as Uint8Array<ArrayBuffer>;
}

describe('safeFetch content-encoding', () => {
  it('asks for gzip/deflate/br, turns auto-decompression off, and decodes by content-encoding', async () => {
    const seen: { ae?: string | null; decompress?: unknown }[] = [];
    const enc = new TextEncoder().encode('hello encoded world');
    const mk = (e: string, body: Uint8Array<ArrayBuffer>) => async (_u: unknown, init?: RequestInit) => {
      seen.push({ ae: new Headers(init?.headers).get('accept-encoding'), decompress: (init as { decompress?: boolean }).decompress });
      return new Response(body, { headers: { 'content-encoding': e } });
    };
    for (const [e, body] of [['gzip', new Uint8Array(Bun.gzipSync(enc))], ['deflate', new Uint8Array(deflateSync(enc))], ['x-gzip', new Uint8Array(Bun.gzipSync(enc))], ['identity', enc]] as const) {
      const sf = createSafeFetch({ fetch: mk(e, body), lookup: pub });
      expect([e, text((await sf('https://a.example.com/')).body)]).toEqual([e, 'hello encoded world']);
    }
    expect(seen[0]).toEqual({ ae: 'gzip, deflate, br', decompress: false });
  });

  it('rejects an unknown or corrupt encoding as network', async () => {
    const odd = createSafeFetch({ fetch: async () => new Response('x', { headers: { 'content-encoding': 'compress' } }), lookup: pub });
    expect(await codeOf(odd('https://a.example.com/'))).toBe('network');
    const bad = createSafeFetch({ fetch: async () => new Response('not gzip at all', { headers: { 'content-encoding': 'gzip' } }), lookup: pub });
    expect(await codeOf(bad('https://a.example.com/'))).toBe('network');
  });

  it('caps decompressed bytes of a real gzip bomb without ballooning memory', async () => {
    const bomb = await gzipOfZeros(400);
    expect(bomb.byteLength).toBeLessThan(2_000_000);
    const srv = Bun.serve({ port: 0, fetch: () => new Response(bomb, { headers: { 'content-encoding': 'gzip' } }) });
    try {
      const sf = createSafeFetch({ allowLoopback: true });
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      let peak = before;
      const t = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
      const code = await codeOf(sf(`http://127.0.0.1:${srv.port}/`));
      clearInterval(t);
      peak = Math.max(peak, process.memoryUsage().rss);
      expect(code).toBe('too_large');
      expect((peak - before) / 1e6).toBeLessThan(150);
    } finally {
      srv.stop(true);
    }
    // Building the 400 MB bomb is CPU-bound: ~4 s on the 1-CPU remote runner, so bun's 5 s default is too tight.
  }, 30_000);
});

describe('safeFetch redirects and headers', () => {
  it('sends caller headers on the first hop only, across origins', async () => {
    const got: Record<string, string>[] = [];
    const b = Bun.serve({ port: 0, fetch: (r) => (got.push(hdrs(r.headers)), new Response('b')) });
    const a = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${b.port}/x` } }) });
    try {
      const sf = createSafeFetch({ allowLoopback: true });
      const r = await sf(`http://localhost:${a.port}/`, { headers: { Authorization: 'Bearer secret', 'X-Payment': 'p', 'X-Custom': '1' } });
      expect(text(r.body)).toBe('b');
      expect(got).toHaveLength(1);
      expect(got[0]!.authorization).toBeUndefined();
      expect(got[0]!['x-payment']).toBeUndefined();
      expect(got[0]!['x-custom']).toBeUndefined();
      expect(got[0]!['user-agent']).toBeDefined();
    } finally {
      a.stop(true);
      b.stop(true);
    }
  });

  it('first hop keeps caller headers (case-insensitive) but accept-encoding stays ours', async () => {
    let h: Headers | undefined;
    const sf = createSafeFetch({ fetch: async (_u, init) => ((h = new Headers(init?.headers)), new Response('x')), lookup: pub });
    await sf('https://a.example.com/', { headers: { Authorization: 'Bearer t', 'Accept-Encoding': 'zstd' } });
    expect([h!.get('authorization'), h!.get('accept-encoding')]).toEqual(['Bearer t', 'gzip, deflate, br']);
  });
});

describe('safeFetch dns timeout', () => {
  it('a slow resolver cannot exceed timeoutMs', async () => {
    const sf = createSafeFetch({ fetch: async () => new Response('x'), lookup: () => new Promise(() => {}) });
    const t0 = Date.now();
    expect(await codeOf(sf('https://slow.example.com/', { timeoutMs: 50 }))).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
    const ac = new AbortController();
    const p = sf('https://slow.example.com/', { signal: ac.signal });
    ac.abort();
    expect(await codeOf(p)).toBe('network');
  });
});
