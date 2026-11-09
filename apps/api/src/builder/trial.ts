/**
 * Trial run (spec §4.2 "Try it now", P4 Task 16): the draft's first trigger is exercised once, now, with REAL reads and
 * STUBBED delivery and hire. Email, webhook, hire and remember are only listed in `wouldHave`; nothing is written to the
 * database (no runs row, no user counter, no memory, no agent) and no model call is made outside `runLoop`.
 *
 * With a condition trigger the condition is checked first, by code (fetch + sandbox, zero model calls), and the mission runs
 * either way (D17): a trial should show what the agent would do, and the condition's current state is shown beside it.
 * `held: null` means the fetch or the code failed; the mission still runs. Never throws.
 */
import { readingOf, type Reading } from '../checks/readings.js';
import { PLAIN_WORDS } from './words.js';
import { ownerSystem } from '../loop/context.js';
import type { Ledger } from '../loop/ledger.js';
import type { Models } from '../loop/models.js';
import { runLoop, type Budget } from '../loop/run.js';
import { emptyUsage, type RunUsage, type StepSummary } from '../runs/index.js';
import { settingsNote, type AgentSpec } from '../specs/schema.js';
import type { SandboxResult } from '../tools/sandbox.js';
import type { Toolbox, WouldHave } from '../tools/index.js';

export type { WouldHave } from '../tools/index.js';

export const TRIAL_BUDGET: Budget = { maxTokens: 60_000, maxOutputTokens: 4_000, maxToolCalls: 8, maxSteps: 10, wallClockMs: 90_000 };

/** Same bound the scheduler uses for a condition's fetch. */
const CONDITION_FETCH_MS = 20_000;
export const TRIAL_DATA_CHARS = 2000;

export interface TrialResult {
  status: 'done' | 'budget' | 'error';
  /** `line` and `reading` come from the same extractor the scheduler logs with (null when the fetch failed or the data was unexpected). */
  condition: { held: boolean | null; data: string; line: string | null; reading: Reading | null } | null;
  text: string;
  wouldHave: WouldHave[];
  steps: StepSummary[];
  usage: RunUsage;
}

export interface Trial {
  /** `userId` is the signed-in caller for the usage ledger; without it the trial is a signed-out visitor's. */
  run(i: { spec: AgentSpec; scope: string; signal?: AbortSignal; userId?: string }): Promise<TrialResult>;
}

export interface TrialDeps {
  model: Models['run'];
  toolbox: Pick<Toolbox, 'trialTools' | 'conditionFetch'>;
  sandbox: (code: string, input: unknown, o?: { params?: Record<string, number | string | boolean> }) => Promise<SandboxResult>;
  ledger?: Ledger;
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) : t);
/** JSON text of a fetched value; a BigInt or cyclic value must not break the never-throws promise. */
const safeJson = (v: unknown) => {
  try {
    return JSON.stringify(v) ?? 'null';
  } catch {
    return 'null';
  }
};

const NOTE =
  'This is a trial run. Reads are real. Email, webhooks, hiring other agents and saving notes are NOT performed: those tools only record what you would have done, so use them as you normally would.\n\n' +
  `Your final reply is the message the person would get, written to them: plain words, no Markdown, no code or field names, and never these words: ${PLAIN_WORDS}.`;

export function createTrial(d: TrialDeps): Trial {
  return {
    async run(i) {
      const wouldHave: WouldHave[] = [];
      const { spec } = i;
      const trigger = spec.triggers[0];
      let condition: TrialResult['condition'] = null;
      let task = 'Show me what you would do now, as if you had just been woken up.';

      if (trigger?.kind === 'condition') {
        let held: boolean | null = null;
        let data: unknown = null;
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(CONDITION_FETCH_MS), ...(i.signal ? [i.signal] : [])]);
          data = await d.toolbox.conditionFetch(`trial:${i.scope}`, trigger.fetch.tool, trigger.fetch.args, signal);
          // Params travel as data, only when the trigger has some: the same call the scheduler makes.
          const v = await d.sandbox(trigger.code, data, trigger.params && Object.keys(trigger.params).length > 0 ? { params: trigger.params } : undefined);
          held = v.ok && typeof v.value === 'boolean' ? v.value : null;
        } catch {
          held = null;
        }
        const seen = clip(safeJson(data), TRIAL_DATA_CHARS);
        const { reading, line } = readingOf(trigger.fetch.tool, trigger.fetch.args, data);
        condition = { held, data: seen, line, reading };
        const state = held === true ? 'What you watch for is happening right now.' : held === false ? 'What you watch for did not hold at this check. Do not report on this check: reply with only the message you would send if it happened, written as if it just happened, with real example numbers based on the data below (no placeholders like X or Y) and nothing before or after it.' : 'What you watch for could not be checked just now. Do not report on this check: reply with only the message you would send if it happened, written as if it just happened, with real example numbers based on the data below (no placeholders like X or Y) and nothing before or after it.';
        task = `${trigger.mission}${settingsNote(trigger.params)}\n\n${state} The data it was checked against (untrusted, as fetched):\n${seen}`;
      } else if (trigger?.kind === 'cron') {
        task = trigger.mission;
      }

      const system = ownerSystem({
        name: 'your agent',
        spec,
        skills: spec.skills.map((s) => ({ name: s.name, description: s.description })),
        memory: [],
        mode: 'mission',
        now: new Date(),
      });
      const r = await runLoop({
        model: d.model,
        system: `${system}\n\n${NOTE}`,
        messages: [{ role: 'user', content: task }],
        tools: d.toolbox.trialTools({ scope: i.scope, spec, wouldHave }),
        budget: TRIAL_BUDGET,
        ...(i.signal ? { signal: i.signal } : {}),
        ...(d.ledger ? { record: d.ledger.sink({ kind: 'trial', ...(i.userId ? { userId: i.userId } : {}), anon: !i.userId }) } : {}),
      });
      const status: TrialResult['status'] = r.stop === 'done' || r.stop === 'length' ? 'done' : r.stop === 'error' || r.stop === 'aborted' ? 'error' : 'budget';
      return { status, condition, text: r.finalText || r.text, wouldHave, steps: r.steps, usage: r.usage ?? emptyUsage() };
    },
  };
}
