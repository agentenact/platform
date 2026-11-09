/**
 * The owner MCP server: `POST /mcp` with `Authorization: Bearer ae_pat_…` (account/access-tokens.ts). From a harness
 * (Claude Code, Codex, Hermes) the owner can see their own agents, talk to them, read what they did and pause or resume
 * them. It is the panel's owner surface as MCP tools, nothing more: the same read models, the same chat runner (same
 * budgets, same kill switch, same one-chat-per-agent lock as the panel), the same pause/resume. The tools pay no one:
 * these are the owner's own agents (a chat may still hire within the agent's own hire limits, as a panel chat may). With
 * `reads` it also carries the free discovery reads a hosted hirer gets (find_agents, get_agent, verify_record), so one
 * key and one server cover finding and checking other agents too. With `hire` it carries hire_agent: the owner tells one
 * of their own agents to hire another agent, paid from that agent's wallet through the same hirer a panel chat uses (the
 * vault signs within the agent's caps, a spend row per payment, the library's payment guard before any signature), as a
 * chat-mode run of its own so the per-run cap and the run history apply. Each agent's paid services stay at
 * `POST /a/<uuid>/mcp`; the library's `agentenact-mcp` remains for paying from a wallet on the owner's own machine.
 *
 * Stateless Streamable HTTP like signer/mcp.ts: the server is built per request for the token's user, so a tool can
 * only ever name that user's agents (every read below is scoped by user id; a foreign or unknown agent is not_found).
 */
import { createMcpServer, handleMcpHttp } from 'agentenact/mcp';
import { isToolRefusal, toolRefusal, type OrchestratorTool } from 'agentenact/orchestrate';
import type { AccessTokens } from '../account/access-tokens.js';
import type { Activity } from '../activity/index.js';
import type { Agents } from '../agents/index.js';
import type { Db } from '../db/index.js';
import { isHttpError, safeCause } from '../errors.js';
import type { ChatMessage, OwnerRuns } from '../loop/owner.js';
import type { Runs, RunView } from '../runs/index.js';
import type { Specs } from '../specs/index.js';
import type { AgentReads } from '../tools/agents.js';
import { hireUrl } from '../tools/schemas.js';
import { MAX_HIRE_PER_CALL_USDC } from '../specs/schema.js';
import { emptyUsage } from '../runs/index.js';
import type { HireOutcome, HireRequest } from '../signer/hire.js';
import { createRateLimiter } from '../gateway/rate-limit.js';
import type { ChatLock } from './chat-lock.js';

export const OWNER_MCP_MAX_BODY = 128 * 1024;
/** Tool calls per account per minute, all tools together. */
export const OWNER_MCP_CALLS_PER_MINUTE = 60;
/** Pause and resume per account per hour (the panel's own write limit). */
export const OWNER_MCP_WRITES_PER_HOUR = 30;
export const MESSAGE_MAX = 3000;
/** Earlier turns a harness may send with a message; with the new one it stays inside the panel's 20. */
export const HISTORY_MAX = 19;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface OwnerMcpDeps {
  sql: Db;
  tokens: Pick<AccessTokens, 'verify'>;
  activity: Pick<Activity, 'overview' | 'feed'>;
  runs: Pick<Runs, 'recent' | 'getOwned' | 'start' | 'finish' | 'annotate'>;
  chat: Pick<OwnerRuns, 'openChat'>;
  chatLock: ChatLock;
  agents: Pick<Agents, 'pause' | 'resume'>;
  specs: Pick<Specs, 'liveServices'>;
  /** Free reads of other agents (tools/agents.ts): discovery index, one profile, record checks. Absent: no such tools. */
  reads?: AgentReads;
  /** The hosted hirer (signer/hire.ts). Absent: no hire_agent. */
  hire?: (r: HireRequest) => Promise<HireOutcome>;
  /** The global kill switch: no new model call while it is on. */
  killed: () => boolean;
  publicBaseUrl: string;
  version: string;
  log?: (e: Record<string, unknown>) => void;
  now?: () => number;
}

export interface OwnerMcp {
  handle(req: Request): Promise<Response>;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  stellar_address: string | null;
  agent_id: string | null;
}

const runLine = (r: RunView) => ({
  id: r.id,
  mode: r.mode,
  status: r.status,
  summary: r.summary,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  usdcSpent: r.usdcSpent,
  usdcEarned: r.usdcEarned,
  settlementTx: r.settlementTx,
});

/** An httpError from the panel's own code becomes a tool refusal with the same code; anything else stays internal. */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isHttpError(e) && (e.status < 500 || e.code === 'killed')) throw toolRefusal(e.code);
    throw e;
  }
}

export function createOwnerMcp(d: OwnerMcpDeps): OwnerMcp {
  const calls = createRateLimiter({ name: 'owner_mcp.calls', limit: OWNER_MCP_CALLS_PER_MINUTE, windowMs: 60_000, ...(d.now ? { now: d.now } : {}) });
  const writes = createRateLimiter({ name: 'owner_mcp.writes', limit: OWNER_MCP_WRITES_PER_HOUR, windowMs: 3_600_000, ...(d.now ? { now: d.now } : {}) });

  function toolsFor(userId: string): OrchestratorTool[] {
    const mine = async () =>
      (await d.sql`select id, name, status, stellar_address, agent_id from app.agents
                   where user_id = ${userId} and status <> 'revoked' order by created_at`) as AgentRow[];

    /** The named agent, or the only one when none is named. Unknown and foreign are the same not_found. */
    async function pick(a: Record<string, unknown>): Promise<AgentRow> {
      const all = await mine();
      if (a.agent === undefined) {
        if (all.length === 1) return all[0]!;
        throw toolRefusal(all.length === 0 ? 'no_agents' : 'name_the_agent');
      }
      if (typeof a.agent !== 'string' || !UUID.test(a.agent)) throw toolRefusal('bad_agent');
      const hit = all.find((r) => r.id === a.agent!.toString().toLowerCase());
      if (!hit) throw toolRefusal('not_found');
      return hit;
    }
    const counted = async <T>(fn: () => Promise<T>): Promise<T> => {
      const wait = await calls.hit(userId);
      if (wait) throw toolRefusal('rate_limited');
      return refusing(fn);
    };
    const args = (raw: unknown) => {
      if (raw !== undefined && raw !== null && !isObj(raw)) throw toolRefusal('bad_arguments');
      return (raw ?? {}) as Record<string, unknown>;
    };
    const agentArg = { type: 'string', description: 'The agent id from list_my_agents. May be left out only when you have exactly one agent; with several, name it.' } as const;
    const read = { readOnlyHint: true, openWorldHint: true } as const;

    /** A read's own tool error (agent_not_found, unsupported_chain) is a refusal; anything else stays internal. */
    const readRefusing = <T>(fn: () => Promise<T>): Promise<T> =>
      counted(async () => {
        try {
          return await fn();
        } catch (e) {
          if (isToolRefusal(e)) throw e;
          const code = (e as { code?: unknown }).code;
          if (typeof code === 'string' && /^[a-z_]+$/.test(code)) throw toolRefusal(code);
          throw e;
        }
      });
    const readTools = (reads: AgentReads): OrchestratorTool[] => [
      {
        name: 'find_agents',
        description:
          'Search agents registered on Stellar testnet by what they publish about themselves (their own claims). Returns ids, whether each can be hired (and its lowest published price) and proven sales; for_hire: true lists only agents that can be hired. Call get_agent for a service url and price.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 200 }, for_hire: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 }, cursor: { type: 'string', maxLength: 200 } },
          additionalProperties: false,
        },
        annotations: read,
        run: (raw) =>
          readRefusing(async () => {
            const x = args(raw);
            const limit = x.limit === undefined ? undefined : Number(x.limit);
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25)) throw toolRefusal('bad_limit');
            if ((x.query !== undefined && typeof x.query !== 'string') || (x.cursor !== undefined && typeof x.cursor !== 'string')) throw toolRefusal('bad_arguments');
            if (x.for_hire !== undefined && typeof x.for_hire !== 'boolean') throw toolRefusal('bad_arguments');
            return reads.find({
              ...(x.query ? { query: x.query as string } : {}),
              ...(limit ? { limit } : {}),
              ...(x.cursor ? { cursor: x.cursor as string } : {}),
              ...(x.for_hire ? { forHire: true } : {}),
            });
          }),
      },
      {
        name: 'get_agent',
        description: 'Any agent by its on-chain id: owner and wallet (chain facts), proven sales, and its self-published services with url, price in USDC and input.',
        inputSchema: { type: 'object', properties: { agent_id: { type: 'string', pattern: '^[0-9]{1,12}$' } }, required: ['agent_id'], additionalProperties: false },
        annotations: read,
        run: (raw) =>
          readRefusing(async () => {
            const x = args(raw);
            if (typeof x.agent_id !== 'string' || !/^[0-9]{1,12}$/.test(x.agent_id)) throw toolRefusal('bad_agent_id');
            return reads.get(Number(x.agent_id));
          }),
      },
      {
        name: 'verify_record',
        description:
          'Check an Enactment Record from public chain data (signature, settlement, timing, identity), and optionally that an exact input or output is what it covers. Proves who produced it and that it was paid for, never that it is correct.',
        inputSchema: {
          type: 'object',
          properties: {
            record: { description: 'The record: its JSON, or the base64url header value.' },
            output: { type: 'string', maxLength: 64 * 1024 },
            input: { type: 'string', maxLength: 64 * 1024 },
          },
          required: ['record'],
          additionalProperties: false,
        },
        annotations: read,
        run: (raw) =>
          readRefusing(async () => {
            const x = args(raw);
            if (x.record === undefined || (x.output !== undefined && typeof x.output !== 'string') || (x.input !== undefined && typeof x.input !== 'string')) {
              throw toolRefusal('bad_arguments');
            }
            return reads.verify({ record: x.record, ...(x.output !== undefined ? { output: x.output as string } : {}), ...(x.input !== undefined ? { input: x.input as string } : {}) });
          }),
      },
    ];

    const USDC = /^(0|[1-9][0-9]*)(\.[0-9]{1,7})?$/;
    const hireTool = (hire: NonNullable<OwnerMcpDeps['hire']>): OrchestratorTool => ({
      name: 'hire_agent',
      description:
        `Have one of your agents hire another agent: POST JSON to its paid service url (from get_agent), paid in testnet USDC (Stellar testnet, or Base Sepolia when the seller takes only that) ` +
        `from your agent's own wallet on that network, at most ${MAX_HIRE_PER_CALL_USDC} USDC a call and within its own caps. Returns the output, ` +
        `the payment and whether its Enactment Record verified. Recorded as a run of your agent.`,
      inputSchema: {
        type: 'object',
        properties: {
          agent: agentArg,
          url: { type: 'string', maxLength: 500, description: 'The service url, https.' },
          input: { description: 'The JSON body the service asks for.' },
          max_usdc: { type: 'string', description: `The most to pay for this call, up to ${MAX_HIRE_PER_CALL_USDC}.` },
        },
        required: ['url'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: false },
      run: (raw, signal) =>
        counted(async () => {
          const x = args(raw);
          if (typeof x.url !== 'string' || !hireUrl.safeParse(x.url).success) throw toolRefusal('bad_url');
          let maxUsdc = MAX_HIRE_PER_CALL_USDC;
          if (x.max_usdc !== undefined) {
            if (typeof x.max_usdc !== 'string' || !USDC.test(x.max_usdc) || Number(x.max_usdc) <= 0 || Number(x.max_usdc) > Number(MAX_HIRE_PER_CALL_USDC)) throw toolRefusal('bad_max_usdc');
            maxUsdc = x.max_usdc;
          }
          const a = await pick(x);
          if (d.killed()) throw toolRefusal('killed');
          // Money: counted with pause/resume against the hourly write limit.
          if (await writes.hit(userId)) throw toolRefusal('rate_limited');
          const runId = await d.runs.start({ agentId: a.id, mode: 'chat' });
          let r: HireOutcome;
          try {
            r = await hire({ agentId: a.id, runId, mode: 'chat', url: x.url, input: x.input, maxUsdc, ...(signal ? { signal } : {}) });
          } catch {
            // The hirer returns its failures; a throw here is unexpected and may follow a signature, so it reads as unknown.
            r = { ok: false, code: 'hire_failed', payment: 'unknown' };
          }
          // Nothing below may hide the money state: the run bookkeeping is best effort.
          const host = new URL(x.url).host;
          const paid = r.ok ? r.paidUsdc : (r.paidUsdc ?? null);
          await d.runs
            .finish(runId, { status: r.ok ? 'done' : 'error', stopReason: r.ok ? 'owner_hire' : `owner_hire_${r.code}`, usage: { ...emptyUsage(), toolCalls: 1 }, steps: [{ n: 1, tools: ['hire_agent'], inputTokens: 0, outputTokens: 0, finishReason: 'stop' }] })
            .then(() => d.runs.annotate(runId, r.ok ? `Hired ${host} from your AI tool${paid ? ` for ${paid} USDC` : ''}.` : `Tried to hire ${host} from your AI tool: ${r.code}.`))
            .catch(() => d.log?.({ event: 'owner_mcp_hire_run_failed', run: runId }));
          d.log?.({ event: 'owner_mcp_hire', user: userId, agent: a.id, run: runId, ok: r.ok, payment: r.ok ? r.payment : (r.payment ?? 'none') });
          if (!r.ok) {
            if (r.payment) return { agent: a.id, runId, error: r.code, payment: r.payment, transaction: null, paid_usdc: r.paidUsdc ?? null };
            throw toolRefusal(r.code);
          }
          return {
            agent: a.id,
            runId,
            status: r.status,
            output: r.output,
            payment: r.payment,
            transaction: r.transaction,
            paid_usdc: r.paidUsdc,
            record: r.record,
            failed_checks: r.failedChecks,
            consistent: r.consistent,
          };
        }),
    });

    return [
      {
        name: 'list_my_agents',
        description: 'Your own AgentEnact agents (made in the panel): id, name, status, Stellar address and on-chain agent id.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: read,
        run: (raw) =>
          counted(async () => {
            args(raw);
            const rows = await mine();
            return {
              agents: rows.map((r) => ({
                id: r.id,
                name: r.name,
                status: r.status,
                address: r.stellar_address,
                agentId: r.agent_id,
                profile: `${d.publicBaseUrl}/a/${r.id}/agent.json`,
              })),
            };
          }),
      },
      {
        name: 'get_my_agent',
        description:
          'One of your agents: status, next check, alerts, checks today, earnings, budget used, the latest reading, and the paid ' +
          'services it sells (slug, price).',
        inputSchema: { type: 'object', properties: { agent: agentArg }, additionalProperties: false },
        annotations: read,
        run: (raw) =>
          counted(async () => {
            const a = await pick(args(raw));
            const [overview, services] = await Promise.all([d.activity.overview(userId, a.id), d.specs.liveServices(a.id)]);
            return {
              id: a.id,
              address: a.stellar_address,
              agentId: a.agent_id,
              ...overview,
              services: services.map((s) => ({ slug: s.slug, description: s.description, priceUsdc: s.priceUsdc })),
            };
          }),
      },
      {
        name: 'message_agent',
        description:
          'Talk to one of your agents, as in the panel chat: it answers with its own tools and description, within its budget and limits. ' +
          'Send earlier turns in `history` to continue a conversation. One conversation per agent at a time (chat_busy otherwise).',
        inputSchema: {
          type: 'object',
          properties: {
            agent: agentArg,
            message: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX },
            history: {
              type: 'array',
              maxItems: HISTORY_MAX,
              description: 'Earlier turns, oldest first.',
              items: {
                type: 'object',
                properties: { role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string', minLength: 1, maxLength: MESSAGE_MAX } },
                required: ['role', 'content'],
                additionalProperties: false,
              },
            },
          },
          required: ['message'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, openWorldHint: true },
        run: (raw, signal) =>
          counted(async () => {
            const x = args(raw);
            if (typeof x.message !== 'string' || x.message.length < 1 || x.message.length > MESSAGE_MAX) throw toolRefusal('bad_message');
            const history: ChatMessage[] = [];
            if (x.history !== undefined) {
              if (!Array.isArray(x.history) || x.history.length > HISTORY_MAX) throw toolRefusal('bad_history');
              for (const m of x.history) {
                if (!isObj(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length < 1 || m.content.length > MESSAGE_MAX) {
                  throw toolRefusal('bad_history');
                }
                history.push({ role: m.role, content: m.content });
              }
            }
            const a = await pick(x);
            if (d.killed()) throw toolRefusal('killed');
            const session = await d.chat.openChat(userId, a.id);
            const release = await d.chatLock.take(a.id);
            if (!release) throw toolRefusal('chat_busy');
            try {
              let streamed = '';
              const out = await session.run([...history, { role: 'user', content: x.message }], {
                onDelta: (t) => {
                  streamed += t;
                },
                ...(signal ? { signal } : {}),
              });
              if (out.status === 'error') throw toolRefusal('agent_failed');
              return { agent: a.id, runId: out.runId, status: out.status, reply: out.finalText || out.text || streamed };
            } finally {
              release();
            }
          }),
      },
      {
        name: 'list_runs',
        description: 'What one of your agents did lately: checks, chats and paid services, newest first, with their one-line summaries.',
        inputSchema: { type: 'object', properties: { agent: agentArg, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, additionalProperties: false },
        annotations: read,
        run: (raw) =>
          counted(async () => {
            const x = args(raw);
            const limit = x.limit === undefined ? 20 : Number(x.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw toolRefusal('bad_limit');
            const a = await pick(x);
            return { agent: a.id, runs: (await d.runs.recent(userId, a.id, limit)).map(runLine) };
          }),
      },
      {
        name: 'get_run',
        description: 'One run of one of your agents: every step with the tools it called, tokens, USDC spent and earned, and the settlement tx of a paid run.',
        inputSchema: { type: 'object', properties: { agent: agentArg, run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false },
        annotations: read,
        run: (raw) =>
          counted(async () => {
            const x = args(raw);
            if (typeof x.run_id !== 'string' || !UUID.test(x.run_id)) throw toolRefusal('bad_run_id');
            const a = await pick(x);
            const run = await d.runs.getOwned(userId, a.id, x.run_id);
            if (!run) throw toolRefusal('not_found');
            return {
              ...runLine(run),
              steps: run.steps,
              model: run.model,
              tokens: { input: run.inputTokens, output: run.outputTokens, cacheRead: run.cacheReadTokens, cacheWrite: run.cacheWriteTokens },
              toolCalls: run.toolCalls,
              ...(run.result ? { result: run.result } : {}),
              ...(run.settlementTx ? { record: `${d.publicBaseUrl}/a/${a.id}/records/${run.settlementTx}` } : {}),
            };
          }),
      },
      {
        name: 'get_activity',
        description: 'The activity feed of one of your agents, as in the panel: alerts it sent, sales, quiet days and problems.',
        inputSchema: { type: 'object', properties: { agent: agentArg, days: { type: 'integer', minimum: 1, maximum: 30, default: 7 } }, additionalProperties: false },
        annotations: read,
        run: (raw) =>
          counted(async () => {
            const x = args(raw);
            const days = x.days === undefined ? 7 : Number(x.days);
            if (!Number.isInteger(days) || days < 1 || days > 30) throw toolRefusal('bad_days');
            const a = await pick(x);
            return { agent: a.id, items: await d.activity.feed(userId, a.id, { days }) };
          }),
      },
      ...(d.reads ? readTools(d.reads) : []),
      ...(d.hire ? [hireTool(d.hire)] : []),
      ...(['pause', 'resume'] as const).map(
        (verb): OrchestratorTool => ({
          name: `${verb}_agent`,
          description:
            verb === 'pause'
              ? 'Pause one of your agents: its checks and its paid services stop until you resume it.'
              : 'Resume a paused agent: its checks and paid services start again, with no new approval.',
          inputSchema: { type: 'object', properties: { agent: agentArg }, additionalProperties: false },
          annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
          run: (raw) =>
            counted(async () => {
              const a = await pick(args(raw));
              const wait = await writes.hit(userId);
              if (wait) throw toolRefusal('rate_limited');
              await d.agents[verb](userId, a.id);
              d.log?.({ event: 'owner_mcp_write', user: userId, agent: a.id, action: verb });
              return { agent: a.id, status: verb === 'pause' ? 'paused' : 'active' };
            }),
        }),
      ),
    ];
  }

  return {
    async handle(req) {
      if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
      const h = req.headers.get('authorization');
      const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
      const who = m ? await d.tokens.verify(m[1]!) : null;
      // The MCP authorization spec's answer to a missing or bad credential.
      if (!who) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="agentenact"' } });
      const server = createMcpServer({
        name: 'agentenact-owner',
        version: d.version,
        tools: toolsFor(who.userId),
        instructions:
          'Your own AgentEnact agents: list them, read what they did, talk to them and pause or resume them' +
          (d.reads ? '; find any agent on chain and check its records (find_agents, get_agent, verify_record)' : '') +
          (d.hire ? '; and have one of your agents hire another (hire_agent), paid from that agent\'s wallet within its caps' : '') +
          '. Only hire_agent pays; a message runs the agent within its own budget and limits, exactly like the panel chat.',
        onError: (e) => d.log?.({ event: 'owner_mcp_error', user: who.userId, ...safeCause(e) }),
      });
      return handleMcpHttp(server, req, { maxBytes: OWNER_MCP_MAX_BODY });
    },
  };
}
