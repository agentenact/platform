/**
 * Owner runs (spec §5.3–5.5): chat sessions and unattended missions on the approved spec, with memory
 * and the skill index in context. A mission's answer is delivered by code, as the spec's delivery says:
 * email to the owner's address and/or the spec's webhook. Delivery failures are logged by fixed event,
 * never thrown and never logged as an error object.
 */
import { renderAlertEmail } from '../tools/alert-email.js';
import type { StepSummary } from '../runs/index.js';
import { plainMarkdown } from '../tools/markdown.js';
import type { Db } from '../db/index.js';
import { httpError } from '../errors.js';
import type { Policy } from '../policy/index.js';
import type { Runs } from '../runs/index.js';
import type { Memory } from '../runs/memory.js';
import type { SealDecision, Seals } from '../seals/index.js';
import type { Specs } from '../specs/index.js';
import type { AgentSpec } from '../specs/schema.js';
import type { Toolbox } from '../tools/index.js';
import { readingSentence } from '../checks/readings.js';
import type { AlertFacts } from '../tools/alert-email.js';
import { ownerSystem, type RecentState } from './context.js';
import type { RunOutcome, Runner } from './index.js';
import type { ToolEvent } from './run.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSession {
  run(messages: ChatMessage[], o: { onDelta: (t: string) => void; onTool?: (e: ToolEvent) => void; signal?: AbortSignal }): Promise<RunOutcome>;
}

export interface OwnerRuns {
  openChat(userId: string, agentId: string): Promise<ChatSession>;
  mission(agentId: string, triggerId: string, text: string): Promise<RunOutcome | null>;
  notify(agentId: string, text: string): Promise<void>;
}

export interface OwnerRunsDeps {
  sql: Db;
  specs: Pick<Specs, 'active' | 'skillIndex'>;
  memory: Pick<Memory, 'all'>;
  runs: Pick<Runs, 'annotate'>;
  runner: Runner;
  toolbox: Pick<Toolbox, 'ownerTools' | 'delivery'>;
  policy: Pick<Policy, 'delivery'>;
  /** The agent's own addresses per network, for the "what you have been doing" block. */
  addresses?: (agentId: string) => Promise<{ network: string; address: string }[]>;
  /** The panel's origin: with it, a mission's result goes out in the agent's mail look (formatted, with links back). */
  appOrigin?: string;
  /**
   * Decision seals (seals/index.ts), when sealing is on: a finished mission queues one, and its mail waits for it (at
   * most `sealWaitMs`) so the mail carries the transaction.
   */
  seals?: Pick<Seals, 'enqueueDecision' | 'decisions'>;
  sealWaitMs?: number;
  sealPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (e: Record<string, string | number>) => void;
}

/** How long a mission's mail waits for its decision seal to land (the worker ticks every 3 s; a submit takes 5–10 s). */
export const SEAL_WAIT_MS = 45_000;
export const SEAL_POLL_MS = 1_500;

/** The agent emailed its owner itself during the run (send_email went out): the result mail would say it twice. */
export const emailedOwner = (steps: StepSummary[] | undefined): boolean =>
  (steps ?? []).some((s) => (s.calls ?? []).some((c) => c.tool === 'send_email' && typeof c.line === 'string' && c.line.startsWith('Emailed you')));

interface AgentInfo {
  name: string;
  status: string;
  user_id: string;
  email: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RECENT_CHECKS = 5;
export const RECENT_RUNS = 5;
/** The result mail's headline: "<agent name>: Your result". */
export const RESULT_HEADLINE = 'Your result';
interface Mail {
  subject: string;
  text: string;
}

const FOOTER = '\n\n-- \nSent by your agent on AgentEnact (Stellar testnet).';

export function createOwnerRuns(d: OwnerRunsDeps): OwnerRuns {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? (() => undefined);

  async function agentInfo(agentId: string): Promise<AgentInfo | null> {
    const rows = (await d.sql`select a.name, a.status, a.user_id, u.email from app.agents a join app.users u on u.id = a.user_id
                              where a.id = ${agentId}`) as AgentInfo[];
    return rows[0] ?? null;
  }

  /**
   * What the check behind a mission read, for the alert email's "What I checked" box: the latest reading that made the
   * condition hold (within the hour), and today's check count. Only real rows; best effort, a failure is no facts.
   */
  async function alertFacts(agentId: string, triggerId: string | undefined): Promise<AlertFacts> {
    const facts: AlertFacts = {};
    try {
      if (triggerId && UUID.test(triggerId)) {
        const rows = (await d.sql`select at, reading from app.check_log where agent_id = ${agentId} and trigger_id = ${triggerId} and held = true
                                  and at > now() - interval '1 hour' order by at desc limit 1`) as { at: Date; reading: Record<string, number | string> | null }[];
        if (rows[0]) {
          facts.at = rows[0].at;
          facts.reading = rows[0].reading ? readingSentence(rows[0].reading) : null;
        }
      }
      const days = (await d.sql`select quiet + fired as n from app.check_days where agent_id = ${agentId} and day = (now() at time zone 'utc')::date`) as { n: number }[];
      if (days[0]) facts.checksToday = Number(days[0].n);
    } catch {
      log({ event: 'alert_facts_failed', agent: agentId });
    }
    return facts;
  }

  /** The agent's schedules, latest checks and runs, and wallets. Best effort: a failed read leaves the block out. */
  async function recentState(agentId: string): Promise<RecentState | null> {
    try {
      const [triggers, days, checks, runs, wallets] = await Promise.all([
        d.sql`select kind, cron_expr, cron_tz, condition, mission, last_fired_at, next_run_at, enabled from app.triggers where agent_id = ${agentId} order by kind, next_run_at limit 10` as Promise<{
          kind: 'cron' | 'condition'; cron_expr: string | null; cron_tz: string | null; condition: { fetch?: { tool?: unknown }; every_s?: unknown } | null; mission: string;
          last_fired_at: Date | null; next_run_at: Date | null; enabled: boolean;
        }[]>,
        d.sql`select quiet, fired from app.check_days where agent_id = ${agentId} and day = (now() at time zone 'utc')::date` as Promise<{ quiet: number; fired: number }[]>,
        d.sql`select at, held, reading from app.check_log where agent_id = ${agentId} order by at desc limit ${RECENT_CHECKS}` as Promise<{ at: Date; held: boolean | null; reading: Record<string, number | string> | null }[]>,
        d.sql`select coalesce(ended_at, started_at) as at, mode, status, summary, nullif(usdc_spent, 0)::text as paid, nullif(usdc_earned, 0)::text as earned
              from app.runs where agent_id = ${agentId} and mode <> 'chat' and status <> 'running' order by started_at desc limit ${RECENT_RUNS}` as Promise<{
          at: Date; mode: string; status: string; summary: string | null; paid: string | null; earned: string | null;
        }[]>,
        d.addresses ? d.addresses(agentId).catch(() => []) : Promise.resolve([]),
      ]);
      return {
        triggers: triggers.map((t) => ({
          kind: t.kind,
          when: t.kind === 'cron' ? `${t.cron_expr ?? ''}${t.cron_tz ? ` (${t.cron_tz})` : ' (UTC)'}` : `every ${Number(t.condition?.every_s) || 0} s with ${typeof t.condition?.fetch?.tool === 'string' ? t.condition.fetch.tool : 'a read'}`,
          mission: t.mission,
          lastFiredAt: t.last_fired_at?.toISOString() ?? null,
          nextRunAt: t.next_run_at?.toISOString() ?? null,
          enabled: t.enabled,
        })),
        checksToday: days[0] ? { quiet: Number(days[0].quiet), fired: Number(days[0].fired) } : null,
        checks: checks.map((c) => ({ at: c.at.toISOString(), held: c.held, reading: c.reading ? readingSentence(c.reading) : null })),
        runs: runs.map((r) => ({ at: r.at.toISOString(), mode: r.mode, status: r.status, summary: r.summary, paidUsdc: r.paid, earnedUsdc: r.earned })),
        wallets,
      };
    } catch {
      log({ event: 'recent_state_failed', agent: agentId });
      return null;
    }
  }

  async function prepare(agentId: string, info: AgentInfo, spec: AgentSpec, mode: 'chat' | 'mission', triggerId?: string, outbox?: (m: Mail) => void) {
    const [skills, memory, alert, recent] = await Promise.all([d.specs.skillIndex(agentId), d.memory.all(agentId), alertFacts(agentId, triggerId), recentState(agentId)]);
    return {
      alert,
      system: ownerSystem({ name: info.name, spec, skills, memory, mode, now: now(), recent }),
      tools: (runId: string) => d.toolbox.ownerTools({ agentId, agentName: info.name, alertFacts: alert, ownerEmail: info.email, mode, spec, runId, ...(outbox ? { outbox } : {}) }),
    };
  }

  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /**
   * Queues the run's decision seal and, when a mail is waiting on it, waits for it to land. `{ tx }` once landed, `{ tx:
   * null }` when it is still on its way (or gave up), null when there is no seal (sealing off, or the agent cannot sign yet).
   */
  async function seal(agentId: string, x: SealDecision, wait: boolean): Promise<{ tx: string | null } | null> {
    if (!d.seals) return null;
    try {
      await d.seals.enqueueDecision(agentId, x);
      if (!wait) return null;
      const until = Date.now() + (d.sealWaitMs ?? SEAL_WAIT_MS);
      for (;;) {
        const r = (await d.seals.decisions(agentId, [x.runId])).get(x.runId);
        if (!r) return null;
        if (r.tx) return { tx: r.tx };
        if (r.status === 'failed' || Date.now() >= until) return { tx: null };
        await sleep(d.sealPollMs ?? SEAL_POLL_MS);
      }
    } catch {
      log({ event: 'decision_seal_failed', agent: agentId });
      return null;
    }
  }

  async function deliver(agentId: string, kind: 'email' | 'webhook', send: () => Promise<unknown>) {
    if (!(await d.policy.delivery(agentId, kind))) {
      log({ event: 'delivery_limited', agent: agentId, kind });
      return;
    }
    try {
      await send();
    } catch {
      log({ event: 'delivery_failed', agent: agentId, kind });
    }
  }

  return {
    async openChat(userId, agentId) {
      const info = await agentInfo(agentId);
      if (!info || info.user_id !== userId) throw httpError(404, 'not_found');
      if (info.status !== 'active') throw httpError(409, 'agent_not_active');
      if (!(await d.specs.active(agentId))) throw httpError(409, 'no_spec');
      return {
        async run(messages, o) {
          // Status and owner email are re-read every turn: the agent may have been revoked since the session opened.
          const cur = await agentInfo(agentId);
          if (!cur || cur.user_id !== userId) throw httpError(404, 'not_found');
          if (cur.status !== 'active') throw httpError(409, 'agent_not_active');
          const active = await d.specs.active(agentId);
          if (!active) throw httpError(409, 'no_spec');
          const { system, tools } = await prepare(agentId, cur, active.spec, 'chat');
          return d.runner.run({ agentId, userId, mode: 'chat', system, messages, tools, onDelta: o.onDelta, ...(o.onTool ? { onTool: o.onTool } : {}), ...(o.signal ? { signal: o.signal } : {}) });
        },
      };
    },

    async mission(agentId, triggerId, text) {
      const info = await agentInfo(agentId);
      if (!info || info.status !== 'active') return null;
      const active = await d.specs.active(agentId);
      if (!active) return null;
      // The agent's own mails wait for the run's end and its seal (send_email still counts them against the cap at once).
      const outbox: Mail[] = [];
      const { system, tools, alert } = await prepare(agentId, info, active.spec, 'mission', triggerId, (m) => outbox.push(m));
      const exists = UUID.test(triggerId) && ((await d.sql`select 1 from app.triggers where id = ${triggerId} and agent_id = ${agentId}`) as unknown[]).length > 0;
      const out = await d.runner.run({
        agentId,
        userId: info.user_id,
        mode: 'mission',
        system,
        messages: [{ role: 'user', content: text }],
        tools,
        ...(exists ? { triggerId } : {}),
      });
      // The panel's one-line result. Best effort: a failed note never fails the mission or its delivery.
      const said = out.finalText || out.text;
      if (out.status === 'done' && said.trim()) {
        try {
          await d.runs.annotate(out.runId, said);
        } catch {
          log({ event: 'annotate_failed', agent: agentId });
        }
      }
      // The run can take a while: an agent revoked meanwhile gets nothing delivered.
      const live = (await agentInfo(agentId))?.status === 'active';
      const delivery = active.spec.delivery;
      const answered = out.status === 'done' && out.text.trim() !== '';
      // The answer, not the narration before its tool calls ("I'll gather the data first."), formatted like every mail the
      // agent sends. Skipped when the agent already emailed its owner itself in this run.
      const resultMail = live && answered && delivery.email && outbox.length === 0 && !emailedOwner(out.steps);
      const sealed = await seal(agentId, { runId: out.runId, status: out.status, input: text, output: said }, live && (outbox.length > 0 || resultMail));
      const appOrigin = d.appOrigin;
      if (live) {
        for (const [n, m] of outbox.entries()) {
          try {
            if (!appOrigin) await d.toolbox.delivery.email(info.email, m.subject, m.text, `run-${out.runId}-${n}`);
            else {
              const r = renderAlertEmail({ agentName: info.name, agentId, runId: out.runId, appOrigin, subject: m.subject, body: m.text, facts: alert, seal: sealed ?? undefined });
              await d.toolbox.delivery.email(info.email, r.subject, r.text, `run-${out.runId}-${n}`, r.html);
            }
          } catch {
            log({ event: 'delivery_failed', agent: agentId, kind: 'email' });
          }
        }
      }
      if (live && answered) {
        if (resultMail) {
          await deliver(agentId, 'email', () => {
            if (!appOrigin) return d.toolbox.delivery.email(info.email, `${info.name}: result`, `${plainMarkdown(said)}${FOOTER}`, `run-${out.runId}`);
            const m = renderAlertEmail({ agentName: info.name, agentId, runId: out.runId, appOrigin, subject: RESULT_HEADLINE, body: said, seal: sealed ?? undefined });
            return d.toolbox.delivery.email(info.email, m.subject, m.text, `run-${out.runId}`, m.html);
          });
        }
        if (delivery.webhook_url) {
          const url = delivery.webhook_url;
          await deliver(agentId, 'webhook', () => d.toolbox.delivery.webhook(url, agentId, { kind: 'mission_result', runId: out.runId, text: out.text }));
        }
      }
      return out;
    },

    async notify(agentId, text) {
      try {
        const info = await agentInfo(agentId);
        if (!info) return;
        // No idempotency key: a platform notice has no natural one.
        await deliver(agentId, 'email', () => d.toolbox.delivery.email(info.email, `${info.name}: notice`, `${text}${FOOTER}`));
      } catch {
        log({ event: 'notify_failed', agent: agentId });
      }
    },
  };
}
