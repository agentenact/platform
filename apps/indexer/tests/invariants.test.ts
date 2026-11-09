import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { allImports } from './scan.js';

const SRC = new URL('../src/', import.meta.url).pathname;

async function sources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const pattern of ['**/*.ts', '**/*.js', '**/*.mjs']) {
    for await (const path of new Glob(pattern).scan({ cwd: SRC })) out.push({ path, text: await Bun.file(SRC + path).text() });
  }
  return out;
}

/** Drops comments but keeps string and template literals intact (they stay scanned). */
export function stripComments(text: string): string {
  return text.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str?: string) => str ?? ' ');
}

const ENV_TOKEN = /\b(?:process|Bun)\s*\.\s*env\b|\bimport\s*\.\s*meta\s*\.\s*env\b/;
/** The identifier `env` itself (also after a spread), not a property named env. */
const BARE_ENV = /(?:(?<![.\w$])|(?<=\.\.\.))env\b/;
const ALLOWED_ENV_NAME = /^env\.(?:INDEXER_[A-Z0-9_]+|PUBLIC_BASE_URL|PORT)\b/;

/**
 * Structural rule proving the indexer never reads the superuser password that `servel link` injects:
 * env is read only through `loadConfig(process.env)` in main.ts and allowlisted `env.NAME` in config.ts,
 * and Bun's implicit-env SQL (`Bun.sql`, `sql` from 'bun') is unreachable. Returns human-readable violations.
 */
export function envViolations(path: string, raw: string): string[] {
  const code = stripComments(raw);
  const out: string[] = [];
  const bad = (re: RegExp, why: string, hay = code): void => {
    if (re.test(hay)) out.push(why);
  };

  // 1 + 2: where env tokens may appear at all.
  if (path === 'main.ts') {
    const rest = code.replace(/\bloadConfig\(\s*process\.env\s*\)/g, 'loadConfig()');
    bad(ENV_TOKEN, 'main.ts: process.env only as the argument of loadConfig(...)', rest);
    bad(BARE_ENV, 'main.ts: bare env', rest);
  } else if (path === 'config.ts') {
    bad(ENV_TOKEN, 'config.ts: use the env parameter, not process.env/Bun.env/import.meta.env');
    const noSig = code.replace(/\benv:\s*Record<string,\s*string\s*\|\s*undefined>/g, ' ');
    for (const m of noSig.matchAll(new RegExp(BARE_ENV, 'g'))) {
      if (!ALLOWED_ENV_NAME.test(noSig.slice(m.index))) out.push('config.ts: env used other than dot access of an allowlisted name');
    }
  } else {
    bad(ENV_TOKEN, 'env token outside main.ts/config.ts');
  }

  // 3: bypass shapes, everywhere.
  bad(/\benv\s*\??\.?\s*\[/, 'env[ computed access');
  bad(/=\s*(?:process|Bun)\s*\.\s*env\b|=\s*import\s*\.\s*meta\s*\.\s*env\b/, 'alias of env');
  bad(/\.\.\.\s*(?:process|Bun)\s*\.\s*env\b|\.\.\.\s*import\s*\.\s*meta\s*\.\s*env\b/, 'spread of env');
  bad(/Object\s*\.\s*(?:keys|entries|values|fromEntries|assign)\s*\(\s*[^)]*\benv\b/, 'Object.* over env');
  bad(/\b(?:process|Bun|globalThis)\s*\[|\bimport\s*\.\s*meta\s*\[/, 'computed access on process/Bun/globalThis/import.meta');
  bad(/\beval\s*\(|\bnew\s+Function\b/, 'eval / new Function');
  bad(/\bBun\s*\.\s*sql\b/, 'Bun.sql reads DATABASE_URL implicitly');
  bad(/\bnew\s+SQL\s*\(\s*\)/, 'new SQL() with no URL reads env implicitly');
  if (path !== 'db.ts') bad(/\bBun\s*\.\s*SQL\b/, 'Bun.SQL outside db.ts');

  // 'bun' imports: no `sql`, no namespace/default/require/dynamic (could reach Bun.sql); `SQL` only in db.ts.
  for (const m of code.matchAll(/\bimport\s+(type\s+)?([^;'"`]*?)\s*from\s*['"](?:node:)?bun['"]/g)) {
    if (m[1]) continue;
    const clause = m[2]!.trim();
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    if (clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim()) out.push("default or namespace import of 'bun'");
    for (const part of (named ?? '').split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (!name) continue;
      if (name === 'sql') out.push("import of sql from 'bun'");
      else if (name === 'SQL' && path !== 'db.ts') out.push("import of SQL from 'bun' outside db.ts");
    }
  }
  bad(/\brequire\s*\(\s*['"](?:node:)?bun['"]|\bimport\s*\(\s*['"](?:node:)?bun['"]/, "require/dynamic import of 'bun'");
  bad(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*from\s*['"](?:node:)?bun['"]/, "re-export from 'bun'");

  // 4: plain-text ban, comments included.
  bad(/SUPABASE_POSTGRES_PASSWORD|POSTGRES_PASSWORD/, 'mentions a superuser password variable', raw);
  return out;
}

/**
 * Network egress is confined to selfpub.ts, price-manifest.ts (the guarded x402 price manifest read) and chain/*. http.ts is NOT exempt as a file: only its inbound server handler
 * key, `Bun.serve({ ..., fetch: <handler> })`, is blanked before the checks, so a real `fetch(` / WebSocket / node:net there is caught.
 */
export function networkViolations(path: string, raw: string): string[] {
  if (path === 'selfpub.ts' || path === 'price-manifest.ts' || path.startsWith('chain/')) return [];
  let code = stripComments(raw);
  if (path === 'http.ts') code = code.replace(/(\bBun\s*\.\s*serve\s*\(\s*\{[^{}]*?)\bfetch\s*:\s*(?!fetch\b)[A-Za-z_$][\w$]*\s*\([^()]*\)/, '$1').replace(/(\bBun\s*\.\s*serve\s*\(\s*\{[^{}]*?)\bfetch\s*:\s*(?!fetch\b)[A-Za-z_$][\w$]*\s*(?=[,}])/, '$1');
  const out: string[] = [];
  if (/\bfetch\b|\bWebSocket\b|\bBun\s*\.\s*(?:connect|listen)\b/.test(code)) out.push('fetch/WebSocket/Bun.fetch/globalThis.fetch');
  if (allImports(code).some((i) => /^(?:node:)?(?:http|https|http2|net|tls|dgram)$/.test(i))) out.push('node network module');
  return out;
}

describe('indexer architecture invariants', () => {
  it('no class declarations', async () => {
    for (const f of await sources()) expect({ f: f.path, cls: /^\s*(export\s+)?(default\s+)?class\s/m.test(f.text) }).toEqual({ f: f.path, cls: false });
  });

  it('src never reads the superuser password or other env, and never uses Bun implicit-env SQL', async () => {
    for (const f of await sources()) expect({ f: f.path, v: envViolations(f.path, f.text) }).toEqual({ f: f.path, v: [] });
  });

  it('src imports nothing from apps/api', async () => {
    for (const f of await sources()) {
      expect({ f: f.path, bad: allImports(f.text).filter((i) => /(^|\/)api(\/|$)/.test(i)) }).toEqual({ f: f.path, bad: [] });
    }
  });

  it('console is not used outside main.ts', async () => {
    for (const f of await sources()) if (f.path !== 'main.ts') expect({ f: f.path, console: f.text.includes('console.') }).toEqual({ f: f.path, console: false });
  });

  it('network egress (fetch, WebSocket, node:http(s)) appears only in selfpub.ts, price-manifest.ts and chain/*', async () => {
    for (const f of await sources()) expect({ f: f.path, v: networkViolations(f.path, f.text) }).toEqual({ f: f.path, v: [] });
  });
});

describe('invariant predicates', () => {
  const MAIN = "import { loadConfig } from './config.js';\nconst config = loadConfig(process.env);\n";
  const CONFIG = [
    "import { z } from 'zod';",
    '// never read from env',
    'export function loadConfig(env: Record<string, string | undefined>) {',
    '  return { a: env.INDEXER_DATABASE_URL || undefined, b: env.PUBLIC_BASE_URL, c: env.PORT };',
    '}',
  ].join('\n');
  const DB = "import { SQL } from 'bun';\nexport const createDb = (url: string) => new SQL(url, { max: 5 });\n";

  it('passes the legitimate code', () => {
    expect(envViolations('main.ts', MAIN)).toEqual([]);
    expect(envViolations('config.ts', CONFIG)).toEqual([]);
    expect(envViolations('db.ts', DB)).toEqual([]);
    expect(envViolations('other.ts', "import { readdir } from 'node:fs/promises';\nexport const x = 1;")).toEqual([]);
    expect(networkViolations('selfpub.ts', 'await fetch(u)')).toEqual([]);
    expect(networkViolations('chain/horizon.ts', "import http from 'node:https'; new WebSocket(u)")).toEqual([]);
  });

  const outside: [string, string][] = [
    ['dot access', 'const x = process.env.INDEXER_X;'],
    ['bracket', "const x = process.env['X'];"],
    ['Bun.env bracket', 'const x = Bun.env["X"];'],
    ['import.meta.env', "const x = import.meta.env['X'];"],
    ['dynamic key', 'const x = process.env[k];'],
    ['destructure', 'const { X } = process.env;'],
    ['entries', 'const x = Object.entries(process.env);'],
    ['spread', 'const x = { ...process.env };'],
    ['alias', 'const e = process.env;'],
    ['concat name', "const x = process.env['SUPA' + 'BASE'];"],
    ['spaced', 'const x = process . env . X;'],
    ['computed process', "const e = process['env'];"],
    ['globalThis computed', "const e = globalThis['process'];"],
  ];
  for (const [name, code] of outside) {
    for (const file of ['other.ts', 'other.js', 'other.mjs']) {
      it(`catches env read outside main/config: ${name} (${file})`, () => {
        expect(envViolations(file, code).length).toBeGreaterThan(0);
      });
    }
  }

  it('catches env abuse in main.ts', () => {
    for (const code of [
      MAIN + 'const p = process.env.PORT;',
      MAIN + 'const e = process.env;',
      'loadConfig({ ...process.env });',
      'loadConfig(process.env, process.env.X);',
      'const { A } = process.env; loadConfig(process.env);',
    ]) expect({ code, n: envViolations('main.ts', code).length > 0 }).toEqual({ code, n: true });
  });

  it('catches env abuse in config.ts', () => {
    for (const code of [
      'const x = env.SUPABASE_POSTGRES_PASSWORD;',
      'const x = env.DATABASE_URL;',
      'const x = env.POSTGRESQL;',
      'const x = env[name];',
      "const x = env['INDEXER_A'];",
      "const x = env['INDEXER_' + n];",
      'const { INDEXER_A } = env;',
      'const e = env;',
      'const x = { ...env };',
      'const x = Object.entries(env);',
      'const x = Object.keys(env);',
      'const x = process.env.PORT;',
      'const x = Bun.env.PORT;',
      'const x = import.meta.env.PORT;',
      'const x = env?.PORT;',
    ]) expect({ code, n: envViolations('config.ts', CONFIG + '\n' + code).length > 0 }).toEqual({ code, n: true });
  });

  it('catches implicit-env SQL', () => {
    for (const code of [
      'const db = Bun.sql`select 1`;',
      "import { sql } from 'bun';",
      "import { SQL, sql } from 'bun';",
      "import { sql as q } from 'bun';",
      "import * as B from 'bun';",
      "import B from 'bun';",
      "import { sql } from 'node:bun';",
      "const b = require('bun');",
      "const b = await import('bun');",
      "export { sql } from 'bun';",
      'const db = new Bun.SQL(url);',
      "import { SQL } from 'bun'; const d = new SQL();",
    ]) expect({ code, n: envViolations('other.ts', code).length > 0 }).toEqual({ code, n: true });
    expect(envViolations('db.ts', "import { SQL } from 'bun'; const d = new SQL();").length).toBeGreaterThan(0);
    expect(envViolations('db.ts', "import { sql } from 'bun';").length).toBeGreaterThan(0);
    expect(envViolations('other.ts', "import { SQL } from 'bun';").length).toBeGreaterThan(0);
    expect(envViolations('other.ts', "import type { SQL } from 'bun';")).toEqual([]);
  });

  it('keeps the plain-text ban on the superuser password, even in comments', () => {
    expect(envViolations('other.ts', '// POSTGRES_PASSWORD')).toContain('mentions a superuser password variable');
    expect(envViolations('other.ts', "const n = 'SUPABASE_POSTGRES_PASSWORD';").length).toBeGreaterThan(0);
  });

  it('ignores env words in comments only', () => {
    expect(envViolations('other.ts', '// process.env.X\n/* Bun.env */ export const a = 1;')).toEqual([]);
    expect(envViolations('other.ts', "const u = 'https://x.io'; const e = process.env;").length).toBeGreaterThan(0);
  });

  it('catches network egress outside selfpub.ts and chain/*', () => {
    for (const code of [
      'await fetch(u)',
      'const f = fetch;',
      'await globalThis.fetch(u)',
      'await Bun.fetch(u)',
      "import http from 'node:http';",
      "import https from 'https';",
      "import { request } from 'node:https';",
      "import net from 'node:net';",
      'new WebSocket(u)',
    ]) expect({ code, n: networkViolations('main.ts', code).length > 0 }).toEqual({ code, n: true });
    expect(networkViolations('x.ts', "const a = 'fetched_at';")).toEqual([]);
  });

  it('http.ts is exempt only for the Bun.serve fetch handler key', () => {
    expect(networkViolations('http.ts', 'Bun.serve({ port: d.port, fetch: createHealth(d) });')).toEqual([]);
    expect(networkViolations('http.ts', 'Bun.serve({ port: 1, fetch: handler });')).toEqual([]);
    for (const code of [
      'Bun.serve({ port: 1, fetch: createHealth(d) }); await fetch(u);',
      'Bun.serve({ port: 1, fetch: createHealth(d) }); const ws = new WebSocket(u);',
      "import net from 'node:net'; Bun.serve({ port: 1, fetch: createHealth(d) });",
      'const f = fetch; Bun.serve({ port: 1, fetch: createHealth(d) });',
      'await globalThis.fetch(u)',
      'Bun.serve({ port: 1, fetch: fetch });',
      'Bun.serve({ port: 1, fetch: fetch })',
    ]) expect({ code, n: networkViolations('http.ts', code).length > 0 }).toEqual({ code, n: true });
  });
});

describe('feed insert ordering', () => {
  it('every insert into discovery.feed is immediately preceded by lockFeed(...) on the same handle', async () => {
    const bad: string[] = [];
    let inserts = 0;
    for (const { path, text } of await sources()) {
      if (path === 'feed-lock.ts') continue;
      const code = stripComments(text);
      for (const m of code.matchAll(/insert\s+into\s+discovery\.feed\b/gi)) {
        inserts++;
        const before = code.slice(0, m.index);
        // the statement's tagged-template call: `<handle>`  just before the insert text
        const call = /(\w+)`\s*$/.exec(before);
        const handle = call?.[1];
        const pre = before.slice(0, call?.index ?? 0);
        if (!handle || !new RegExp(`await\\s+lockFeed\\(\\s*${handle}\\s*\\)\\s*;\\s*await\\s+$`).test(pre)) bad.push(path);
      }
    }
    expect(inserts).toBeGreaterThanOrEqual(3);
    expect(bad).toEqual([]);
  });

  it('in every transaction that inserts into discovery.feed, the first statement is lockFeed(tx)', async () => {
    const bad: string[] = [];
    let txs = 0;
    for (const { path, text } of await sources()) {
      if (path === 'feed-lock.ts') continue;
      const code = stripComments(text);
      const begins = [...code.matchAll(/\.begin\(\s*async\s*\(\s*(\w+)\s*(?::\s*\w+)?\)\s*=>\s*\{/g)];
      for (const [i, m] of begins.entries()) {
        const start = m.index! + m[0].length;
        const body = code.slice(start, begins[i + 1]?.index ?? code.length);
        if (!/insert\s+into\s+discovery\.feed\b/i.test(body)) continue;
        txs++;
        // the first statement, optionally behind a cheap `if (...)` guard, takes the lock on the transaction handle
        if (!new RegExp(`^\\s*(?:if\\s*\\([^)]*\\)\\s*)?await\\s+lockFeed\\(\\s*${m[1]}\\s*\\)\\s*;`).test(body)) bad.push(path);
      }
    }
    expect(txs).toBeGreaterThanOrEqual(3);
    expect(bad).toEqual([]);
  });

  it('the feed lock key is distinct from the other advisory keys', async () => {
    const { FEED_LOCK_KEY } = await import('../src/feed-lock.js');
    const { INDEXER_LOCK_KEY } = await import('../src/singleton.js');
    expect(FEED_LOCK_KEY).not.toBe(INDEXER_LOCK_KEY);
    expect(FEED_LOCK_KEY).not.toBe(0x41455331);
  });
});
