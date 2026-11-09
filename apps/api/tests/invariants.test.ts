import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { posix } from 'node:path';
import { allImports, valueImports } from './scan.js';

const SRC = new URL('../src/', import.meta.url).pathname;

async function sources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for await (const path of new Glob('**/*.ts').scan({ cwd: SRC })) out.push({ path, text: await Bun.file(SRC + path).text() });
  return out;
}
const unitOf = (path: string) => (path.includes('/') ? path.split('/')[0]! : '(root)');
/**
 * Units that a file's relative imports reach: each specifier is resolved against the importing file's path
 * (relative to src/) and the first segment of the target is the unit; a root-level target is '(root)'.
 * Imports that stay inside the file's own unit are omitted.
 */
const unitImports = (path: string, text: string) =>
  allImports(text)
    .filter((i) => i.startsWith('.'))
    .map((i) => posix.normalize(posix.join(posix.dirname(path), i)))
    .map((target) => (target.includes('/') ? target.split('/')[0]! : '(root)'))
    .filter((unit) => unit !== unitOf(path));

/** Units that sign, submit, sponsor, provision or pay: they must stay testnet-only. */
const WRITE_UNITS = new Set(['signer', 'provision', 'chain', 'owner-client', 'keys']);
/**
 * Mainnet is read-only. Exactly these files may import the mainnet table (tools/networks.ts); each can read, none
 * can sign or submit. Adding a reader means adding it here on purpose.
 */
const READ_ONLY_FILES = ['tools/chain.ts', 'tools/payments.ts'];
/** What a read-only file must never contain. */
const WRITE_WORDS = ['sendTransaction', 'submitTransaction', 'submitAsync', '.sign(', 'Keypair', 'signAuthEntry', 'fromSecret', 'withSecret', 'smart-account-kit', 'agentenact/', '@x402/'];
const writeWords = (text: string) => WRITE_WORDS.filter((w) => stripComments(text).includes(w));
/** A file that signs, submits or pays: it imports the money libraries or calls a submit / secret-key API. Derived, not listed. */
const SIGNING_API = /\b(sendTransaction|submitTransaction|submitAsync|fromSecret)\b|\.withSecret\(|\/transactions['"`]/;
const MONEY_IMPORT = /^(agentenact\/(serve|hire|create)$|@x402\/|smart-account-kit$)/;
const isWriteFile = (f: { text: string }) => allImports(f.text).some((i) => MONEY_IMPORT.test(i)) || SIGNING_API.test(stripComments(f.text));
/** src/-relative path of the file a relative specifier loads, or undefined (package import, or no such source). */
function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.(js|ts)$/, '');
  return [`${stem}.ts`, `${base}.ts`, `${base}/index.ts`, `${stem}/index.ts`].find((c) => known.has(c));
}
const importGraph = (files: { path: string; text: string }[]) => {
  const known = new Set(files.map((f) => f.path));
  return new Map(files.map((f) => [f.path, new Set(allImports(f.text).map((i) => resolveImport(f.path, i, known)).filter((t): t is string => t !== undefined))]));
};
const closure = (graph: Map<string, Set<string>>, roots: string[]) => {
  const seen = new Set<string>();
  const todo = [...roots];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const d of graph.get(f) ?? []) todo.push(d);
  }
  return seen;
};
/** Mainnet identifiers: the SDK constant, the passphrase, the pubnet network id, and Stellar mainnet RPC / Horizon hosts (incl. gateways). */
const MAINNET_MARKERS: [string, RegExp][] = [
  ['Networks.PUBLIC', /\bNetworks\s*\.\s*(PUBLIC|MAINNET)\b/],
  ['passphrase', /Public Global Stellar/i],
  ['pubnet id', /stellar:(pubnet|public|mainnet)|\bpubnet\b/i],
  ['horizon host', /\bhorizon\.stellar\.org/i],
  ['rpc host', /sorobanrpc\.com|soroban-?rpc(?!.*testnet)|soroban\.stellar\.org|gateway\.fm|quiknode|blastapi/i],
  ['STELLAR_READ', /\bSTELLAR_READ\b/],
];
/**
 * Code without comments, so prose about a network is not mistaken for using it. String-aware: a `/*` or `//` inside
 * a '…', "…" or `…` literal (`'*\/*'`, `'https://…'`) is text, kept as is. A stray quote inside a regex literal can only
 * make this keep more text than it should (stricter), never drop code.
 */
function stripComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && !(c !== '`' && text[j] === '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
const mainnetMentions = (text: string) => MAINNET_MARKERS.filter(([, re]) => re.test(stripComments(text))).map(([name]) => name);
/**
 * Mainnet markers a file may NOT carry. Readers may name STELLAR_READ; tools/chain.ts (written before this guard) may
 * also carry its one legacy `'reflector-pubnet'` source label, and nothing else.
 */
function mainnetViolations(path: string, text: string): string[] {
  if (path === 'tools/networks.ts') return [];
  const body = path === 'tools/chain.ts' ? text.replaceAll("'reflector-pubnet'", "''") : text;
  return mainnetMentions(body).filter((m) => !(READ_ONLY_FILES.includes(path) && m === 'STELLAR_READ'));
}
/** Extra positive rules for write units: any mainnet marker, the word mainnet, a non-testnet Stellar id/host/passphrase. */
function writeViolations(source: string): string[] {
  const text = stripComments(source);
  const bad = mainnetMentions(text);
  if (/mainnet/i.test(text)) bad.push('mainnet');
  for (const m of text.matchAll(/['"`](stellar:[a-z]+)['"`]/g)) if (m[1] !== 'stellar:testnet') bad.push(m[1]!);
  for (const m of text.matchAll(/['"`]([^'"`\n]*Network ;[^'"`\n]*)['"`]/g)) if (m[1] !== 'Test SDF Network ; September 2015') bad.push(m[1]!);
  for (const m of text.matchAll(/https?:\/\/[^\s'"`)]+/g)) if (!/testnet/.test(m[0]) && !m[0].startsWith('https://agentenact.io/')) bad.push(m[0]);
  return bad;
}

const usesConsole = (text: string) => text.includes('console.');

const SECRET_OWNER: Record<string, string> = {
  KEYS_MASTER_SECRET: 'keys',
  VAULT_TOKEN: 'keys',
  SPONSOR_SECRET: 'chain',
  OPENROUTER_API_KEY: 'loop',
  TAVILY_API_KEY: 'tools',
  RESEND_API_KEY: 'tools',
  OZ_API_KEY: 'signer',
  PANEL_SECRET: 'gateway',
};
/** Secrets named in a file that does not belong to the secret's unit. */
const secretViolations = (path: string, text: string) =>
  Object.entries(SECRET_OWNER)
    .filter(([name, unit]) => text.includes(name) && unitOf(path) !== unit)
    .map(([name]) => ({ f: path, name, unit: unitOf(path) }));

describe('architecture invariants', () => {
  it('no class declarations', async () => {
    for (const f of await sources()) expect({ f: f.path, cls: /^\s*(export\s+)?(default\s+)?class\s/m.test(f.text) }).toEqual({ f: f.path, cls: false });
  });

  it('only provision (and the vault, for its payload checkers) value-imports agentenact/create; only signer imports serve, hire and @x402', async () => {
    for (const f of await sources()) {
      if (valueImports(f.text).includes('agentenact/create')) expect(['provision', 'keys/vault.ts']).toContain(f.path === 'keys/vault.ts' ? f.path : unitOf(f.path));
      const money = allImports(f.text).filter((i) => i === 'agentenact/serve' || i === 'agentenact/hire' || i.startsWith('@x402/'));
      if (money.length > 0) expect({ f: f.path, unit: unitOf(f.path) }).toEqual({ f: f.path, unit: 'signer' });
    }
  });

  it('signer imports neither loop nor tools (runService and hire are injected)', async () => {
    for (const f of await sources()) if (unitOf(f.path) === 'signer') expect({ f: f.path, bad: unitImports(f.path, f.text).filter((u) => u === 'loop' || u === 'tools') }).toEqual({ f: f.path, bad: [] });
  });

  it('the test-only hireFn seam (it receives the raw S… key) appears in src/ only in signer/hire.ts', async () => {
    for (const f of await sources()) if (f.path !== 'signer/hire.ts') expect({ f: f.path, hireFn: f.text.includes('hireFn') }).toEqual({ f: f.path, hireFn: false });
  });

  it('mainnet is read-only: its config is tools/networks.ts, only the read-only files import that, and no write path can reach any of them', async () => {
    const files = await sources();
    const graph = importGraph(files);
    const importers = (target: string) => [...graph].filter(([, deps]) => deps.has(target)).map(([f]) => f).sort();
    // Relative imports are resolved to real files, so `./networks.js`, `../tools/networks.js` and `./index.js` re-exports all count.
    expect(importers('tools/networks.ts')).toEqual(READ_ONLY_FILES);
    for (const r of READ_ONLY_FILES) expect({ r, importers: importers(r) }).toEqual({ r, importers: ['tools/index.ts'] });
    // The whole transitive closure of every write unit (sponsor, signer, hire, provision, owner client) avoids all of them.
    const reach = closure(graph, files.filter((f) => WRITE_UNITS.has(unitOf(f.path))).map((f) => f.path));
    expect({ reachesMainnetConfig: ['tools/networks.ts', ...READ_ONLY_FILES].filter((t) => reach.has(t)) }).toEqual({ reachesMainnetConfig: [] });
    // A computed import() or require() could hide an edge from the graph: none may exist.
    for (const f of files) expect({ f: f.path, computed: /\bimport\s*\(\s*[^'"\s)]|\brequire\s*\(/.test(f.text) }).toEqual({ f: f.path, computed: false });
    // No mainnet constant outside the config file. The readers may name only STELLAR_READ (chain.ts, written before this
    // guard, still names its pubnet oracle label); everything else names nothing.
    for (const f of files) {
      expect({ f: f.path, mainnet: mainnetViolations(f.path, f.text) }).toEqual({ f: f.path, mainnet: [] });
    }
    // Every reader is unable to sign or submit.
    for (const r of READ_ONLY_FILES) expect({ r, bad: writeWords(files.find((f) => f.path === r)!.text) }).toEqual({ r, bad: [] });
  });

  it('every file that signs, submits or pays lives in a testnet-only write unit (derived from content, not listed)', async () => {
    const files = await sources();
    const writers = files.filter(isWriteFile).map((f) => f.path);
    expect(writers.length).toBeGreaterThan(0);
    expect(writers.filter((p) => !WRITE_UNITS.has(unitOf(p)))).toEqual([]);
  });

  it('every write unit names only the testnet: network ids, passphrases, hosts, and the sponsor refusal', async () => {
    const files = (await sources()).filter((f) => WRITE_UNITS.has(unitOf(f.path)));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect({ f: f.path, bad: writeViolations(f.text) }).toEqual({ f: f.path, bad: [] });
    const sponsor = files.find((f) => f.path === 'chain/sponsor.ts')!;
    expect(sponsor.text).toContain('networkPassphrase !== TESTNET.passphrase');
  });

  it('only the vault process opens keys: keys/index.ts and keys/vault.ts are imported only inside keys and by vault-main.ts', async () => {
    const files = await sources();
    const graph = importGraph(files);
    for (const target of ['keys/index.ts', 'keys/vault.ts']) {
      const importers = [...graph].filter(([f, deps]) => deps.has(target) && unitOf(f) !== 'keys').map(([f]) => f);
      expect({ target, importers }).toEqual({ target, importers: ['vault-main.ts'] });
    }
    // The api's whole import closure never reaches the key store or the vault.
    const reach = closure(graph, ['main.ts']);
    expect(['keys/index.ts', 'keys/vault.ts'].filter((t) => reach.has(t))).toEqual([]);
  });

  it('each secret is read by its one unit', async () => {
    for (const f of await sources()) expect(secretViolations(f.path, f.text)).toEqual([]);
  });

  it('only chain and owner-client import smart-account-kit', async () => {
    for (const f of await sources()) {
      if (allImports(f.text).includes('smart-account-kit')) expect(['chain', 'owner-client']).toContain(unitOf(f.path));
    }
  });

  it('owner-client (the browser module) imports no other unit', async () => {
    for (const f of await sources()) {
      if (unitOf(f.path) !== 'owner-client') continue;
      expect(allImports(f.text).filter((i) => i.startsWith('../'))).toEqual([]);
    }
  });

  it('builder imports neither keys, signer, provision nor chain', async () => {
    for (const f of await sources()) {
      if (unitOf(f.path) !== 'builder') continue;
      expect({ f: f.path, bad: unitImports(f.path, f.text).filter((u) => ['keys', 'signer', 'provision', 'chain'].includes(u)) }).toEqual({ f: f.path, bad: [] });
    }
  });

  it('tools never import keys', async () => {
    for (const f of await sources()) if (unitOf(f.path) === 'tools') expect({ f: f.path, keys: unitImports(f.path, f.text).includes('keys') }).toEqual({ f: f.path, keys: false });
  });

  it('only loop imports @openrouter/ai-sdk-provider; only loop and tools import ai; scheduler never does', async () => {
    for (const f of await sources()) {
      const imports = allImports(f.text);
      if (imports.includes('@openrouter/ai-sdk-provider')) expect({ f: f.path, unit: unitOf(f.path) }).toEqual({ f: f.path, unit: 'loop' });
      if (imports.some((i) => i === 'ai' || i.startsWith('ai/'))) expect(['loop', 'tools']).toContain(unitOf(f.path));
    }
  });

  it('discovery (src/discovery and gateway/discovery.ts) imports none of keys, chain, signer, loop, tools, provision, account', async () => {
    const banned = ['keys', 'chain', 'signer', 'loop', 'tools', 'provision', 'account'];
    let seen = 0;
    for (const f of await sources()) {
      if (unitOf(f.path) !== 'discovery' && f.path !== 'gateway/discovery.ts') continue;
      seen++;
      expect({ f: f.path, bad: unitImports(f.path, f.text).filter((u) => banned.includes(u)) }).toEqual({ f: f.path, bad: [] });
    }
    expect(seen).toBeGreaterThan(4);
  });

  // Direct Anthropic came back for per-agent picks (Kerem, 2026-11-04): the key and the SDK live in loop/models.ts only.
  it('ANTHROPIC_API_KEY and @ai-sdk/anthropic appear only in loop/models.ts', async () => {
    for (const f of await sources()) {
      const own = f.path.endsWith('loop/models.ts');
      expect({ f: f.path, key: f.text.includes('ANTHROPIC_API_KEY') && !own }).toEqual({ f: f.path, key: false });
      expect({ f: f.path, sdk: allImports(f.text).includes('@ai-sdk/anthropic') && !own }).toEqual({ f: f.path, sdk: false });
    }
  });

  it('Brave is gone from src', async () => {
    for (const f of await sources()) expect({ f: f.path, brave: /brave/i.test(f.text) }).toEqual({ f: f.path, brave: false });
  });

  it('runtime units never write to the console (no error object reaches a log)', async () => {
    const quiet = new Set(['discovery', 'provision', 'tools', 'loop', 'scheduler', 'policy', 'specs', 'runs', 'signer', 'agents']);
    for (const f of await sources()) if (quiet.has(unitOf(f.path))) expect({ f: f.path, console: usesConsole(f.text) }).toEqual({ f: f.path, console: false });
  });
});

describe('import scanners (self-test: the failure path works while src/ has no units)', () => {
  const forms = {
    static: `import { x } from 'agentenact/create';`,
    multiline: `import {\n  a,\n  b,\n} from "agentenact/create";`,
    dynamic: `const m = import('agentenact/create');`,
    awaited: `const m = await import("agentenact/create");`,
    bare: `import 'agentenact/create';`,
  };
  for (const [name, text] of Object.entries(forms)) {
    it(`finds a ${name} import`, () => {
      expect(allImports(text)).toEqual(['agentenact/create']);
      expect(valueImports(text)).toEqual(['agentenact/create']);
    });
  }
  it('ignores type-only imports for value imports but not for allImports', () => {
    const t = `import type { X } from 'smart-account-kit';`;
    expect(valueImports(t)).toEqual([]);
    expect(allImports(t)).toEqual(['smart-account-kit']);
  });
  it('a violating fixture trips the same assertions the invariants use', () => {
    for (const text of [forms.static, forms.dynamic, forms.awaited, forms.bare]) {
      expect(allImports(text).filter((i) => i === 'agentenact/create').length).toBe(1);
      expect(allImports(text.replace('agentenact/create', 'agentenact/serve')).filter((i) => i === 'agentenact/serve' || i === 'agentenact/hire')).toEqual(['agentenact/serve']);
      expect(allImports(text.replace('agentenact/create', '../keys/index.js')).filter((i) => i.startsWith('../'))).toEqual(['../keys/index.js']);
      expect(unitImports('tools/x.ts', text.replace('agentenact/create', '../keys/index.js'))).toEqual(['keys']);
    }
  });

  it('resolves nested relative imports to the target unit', () => {
    expect(unitImports('tools/a/b.ts', `import { k } from '../../keys/index.js';`)).toEqual(['keys']);
    expect(unitImports('tools/x.ts', `import { c } from '../config.js';`)).toEqual(['(root)']);
    expect(unitImports('tools/x.ts', `import { k } from '../keys/index.js';`)).toEqual(['keys']);
    expect(unitImports('tools/a/b.ts', `import { s } from './sibling.js';`)).toEqual([]);
    expect(unitImports('tools/a/b.ts', `import { s } from '../sibling.js';`)).toEqual([]);
  });
  it('the keys rule flags a nested tools file importing keys', () => {
    expect(unitImports('tools/a/b.ts', `import { k } from '../../keys/index.js';`).includes('keys')).toBe(true);
  });
  it('the console predicate catches a violating fixture', () => {
    expect(usesConsole(`console.log(err)`)).toBe(true);
    expect(usesConsole(`const x = 1;`)).toBe(false);
  });
  it('the secret-name predicate catches a violating fixture', () => {
    expect(secretViolations('tools/x.ts', `process.env.OPENROUTER_API_KEY`)).toEqual([{ f: 'tools/x.ts', name: 'OPENROUTER_API_KEY', unit: 'tools' }]);
    expect(secretViolations('loop/x.ts', `process.env.OPENROUTER_API_KEY`)).toEqual([]);
    expect(secretViolations('keys/x.ts', `env.KEYS_MASTER_SECRET`)).toEqual([]);
    expect(secretViolations('loop/x.ts', 'process.env.OZ_API_KEY')).toEqual([{ f: 'loop/x.ts', name: 'OZ_API_KEY', unit: 'loop' }]);
    expect(secretViolations('signer/x.ts', 'env.OZ_API_KEY')).toEqual([]);
    expect(secretViolations('main.ts', 'env.PANEL_SECRET')).toEqual([{ f: 'main.ts', name: 'PANEL_SECRET', unit: '(root)' }]);
    expect(secretViolations('gateway/panel.ts', 'env.PANEL_SECRET')).toEqual([]);
  });

  it('the mainnet guard resolves relative imports and catches the realistic violations', () => {
    const known = new Set(['tools/networks.ts', 'tools/chain.ts', 'tools/index.ts', 'tools/sibling.ts', 'signer/hire.ts']);
    for (const [from, spec] of [['tools/sibling.ts', './networks.js'], ['tools/sibling.ts', './networks'], ['signer/hire.ts', '../tools/networks.js'], ['signer/hire.ts', '../tools/chain.js']] as const) {
      expect(resolveImport(from, spec, known)).toMatch(/^tools\/(networks|chain)\.ts$/);
    }
    expect(resolveImport('signer/hire.ts', '../tools/index.js', known)).toBe('tools/index.ts');
    const g = importGraph([
      { path: 'signer/hire.ts', text: `import { x } from '../tools/index.js';` },
      { path: 'tools/index.ts', text: `export * from './chain.js';` },
      { path: 'tools/chain.ts', text: `import { N } from './networks.js';` },
      { path: 'tools/networks.ts', text: '' },
    ]);
    expect(closure(g, ['signer/hire.ts']).has('tools/networks.ts')).toBe(true);
    expect(mainnetMentions(`import { Networks } from '@stellar/stellar-sdk'; const p = Networks.PUBLIC;`)).toEqual(['Networks.PUBLIC']);
    expect(mainnetMentions(`const p = StellarSdk.Networks.PUBLIC;`)).toEqual(['Networks.PUBLIC']);
    for (const host of ["'https://horizon.stellar.org'", "'https://mainnet.sorobanrpc.com'", "'https://soroban-rpc.mainnet.stellar.gateway.fm'", "'https://rpc.quiknode.pro/x'"]) expect(mainnetMentions(host).length).toBeGreaterThan(0);
    expect(mainnetMentions(`'https://soroban-testnet.stellar.org', 'https://horizon-testnet.stellar.org'`)).toEqual([]);
    expect(writeViolations(`// pubnet is read elsewhere\nconst n = 1;`)).toEqual([]);
    expect(writeViolations(`const n = 'stellar:pubnet';`).length).toBeGreaterThan(0);
    expect(writeViolations(`fetch('https://horizon.example.org/x')`)).toEqual(['https://horizon.example.org/x']);
    expect(writeViolations(`const n = 'stellar:testnet'; fetch('https://horizon-testnet.stellar.org')`)).toEqual([]);
  });
});


describe('mainnet guards (self-test: planted violations are caught)', () => {
  it('stripComments is string-aware', () => {
    expect(stripComments(`accept: '*/*', h: 'horizon.stellar.org' /* gone */ // gone too\nx`)).toBe(`accept: '*/*', h: 'horizon.stellar.org'   \nx`);
    expect(mainnetMentions(`const a = '*/*'; const h = 'horizon.stellar.org';`)).toEqual(['horizon host']);
    expect(stripComments(`const u = 'https://example.com/x'; // note`)).toBe(`const u = 'https://example.com/x'; `);
    expect(stripComments('const t = `a // b ${x} /* c */`;')).toBe('const t = `a // b ${x} /* c */`;');
    expect(stripComments(`/** doc 'with quote */ const x = 1;`)).toBe(`  const x = 1;`);
    expect(mainnetMentions(`/* horizon.stellar.org */ // pubnet\nconst x = 1;`)).toEqual([]);
  });
  it('a bare mainnet host string is caught, the testnet host is not', () => {
    expect(mainnetMentions(`const H = 'horizon.stellar.org';`)).toEqual(['horizon host']);
    expect(writeViolations(`const H = 'horizon.stellar.org';`)).toContain('horizon host');
    expect(mainnetMentions(`'horizon-testnet.stellar.org'`)).toEqual([]);
  });
  it('chain.ts is exempt only for STELLAR_READ and its legacy reflector-pubnet label', () => {
    expect(mainnetViolations('tools/chain.ts', `source: 'reflector-testnet' | 'reflector-pubnet'; const n = STELLAR_READ[x];`)).toEqual([]);
    expect(mainnetViolations('tools/chain.ts', `const H = 'https://horizon.stellar.org';`)).toEqual(['horizon host']);
    expect(mainnetViolations('tools/chain.ts', `const p = Networks.PUBLIC;`)).toEqual(['Networks.PUBLIC']);
    expect(mainnetViolations('tools/chain.ts', `const id = 'stellar:pubnet';`)).toEqual(['pubnet id']);
    expect(mainnetViolations('tools/chain.ts', `const s = 'reflector-pubnet'; const t = 'pubnet';`)).toEqual(['pubnet id']);
    expect(mainnetViolations('tools/other.ts', `const s = 'reflector-pubnet';`)).toEqual(['pubnet id']);
    expect(mainnetViolations('tools/networks.ts', `Networks.PUBLIC`)).toEqual([]);
  });
  it('the write-file predicate catches signing, submitting and money imports', () => {
    for (const text of [`import { x } from 'agentenact/hire';`, `import { y } from '@x402/stellar';`, `import 'smart-account-kit';`, `await server.sendTransaction(tx);`, `Keypair.fromSecret(s)`]) {
      expect(isWriteFile({ text })).toBe(true);
    }
    // A unit that takes the secret from the key store and submits by plain HTTP, with no SDK submit call.
    expect(isWriteFile({ text: `await keys.withSecret(id, (kp) => tx.sign(kp));` })).toBe(true);
    expect(isWriteFile({ text: "await safeFetch(horizon + '/transactions', { method: 'POST' });" })).toBe(true);
    expect(isWriteFile({ text: 'await safeFetch(`${base}/transactions`, { method: "POST" });' })).toBe(true);
    expect(isWriteFile({ text: `// keys.withSecret( and '/transactions' in prose\nconst x = 1;` })).toBe(false);
    expect(isWriteFile({ text: `const kp = Keypair.random(); // key custody (keys/) generates, never sends` })).toBe(false);
    expect(isWriteFile({ text: `import { StrKey } from '@stellar/stellar-sdk'; // sendTransaction in prose` })).toBe(false);
  });
  it('the read-only word check catches a reader that could sign or submit', () => {
    expect(writeWords(`import { Keypair } from '@stellar/stellar-sdk';`)).toEqual(['Keypair']);
    expect(writeWords(`tx.sign(k)`)).toEqual(['.sign(']);
    expect(writeWords(`import { hire } from 'agentenact/hire';`)).toEqual(['agentenact/']);
    expect(writeWords(`// Keypair is never used\nconst x = StrKey.isValidEd25519PublicKey(a);`)).toEqual([]);
  });
  it('a reader outside the allowlist, or a write file reaching a reader, trips the graph checks', () => {
    const g = importGraph([
      { path: 'tools/index.ts', text: `import './payments.js'; import './rogue.js';` },
      { path: 'tools/payments.ts', text: `import { STELLAR_READ } from './networks.js';` },
      { path: 'tools/rogue.ts', text: `import { STELLAR_READ } from './networks.js';` },
      { path: 'tools/networks.ts', text: '' },
      { path: 'signer/hire.ts', text: `import { p } from '../tools/payments.js';` },
    ]);
    const importers = (t: string) => [...g].filter(([, d]) => d.has(t)).map(([f]) => f).sort();
    expect(importers('tools/networks.ts')).not.toEqual(READ_ONLY_FILES);
    expect(closure(g, ['signer/hire.ts']).has('tools/payments.ts')).toBe(true);
  });
});
