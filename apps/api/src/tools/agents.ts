/**
 * `find_agents`, `get_agent`, `verify_record`: what a hosted agent reads before and after it hires (MCP plan step 4).
 * Owner runs get them together with `hire_agent`; services never do. Free reads: no money, no key.
 * - find_agents: the discovery index (the same as /public/agents), names and services as the agents publish them.
 * - get_agent: the discovery profile (chain facts) plus the service urls from the agent's own registration document,
 *   read through safeFetch (no redirects, 64 KB). Everything an agent says about itself is returned under selfPublished.
 * - verify_record: the library's four checks on testnet, plus optional exact input/output hash checks.
 * A verified record proves who produced an output and that it was paid for, never that it is correct.
 */
import { bytesToHex, decodeRecordHeader, parseRecord, recordDigest, sha256Hex, verifyRecord, type ChainAdapter, type EnactmentRecord } from 'agentenact';
import { fetchAgentDocument, parseAgentDocument, type SelfPublished } from 'agentenact/orchestrate';
import type { Discovery } from '../discovery/queries.js';
import { toolError } from './errors.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AgentReads {
  find(a: { query?: string; limit?: number; cursor?: string; forHire?: boolean }): Promise<unknown>;
  get(agentId: number): Promise<unknown>;
  verify(a: { record: unknown; output?: string; input?: string }): Promise<unknown>;
}

export function createAgentReads(d: {
  discovery: Pick<Discovery, 'agents' | 'profile'>;
  /** The registry uri the indexer holds for an agent ('' when none). */
  agentUri: (agentId: number) => Promise<string | null>;
  fetch: Fetch;
  adapter: ChainAdapter;
}): AgentReads {
  return {
    async find({ query, limit, cursor, forHire }) {
      const r = await d.discovery.agents({
        ...(query ? { q: query } : {}),
        ...(cursor ? { cursor } : {}),
        ...(forHire ? { filter: { hire: true } } : {}),
        limit: Math.min(limit ?? 10, 25),
      });
      return {
        network: 'stellar:testnet',
        agents: r.items.map((a) => ({
          agent_id: String(a.id),
          builder: a.builder,
          selfPublished: a.selfPublished,
          // can be called (HireOffer): price_usdc is the lowest published price (null: quoted when called); service and
          // url name what to pass hire_agent (null: read get_agent for it)
          for_hire: a.hire ? { price_usdc: a.hire.priceUsdc, service: a.hire.service?.slug ?? null, url: a.hire.service?.url ?? null } : null,
          proven_sales: a.provenSales,
          last_active_at: a.lastActiveAt,
        })),
        next: r.next,
      };
    },

    async get(agentId) {
      const p = await d.discovery.profile(agentId, { limit: 5 });
      if (!p || p.hidden) throw toolError('agent_not_found');
      const uri = (await d.agentUri(agentId)) ?? '';
      let document: SelfPublished | null = null;
      let documentError: string | undefined;
      if (!uri) documentError = 'no uri';
      else {
        try {
          document = parseAgentDocument(await fetchAgentDocument(uri, d.fetch as typeof fetch));
        } catch {
          documentError = 'unreadable';
        }
      }
      return {
        agent_id: String(p.id),
        network: 'stellar:testnet',
        owner: p.owner,
        wallet: p.wallet,
        builder: p.builder,
        proven_sales: p.totals.provenSales,
        uri,
        selfPublished: document ?? (p.selfPublished ? { ...p.selfPublished, endpoints: [] } : null),
        ...(documentError ? { documentError } : {}),
      };
    },

    async verify({ record, output, input }) {
      let rec: EnactmentRecord;
      try {
        rec = typeof record === 'string' ? decodeRecordHeader(record) : parseRecord(record);
      } catch {
        return { ok: false, failure: { check: 'record', reason: 'malformed' } };
      }
      if (rec.agent.chain !== d.adapter.chain) throw toolError('unsupported_chain');
      const v = await verifyRecord(rec, d.adapter);
      const hashes: Record<string, boolean> = {};
      if (output !== undefined) hashes.output = (await sha256Hex(output)) === rec.output.sha256;
      if (input !== undefined) hashes.input = (await sha256Hex(input)) === rec.input.sha256;
      return {
        ok: v.ok,
        checks: v.checks,
        ...(v.failure ? { failure: v.failure } : {}),
        record_digest: bytesToHex(await recordDigest(rec)),
        ...(Object.keys(hashes).length ? { hashes } : {}),
      };
    },
  };
}
