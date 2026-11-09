import type { Db } from './db.js';
import { lockFeed } from './feed-lock.js';
import { MANIFEST_SERVICE, fetchManifest, manifestUrlOf, readManifest, type Lookup } from './price-manifest.js';
import { isIP } from 'node:net';
import { classifyUri } from './registry-sync.js';

// Caps (Global Constraints). Self-published text is plain text only.
const NAME_MAX = 64;
const DESCRIPTION_MAX = 280;
const SERVICE_DESCRIPTION_MAX = 140;
const SERVICES_MAX = 10;
const SLUG_MAX = 40;
const INLINE_MAX_BYTES = 64 * 1024;
const HOSTED_MAX_BYTES = 256 * 1024;
const HOSTED_TIMEOUT_MS = 5000;
const PRICE = /^\d{1,6}(\.\d{1,7})?$/;
const URL_MAX = 300;
const DEFAULT_BATCH = 20;
/**
 * The parser's version, the third part of `doc_hash` (uri hash : parse hash : version). A row written by another version
 * is read again, so a field the parser learns (x402 on 2026-11-02) fills in on every agent without a migration. Bump it
 * whenever parseAgentDoc or the manifest merge stores something new.
 */
export const PARSE_VERSION = 'p3';
const DEFAULT_HOSTED_EVERY_MS = 5 * 60 * 1000;
/** After a failed fetch the agent is not tried again for this long (it keeps its previous rows). */
const RETRY_AFTER_MS = 5 * 60 * 1000;
/** A hosted agent whose last good verification (selfpub.fetched_at) is older than this is no longer 'hosted', whatever the fetch says now. */
const HOSTED_TRUST_MS = 60 * 60 * 1000;

/** `url`: where the service says it answers (serviceUrlOf); null when it names none we would ever call. */
export type ParsedService = { slug: string; description: string | null; priceUsdc: string | null; url: string | null };
/** `x402`: the document says the agent takes x402 payments (ERC-8004 `x402support`, or the `x402` flag some registrations use). */
export type ParsedDoc = { name: string | null; description: string | null; services: ParsedService[]; x402: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Plain text: whitespace collapsed, control and bidi/invisible-format characters removed, capped by code points. Never interpreted. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v
    // C0, DEL, C1, zero-width and directional marks (200B-200F), bidi embeddings/overrides (202A-202E), isolates (2066-2069), BOM
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  return Array.from(t).slice(0, max).join('').trim() || null;
}

function slugify(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s || null;
}

/**
 * A service address we would ever call: https on 443, no credentials, a dotted host name that is not an IP literal,
 * localhost or a private suffix. Only the text is checked (nothing is fetched here); the api's safe fetch still resolves
 * and refuses private addresses when an agent actually calls it.
 */
export function serviceUrlOf(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.hash) return null;
  if (isIP(host) || host.startsWith('[') || !host.includes('.') || host === 'localhost' || /\.(local|internal|localhost|test|example|invalid)$/.test(host)) return null;
  return u.toString();
}

function priceOf(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
  return s !== null && PRICE.test(s) ? s : null;
}

/** Tolerant reader for our agent.json and the generic registration shape. Anything unreadable becomes null / empty. */
export function parseAgentDoc(raw: unknown): ParsedDoc {
  if (!isObject(raw)) return { name: null, description: null, services: [], x402: false };
  const services: ParsedService[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.services)) {
    for (const item of raw.services) {
      if (services.length >= SERVICES_MAX) break;
      if (!isObject(item)) continue;
      const slug = slugify(item.slug) ?? slugify(item.name);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      services.push({
        slug,
        description: cleanText(item.description, SERVICE_DESCRIPTION_MAX),
        priceUsdc: priceOf(item.price_usdc) ?? priceOf(item.price),
        url: serviceUrlOf(item.url) ?? serviceUrlOf(item.endpoint),
      });
    }
  }
  // Only a literal `true` counts: "yes", 1 or an object is not a claim we read.
  const x402 = raw.x402support === true || raw.x402Support === true || raw.x402 === true;
  return { name: cleanText(raw.name, NAME_MAX), description: cleanText(raw.description, DESCRIPTION_MAX), services, x402 };
}

/** Only `data:application/json[;base64],...` and `data:,{json}`. More than 64 KB decoded, or invalid JSON, is null. */
export function readInlineDoc(uri: string): unknown | null {
  if (typeof uri !== 'string' || uri.length > INLINE_MAX_BYTES * 4) return null;
  const m = /^data:(?:(application\/json)(?:;charset=[\w-]+)?(;base64)?)?,([\s\S]*)$/i.exec(uri);
  if (!m) return null;
  try {
    const bytes = m[1] && m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
    if (bytes.length > INLINE_MAX_BYTES) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/** The one URL we fetch for an agent document (an x402 agent's price manifest, price-manifest.ts, is the only other). */
export function hostedDocUrl(hostedUuid: string, publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/a/${hostedUuid}/agent.json`;
}

export type SelfpubDeps = {
  sql: Db;
  publicBaseUrl: string;
  fetch?: typeof fetch;
  now?: () => Date;
  batch?: number;
  hostedEveryMs?: number;
  /** DNS for the price manifest fetch (tests); defaults to the system resolver. */
  lookup?: Lookup;
};

type Candidate = { agent_id: number; owner: string; wallet: string | null; uri: string; hosted_uuid: string | null; builder: string };

async function sha16(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(buf).toString('hex').slice(0, 16);
}

/** Reads a response body, rejecting anything over `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) throw new Error('too_large');
  if (!res.body) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new Error('too_large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const GONE = Symbol('gone');

/** The document at our own hosted URL. Throws on any failure (network, redirect, status, size, JSON). */
async function fetchHosted(f: typeof fetch, url: string): Promise<unknown | typeof GONE> {
  const res = await f(url, { redirect: 'error', signal: AbortSignal.timeout(HOSTED_TIMEOUT_MS), headers: { accept: 'application/json' } });
  // Our own api answers 404 for an unknown or revoked agent: a definitive "no such hosted agent", not a failure.
  if (res.status === 404 || res.status === 410) return GONE;
  if (res.status < 200 || res.status > 299) throw new Error(`status_${res.status}`);
  return JSON.parse(await readCapped(res, HOSTED_MAX_BYTES));
}

/**
 * Does the document our own api serves name this very agent? Same registry id AND same agent wallet as the row.
 * Field names verified against the api's /a/<uuid>/agent.json: `agentId` (number) and `agentWallet` (G... address).
 */
function namesThisAgent(doc: unknown, a: Candidate): boolean {
  if (!isObject(doc) || a.wallet === null) return false;
  const id = doc.agentId;
  if (typeof id !== 'number' && typeof id !== 'string') return false;
  return String(id) === String(a.agent_id) && doc.agentWallet === a.wallet;
}

/**
 * Self-published name, description and services, plus the ONLY place `builder = 'hosted'` is ever set.
 * A uri is a claim (anyone can register an agentenact.io uri): it flips to 'hosted' only when our own document, fetched
 * from the exact URL built from the uuid, names the same agent id and wallet. 'library' is never overwritten.
 * External registration uris (https, ipfs, anything else) are never fetched; `data:` uris are decoded in memory. The one
 * external read is the price manifest an x402 document names (price-manifest.ts).
 */
export async function refreshSelfPublished(d: SelfpubDeps): Promise<{ checked: number; changed: number }> {
  const doFetch = d.fetch ?? fetch;
  const now = d.now ?? (() => new Date());
  const t = now();
  const batch = d.batch ?? DEFAULT_BATCH;
  const hostedEveryMs = d.hostedEveryMs ?? DEFAULT_HOSTED_EVERY_MS;

  // Hidden agents: nothing self-published is kept.
  await d.sql`delete from discovery.services where agent_id in (select agent_id from discovery.hidden)`;
  await d.sql`delete from discovery.selfpub where agent_id in (select agent_id from discovery.hidden)`;
  await d.sql`update discovery.feed set label = null where self_published and label is not null and agent_id in (select agent_id from discovery.hidden)`;

  const staleBefore = new Date(t.getTime() - hostedEveryMs);
  const candidates = (await d.sql`
    select a.agent_id, a.owner, a.wallet, a.uri, a.hosted_uuid::text as hosted_uuid, a.builder
    from discovery.agents a
    left join discovery.selfpub s on s.agent_id = a.agent_id
    where not exists (select 1 from discovery.hidden h where h.agent_id = a.agent_id)
      and not exists (select 1 from discovery.meta m where m.key = 'selfpub_retry:' || a.agent_id and m.value > ${t.toISOString()}::text)
      and (s.agent_id is null
           or ((a.hosted_uuid is not null or s.manifest) and s.fetched_at < ${staleBefore})
           or split_part(coalesce(s.doc_hash, ''), ':', 1) <> left(encode(sha256(convert_to(a.uri, 'UTF8')), 'hex'), 16)
           or split_part(coalesce(s.doc_hash, ''), ':', 3) <> ${PARSE_VERSION})
    order by s.fetched_at asc nulls first, a.agent_id
    limit ${batch}`) as Candidate[];

  let changed = 0;
  for (const a of candidates) {
    try {
      if (await refreshOne(d, doFetch, a, t)) changed++;
    } catch {
      // Network, timeout, 5xx, redirect, oversize, bad JSON: previous rows stay, but 'hosted' is only trusted for an hour
      // after the last good verification; retry after a pause.
      await d.sql`
        update discovery.agents set builder = 'external'
        where agent_id = ${a.agent_id} and builder = 'hosted' and uri = ${a.uri}
          and not exists (select 1 from discovery.selfpub s where s.agent_id = ${a.agent_id} and s.fetched_at >= ${new Date(t.getTime() - HOSTED_TRUST_MS)})`.catch(() => {});
      const until = new Date(t.getTime() + RETRY_AFTER_MS).toISOString();
      await d.sql`insert into discovery.meta (key, value) values (${`selfpub_retry:${a.agent_id}`}, ${until})
                  on conflict (key) do update set value = excluded.value`.catch(() => {});
    }
  }
  return { checked: candidates.length, changed };
}

async function refreshOne(d: SelfpubDeps, doFetch: typeof fetch, a: Candidate, t: Date): Promise<boolean> {
  let doc: unknown | null = null;
  let hostedMatch: boolean | null = null; // null: this agent has no hosted claim

  const claimed = a.hosted_uuid !== null && classifyUri(a.uri, d.publicBaseUrl).hostedUuid === a.hosted_uuid;
  if (claimed) {
    const got = await fetchHosted(doFetch, hostedDocUrl(a.hosted_uuid!, d.publicBaseUrl));
    // 404/410: revoked or unknown to our api. Handled like a document that names someone else: external, nothing kept.
    doc = got === GONE ? null : got;
    hostedMatch = got === GONE ? false : namesThisAgent(got, a);
  } else if (a.uri.startsWith('data:')) {
    doc = readInlineDoc(a.uri);
  }

  // A claimed-hosted document that does not name this agent is someone else's: none of its text is taken.
  const parsed = parseAgentDoc(hostedMatch === false ? null : doc);

  // An external x402 agent may publish its prices in a stellar-agent-services manifest. A failed fetch throws, so the
  // agent keeps its previous rows and is tried again later; a manifest that is not this agent's adds nothing.
  const manifestUrl = !claimed && parsed.x402 ? manifestUrlOf(doc) : null;
  if (manifestUrl) {
    const priced = readManifest(await fetchManifest(manifestUrl, doFetch, d.lookup), { agentId: a.agent_id, owner: a.owner, wallet: a.wallet });
    if (priced?.length) {
      // no url: a manifest service is reached through its provider protocol, not a plain x402 POST we can make
      const fromManifest = parseAgentDoc({ services: priced.map((p) => ({ name: p.name, description: p.description, price_usdc: p.priceUsdc })) }).services;
      const slugs = new Set(fromManifest.map((p) => p.slug));
      // the pointer to the manifest is not a service of its own once the manifest is read
      parsed.services = [...fromManifest, ...parsed.services.filter((p) => !slugs.has(p.slug) && p.slug !== MANIFEST_SERVICE)].slice(0, SERVICES_MAX);
    }
  }
  const stored = JSON.stringify(parsed);
  const docHash = `${await sha16(a.uri)}:${await sha16(stored)}:${PARSE_VERSION}`;
  const wantBuilder = hostedMatch === null ? null : hostedMatch ? 'hosted' : 'external';

  return d.sql.begin(async (tx: Db) => {
    // Lock order: the feed lock before the agent row lock (see feed-lock.ts). A service may open below.
    await lockFeed(tx);
    // Re-check under the transaction: a hide, or any change of the identity the fetch was verified against, must not be overwritten.
    const [cur] = (await tx`select uri, owner, wallet, hosted_uuid::text as hosted_uuid, builder from discovery.agents where agent_id = ${a.agent_id} for update`) as Array<{
      uri: string;
      owner: string;
      wallet: string | null;
      hosted_uuid: string | null;
      builder: string;
    }>;
    const [hid] = (await tx`select 1 as x from discovery.hidden where agent_id = ${a.agent_id}`) as unknown[];
    if (!cur || cur.uri !== a.uri || cur.wallet !== a.wallet || cur.owner !== a.owner || cur.hosted_uuid !== a.hosted_uuid || hid) return false;

    let didChange = false;
    if (wantBuilder !== null && cur.builder !== 'library' && cur.builder !== wantBuilder) {
      await tx`update discovery.agents set builder = ${wantBuilder} where agent_id = ${a.agent_id}`;
      didChange = true;
    } else if (wantBuilder === null && cur.builder === 'hosted') {
      // the uri no longer claims a hosted document
      await tx`update discovery.agents set builder = 'external' where agent_id = ${a.agent_id}`;
      didChange = true;
    }

    const [prev] = (await tx`select doc_hash from discovery.selfpub where agent_id = ${a.agent_id}`) as Array<{ doc_hash: string | null }>;
    if (prev?.doc_hash !== docHash) didChange = true;
    await tx`
      insert into discovery.selfpub (agent_id, name, description, fetched_at, doc_hash, x402, manifest)
      values (${a.agent_id}, ${parsed.name}, ${parsed.description}, ${t}, ${docHash}, ${parsed.x402}, ${manifestUrl !== null})
      on conflict (agent_id) do update set name = excluded.name, description = excluded.description, fetched_at = excluded.fetched_at,
        doc_hash = excluded.doc_hash, x402 = excluded.x402, manifest = excluded.manifest`;

    const known = new Set(((await tx`select slug from discovery.services where agent_id = ${a.agent_id}`) as Array<{ slug: string }>).map((r) => r.slug));
    for (const s of parsed.services) {
      await tx`
        insert into discovery.services (agent_id, slug, description, price_usdc, url, first_seen_at, last_seen_at)
        values (${a.agent_id}, ${s.slug}, ${s.description}, ${s.priceUsdc}, ${s.url}, ${t}, ${t})
        on conflict (agent_id, slug) do update set description = excluded.description, price_usdc = excluded.price_usdc, url = excluded.url, last_seen_at = excluded.last_seen_at`;
      // Opened after the agent's first self-published row: a feed line. The initial set at first sight makes none.
      if (prev && !known.has(s.slug)) {
        await lockFeed(tx);
        await tx`
          insert into discovery.feed (kind, agent_id, label, at, self_published, source_key)
          values ('service_opened', ${a.agent_id}, ${s.description ?? s.slug}, ${t}, true, ${`svc:${a.agent_id}:${s.slug}`})
          on conflict (source_key) do nothing`;
      }
    }
    const slugs = parsed.services.map((s) => s.slug);
    await tx`delete from discovery.services where agent_id = ${a.agent_id} and slug not in (select jsonb_array_elements_text(${slugs}::jsonb))`;
    await tx`delete from discovery.meta where key = ${`selfpub_retry:${a.agent_id}`}`;
    return didChange;
  });
}
