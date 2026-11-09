/**
 * `runs`: one row per budgeted run (spec §4). Usage is written after every model step and again at the
 * end, so an abort or a crash still leaves what was spent. `steps` is redacted: tool names and token
 * counts only, never tool inputs or results (spec §7 logging).
 */
import type { Db } from '../db/index.js';
import { units } from '../policy/spend.js';
import { joinDetails, splitDetails, type CallDetail } from '../loop/call-detail.js';

export type RunMode = 'chat' | 'mission' | 'service';
export type RunStatus = 'running' | 'done' | 'budget' | 'capped' | 'error';
export type FinishedStatus = Exclude<RunStatus, 'running'>;

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  steps: number;
  toolCalls: number;
}

export interface StepSummary {
  n: number;
  tools: string[];
  /** A plain line per tool call that returned (D3); absent on older runs and on steps with no calls. */
  calls?: { tool: string; line: string | null; detail?: CallDetail }[];
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

export const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0, toolCalls: 0 });

export interface RunView {
  id: string;
  mode: RunMode;
  status: RunStatus;
  stopReason: string | null;
  steps: StepSummary[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  usdcSpent: string;
  usdcEarned: string;
  settlementTx: string | null;
  /** What a finished mission said, clipped to 400 characters; null until annotated. */
  summary: string | null;
  /** The mission's whole answer (markdown as the model wrote it, up to RESULT_MAX); only from get/getOwned, never in lists. */
  result?: string | null;
  triggerId: string | null;
  serviceId: string | null;
  /** The model id string the run used (shown in Technical details); null on runs from before it was kept. */
  model: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface Runs {
  start(r: { agentId: string; mode: RunMode; triggerId?: string; serviceId?: string; model?: string }): Promise<string>;
  progress(id: string, u: RunUsage, steps: StepSummary[]): Promise<void>;
  /** The tail of a running mission's text so far, for the agent page (cleared by finish). Only a `running` row takes it. */
  live(id: string, text: string): Promise<void>;
  finish(id: string, r: { status: FinishedStatus; stopReason: string; usage: RunUsage; steps: StepSummary[] }): Promise<void>;
  recent(userId: string, agentId: string, limit?: number): Promise<RunView[]>;
  get(id: string): Promise<RunView | null>;
  /** One run, only when the agent belongs to the user and the run belongs to that agent; null otherwise (unknown and foreign look the same). */
  getOwned(userId: string, agentId: string, runId: string): Promise<RunView | null>;
  /** A paid service run's settlement: the tx hash from PAYMENT-RESPONSE and what the agent earned.
   *  Write-once and service-only: true when this call recorded it, false when nothing changed. Throws on a bad amount. */
  settle(id: string, txHash: string, earnedUsdc: string): Promise<boolean>;
  /** A finished mission's answer, kept for the panel. Clipped to 400 characters at a code-point boundary and
   *  write-once: only a run whose summary is still null takes it. The whole answer (to RESULT_MAX) is kept as `result`. */
  annotate(runId: string, summary: string): Promise<void>;
  failInterrupted(): Promise<number>;
}

/** Cut to `max` code points (never inside a surrogate pair). */
const clipPoints = (s: string, max: number): string => {
  const out: string[] = [];
  for (const ch of s) {
    if (out.length === max) break;
    out.push(ch);
  }
  return out.join('');
};

export const SUMMARY_MAX = 400;
/** The whole answer kept for the run's page. */
export const RESULT_MAX = 20_000;

interface Row {
  id: string;
  mode: RunMode;
  status: RunStatus;
  stop_reason: string | null;
  steps: StepSummary[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  usdc_spent: string;
  usdc_earned: string;
  settlement_tx: string | null;
  summary: string | null;
  result?: string | null;
  trigger_id: string | null;
  service_id: string | null;
  model: string | null;
  call_details?: unknown;
  started_at: Date;
  ended_at: Date | null;
}

const toView = (r: Row): RunView => ({
  id: r.id,
  mode: r.mode,
  status: r.status,
  stopReason: r.stop_reason,
  steps: r.call_details === undefined ? r.steps : joinDetails(r.steps, r.call_details),
  inputTokens: r.input_tokens,
  outputTokens: r.output_tokens,
  cacheReadTokens: r.cache_read_tokens,
  cacheWriteTokens: r.cache_write_tokens,
  toolCalls: r.tool_calls,
  usdcSpent: r.usdc_spent,
  usdcEarned: r.usdc_earned,
  settlementTx: r.settlement_tx,
  summary: r.summary,
  ...(r.result !== undefined ? { result: r.result } : {}),
  triggerId: r.trigger_id,
  serviceId: r.service_id,
  model: r.model,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export const RECENT_LIMIT = 20;

/** `instance`: this process's id (db/replica.ts), written on each run it starts so recovery never fails a live replica's run. */
export function createRuns(sql: Db, o: { instance?: number } = {}): Runs {
  return {
    async start(r) {
      const rows = (await sql`insert into app.runs (agent_id, mode, trigger_id, service_id, model, instance)
                              values (${r.agentId}, ${r.mode}, ${r.triggerId ?? null}, ${r.serviceId ?? null}, ${r.model ?? null}, ${o.instance ?? null}) returning id`) as { id: string }[];
      return rows[0]!.id;
    },

    async progress(id, u, all) {
      const { steps, details } = splitDetails(all);
      await sql`update app.runs set input_tokens = ${u.inputTokens}, output_tokens = ${u.outputTokens},
                  cache_read_tokens = ${u.cacheReadTokens}, cache_write_tokens = ${u.cacheWriteTokens},
                  tool_calls = ${u.toolCalls}, steps = ${steps}, call_details = ${details.length ? details : null}
                where id = ${id} and status = 'running'`;
    },

    async live(id, text) {
      await sql`update app.runs set live_text = ${text} where id = ${id} and status = 'running'`;
    },

    async finish(id, r) {
      const u = r.usage;
      const { steps, details } = splitDetails(r.steps);
      await sql`update app.runs set status = ${r.status}, stop_reason = ${r.stopReason}, ended_at = now(), live_text = null,
                  input_tokens = ${u.inputTokens}, output_tokens = ${u.outputTokens},
                  cache_read_tokens = ${u.cacheReadTokens}, cache_write_tokens = ${u.cacheWriteTokens},
                  tool_calls = ${u.toolCalls}, steps = ${steps}, call_details = ${details.length ? details : null}
                where id = ${id} and status = 'running'`;
    },

    async recent(userId, agentId, limit = RECENT_LIMIT) {
      const rows = (await sql`select r.id, r.mode, r.status, r.stop_reason, r.steps, r.input_tokens, r.output_tokens, r.cache_read_tokens,
                                     r.cache_write_tokens, r.tool_calls, r.usdc_spent::text as usdc_spent, r.usdc_earned::text as usdc_earned,
                                     r.settlement_tx, r.summary, r.trigger_id, r.service_id, r.model, r.started_at, r.ended_at
                              from app.runs r join app.agents a on a.id = r.agent_id
                              where r.agent_id = ${agentId} and a.user_id = ${userId}
                              order by r.started_at desc limit ${Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : RECENT_LIMIT}`) as Row[];
      return rows.map(toView);
    },

    async get(id) {
      const rows = (await sql`select id, mode, status, stop_reason, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                     tool_calls, usdc_spent::text as usdc_spent, usdc_earned::text as usdc_earned, settlement_tx, summary, result, trigger_id,
                                     service_id, model, started_at, ended_at
                              from app.runs where id = ${id}`) as Row[];
      return rows[0] ? toView(rows[0]) : null;
    },

    async getOwned(userId, agentId, runId) {
      const rows = (await sql`select r.id, r.mode, r.status, r.stop_reason, r.steps, r.input_tokens, r.output_tokens, r.cache_read_tokens,
                                     r.cache_write_tokens, r.tool_calls, r.usdc_spent::text as usdc_spent, r.usdc_earned::text as usdc_earned,
                                     r.settlement_tx, r.summary, r.result, r.call_details, r.trigger_id, r.service_id, r.model, r.started_at, r.ended_at
                              from app.runs r join app.agents a on a.id = r.agent_id
                              where r.id = ${runId} and r.agent_id = ${agentId} and a.user_id = ${userId}`) as Row[];
      return rows[0] ? toView(rows[0]) : null;
    },

    async settle(id, txHash, earnedUsdc) {
      units(earnedUsdc); // strict: at most 7 decimals, never truncated
      const rows = (await sql`update app.runs set settlement_tx = ${txHash}, usdc_earned = ${earnedUsdc}::numeric
                              where id = ${id} and mode = 'service' and settlement_tx is null returning id`) as unknown[];
      return rows.length > 0;
    },

    async annotate(runId, summary) {
      const text = clipPoints(summary, SUMMARY_MAX);
      if (!text.trim()) return;
      await sql`update app.runs set summary = ${text}, result = ${clipPoints(summary, RESULT_MAX)} where id = ${runId} and summary is null`;
    },

    async failInterrupted() {
      const rows = (await sql`update app.runs set status = 'error', stop_reason = 'interrupted', ended_at = now()
                              where status = 'running' and not app.instance_alive(instance) returning id`) as unknown[];
      return rows.length;
    },
  };
}
