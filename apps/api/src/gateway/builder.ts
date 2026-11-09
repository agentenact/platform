/**
 * Builder routes (P4 Task 15): the anonymous draft and the parameter edit. Auth is optional: a valid bearer makes the
 * caller a user (limited per user), no bearer makes them a visitor (limited per real IP and globally; their drafts run on the
 * cheap model). A bad bearer is a 401, never a quiet downgrade to anonymous. Bodies are validated before anything is counted.
 * `current` (revise mode) comes from the client: it is model input only, and the answer is validated, scoped and limited as usual.
 */
import type { Profile } from '../account/profiles.js';
import { checkDraft, DraftResult } from '../builder/draft-schema.js';
import { emailSha256, handoffProblem, HANDOFF_ID, type Handoffs } from '../builder/handoff.js';
import type { Builder } from '../builder/index.js';
import type { BuilderLimits, Who } from '../builder/limits.js';
import { applyParam } from '../builder/params.js';
import { agentTemplates } from '../builder/templates.js';
import { conditionRuleProblem, draftScopeProblem, outsideBuilderScope } from '../builder/scope.js';
import type { Trial } from '../builder/trial.js';
import { parseSpec } from '../specs/schema.js';
import { httpError } from '../errors.js';
import type { Route } from './app.js';
import { ipKey } from './rate-limit.js';
import type { RouteHelpers } from './runtime.js';

export interface BuilderDeps {
  builder: Pick<Builder, 'draft'>;
  /** Trial runs (P4 Task 16): signed-in callers use the normal run model, visitors the cheap one. Absent: the route answers 404. */
  trial?: Pick<Trial, 'run'>;
  trialAnon?: Pick<Trial, 'run'>;
  /** Draft handoff across the magic link (P4 Task 17). Absent: the routes answer 404. */
  handoffs?: Pick<Handoffs, 'put' | 'claim'>;
  limits: Pick<BuilderLimits, 'admit' | 'addTokens'>;
  killed: boolean;
}

export const PROMPT_MAX = 2000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function builderRoutes(b: BuilderDeps, h: RouteHelpers & { optionalUser(req: Request): Promise<Profile | null> }): Route[] {
  const who = async (req: Request, ip: string | undefined): Promise<Who> => {
    const u = await h.optionalUser(req);
    return { ip: ip ?? 'unknown', ...(u ? { userId: u.id } : {}) }; // no address: one shared bucket, never exempt
  };
  const refusal = (reason: 'sign_in' | 'daily' | 'capacity') =>
    h.json(429, { error: reason === 'sign_in' ? 'sign_in_to_keep_drafting' : reason === 'capacity' ? 'capacity_reached' : 'daily_limit' });

  const trialRoute = (user: Pick<Trial, 'run'>, anon: Pick<Trial, 'run'>): Route => [
    'POST',
    /^\/api\/builder\/trial$/,
    async (r, _m, ip) => {
      if (b.killed) throw httpError(503, 'killed');
      const w = await who(r, ip);
      const body = await h.body<{ spec?: unknown }>(r);
      // The spec comes from the client: it is held to the Builder's scope exactly like a draft before anything is counted or run.
      const parsed = isObject(body) ? parseSpec(body.spec) : null;
      const problem = parsed?.ok ? (outsideBuilderScope(parsed.spec) ?? conditionRuleProblem(parsed.spec)) : 'the spec is not valid';
      if (!parsed?.ok || problem) throw httpError(400, 'bad_spec');
      const admitted = await b.limits.admit(w, 'trial');
      if (!admitted.ok) return refusal(admitted.reason);
      const scope = w.userId ? `user:${w.userId}` : `ip:${ipKey(w.ip)}`;
      const out = await (w.userId ? user : anon).run({ spec: parsed.spec, scope, signal: r.signal, ...(w.userId ? { userId: w.userId } : {}) });
      // Every outcome is metered, a trial that failed or was left included.
      const u = out.usage;
      await b.limits.addTokens(w, 'trial', u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens);
      if (r.signal.aborted) return h.json(499, { error: 'client_closed' });
      return h.json(200, { trial: out });
    },
  ];

  const handoffRoutes = (store: Pick<Handoffs, 'put' | 'claim'>): Route[] => [
    // The visitor's draft, parked under an unguessable id. Validated like a model answer (shape, checks, scope) before anything is counted.
    ['POST', /^\/api\/builder\/handoff$/, async (r, _m, ip) => {
      if (b.killed) throw httpError(503, 'killed');
      const w = await who(r, ip);
      const body = await h.body<{ draft?: unknown; email?: unknown }>(r); // 64 KB, counted in bytes
      const checked = handoffProblem(isObject(body) ? body.draft : undefined);
      if ('problem' in checked) return h.json(400, { error: 'bad_draft', problem: checked.problem });
      const admitted = await b.limits.admit(w, 'handoff');
      if (!admitted.ok) return refusal(admitted.reason);
      return h.json(200, { id: await store.put(checked.draft, emailSha256(isObject(body) ? body.email : undefined)) });
    }],

    // Whoever is signed in and holds the id may claim it, once: the id is the secret. A handoff parked with an email is also
    // bound to it: the account's verified email (from the session, never the request) must hash to the stored value.
    ['POST', /^\/api\/builder\/handoff\/([^/]+)\/claim$/, async (r) => {
      const user = await h.user(r);
      // From the URL, not the dispatcher's match: it lower-cases the first capture (right for uuids), and this id is case-sensitive.
      const id = /^\/api\/builder\/handoff\/([^/]+)\/claim$/.exec(new URL(r.url).pathname)![1]!;
      if (!HANDOFF_ID.test(id)) throw httpError(404, 'not_found');
      const draft = await store.claim(id, user.email);
      if (!draft) throw httpError(404, 'not_found');
      return h.json(200, { draft }, { ...h.cors, 'cache-control': 'no-store' });
    }],
  ];

  return [
    // Ready drafts (agent templates): static, so no limit is counted and no model runs. Open while killed: nothing is spent.
    ['GET', /^\/api\/builder\/templates$/, async () => h.json(200, { templates: agentTemplates() }, { ...h.cors, 'cache-control': 'public, max-age=300' })],

    ['POST', /^\/api\/builder\/draft$/, async (r, _m, ip) => {
      if (b.killed) throw httpError(503, 'killed');
      const w = await who(r, ip);
      const body = await h.body<{ prompt?: unknown; current?: unknown }>(r);
      const prompt = isObject(body) && typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (prompt.length < 1 || prompt.length > PROMPT_MAX) throw httpError(400, 'bad_prompt');
      let current: DraftResult | null = null;
      if (isObject(body) && body.current !== undefined && body.current !== null) {
        const c = DraftResult.safeParse(body.current);
        if (!c.success) throw httpError(400, 'bad_current');
        current = c.data;
      }
      const admitted = await b.limits.admit(w, 'draft');
      if (!admitted.ok) return refusal(admitted.reason);
      const out = await b.builder.draft({ prompt, current, anonymous: !w.userId, signal: r.signal, ...(w.userId ? { userId: w.userId } : {}) });
      // Every outcome is metered (a failed draft spent real tokens), a client that hung up included.
      const tokens = out.usage.inputTokens + out.usage.outputTokens + out.usage.cacheReadTokens + out.usage.cacheWriteTokens;
      await b.limits.addTokens(w, 'draft', tokens);
      if (out.ok) return h.json(200, { draft: out.draft });
      if (out.code === 'aborted') return h.json(499, { error: 'client_closed' }); // the caller left; not a builder failure
      return h.json(502, { error: 'builder_failed', code: out.code });
    }],

    ...(b.trial && b.trialAnon ? [trialRoute(b.trial, b.trialAnon)] : []),

    ...(b.handoffs ? handoffRoutes(b.handoffs) : []),

    ['POST', /^\/api\/builder\/edit$/, async (r, _m, ip) => {
      const w = await who(r, ip);
      const body = await h.body<{ draft?: unknown; param?: unknown; value?: unknown }>(r);
      if (!isObject(body) || typeof body.param !== 'string' || body.param.length < 1 || body.param.length > 64) throw httpError(400, 'bad_request');
      // The draft comes from the client: it is checked like a model answer before anything is applied to it.
      const parsed = DraftResult.safeParse(body.draft);
      const problem = parsed.success ? (checkDraft(parsed.data) ?? draftScopeProblem(parsed.data)) : 'the draft is not valid';
      if (!parsed.success || problem) return h.json(400, { error: 'bad_edit', problem: problem ?? 'the draft is not valid' });
      const admitted = await b.limits.admit(w, 'edit');
      if (!admitted.ok) return refusal(admitted.reason);
      const applied = applyParam(parsed.data, body.param, body.value);
      if (!applied.ok) return h.json(400, { error: 'bad_edit', problem: applied.problem });
      return h.json(200, { draft: applied.draft });
    }],
  ];
}
