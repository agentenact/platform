/**
 * AgentSpec (spec §4): what the Builder (P4) produces and the owner approves. Validated by zod on every
 * save. Budgets are platform constants (spec §6), so the spec carries none.
 */
import { Cron } from 'croner';
import { z } from 'zod';
import { CONDITION_ARGS, hireUrl } from '../tools/schemas.js';
import { schemaProblem, type Schema } from './json-schema.js';

export const TOOL_NAMES = ['web_search', 'web_read', 'stellar_price', 'stellar_price_change', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price', 'compute', 'send_email', 'send_webhook', 'hire_agent'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Tools a paid service may use: reads and compute only; never memory, delivery or money. */
export const SERVICE_TOOLS = ['web_search', 'web_read', 'stellar_price', 'stellar_price_change', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price', 'compute'] as const;
export type ServiceToolName = (typeof SERVICE_TOOLS)[number];
export const CONDITION_FETCH_TOOLS = ['stellar_price', 'stellar_price_change', 'stellar_read', 'stellar_payments', 'wallet_payments', 'wallet_balance', 'market_price'] as const;
export type ConditionFetchTool = (typeof CONDITION_FETCH_TOOLS)[number];

export const MIN_CRON_INTERVAL_S = 15 * 60;
export const MIN_CONDITION_EVERY_S = 300;
/** Spec §5.7 per-call hire cap. */
export const MAX_HIRE_PER_CALL_USDC = '0.05';

/** Whether `tz` is an IANA time zone this runtime knows ("Europe/Istanbul", "UTC"). */
export function isTimeZone(tz: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Smallest gap in seconds between consecutive fire times over the next 200; null unless a valid 5-field expression. */
export function cronMinGapSeconds(expr: string, from = new Date('2026-01-01T00:00:00Z'), tz = 'UTC'): number | null {
  if (expr.trim().split(/\s+/).length !== 5) return null;
  let runs: Date[];
  try {
    runs = new Cron(expr, { timezone: tz, paused: true }).nextRuns(200, from);
  } catch {
    return null;
  }
  if (runs.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i]!.getTime() - runs[i - 1]!.getTime()) / 1000);
  return min;
}

/**
 * The next fire time after `from`. The expression reads in `tz` (a schedule without one, stored before time zones,
 * reads in UTC). Only called on expressions parseSpec accepted.
 */
export function cronNext(expr: string, from: Date, tz: string | null = 'UTC'): Date {
  const next = new Cron(expr, { timezone: tz ?? 'UTC', paused: true }).nextRun(from);
  if (!next) throw new Error('specs: the cron expression has no next run');
  return next;
}

const usdc = (max: number) =>
  z
    .string()
    .regex(/^\d{1,3}(\.\d{1,7})?$/, 'a decimal with at most 7 places')
    .refine((v) => Number(v) > 0 && Number(v) <= max, `must be > 0 and <= ${max}`);
const jsonSchemaField = z.custom<Schema>((v) => schemaProblem(v) === null, 'not a schema of the supported subset');
const mission = z.string().min(1).max(4000);

export const PARAM_NAME = /^[a-z][a-z0-9_]{0,23}$/;
export const MAX_PARAMS = 8;
/**
 * Tunable values of a condition (a threshold, an account), passed to its code as the frozen global `params`.
 * Data only: the sandbox receives them as JSON and the code never contains them, so editing one never edits code.
 */
export const ConditionParams = z
  .record(z.string().regex(PARAM_NAME), z.union([z.number().finite(), z.string().max(100), z.boolean()]))
  .refine((p) => Object.keys(p).length <= MAX_PARAMS, `at most ${MAX_PARAMS} params`);

/**
 * The paragraph a condition's mission carries so the model knows the person's values (it never sees the code), or '' when
 * the condition has none. Without it the model invents its own threshold and its words contradict the person's.
 */
export function settingsNote(params: z.infer<typeof ConditionParams> | undefined): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return '';
  return `\n\nThe person's settings, already applied by the check: ${entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}.`;
}

const CronTrigger = z
  .object({
    kind: z.literal('cron'),
    cron: z
      .string()
      .max(100)
      .refine((c) => {
        const gap = cronMinGapSeconds(c);
        return gap !== null && gap >= MIN_CRON_INTERVAL_S;
      }, 'a 5-field cron expression that fires at most every 15 minutes'),
    /** The person's time zone the expression reads in (IANA). Absent: UTC. The panel fills it from the browser. */
    tz: z.string().max(64).refine(isTimeZone, 'an IANA time zone such as Europe/Istanbul').optional(),
    mission,
  })
  .strict()
  .superRefine((t, ctx) => {
    // The gap is checked again in the zone: a daylight-saving change must not squeeze two runs closer than allowed.
    const gap = t.tz ? cronMinGapSeconds(t.cron, undefined, t.tz) : null;
    if (t.tz && (gap === null || gap < MIN_CRON_INTERVAL_S)) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'fires more often than every 15 minutes in this time zone' });
  });

const ConditionTrigger = z
  .object({
    kind: z.literal('condition'),
    fetch: z.object({ tool: z.enum(CONDITION_FETCH_TOOLS), args: z.record(z.string(), z.unknown()) }).strict(),
    code: z.string().min(1).max(4000),
    params: ConditionParams.optional(),
    every_s: z.number().int().min(MIN_CONDITION_EVERY_S).max(86_400),
    cooldown_s: z.number().int().min(0).max(604_800).default(3600),
    mission,
  })
  .strict()
  .superRefine((t, ctx) => {
    if (!CONDITION_ARGS[t.fetch.tool].safeParse(t.fetch.args).success) ctx.addIssue({ code: 'custom', path: ['fetch', 'args'], message: `not valid ${t.fetch.tool} arguments` });
  });

export const TriggerSpec = z.discriminatedUnion('kind', [CronTrigger, ConditionTrigger]);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Skills one paid service may run with: their instructions go into the service's small context (budgets.ts: 20k tokens). */
export const MAX_SERVICE_SKILLS = 2;
export const SkillSpec = z.object({ name: z.string().regex(SKILL_NAME), description: z.string().min(1).max(500), body: z.string().min(1).max(20_000) }).strict();
const unique = <T>(key: (t: T) => string) => (list: T[]) => new Set(list.map(key)).size === list.length;

export const ServiceSpec = z
  .object({
    // `mcp` is the agent's MCP endpoint (/a/<uuid>/mcp), `records` its stored proofs: never a service.
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).refine((v) => v !== 'mcp' && v !== 'records', 'this slug is reserved'),
    description: z.string().min(1).max(500),
    price_usdc: usdc(10),
    input_schema: jsonSchemaField,
    output_schema: jsonSchemaField,
    persona: z.string().min(1).max(2000),
    skill_body: z.string().max(20_000).default(''),
    tools: z.array(z.enum(SERVICE_TOOLS)).max(2).default([]).refine(unique((t: string) => t), 'tools must be unique'),
    /**
     * Names of the agent's own skills (owner-approved ones from skills.sh) this paid service runs with. Optional, never
     * defaulted, so a description saved before it existed parses to the same JSON.
     */
    skills: z.array(z.string().regex(SKILL_NAME)).min(1).max(MAX_SERVICE_SKILLS).refine(unique((n: string) => n), 'skills must be unique').optional(),
  })
  .strict();

export const AgentSpec = z
  .object({
    persona: z.string().min(1).max(2000),
    system_prompt: z.string().min(1).max(20_000),
    suggested_plan: z.array(z.string().min(1).max(500)).max(20).default([]),
    tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).default([]).refine(unique((t: string) => t), 'tools must be unique'),
    triggers: z.array(TriggerSpec).max(5).default([]),
    skills: z.array(SkillSpec).max(10).default([]).refine(unique((s: { name: string }) => s.name), 'skill names must be unique'),
    services: z.array(ServiceSpec).max(3).default([]).refine(unique((s: { slug: string }) => s.slug), 'service slugs must be unique'),
    delivery: z.object({ email: z.boolean().default(false), webhook_url: z.url({ protocol: /^https$/ }).max(500).optional() }).strict().default({ email: false }),
    hire_targets: z.array(z.object({ url: hireUrl, max_usdc: usdc(Number(MAX_HIRE_PER_CALL_USDC)) }).strict()).max(10).default([]),
  })
  .strict()
  .superRefine((a, ctx) => {
    const held = new Set(a.skills.map((s) => s.name));
    a.services.forEach((svc, i) =>
      (svc.skills ?? []).forEach((n, j) => {
        if (!held.has(n)) ctx.addIssue({ code: 'custom', path: ['services', i, 'skills', j], message: `no skill named ${n}` });
      }),
    );
  });

export type AgentSpec = z.infer<typeof AgentSpec>;
export type TriggerSpec = z.infer<typeof TriggerSpec>;
export type ServiceSpec = z.infer<typeof ServiceSpec>;
export type SkillSpec = z.infer<typeof SkillSpec>;

/** Parses an owner-supplied spec: the spec with defaults filled, or the first problem as `path: message`. */
export function parseSpec(raw: unknown): { ok: true; spec: AgentSpec } | { ok: false; problem: string } {
  const r = AgentSpec.safeParse(raw);
  if (r.success) return { ok: true, spec: r.data };
  const issue = r.error.issues[0]!;
  const path = issue.path.join('.');
  return { ok: false, problem: path.length ? `${path}: ${issue.message}` : issue.message };
}
