/**
 * Panel routes (P4): the owner's builder panel. Every route authenticates and touches only the caller's agent.
 * Task 7: pause and resume. Task 10: the read models (overview, activity, earnings). Later tasks extend `PanelDeps`.
 */
import { httpError } from '../errors.js';
import type { Activity } from '../activity/index.js';
import type { Agents } from '../agents/index.js';
import type { WalletHistory } from '../agents/wallet-history.js';
import type { AgentWallets } from '../agents/wallets.js';
import type { Builder } from '../builder/index.js';
import type { BuilderLimits } from '../builder/limits.js';
import type { Suggest } from '../builder/suggest.js';
import { applyParam } from '../builder/params.js';
import { holdBack, restore } from '../builder/revise.js';
import type { Specs } from '../specs/index.js';
import type { ModelDirectory } from '../loop/model-choices.js';
import type { Route } from './app.js';
import { createRateLimiter } from './rate-limit.js';
import type { RouteHelpers } from './runtime.js';

export interface PanelDeps {
  agents: Pick<Agents, 'pause' | 'resume' | 'setMorningNote'> & Partial<Pick<Agents, 'remove' | 'runNow' | 'setModel'>>;
  /** The platform kill switch: Run now answers 503 killed while it is on (the scheduler is stopped too). */
  killed?: () => boolean;
  /** Closes a deleted agent's wallets (agents/close.ts). Absent: the leader's sweep does it on its next pass. */
  closer?: { close(agentId: string): Promise<void> };
  activity: Pick<Activity, 'overview' | 'feed' | 'earnings'> & Partial<Pick<Activity, 'seals' | 'live'>>;
  /** Revising the agent's description with a new prompt (Task 18). Absent: the route answers 404. */
  revise?: { builder: Pick<Builder, 'draft'>; limits: Pick<BuilderLimits, 'admit' | 'addTokens'>; specs: Pick<Specs, 'view' | 'saveDraft'>; killed: boolean };
  /** The selling suggestion (Task 19). Absent: the routes answer 404. `killed` stops new model calls. */
  suggest?: { suggest: Pick<Suggest, 'get' | 'publish'>; killed: boolean };
  /** The agent's wallets per network. Absent: the routes answer 404. */
  wallets?: AgentWallets;
  /** What the agent did on chain from its wallets. Absent: the route answers 404. */
  history?: WalletHistory;
  /** Every model an owner can pick (GET /api/models). Absent: the route answers 404. */
  models?: Pick<ModelDirectory, 'all'>;
  now?: () => number;
}

/** Panel writes per account per hour. */
export const PANEL_WRITES_PER_HOUR = 30;
/** Run now presses per agent per hour: each one can start a mission, so the model bill stays bounded on top of the daily budget. */
export const RUN_NOW_PER_HOUR = 6;
export const REVISE_PROMPT_MAX = 2000;
/** Taps on screen that a knob edit replays first. */
export const MAX_EARLIER_EDITS = 32;
/** A parameter id: a short non-empty string. */
const okParam = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export function panelRoutes(p: PanelDeps, h: RouteHelpers): Route[] {
  const rev = p.revise;
  const sug = p.suggest;
  const writes = createRateLimiter({ name: 'panel-routes.writes', limit: PANEL_WRITES_PER_HOUR, windowMs: 3_600_000, ...(p.now ? { now: p.now } : {}) });
  const runs = createRateLimiter({ name: 'panel-routes.run-now', limit: RUN_NOW_PER_HOUR, windowMs: 3_600_000, ...(p.now ? { now: p.now } : {}) });
  const limitWrites = async (userId: string) => {
    const wait = await writes.hit(userId);
    if (wait) throw Object.assign(httpError(429, 'rate_limited'), { retryAfter: wait });
  };

  return [
    ...(rev
      ? ([
          // A knob tap on the agent's own description (Task 29). The stored active version is held back, edited as data and
          // restored, all in code: no model call, nothing from the client but the parameter. The anonymous /api/builder/edit
          // stays strict and cannot do this (it refuses owner-added services, hiring, webhook and skills).
          ['POST', new RegExp(`^/api/agents/(${UUID})/builder/edit$`), async (r, m) => {
            const u = await h.user(r);
            await limitWrites(u.id);
            const agentId = m[1]!;
            const a = await h.ownAgent(u.id, agentId);
            if (a.status !== 'active' && a.status !== 'paused') throw httpError(409, 'agent_not_active');
            const body = await h.body<{ param?: unknown; value?: unknown; earlier?: unknown }>(r);
            if (!isObject(body) || !okParam(body.param)) throw httpError(400, 'bad_request');
            // `earlier`: the taps already on the owner's screen, not stored yet. They are applied first, in order, so a second tap
            // never loses the first.
            const earlier = body.earlier === undefined ? [] : body.earlier;
            if (!Array.isArray(earlier) || earlier.length > MAX_EARLIER_EDITS) throw httpError(400, 'bad_request');
            const active = (await rev.specs.view(u.id, agentId)).active;
            if (!active) throw httpError(409, 'agent_not_active');
            const { current, held } = holdBack(a.name, active.spec, active.view);
            let edited = current;
            for (const e of [...earlier, { param: body.param, value: body.value }]) {
              if (!isObject(e) || !okParam(e.param)) throw httpError(400, 'bad_request');
              const applied = applyParam(edited, e.param, e.value);
              if (!applied.ok) return h.json(400, { error: 'bad_edit', problem: applied.problem });
              edited = applied.draft;
            }
            const full = restore(edited, held);
            if (!full.ok) return h.json(400, { error: 'bad_edit', problem: full.problem });
            return h.json(200, { draft: full.draft });
          }],
          // One agent per user: a new prompt is a new description version for approval, never a second agent. "Current" is always
          // the stored active version; the request carries only the prompt.
          ['POST', new RegExp(`^/api/agents/(${UUID})/builder/draft$`), async (r, m, ip) => {
            const u = await h.user(r);
            const agentId = m[1]!;
            const a = await h.ownAgent(u.id, agentId);
            if (rev.killed) throw httpError(503, 'killed');
            if (a.status !== 'active' && a.status !== 'paused') throw httpError(409, 'agent_not_active');
            const body = await h.body<{ prompt?: unknown }>(r);
            const prompt = isObject(body) && typeof body.prompt === 'string' ? body.prompt.trim() : '';
            if (prompt.length < 1 || prompt.length > REVISE_PROMPT_MAX) throw httpError(400, 'bad_prompt');
            const active = (await rev.specs.view(u.id, agentId)).active;
            if (!active) throw httpError(409, 'agent_not_active');
            const w = { ip: ip ?? 'unknown', userId: u.id };
            const admitted = await rev.limits.admit(w, 'draft');
            if (!admitted.ok) return h.json(429, { error: admitted.reason === 'capacity' ? 'capacity_reached' : 'daily_limit' });
            const { current, held } = holdBack(a.name, active.spec, active.view);
            const out = await rev.builder.draft({ prompt, current, anonymous: false, signal: r.signal, kind: 'edit', userId: u.id, agentId });
            // Every outcome is metered, a client that hung up included.
            const t = out.usage;
            await rev.limits.addTokens(w, 'draft', t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens);
            if (!out.ok) {
              if (out.code === 'aborted') return h.json(499, { error: 'client_closed' });
              return h.json(502, { error: 'builder_failed', code: out.code });
            }
            const full = restore(out.draft, held);
            if (!full.ok) return h.json(502, { error: 'builder_failed', code: 'invalid' });
            const { name: _n, spec, ...view } = full.draft;
            // Built on `active`: if a publish moved the live version while the model ran, saveDraft refuses 409 version_changed
            // (the draft would carry the old services and switch the newly published ones off on approve).
            const version = await rev.specs.saveDraft(u.id, agentId, spec, prompt, view, active.version);
            // `createdAt` identifies this exact draft: the owner's approve sends it back, and a replaced draft is 409 version_changed.
            const stored = (await rev.specs.view(u.id, agentId)).draft;
            return h.json(200, { version, createdAt: stored && stored.version === version ? stored.createdAt : null, draft: { ...full.draft, name: a.name } }); // the model's name is never saved: show the one the agent keeps
          }],
        ] satisfies Route[])
      : []),

    ...(sug
      ? ([
          // The card: eligible, and the one suggested offer (generated once per active version, never by a client).
          ['GET', new RegExp(`^/api/agents/(${UUID})/suggestion$`), async (r, m) => {
            const u = await h.user(r);
            if (sug.killed) throw httpError(503, 'killed');
            return h.json(200, await sug.suggest.get(u.id, m[1]!));
          }],
          // One tap: publishes the suggested offer through the normal approval. 409 not_eligible once it is live or no longer offered.
          ['POST', new RegExp(`^/api/agents/(${UUID})/suggestion/publish$`), async (r, m) => {
            const u = await h.user(r);
            if (sug.killed) throw httpError(503, 'killed');
            await limitWrites(u.id);
            // The version the card showed. A stale card (the description moved on) is 409 not_eligible from the store.
            const b = await h.body<{ version?: unknown }>(r);
            if (!isObject(b) || typeof b.version !== 'number' || !Number.isSafeInteger(b.version) || b.version < 1) throw httpError(400, 'bad_request');
            await sug.suggest.publish(u.id, m[1]!, b.version);
            return h.json(204, null);
          }],
        ] satisfies Route[])
      : []),

    ['POST', new RegExp(`^/api/agents/(${UUID})/pause$`), async (r, m) => {
      const u = await h.user(r);
      await limitWrites(u.id);
      await p.agents.pause(u.id, m[1]!);
      return h.json(204, null);
    }],

    ['POST', new RegExp(`^/api/agents/(${UUID})/resume$`), async (r, m) => {
      const u = await h.user(r);
      await limitWrites(u.id);
      await p.agents.resume(u.id, m[1]!);
      return h.json(204, null);
    }],

    // Run now: the agent's next check moves to now; the scheduler fires it within one tick. Nothing runs in this request.
    ['POST', new RegExp(`^/api/agents/(${UUID})/run$`), async (r, m) => {
      const u = await h.user(r);
      if (!p.agents.runNow) throw httpError(404, 'not_found');
      if (p.killed?.()) throw httpError(503, 'killed');
      await limitWrites(u.id);
      const wait = await runs.hit(m[1]!);
      if (wait) throw Object.assign(httpError(429, 'rate_limited'), { retryAfter: wait });
      return h.json(200, await p.agents.runNow(u.id, m[1]!));
    }],

    // Deletes the agent. The answer comes before its wallet is closed: that runs on (the closer), and retries on its own.
    ['DELETE', new RegExp(`^/api/agents/(${UUID})$`), async (r, m) => {
      const u = await h.user(r);
      if (!p.agents.remove) throw httpError(404, 'not_found');
      await limitWrites(u.id);
      await p.agents.remove(u.id, m[1]!);
      if (p.closer) void p.closer.close(m[1]!).catch(() => undefined);
      return h.json(202, { deleted: true });
    }],

    // A yes or a no, once: the owner's answer to "Want a short note each morning?". Only stored here.
    ['POST', new RegExp(`^/api/agents/(${UUID})/morning-note$`), async (r, m) => {
      const u = await h.user(r);
      await limitWrites(u.id);
      const b = await h.body<{ on?: unknown }>(r);
      if (!isObject(b) || typeof b.on !== 'boolean') throw httpError(400, 'bad_request');
      await p.agents.setMorningNote(u.id, m[1]!, b.on);
      return h.json(204, null);
    }],

    // The model the agent's runs use: a slug from the overview's list, or null for the default. The next run uses it.
    ['POST', new RegExp(`^/api/agents/(${UUID})/model$`), async (r, m) => {
      const u = await h.user(r);
      if (!p.agents.setModel) throw httpError(404, 'not_found');
      await limitWrites(u.id);
      const b = await h.body<{ model?: unknown }>(r);
      if (!isObject(b) || !(b.model === null || (typeof b.model === 'string' && b.model.length <= 120))) throw httpError(400, 'bad_request');
      await p.agents.setModel(u.id, m[1]!, b.model);
      return h.json(204, null);
    }],

    // The whole pick list: the suggested models, then the OpenRouter catalog. The same for every owner.
    ['GET', /^\/api\/models$/, async (r) => {
      await h.user(r);
      if (!p.models) throw httpError(404, 'not_found');
      return h.json(200, { models: await p.models.all() });
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/overview$`), async (r, m) => {
      const u = await h.user(r);
      return h.json(200, await p.activity.overview(u.id, m[1]!));
    }],

    // What the current run is doing, polled by the agent page while it runs (about once a second while open).
    ['GET', new RegExp(`^/api/agents/(${UUID})/live$`), async (r, m) => {
      const u = await h.user(r);
      if (!p.activity.live) throw httpError(404, 'not_found');
      return h.json(200, await p.activity.live(u.id, m[1]!));
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/activity$`), async (r, m) => {
      const u = await h.user(r);
      const raw = new URL(r.url).searchParams.get('days');
      const n = raw === null || raw.trim() === '' ? NaN : Number(raw);
      const days = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 30) : 7;
      return h.json(200, await p.activity.feed(u.id, m[1]!, { days }));
    }],

    ['GET', new RegExp(`^/api/agents/(${UUID})/earnings$`), async (r, m) => {
      const u = await h.user(r);
      return h.json(200, await p.activity.earnings(u.id, m[1]!));
    }],

    // One UTC day of check seals, documents included: the owner's proof download (a reading can be private).
    ['GET', new RegExp(`^/api/agents/(${UUID})/seals/(\\d{4}-\\d{2}-\\d{2})$`), async (r, m) => {
      const u = await h.user(r);
      if (!p.activity.seals) throw httpError(404, 'not_found');
      return h.json(200, { seals: await p.activity.seals(u.id, m[1]!, m[2]!) });
    }],

    ...(p.wallets
      ? ([
          ['GET', new RegExp(`^/api/agents/(${UUID})/wallets$`), async (r, m) => {
            const u = await h.user(r);
            return h.json(200, { wallets: await p.wallets!.list(u.id, m[1]!) });
          }],
          // Opens the agent's wallet on an EVM testnet (the vault makes its key). Idempotent: the same address after.
          ['POST', new RegExp(`^/api/agents/(${UUID})/wallets/(eip155:[0-9]{1,12}|solana:[1-9A-HJ-NP-Za-km-z]{32})$`), async (r, m) => {
            const u = await h.user(r);
            await limitWrites(u.id);
            return h.json(200, { wallets: await p.wallets!.open(u.id, m[1]!, m[2]!) });
          }],
        ] as Route[])
      : []),
    ...(p.history
      ? ([
          ['GET', new RegExp(`^/api/agents/(${UUID})/wallets/history$`), async (r, m) => {
            const u = await h.user(r);
            return h.json(200, { chains: await p.history!.list(u.id, m[1]!) });
          }],
        ] as Route[])
      : []),
  ];
}
