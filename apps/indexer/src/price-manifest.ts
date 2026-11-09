/**
 * Service prices an external x402 agent publishes off its registration: the `stellar-agent-services/provider@1`
 * manifest at `https://<host>/.well-known/stellar-agent-services.json`, named by a `stellar-agent-services` service in
 * the agent's own registration document. The only external URL the indexer ever fetches, and only for an agent whose
 * document says it takes x402.
 *
 * A manifest counts only when it names this very agent (provider.agentId), is paid in pinned testnet USDC, and pays
 * the agent's wallet or owner. Prices are base units of that asset (7 decimals). Anything else reads as no prices.
 *
 * The fetch: https on 443 only, no credentials, no IP literal or dotless host, every DNS answer public, no redirects,
 * 5 s, 64 KB. Residual risk as in the api's safe fetch: DNS rebinding between our lookup and the connection.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const MANIFEST_SERVICE = 'stellar-agent-services';
const MANIFEST_PATH = '/.well-known/stellar-agent-services.json';
const STANDARD = /^stellar-agent-services\/provider@1(\.\d+)*$/;
/** Circle USDC's Stellar Asset Contract on testnet (USDC:GBBD47IF…LLFLA5). */
export const TESTNET_USDC_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

export type Lookup = (host: string) => Promise<string[]>;
export type ManifestService = { name: string; description: unknown; priceUsdc: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The manifest url a registration document points at, or null. Only the exact well-known path on https. */
export function manifestUrlOf(doc: unknown): string | null {
  if (!isObject(doc) || !Array.isArray(doc.services)) return null;
  for (const s of doc.services) {
    if (!isObject(s) || s.name !== MANIFEST_SERVICE || typeof s.endpoint !== 'string') continue;
    let u: URL;
    try {
      u = new URL(s.endpoint);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.pathname !== MANIFEST_PATH || u.search || u.hash) continue;
    return u.toString();
  }
  return null;
}

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

/** true for every address a public fetch must never reach; anything that is not a plain public IP counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return v4Private(ip);
  if (v !== 6) return true;
  let x: string;
  try {
    x = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return true;
  }
  if (x === '::' || x === '::1' || x.startsWith('::')) return true; // unspecified, loopback, mapped and compatible forms
  return /^(fc|fd|fe[89abcdef]|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8:') || x.startsWith('2002:') || x.startsWith('2001:0:') || x.startsWith('2001::');
}

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** GETs the manifest under the rules above. Throws on anything else (the caller keeps the agent's previous rows). */
export async function fetchManifest(url: string, f: typeof fetch, lookup: Lookup = defaultLookup): Promise<unknown> {
  const u = new URL(url);
  const host = u.hostname;
  if (isIP(host) || host.startsWith('[') || !host.includes('.') || /\.(local|internal|localhost)$/i.test(host) || host === 'localhost') throw new Error('blocked_host');
  const addrs = await lookup(host);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('blocked_host');
  const res = await f(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (res.status < 200 || res.status > 299) throw new Error(`status_${res.status}`);
  if (Number(res.headers.get('content-length') ?? '0') > MAX_BYTES) throw new Error('too_large');
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new Error('too_large');
  return JSON.parse(new TextDecoder().decode(buf));
}

/** 7-decimal base units to a decimal string ("1000000" -> "0.1"); null for anything that is not a positive whole number. */
export function unitsToUsdc(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{1,13}$/.test(v)) return null;
  const n = BigInt(v);
  if (n <= 0n) return null;
  const whole = n / 10_000_000n;
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * The priced services of a manifest that belongs to this agent, or null when it does not (another agent's id, another
 * asset or network, a payee that is neither the agent's wallet nor its owner, an unknown standard).
 */
export function readManifest(raw: unknown, a: { agentId: number; owner: string; wallet: string | null }): ManifestService[] | null {
  if (!isObject(raw) || typeof raw.standard !== 'string' || !STANDARD.test(raw.standard)) return null;
  if (!isObject(raw.provider) || String(raw.provider.agentId) !== String(a.agentId)) return null;
  const pay = raw.payment;
  if (!isObject(pay) || pay.protocol !== 'x402' || !Array.isArray(pay.accepts)) return null;
  const payees = new Set([a.owner, ...(a.wallet ? [a.wallet] : [])]);
  const ok = pay.accepts.some(
    (x) => isObject(x) && x.network === 'stellar:testnet' && x.asset === TESTNET_USDC_SAC && typeof x.payTo === 'string' && payees.has(x.payTo),
  );
  if (!ok || !Array.isArray(raw.services)) return null;
  const out: ManifestService[] = [];
  for (const s of raw.services) {
    if (!isObject(s) || typeof s.name !== 'string' || !isObject(s.price)) continue;
    const priceUsdc = unitsToUsdc(s.price.amount);
    if (priceUsdc) out.push({ name: s.name, description: s.description, priceUsdc });
  }
  return out;
}
