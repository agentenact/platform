/**
 * `gateway`: one fetch handler. Owner routes authenticate with a Supabase access token
 * (Authorization: Bearer); there are no cookies, so CORS (the app's own origins only) is the boundary.
 * Every owner query is scoped by the caller's user id.
 */
import type { ServiceMcp } from '../signer/mcp.js';
import type { AccessTokens } from '../account/access-tokens.js';
import type { OwnerMcp } from '../owner-mcp/index.js';
import { AGENT_LIMITS, createAgents, type AgentLimits } from '../agents/index.js';
import type { FeeModel } from '../config.js';
import { bearerToken, type AuthVerifier } from '../account/auth.js';
import type { PasskeyAccount } from '../account/passkey.js';
import { ensureProfile, getProfile, type Profile } from '../account/profiles.js';
import type { SignRequests } from '../account/sign-requests.js';
import type { Db } from '../db/index.js';
import { httpError, isHttpError, safeCause } from '../errors.js';
import { bannedWord } from '../builder/words.js';
import type { RegistrationResponse } from '../owner-client/types.js';
import type { Provisioner, ProvisionState, ProvisionStep, StartOutcome } from '../provision/index.js';
import { DISCOVERY_HEADERS, discoveryRoutes, type DiscoveryRouteDeps } from './discovery.js';
import type { Records } from '../records/index.js';
import { checkDraft, DraftView } from '../builder/draft-schema.js';
import { builderRoutes, type BuilderDeps } from './builder.js';
import { panelRoutes, type PanelDeps } from './panel-routes.js';
import { skillRoutes, type SkillRouteDeps } from './skills-routes.js';
import { createRateLimiter, ipKey } from './rate-limit.js';
import { runtimeRoutes, type RuntimeDeps } from './runtime.js';
import type { ServiceEndpoint } from '../signer/serve.js';
import { priceOf, PUBLIC_HEADERS } from '../signer/serve.js';
import { parseSpec } from '../specs/schema.js';
import type { Specs } from '../specs/index.js';

export interface AppDeps {
  sql: Db;
  verify: AuthVerifier;
  passkey: PasskeyAccount;
  signRequests: Pick<SignRequests, 'pending' | 'sign' | 'reject'>;
  provisioner: Pick<Provisioner, 'start'>;
  /** The canonical web origin. */
  appOrigin: string;
  /**
   * Every web origin CORS may answer for (the canonical one is always included). A request whose Origin is one of
   * these gets it reflected; any other request gets no allow-origin. Absent: the canonical origin only.
   */
  appOrigins?: readonly string[];
  /** P3 owner runtime routes (spec, runs, webhook secret, chat). Absent in onboarding-only tests. */
  runtime?: RuntimeDeps;
  /** P4 builder panel routes (pause and resume, more to come). */
  panel?: PanelDeps;
  /** Skills from skills.sh: suggestions, reviews, approvals. Absent: those routes answer 404. */
  skills?: SkillRouteDeps;
  /** P4 anonymous drafting: the draft and edit routes. Absent: they answer 404. */
  builder?: BuilderDeps;
  /** P3b paid services: the endpoint (signer) and the live service list for agent.json. */
  services?: { endpoint: Pick<ServiceEndpoint, 'handle' | 'resourceUrl'>; specs: Pick<Specs, 'liveServices'>; mcp?: ServiceMcp };
  /** Public discovery reads under /public/. */
  discovery?: DiscoveryRouteDeps;
  /** P4 stored Enactment Records, served publicly at /a/:uuid/records/:tx. Absent: the route answers 404. */
  records?: Pick<Records, 'get'>;
  /** Routes the build's extensions add (extensions.ts), matched before the optional route groups below. */
  extraRoutes?: (h: { body<T>(req: Request): Promise<T> }) => Route[];
  /** The owner MCP server at POST /mcp (a harness talking to the owner's own agents). Absent: 404. */
  ownerMcp?: OwnerMcp;
  /** The owner's access tokens for that server, managed from the panel under /api/tokens. Absent: 404. */
  tokens?: Pick<AccessTokens, 'issue' | 'list' | 'revoke'>;
  /** How many agents an account may hold and make a day. Absent: AGENT_LIMITS. */
  agentLimits?: AgentLimits;
  /** Who pays an agent's reserves and fees (config.ts FeeModel). Absent: 'agent'. */
  feeModel?: FeeModel;
  log?: (e: Record<string, string | number>) => void;
}

/** The handler. `ip` is the client address as the server (or its proxy) saw it; main.ts supplies it. */
export type App = (req: Request, ip?: string) => Promise<Response>;

const MAX_BODY = 64 * 1024;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * Limits per hour. Signups are open and every passkey register deploys a wallet the sponsor pays for,
 * so register is tight per account and per IP (IPv6 by /64). options costs only a challenge write.
 * The IP is counted only after auth succeeds, so anonymous junk cannot spend a shared IP's budget.
 * A provision retry can spend sponsor fees too: 5 launches per account per hour.
 */
export const PASSKEY_REGISTER_PER_ACCOUNT = 5;
export const PASSKEY_REGISTER_PER_IP = 30;
export const PASSKEY_OPTIONS_PER_ACCOUNT = 30;
export const PASSKEY_OPTIONS_PER_IP = 100;
export const RETRY_LIMIT_PER_ACCOUNT = 5;
const HOUR_MS = 3_600_000;
/** Abandoned keys after which an agent is left to an operator instead of being retried again. */
// An owner stall resumes its key (no orphan); only other failures that leave something on chain abandon a key.
// Operators unblock with scripts/unblock-agent.ts.
export const MAX_ORPHANS = 3;
/** Spec §5.6.1 per-IP limit on paid calls (plan D3: through the apex proxy all callers share one address). */
export const PAID_PER_IP_PER_MIN = 30;
/** Owner MCP requests per IP per minute, before the token is looked at; the server limits each account on its own too. */
export const OWNER_MCP_PER_IP_PER_MIN = 120;
/** Access tokens an account may make per hour. */
export const TOKEN_ISSUES_PER_HOUR = 10;
const SLUG = '[a-z0-9][a-z0-9-]{0,39}';

/** Steps a retry may start from: nothing of the current run can be on chain (see the retry route). */
const RETRYABLE: ReadonlySet<ProvisionStep> = new Set<ProvisionStep>(['pending', 'key_ready', 'failed']);

/** Consecutive `registry_no_agent` deferrals after which it is no longer read as RPC lag (e.g. a testnet reset). */
const NO_AGENT_OPERATOR_STREAK = 3;

interface AgentRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  stellar_address: string | null;
  agent_id: string | null;
  provision_state: ProvisionState;
}

type LastStart = StartOutcome & { at: string };
/** Public paid surface: everything under /a/ answers with ACAO *, never the app's origin-bound CORS. */
export const isPaidPath = (path: string) => path.startsWith('/a/');
/** Public discovery surface: ACAO *, GET only (records intake adds POST). */
export const isPublicPath = (path: string) => path.startsWith('/public/');

/** The shutdown 503. `/a/` gets public CORS so a browser caller sees the status instead of a CORS failure. */
export function drainingResponse(path: string): Response {
  return new Response(null, { status: 503, headers: { ...(isPaidPath(path) ? PUBLIC_HEADERS : isPublicPath(path) ? DISCOVERY_HEADERS : {}), connection: 'close' } });
}

export type Handler = (req: Request, m: RegExpExecArray, ip: string | undefined) => Promise<Response>;
export type Route = [string, RegExp, Handler];

export function createApp(d: AppDeps): App {
  const allowedOrigins = new Set([d.appOrigin, ...(d.appOrigins ?? [])]);
  // Every app-CORS response is built with this marker as its allow-origin; `answerFor` replaces it per request.
  const cors: Record<string, string> = {
    'access-control-allow-origin': d.appOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
    'access-control-max-age': '600',
    // Lets the web panel read how long a 429 lasts.
    'access-control-expose-headers': 'retry-after',
    vary: 'Origin',
  };
  const publicHeaders: Record<string, string> = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' };
  const paidPreflight: Record<string, string> = {
    ...PUBLIC_HEADERS,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'content-type, payment-signature, access-control-expose-headers, agentenact-delegation, accept, mcp-protocol-version, mcp-session-id',
    'access-control-max-age': '600',
  };
  const publicPreflight: Record<string, string> = { ...DISCOVERY_HEADERS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' };
  const limits = {
    register: { account: createRateLimiter({ name: 'app.register_account', limit: PASSKEY_REGISTER_PER_ACCOUNT, windowMs: HOUR_MS }), ip: createRateLimiter({ name: 'app.register_ip', limit: PASSKEY_REGISTER_PER_IP, windowMs: HOUR_MS }) },
    options: { account: createRateLimiter({ name: 'app.options_account', limit: PASSKEY_OPTIONS_PER_ACCOUNT, windowMs: HOUR_MS }), ip: createRateLimiter({ name: 'app.options_ip', limit: PASSKEY_OPTIONS_PER_IP, windowMs: HOUR_MS }) },
  };
  const retries = createRateLimiter({ name: 'app.retries', limit: RETRY_LIMIT_PER_ACCOUNT, windowMs: HOUR_MS });
  const paidByIp = createRateLimiter({ name: 'app.paidByIp', limit: PAID_PER_IP_PER_MIN, windowMs: 60_000 });
  const ownerMcpByIp = createRateLimiter({ name: 'app.ownerMcpByIp', limit: OWNER_MCP_PER_IP_PER_MIN, windowMs: 60_000 });
  const tokenIssues = createRateLimiter({ name: 'app.tokenIssues', limit: TOKEN_ISSUES_PER_HOUR, windowMs: HOUR_MS });

  // A start's outcome is not saved on the agent when it changes nothing (a deferral), so the latest one is kept in
  // app.provision_starts for the status endpoint: any replica may answer it.
  const agentLimits = d.agentLimits ?? AGENT_LIMITS;
  const agents = createAgents(d.sql, { limits: agentLimits, feeModel: d.feeModel });
  const noteStart = async (id: string, o: LastStart, streak: 'inc' | 'reset' | 'keep') => {
    try {
      await d.sql`insert into app.provision_starts (agent_id, outcome, no_agent_streak, at)
                  values (${id}, ${o}, ${streak === 'inc' ? 1 : 0}, now())
                  on conflict (agent_id) do update set outcome = excluded.outcome, at = now(),
                    no_agent_streak = case ${streak} when 'inc' then app.provision_starts.no_agent_streak + 1
                                                     when 'reset' then 0 else app.provision_starts.no_agent_streak end`;
    } catch {
      d.log?.({ event: 'launch_note_failed', agent: id });
    }
  };
  const launch = (id: string) => {
    d.provisioner.start(id).then(
      (o) => {
        // Only a definite answer moves the streak: a busy/skipped/error start says nothing about the registry.
        const streak = o.outcome === 'deferred' && o.code === 'registry_no_agent' ? 'inc' : o.outcome === 'active' || o.outcome === 'failed' || o.outcome === 'deferred' ? 'reset' : 'keep';
        return noteStart(id, { ...o, at: new Date().toISOString() }, streak);
      },
      (e) => {
        d.log?.({ event: 'launch_error', agent: id, ...safeCause(e) });
        return noteStart(id, { outcome: 'error', at: new Date().toISOString() }, 'keep');
      },
    );
  };
  const lastStartOf = async (id: string): Promise<{ lastStart: LastStart | null; streak: number }> => {
    const [r] = (await d.sql`select outcome, no_agent_streak from app.provision_starts where agent_id = ${id}`) as { outcome: LastStart; no_agent_streak: number }[];
    return { lastStart: r?.outcome ?? null, streak: r?.no_agent_streak ?? 0 };
  };
  /** Persisted operator cases: a retry is refused. */
  const blocked = (a: AgentRow) => a.provision_state.error === 'bound_foreign_owner' || (a.provision_state.orphans?.length ?? 0) >= MAX_ORPHANS;
  /** Shown to the client. A no-agent streak flags but never blocks a retry (the registry may recover). */
  const needsOperator = (a: AgentRow, streak: number) => blocked(a) || streak >= NO_AGENT_OPERATOR_STREAK;

  const json = (status: number, body: unknown, headers: Record<string, string> = cors) =>
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: body === null ? headers : { ...headers, 'content-type': 'application/json' },
    });

  async function user(req: Request): Promise<Profile> {
    const token = bearerToken(req);
    if (!token) throw httpError(401, 'unauthorized');
    let u: Awaited<ReturnType<AuthVerifier>>;
    const startedAt = Date.now();
    try {
      u = await d.verify(token);
    } catch (e) {
      // A 503 the panel turns into "Something went wrong": the only trace of a slow or unreachable verifier.
      d.log?.({ event: 'auth_unavailable', ms: Date.now() - startedAt, ...safeCause(e) });
      throw httpError(503, 'auth_unavailable');
    }
    if (!u) throw httpError(401, 'unauthorized');
    // Write only when needed: an upsert per request would churn the row.
    const p = await getProfile(d.sql, u.id);
    return p && p.email === u.email ? p : ensureProfile(d.sql, u);
  }

  /** Auth is optional: no bearer is an anonymous visitor (null), a bad one is still a 401. */
  async function optionalUser(req: Request): Promise<Profile | null> {
    return bearerToken(req) ? user(req) : null;
  }

  function limited(retryAfter: number): never {
    throw Object.assign(httpError(429, 'rate_limited'), { retryAfter });
  }

  /** Auth first, then the IP (only authenticated hits count), then the account. Returns the profile. */
  async function passkeyUser(req: Request, ip: string | undefined, kind: keyof typeof limits): Promise<Profile> {
    const p = await user(req);
    const waitIp = ip ? await limits[kind].ip.hit(ipKey(ip)) : 0;
    if (waitIp) limited(waitIp);
    const wait = await limits[kind].account.hit(p.id);
    if (wait) limited(wait);
    return p;
  }

  async function body<T>(req: Request): Promise<T> {
    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY) throw httpError(413, 'too_large');
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY) throw httpError(413, 'too_large');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw httpError(400, 'bad_json');
    }
  }

  async function ownAgent(userId: string, id: string): Promise<AgentRow> {
    const rows = (await d.sql`select id, user_id, name, status, stellar_address, agent_id, provision_state from app.agents
                              where id = ${id} and user_id = ${userId}`) as AgentRow[];
    if (!rows[0]) throw httpError(404, 'not_found');
    return rows[0];
  }

  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

  const routes: Route[] = [
    ['GET', /^\/health$/, async () => {
      await d.sql`select 1 from app.agents limit 1`;
      return json(200, { ok: true });
    }],

    ['GET', new RegExp(`^/a/(${UUID})/agent\\.json$`), async (_r, m) => {
      // Public: every answer, a 500 included, carries the public headers (ACAO *), never the app's CORS.
      try {
        const rows = (await d.sql`select name, status, agent_id, stellar_address from app.agents where id = ${m[1]!}`) as { name: string; status: string; agent_id: string | null; stellar_address: string | null }[];
        if (!rows[0]) return json(404, { error: 'not_found' }, publicHeaders);
        // Its identity stays on chain and points here: say the agent is gone for good, not that it never was.
        if (rows[0].status === 'revoked') return json(410, { error: 'retired' }, publicHeaders);
        // liveServices drops only revoked agents: services are listed only while the agent can sell (the paid route 404s the rest).
        const live = d.services && rows[0].status === 'active' ? await d.services.specs.liveServices(m[1]!) : [];
        const services = live.map((s) => ({
          slug: s.slug,
          description: s.description,
          price_usdc: priceOf(s.priceUsdc),
          url: d.services!.endpoint.resourceUrl(m[1]!, s.slug),
          input_schema: s.inputSchema,
          output_schema: s.outputSchema,
        }));
        // agentId (the stellar-8004 registry id) and agentWallet are public chain facts: the discovery indexer checks them
        // against the registry before it marks an agent as hosted here.
        const agentId = rows[0].agent_id !== null && /^\d{1,10}$/.test(rows[0].agent_id) ? Number(rows[0].agent_id) : null;
        // ERC-8004 lists an agent's endpoints by name; MCP is one of the standard ones.
        const endpoints = services.length && d.services?.mcp ? [{ name: 'MCP', endpoint: `${d.services.endpoint.resourceUrl(m[1]!, 'mcp')}`, version: '2025-06-18' }] : [];
        return json(200, { name: rows[0].name, description: '', agentId, agentWallet: rows[0].stellar_address, services, ...(endpoints.length ? { endpoints } : {}) }, publicHeaders);
      } catch (e) {
        d.log?.({ event: 'unhandled', path: '/a/:id/agent.json', ...safeCause(e) });
        return json(500, { error: 'internal' }, publicHeaders);
      }
    }],

    ['GET', new RegExp(`^/a/(${UUID})/records/([0-9a-fA-F]{64})$`, 'i'), async (_r, m) => {
      // Public proof: only this agent's own record, only its own fields (records.get re-parses them). Public headers on every answer.
      try {
        const record = d.records ? await d.records.get(m[1]!, m[2]!.toLowerCase()) : null;
        if (!record) return json(404, { error: 'not_found' }, PUBLIC_HEADERS);
        return json(200, record, { ...PUBLIC_HEADERS, 'cache-control': 'public, max-age=31536000, immutable' });
      } catch (e) {
        d.log?.({ event: 'unhandled', path: '/a/:id/records/:tx', ...safeCause(e) });
        return json(500, { error: 'internal' }, PUBLIC_HEADERS);
      }
    }],

    ['POST', new RegExp(`^/a/(${UUID})/mcp$`), async (r, m, ip) => {
      // The agent's paid services over MCP: same per-IP bucket as the paid route, every call goes through that endpoint.
      const wait = await paidByIp.hit(ip ? ipKey(ip) : 'unknown');
      if (wait) return json(429, { error: 'rate_limited' }, { ...PUBLIC_HEADERS, 'retry-after': String(wait) });
      if (!d.services?.mcp) return json(404, { error: 'not_found' }, PUBLIC_HEADERS);
      try {
        const res = await d.services.mcp.handle(r, m[1]!);
        for (const [k, v] of Object.entries(PUBLIC_HEADERS)) if (!res.headers.has(k)) res.headers.set(k, v);
        return res;
      } catch (e) {
        d.log?.({ event: 'unhandled', path: '/a/:id/mcp', ...safeCause(e) });
        return json(500, { error: 'internal' }, PUBLIC_HEADERS);
      }
    }],

    ['POST', new RegExp(`^/a/(${UUID})/(${SLUG})$`), async (r, m, ip) => {
      // Public and paid: every answer carries ACAO *, never the app's CORS. The per-IP limit runs first.
      const wait = await paidByIp.hit(ip ? ipKey(ip) : 'unknown'); // no address: one shared bucket, never exempt (plan D3)
      if (wait) return json(429, { error: 'rate_limited' }, { ...PUBLIC_HEADERS, 'retry-after': String(wait) });
      if (!d.services) return json(404, { error: 'not_found' }, PUBLIC_HEADERS);
      try {
        return await d.services.endpoint.handle(r, m[1]!, m[2]!);
      } catch (e) {
        d.log?.({ event: 'unhandled', path: '/a/:id/:service', ...safeCause(e) });
        return json(500, { error: 'internal' }, PUBLIC_HEADERS);
      }
    }],

    ['POST', /^\/mcp$/, async (r, _m, ip) => {
      // A harness, not a browser: no CORS. The per-IP bucket runs before any token lookup.
      const wait = await ownerMcpByIp.hit(ip ? ipKey(ip) : 'unknown');
      if (wait) return json(429, { error: 'rate_limited' }, { 'retry-after': String(wait) });
      if (!d.ownerMcp) return json(404, { error: 'not_found' }, {});
      return d.ownerMcp.handle(r);
    }],

    // No server-sent stream on this server: the MCP transport's answer to a GET is 405.
    ['GET', /^\/mcp$/, async () => new Response(null, { status: 405, headers: { allow: 'POST' } })],

    ['GET', /^\/api\/tokens$/, async (r) => {
      const p = await user(r);
      if (!d.tokens) throw httpError(404, 'not_found');
      return json(200, { tokens: await d.tokens.list(p.id) }, { ...cors, 'cache-control': 'no-store' });
    }],

    ['POST', /^\/api\/tokens$/, async (r) => {
      const p = await user(r);
      if (!d.tokens) throw httpError(404, 'not_found');
      const wait = await tokenIssues.hit(p.id);
      if (wait) limited(wait);
      const b = await body<{ name?: unknown }>(r);
      if (!isObject(b) || typeof b.name !== 'string') throw httpError(400, 'bad_name');
      const t = await d.tokens.issue(p.id, b.name);
      d.log?.({ event: 'token_issued', user: p.id, token: t.id });
      // Shown once: never cached anywhere on the way.
      return json(201, t, { ...cors, 'cache-control': 'no-store' });
    }],

    ['POST', new RegExp(`^/api/tokens/(${UUID})/revoke$`), async (r, m) => {
      const p = await user(r);
      if (!d.tokens) throw httpError(404, 'not_found');
      await d.tokens.revoke(p.id, m[1]!);
      d.log?.({ event: 'token_revoked', user: p.id, token: m[1]! });
      return json(204, null);
    }],

    ['GET', /^\/api\/me$/, async (r) => {
      const p = await user(r);
      // Every non-revoked agent, oldest first. `agent` is the first of them, for a panel that predates several agents.
      const mine = (await d.sql`select id, name, status from app.agents where user_id = ${p.id} and status <> 'revoked' order by created_at, id`) as { id: string; name: string; status: string }[];
      return json(200, { id: p.id, email: p.email, ownerAddress: p.ownerAddress, agent: mine[0] ?? null, agents: mine, agentLimit: agentLimits.live });
    }],

    ['POST', /^\/api\/passkey\/options$/, async (r, _m, ip) => json(200, await d.passkey.options(await passkeyUser(r, ip, 'options')))],

    ['POST', /^\/api\/passkey\/register$/, async (r, _m, ip) => {
      const p = await passkeyUser(r, ip, 'register');
      const b = await body<{ response?: unknown }>(r);
      const resp = isObject(b) ? b.response : undefined;
      if (!isObject(resp) || !isObject(resp.response) || typeof resp.response.clientDataJSON !== 'string') throw httpError(400, 'bad_request');
      try {
        return json(200, await d.passkey.register(p, resp as unknown as RegistrationResponse));
      } catch (e) {
        // The wallet exists on chain but our record of it failed: its public ids exist only in this log line.
        if (isHttpError(e) && e.code === 'wallet_record_failed') {
          const w = e as { contractId?: unknown; deployTx?: unknown };
          d.log?.({ event: 'wallet_record_failed', user: p.id, contractId: String(w.contractId), deployTx: String(w.deployTx) });
        }
        throw e;
      }
    }],

    ['GET', /^\/api\/wallet$/, async (r) => json(200, d.passkey.wallet(await user(r)))],

    ['GET', /^\/api\/sign-requests$/, async (r) => json(200, await d.signRequests.pending((await user(r)).id))],

    ['POST', new RegExp(`^/api/sign-requests/(${UUID})/sign$`), async (r, m) => {
      const p = await user(r);
      const b = await body<{ signedEntryXdr?: unknown }>(r);
      if (!isObject(b) || typeof b.signedEntryXdr !== 'string') throw httpError(400, 'bad_request');
      await d.signRequests.sign(p.id, m[1]!, b.signedEntryXdr);
      return json(204, null);
    }],

    ['POST', new RegExp(`^/api/sign-requests/(${UUID})/reject$`), async (r, m) => {
      await d.signRequests.reject((await user(r)).id, m[1]!);
      return json(204, null);
    }],

    ['POST', /^\/api\/agents$/, async (r) => {
      const p = await user(r);
      const b = await body<{ name?: unknown; spec?: unknown; view?: unknown; key?: unknown; skillSet?: unknown }>(r);
      const name = isObject(b) && typeof b.name === 'string' ? b.name.trim() : '';
      const key = isObject(b) && b.key !== undefined && b.key !== null ? b.key : undefined;
      if (key !== undefined && (typeof key !== 'string' || !new RegExp(`^${UUID}$`).test(key))) throw httpError(400, 'bad_key');
      if (name.length < 1 || name.length > 64 || bannedWord(name) !== null) throw httpError(400, 'bad_name'); // the name is shown in the panel's plain words: the Builder's word list applies
      // Spec §6c: creation starts from the approved description. Validated before anything is written.
      const parsed = parseSpec(isObject(b) ? b.spec : undefined);
      if (!parsed.ok) return json(400, { error: 'bad_spec', problem: parsed.problem });
      // The plain-words view the owner approved with the spec: it must describe this spec (same checks as a draft).
      let view: DraftView | undefined;
      if (isObject(b) && b.view !== undefined && b.view !== null) {
        const v = DraftView.safeParse(b.view);
        if (!v.success || checkDraft({ name, ...v.data, spec: parsed.spec })) return json(400, { error: 'bad_view' });
        view = v.data;
      }
      // One of the owner's skill sets, at the revision the screen showed (skills/sets.ts): put into v1 in the same transaction.
      let skillSet: { id: string; revision: number } | undefined;
      if (isObject(b) && b.skillSet !== undefined && b.skillSet !== null) {
        const s = b.skillSet;
        if (!isObject(s) || typeof s.id !== 'string' || !new RegExp(`^${UUID}$`).test(s.id) || typeof s.revision !== 'number' || !Number.isSafeInteger(s.revision) || s.revision < 1) throw httpError(400, 'bad_skill_set');
        skillSet = { id: s.id.toLowerCase(), revision: s.revision };
      }
      if (!p.ownerAddress) throw httpError(409, 'no_wallet');
      // The account's ceiling (agents/index.ts AgentLimits). One transaction writes the agent, its description v1 and
      // the approval; provisioning starts only after it commits. The same key again is the same agent: 200, nothing launched.
      const { id, resumed } = await agents.create(p.id, name, parsed.spec, view, key?.toLowerCase(), skillSet);
      if (resumed) return json(200, { id, resumed: true });
      launch(id);
      return json(202, { id });
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})$`), async (r, m) => {
      const a = await ownAgent((await user(r)).id, m[1]!);
      const started = await lastStartOf(a.id);
      return json(200, {
        id: a.id,
        name: a.name,
        status: a.status,
        stellarAddress: a.stellar_address,
        agentId: a.agent_id,
        provision: a.provision_state,
        lastStart: started.lastStart,
        needsOperator: needsOperator(a, started.streak),
      });
    }],

    ['POST', new RegExp(`^/api/agents/(${UUID})/retry$`), async (r, m) => {
      const a = await ownAgent((await user(r)).id, m[1]!);
      // pending / key_ready: a first start that errored or a process that died before `creating`. Nothing is
      // on chain yet and provision reuses the live key, so these retry like `failed`. A run in flight is
      // still guarded by provision (`busy`); `creating` (maybe on chain) and `active` are refused.
      if (a.status !== 'provisioning' || !RETRYABLE.has(a.provision_state.step)) throw httpError(409, 'not_failed');
      if (blocked(a)) throw httpError(409, 'needs_operator');
      // Only a launch can spend sponsor fees, so only a launch is counted.
      const wait = await retries.hit(a.user_id);
      if (wait) limited(wait);
      launch(a.id);
      return json(202, { id: a.id });
    }],
  ];

  if (d.extraRoutes) routes.push(...d.extraRoutes({ body }));
  if (d.discovery) routes.push(...discoveryRoutes(d.discovery));
  if (d.runtime) routes.push(...runtimeRoutes(d.runtime, { user, body, ownAgent, json, cors }));
  if (d.panel) routes.push(...panelRoutes(d.panel, { user, body, ownAgent, json, cors }));
  if (d.skills) routes.push(...skillRoutes(d.skills, { user, body, ownAgent, json, cors }));
  if (d.builder) routes.push(...builderRoutes(d.builder, { user, optionalUser, body, ownAgent, json, cors }));

  /**
   * The app's CORS answer for this request: a response carrying the app marker gets the request's Origin when that is
   * an accepted one, else no allow-origin at all (never the canonical origin by default, and never a foreign one).
   * Responses with ACAO * (the /a/ and /public/ surfaces) or none (extension routes that send no CORS header) pass through untouched. `vary: Origin` stays.
   */
  function answerFor(req: Request, res: Response): Response {
    const path = new URL(req.url).pathname;
    if (isPaidPath(path) || isPublicPath(path) || res.headers.get('access-control-allow-origin') !== d.appOrigin) return res;
    const origin = req.headers.get('origin');
    const reflect = origin !== null && allowedOrigins.has(origin) ? origin : null;
    try {
      if (reflect) res.headers.set('access-control-allow-origin', reflect);
      else res.headers.delete('access-control-allow-origin');
      return res;
    } catch {
      // Immutable headers (a response this process did not build): copy them.
      const headers = new Headers(res.headers);
      if (reflect) headers.set('access-control-allow-origin', reflect);
      else headers.delete('access-control-allow-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
  }

  return async (req, ip) => answerFor(req, await handle(req, ip));

  async function handle(req: Request, ip: string | undefined): Promise<Response> {
    const path = new URL(req.url).pathname;
    const paid = isPaidPath(path);
    const open = isPublicPath(path);
    const errCors = paid ? PUBLIC_HEADERS : open ? DISCOVERY_HEADERS : cors;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: paid ? paidPreflight : open ? publicPreflight : cors });
    try {
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = re.exec(path);
        if (m) {
          if (m[1]) m[1] = m[1].toLowerCase(); // Postgres prints uuids in lower case; ids are compared as text
          return await handler(req, m, ip);
        }
      }
      return json(404, { error: 'not_found' }, errCors);
    } catch (e) {
      if (isHttpError(e)) {
        const retryAfter = (e as { retryAfter?: unknown }).retryAfter;
        return json(e.status, { error: e.code }, typeof retryAfter === 'number' ? { ...errCors, 'retry-after': String(retryAfter) } : errCors);
      }
      d.log?.({ event: 'unhandled', path: path.replace(new RegExp(UUID, 'gi'), ':id').replace(/^(\/api\/builder\/handoff\/)[^/]+/, '$1:id'), ...safeCause(e) });
      return json(500, { error: 'internal' }, errCors);
    }
  }
}
