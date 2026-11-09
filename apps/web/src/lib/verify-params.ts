/**
 * What /verify was asked to check, from its query string. Two shapes, both from proof links on this site:
 * - a hosted agent's stored record: `?agent=<uuid>&tx=<64 hex>` → fetched same origin at /a/<uuid>/records/<tx>;
 * - a library agent's public record: `?record=https://api.agentenact.io/public/records/<64 hex>`;
 * - any testnet transaction: `?tx=<64 hex>` (a public record by that hash, else what the chain says: a seal or not).
 * Anything else (another host, http, extra path or query, repeated params) is null, so a crafted link can never make
 * the page fetch an arbitrary URL.
 */
export type VerifyTarget = { kind: 'hosted'; agent: string; tx: string } | { kind: 'public'; ref: string } | { kind: 'tx'; tx: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PUBLIC_RECORD = /^https:\/\/api\.agentenact\.io\/public\/records\/([0-9a-f]{64})$/;

export function parseVerifyParams(search: string): VerifyTarget | null {
  const q = new URLSearchParams(search);
  const one = (k: string): string | null => {
    const all = q.getAll(k);
    return all.length === 1 ? all[0]! : null;
  };
  const agent = one('agent')?.toLowerCase();
  const tx = one('tx');
  if (agent !== undefined && tx !== null && q.getAll('record').length === 0) {
    return UUID.test(agent) && HEX64.test(tx) ? { kind: 'hosted', agent, tx } : null;
  }
  if (tx !== null && q.getAll('agent').length === 0 && q.getAll('record').length === 0 && [...q.keys()].length === 1) {
    return HEX64.test(tx) ? { kind: 'tx', tx } : null;
  }
  const record = one('record');
  if (record !== null && q.getAll('agent').length === 0 && q.getAll('tx').length === 0) {
    const m = PUBLIC_RECORD.exec(record);
    return m ? { kind: 'public', ref: m[1]! } : null;
  }
  return null;
}

export function recordUrl(t: VerifyTarget): string {
  return t.kind === 'hosted' ? `/a/${t.agent}/records/${t.tx}` : `https://api.agentenact.io/public/records/${t.kind === 'tx' ? t.tx : t.ref}`;
}

/** The query string for a target, built only from validated parts (the inverse of parseVerifyParams). */
export function verifySearch(t: VerifyTarget): string {
  if (t.kind === 'hosted') return `?agent=${encodeURIComponent(t.agent)}&tx=${encodeURIComponent(t.tx)}`;
  return t.kind === 'tx' ? `?tx=${encodeURIComponent(t.tx)}` : `?record=${encodeURIComponent(recordUrl(t))}`;
}

/** The parts of a pasted record the page needs before handing the whole object to the verifier. */
interface PastedRecord {
  agent: { address: string; agentId?: string };
  settlement: { ref: string; payer: string; amount: string; asset: string };
  issuedAt: string;
}

export type Pasted =
  | { kind: 'target'; target: VerifyTarget }
  | { kind: 'record'; record: PastedRecord }
  /** A Stellar transaction signature (base64 of 64 bytes): looked up among AgentEnact seals (verify-start.tsx). */
  | { kind: 'signature'; sig: string }
  | { kind: 'invalid' };

const SITE_HOSTS = new Set(['agentenact.io', 'www.agentenact.io', 'app.agentenact.io']);
const API_HOST = 'api.agentenact.io';
const RECORD_PATH = /^\/a\/([0-9a-fA-F-]{36})\/records\/([0-9a-fA-F]{64})\/?$/;
const PUBLIC_PATH = /^\/public\/records\/([0-9a-fA-F]{64})\/?$/;

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function asRecord(v: unknown): PastedRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as { agent?: { address?: unknown; agentId?: unknown }; settlement?: Record<string, unknown>; issuedAt?: unknown };
  const s = r.settlement;
  if (!r.agent || !str(r.agent.address) || !s || !str(s.ref) || !str(s.payer) || !str(s.amount) || !str(s.asset) || !str(r.issuedAt)) return null;
  if (r.agent.agentId !== undefined && typeof r.agent.agentId !== 'string') return null;
  return v as PastedRecord;
}

/**
 * What someone pasted into /verify: a proof link from this site (any of its hosts, or the api's record urls), a bare
 * 64-hex payment hash (looked up as a public record), or a whole Enactment Record as JSON (checked in place, never sent
 * anywhere), or a stellar.expert testnet transaction link (like a bare hash). Links are reduced to a validated target, so a paste can never make the page fetch another host.
 */
export function parsePasted(input: string): Pasted {
  const text = input.trim();
  if (!text) return { kind: 'invalid' };
  if (text.startsWith('{')) {
    try {
      const record = asRecord(JSON.parse(text));
      return record ? { kind: 'record', record } : { kind: 'invalid' };
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) return { kind: 'target', target: { kind: 'tx', tx: text.toLowerCase() } };
  if (/^[A-Za-z0-9+/]{86}==$/.test(text)) return { kind: 'signature', sig: text };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text.replace(/^\/+/, '')}`);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return { kind: 'invalid' };
  const host = url.hostname.toLowerCase();
  const asTarget = (t: VerifyTarget | null): Pasted => (t ? { kind: 'target', target: t } : { kind: 'invalid' });
  if (SITE_HOSTS.has(host) && url.pathname.replace(/\/$/, '') === '/verify') return asTarget(parseVerifyParams(url.search));
  if (SITE_HOSTS.has(host) || host === API_HOST) {
    const hosted = RECORD_PATH.exec(url.pathname);
    if (hosted && !url.search) return asTarget(parseVerifyParams(`?agent=${hosted[1]}&tx=${hosted[2]!.toLowerCase()}`));
  }
  if (host === 'stellar.expert') {
    const m = /^\/explorer\/testnet\/tx\/([0-9a-fA-F]{64})\/?$/.exec(url.pathname);
    return m ? { kind: 'target', target: { kind: 'tx', tx: m[1]!.toLowerCase() } } : { kind: 'invalid' };
  }
  if (host === API_HOST) {
    const pub = PUBLIC_PATH.exec(url.pathname);
    if (pub && !url.search) return asTarget({ kind: 'public', ref: pub[1]!.toLowerCase() });
  }
  return { kind: 'invalid' };
}
