/**
 * Community templates: an open index of `agentenact.template/1` documents (library `agentenact/community`) that anyone
 * can push. A document is listed only after it passes, cheapest first:
 *
 *   1. pure checks: the format, testnet only, kind `agentenact.draft/1`, and the body through the same checks as a Builder
 *      draft (shape, draft checks, Builder scope; `handoffProblem`), so a community draft can do nothing a drafted one cannot;
 *   2. one index read: an already-held hash costs nothing further;
 *   3. the global hourly budget, then the library verifier: the author's signature, the author's agent (with `agentId`) and
 *      the anchor on the author's own account, which must hold exactly this hash (`manage_data ae.tpl:<slug>`).
 *
 * The anchor is what makes the index rebuildable and spam costly (a funded account and a 0.5 XLM reserve per slug), so an
 * unanchored or superseded document is refused. Listing is not endorsement: every answer says "community" and the
 * draft still goes through the trial and the create checks. Reports hide a template from this index after
 * REPORTS_TO_HIDE distinct reporters; only an operator un-hides. Nothing is deleted: the document and the anchor are the
 * author's, and another index may list them.
 *
 * Handles are local to this index, first come, one per key. A key changes its handle with a newer template or with a signed
 * `agentenact.handle/1` change (setHandle); the newest signed claim wins, so a replayed old one changes nothing.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { ChainAdapter } from 'agentenact';
import {
  parseSignedCommunityTemplate,
  templateHash,
  verifyCommunityTemplate,
  verifyHandleChange,
  type SignedCommunityTemplate,
  type TemplateAnchorReader,
  type TemplateFailure,
} from 'agentenact/community';
import type { Db } from '../db/index.js';
import { handoffProblem } from '../builder/handoff.js';
import type { DraftResult } from '../builder/draft-schema.js';
import { createRateLimiter } from '../gateway/rate-limit.js';

export const COMMUNITY_NETWORK = 'stellar:testnet' as const;
export const COMMUNITY_KIND = 'agentenact.draft/1' as const;
/** Chain-reading verifications across everyone, per hour. */
export const COMMUNITY_SUBMISSIONS_PER_HOUR = 100;
/** Listed templates one author may have at a time (one per slug; a new version replaces the old). */
export const MAX_LISTED_PER_AUTHOR = 20;
export const REPORTS_TO_HIDE = 3;
export const RECHECK_AFTER_MS = 15 * 60_000;
export const RECHECK_BATCH = 25;
export const LIST_MAX = 100;
/** A handle change must be signed within this long of when it arrives, so a captured one goes stale. */
export const HANDLE_CHANGE_WINDOW_MS = 10 * 60_000;
export const REPORT_REASONS = ['spam', 'harmful', 'broken', 'other'] as const;
/** Handles nobody may take here: they would read as us or as a platform. Matched after dropping `_` and `-`. */
export const RESERVED_NAMES: readonly string[] = ['agentenact', 'enact', 'official', 'admin', 'administrator', 'support', 'team', 'staff', 'moderator', 'system', 'agentkarma', 'karma', 'stellar', 'sdf', 'anthropic', 'claude', 'openai', 'circle', 'usdc'];
export const isReservedName = (name: string): boolean => {
  const bare = name.replace(/[_-]/g, '');
  return RESERVED_NAMES.some((r) => bare === r || bare.startsWith(r) || bare.endsWith(r));
};
export type ReportReason = (typeof REPORT_REASONS)[number];
const SHA = /^[0-9a-f]{64}$/;

export type CommunityRefusal = 'malformed' | 'name_reserved' | 'name_taken' | 'wrong_network' | 'wrong_kind' | 'bad_draft' | 'not_verified' | 'not_anchored' | 'author_limit' | 'rate_limited' | 'chain_unavailable';
export type CommunitySubmitResult =
  | { status: 'listed' | 'already_received'; sha256: string }
  | { status: 'refused'; code: CommunityRefusal; problem?: string; failure?: TemplateFailure; retryAfter?: number };

export type HandleRefusal = 'malformed' | 'wrong_network' | 'name_reserved' | 'name_taken' | 'not_verified' | 'not_fresh' | 'chain_unavailable';
export type HandleChangeResult = { status: 'changed'; name: string | null } | { status: 'refused'; code: HandleRefusal };

export interface ListedTemplate {
  sha256: string;
  slug: string;
  version: number;
  title: string;
  summary: string;
  author: { network: string; address: string; agentId?: string; name?: string };
  kind: string;
  receivedAt: string;
}

export interface CommunityIndex {
  submit(raw: unknown): Promise<CommunitySubmitResult>;
  list(o?: { q?: string; limit?: number }): Promise<ListedTemplate[]>;
  /** A listed, anchored template with its draft; null for anything else (unknown, hidden or superseded). */
  get(sha256: string): Promise<(ListedTemplate & { document: SignedCommunityTemplate; draft: DraftResult }) | null>;
  /** One report per reporter; the REPORTS_TO_HIDE-th distinct one hides the template. */
  report(sha256: string, clientKey: string, reason: ReportReason): Promise<'reported' | 'already_reported' | 'not_found'>;
  /** A signed `agentenact.handle/1` change: renames the key (or drops its handle) without a template. */
  setHandle(raw: unknown): Promise<HandleChangeResult>;
  /** Re-reads the anchors checked longest ago; a moved or removed anchor makes the row superseded. Returns rows checked. */
  recheck(): Promise<number>;
}

export interface CommunityVerifier {
  adapter: ChainAdapter;
  anchors: TemplateAnchorReader;
}

/** Stellar testnet, loaded on first use: an index that never verifies does not pay for the SDK. */
export function stellarTestnetCommunityVerifier(): () => Promise<CommunityVerifier> {
  let loaded: Promise<CommunityVerifier> | undefined;
  return () =>
    (loaded ??= import('agentenact/adapters/stellar').then(
      (m) => ({ adapter: m.createStellarAdapter({ network: 'testnet' }), anchors: m.createStellarTemplateAnchors({ network: 'testnet' }) }),
      (e) => ((loaded = undefined), Promise.reject(e)),
    ));
}

type Row = {
  sha256: string;
  slug: string;
  version: number;
  title: string;
  summary: string;
  network: string;
  author: string;
  agent_id: number | null;
  /** The key's current handle in this index (community_authors), not the one an older document carried. */
  author_name: string | null;
  kind: string;
  received_at: Date;
  document?: SignedCommunityTemplate;
};

const listed = (r: Row): ListedTemplate => ({
  sha256: r.sha256,
  slug: r.slug,
  version: r.version,
  title: r.title,
  summary: r.summary,
  author: { network: r.network, address: r.author, ...(r.agent_id === null ? {} : { agentId: String(r.agent_id) }), ...(r.author_name === null ? {} : { name: r.author_name }) },
  kind: r.kind,
  receivedAt: r.received_at.toISOString(),
});

export function createCommunityIndex(d: {
  sql: Db;
  verifier: () => Promise<CommunityVerifier>;
  /** Charges one chain-reading verification: 0 if allowed, else seconds to wait. */
  budget?: () => number | Promise<number>;
  /** Fixed event codes only. */
  log?: (e: Record<string, string | number>) => void;
  now?: () => number;
}): CommunityIndex {
  const now = d.now ?? Date.now;
  const global = createRateLimiter({ name: 'community.global', limit: COMMUNITY_SUBMISSIONS_PER_HOUR, windowMs: 3_600_000 });
  const budget = d.budget ?? (() => global.hit('all'));
  const refuse = (code: CommunityRefusal, extra: Omit<Extract<CommunitySubmitResult, { status: 'refused' }>, 'status' | 'code'> = {}): CommunitySubmitResult => ({ status: 'refused', code, ...extra });

  // The reporter key is an HMAC of the client address under a salt kept in discovery.meta, so a stored report never holds an address.
  let salt: Promise<string> | undefined;
  const reporterKey = async (clientKey: string) => {
    salt ??= (async () => {
      await d.sql`insert into discovery.meta (key, value) values ('community_report_salt', ${randomBytes(32).toString('hex')}) on conflict (key) do nothing`;
      const rows = (await d.sql`select value from discovery.meta where key = 'community_report_salt'`) as { value: string }[];
      return rows[0]!.value;
    })().catch((e) => ((salt = undefined), Promise.reject(e)));
    return createHmac('sha256', await salt).update(clientKey).digest('hex');
  };

  return {
    async submit(raw) {
      // 1. pure checks
      let t: SignedCommunityTemplate;
      try {
        t = parseSignedCommunityTemplate(raw);
      } catch {
        return refuse('malformed');
      }
      if (t.author.network !== COMMUNITY_NETWORK) return refuse('wrong_network');
      if (t.kind !== COMMUNITY_KIND) return refuse('wrong_kind');
      const draft = handoffProblem(t.body);
      if ('problem' in draft) return refuse('bad_draft', { problem: draft.problem });
      const name = t.author.name;
      if (name !== undefined && isReservedName(name)) return refuse('name_reserved');
      const sha256 = await templateHash(t);

      // 2. one index read
      if ((await d.sql`select 1 from discovery.community_templates where sha256 = ${sha256}`).length > 0) return { status: 'already_received', sha256 };
      const others = (await d.sql`select count(*)::int as n from discovery.community_templates
                                  where network = ${t.author.network} and author = ${t.author.address} and slug <> ${t.slug}
                                    and status = 'listed' and anchor = 'anchored'`) as { n: number }[];
      if (others[0]!.n >= MAX_LISTED_PER_AUTHOR) return refuse('author_limit');
      // A document's handle applies only when it was signed after the key's last handle claim (a template or a change),
      // so re-pushing an old version cannot undo a rename. A future createdAt counts as now, so it cannot lock the key.
      const claimedAt = new Date(Math.min(Date.parse(t.createdAt), now()));
      const held = (await d.sql`select issued_at from discovery.community_authors where network = ${t.author.network} and address = ${t.author.address}`) as { issued_at: Date }[];
      const rename = name !== undefined && (held.length === 0 || claimedAt > held[0]!.issued_at);
      const nameTaken = async (q: Db) =>
        rename &&
        ((await q`select 1 from discovery.community_authors where name = ${name} and not (network = ${t.author.network} and address = ${t.author.address})`) as unknown[]).length > 0;
      if (await nameTaken(d.sql)) return refuse('name_taken');

      // 3. budget, then the chain: signature (local), the author's agent, the anchor
      const wait = await budget();
      if (wait) return refuse('rate_limited', { retryAfter: wait });
      let v;
      try {
        const { adapter, anchors } = await d.verifier();
        v = await verifyCommunityTemplate(t, { adapter, anchors });
      } catch {
        d.log?.({ event: 'community_chain_unavailable' });
        return refuse('chain_unavailable');
      }
      if (!v.ok) return v.failure.check === 'identity' && v.failure.reason === 'unreachable' ? refuse('chain_unavailable') : refuse('not_verified', { failure: v.failure });
      if (v.anchor === 'unchecked') return refuse('chain_unavailable');
      if (v.anchor !== 'anchored') return refuse('not_anchored');

      // The anchor now names this version, so every other row for the slug is superseded, in the same transaction.
      let stored: boolean;
      try {
        stored = await d.sql.begin(async (raw) => {
          const tx = raw as unknown as Db;
          if (rename) {
            if (await nameTaken(tx)) return false; // taken between the first look and now
            await tx`insert into discovery.community_authors (network, address, name, issued_at) values (${t.author.network}, ${t.author.address}, ${name!}, ${claimedAt})
                     on conflict (network, address) do update set name = excluded.name, issued_at = excluded.issued_at, updated_at = now()
                     where discovery.community_authors.issued_at < excluded.issued_at`;
          }
          await tx`update discovery.community_templates set anchor = 'superseded', anchor_checked_at = now()
                   where network = ${t.author.network} and author = ${t.author.address} and slug = ${t.slug} and anchor = 'anchored'`;
          await tx`insert into discovery.community_templates
                     (sha256, network, author, slug, version, agent_id, author_name, title, summary, kind, document, anchor)
                   values (${sha256}, ${t.author.network}, ${t.author.address}, ${t.slug}, ${t.version},
                           ${t.author.agentId === undefined ? null : Number(t.author.agentId)}, ${name ?? null}, ${t.title}, ${t.summary}, ${t.kind},
                           ${v.template as unknown as Record<string, unknown>}, 'anchored')
                   on conflict (sha256) do nothing`;
          return true;
        });
      } catch (e) {
        if ((e as { errno?: string } | null)?.errno !== '23505') throw e;
        stored = false; // two keys raced for one handle: the unique index chose the other
      }
      if (!stored) return refuse('name_taken');
      return { status: 'listed', sha256 };
    },

    async list(o = {}) {
      const limit = Math.min(Math.max(1, Math.trunc(o.limit ?? 50)), LIST_MAX);
      const q = o.q?.trim().slice(0, 64);
      const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const rows = (await d.sql`select t.sha256, t.slug, t.version, t.title, t.summary, t.network, t.author, t.agent_id, h.name as author_name, t.kind, t.received_at
                                from discovery.community_templates t
                                left join discovery.community_authors h on h.network = t.network and h.address = t.author
                                where status = 'listed' and anchor = 'anchored'
                                  and (${like}::text is null or t.title ilike ${like} or t.summary ilike ${like})
                                order by received_at desc limit ${limit}`) as Row[];
      return rows.map(listed);
    },

    async get(sha256) {
      if (!SHA.test(sha256)) return null;
      const rows = (await d.sql`select t.sha256, t.slug, t.version, t.title, t.summary, t.network, t.author, t.agent_id, h.name as author_name, t.kind, t.received_at, t.document
                                from discovery.community_templates t
                                left join discovery.community_authors h on h.network = t.network and h.address = t.author
                                where t.sha256 = ${sha256} and status = 'listed' and anchor = 'anchored'`) as Row[];
      const r = rows[0];
      if (!r?.document) return null;
      if (typeof r.document === 'string') r.document = JSON.parse(r.document) as SignedCommunityTemplate; // jsonb can arrive as text
      // Stored only after these checks passed; re-run so a later tightening of the Builder's rules applies to old rows too.
      const draft = handoffProblem(r.document.body);
      if ('problem' in draft) return null;
      return { ...listed(r), document: r.document, draft: draft.draft };
    },

    async report(sha256, clientKey, reason) {
      if (!SHA.test(sha256)) return 'not_found';
      const reporter = await reporterKey(clientKey);
      return d.sql.begin(async (tx) => {
        const known = (await tx`select 1 from discovery.community_templates where sha256 = ${sha256} for update`) as unknown[];
        if (known.length === 0) return 'not_found' as const;
        const added = (await tx`insert into discovery.community_template_reports (sha256, reporter, reason) values (${sha256}, ${reporter}, ${reason})
                                on conflict do nothing returning sha256`) as unknown[];
        if (added.length === 0) return 'already_reported' as const;
        await tx`update discovery.community_templates
                 set reports = reports + 1,
                     status = case when reports + 1 >= ${REPORTS_TO_HIDE} then 'hidden' else status end,
                     hidden_reason = case when reports + 1 >= ${REPORTS_TO_HIDE} and status = 'listed' then 'reports' else hidden_reason end
                 where sha256 = ${sha256}`;
        return 'reported' as const;
      });
    },

    async setHandle(raw) {
      const refuse = (code: HandleRefusal): HandleChangeResult => ({ status: 'refused', code });
      const network = (raw as { network?: unknown } | null)?.network;
      if (typeof raw !== 'object' || raw === null) return refuse('malformed');
      if (network !== COMMUNITY_NETWORK) return refuse(typeof network === 'string' ? 'wrong_network' : 'malformed');
      let v;
      try {
        v = await verifyHandleChange(raw, (await d.verifier()).adapter);
      } catch {
        d.log?.({ event: 'community_chain_unavailable' });
        return refuse('chain_unavailable');
      }
      if (!v.ok) return refuse(v.reason === 'malformed' ? 'malformed' : 'not_verified');
      const h = v.change;
      if (h.name !== null && isReservedName(h.name)) return refuse('name_reserved');
      const issuedAt = new Date(h.issuedAt);
      if (Math.abs(issuedAt.getTime() - now()) > HANDLE_CHANGE_WINDOW_MS) return refuse('not_fresh');

      try {
        const r = await d.sql.begin(async (raw) => {
          const tx = raw as unknown as Db;
          const held = (await tx`select issued_at from discovery.community_authors where network = ${h.network} and address = ${h.address} for update`) as { issued_at: Date }[];
          if (held.length > 0 && issuedAt <= held[0]!.issued_at) return 'not_fresh' as const; // a replay, or older than the last claim
          if (h.name !== null && ((await tx`select 1 from discovery.community_authors where name = ${h.name} and not (network = ${h.network} and address = ${h.address})`) as unknown[]).length > 0) {
            return 'name_taken' as const;
          }
          await tx`insert into discovery.community_authors (network, address, name, issued_at) values (${h.network}, ${h.address}, ${h.name}, ${issuedAt})
                   on conflict (network, address) do update set name = excluded.name, issued_at = excluded.issued_at, updated_at = now()`;
          return 'changed' as const;
        });
        return r === 'changed' ? { status: 'changed', name: h.name } : refuse(r);
      } catch (e) {
        if ((e as { errno?: string } | null)?.errno !== '23505') throw e;
        return refuse('name_taken'); // two keys raced for one handle
      }
    },

    async recheck() {
      const rows = (await d.sql`select sha256, slug, author, network from discovery.community_templates
                                where anchor = 'anchored' and anchor_checked_at < now() - (${RECHECK_AFTER_MS}::double precision * interval '1 millisecond')
                                order by anchor_checked_at limit ${RECHECK_BATCH}`) as { sha256: string; slug: string; author: string; network: string }[];
      if (rows.length === 0) return 0;
      const { anchors } = await d.verifier();
      let checked = 0;
      for (const r of rows) {
        if (r.network !== anchors.network) continue;
        let held: string | null;
        try {
          held = await anchors.readAnchor(r.author, r.slug);
        } catch {
          d.log?.({ event: 'community_recheck_unavailable' });
          break; // Horizon is down: keep the rows as they are and try again next round
        }
        await d.sql`update discovery.community_templates set anchor = ${held === r.sha256 ? 'anchored' : 'superseded'}, anchor_checked_at = now() where sha256 = ${r.sha256}`;
        checked++;
      }
      return checked;
    },
  };
}
