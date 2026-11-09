import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { checkDraft, type DraftResult } from '../../src/builder/draft-schema.js';
import { EXAMPLES } from '../../src/builder/examples.js';
import { createBuilder, type DraftOutcome } from '../../src/builder/index.js';
import { applyParam } from '../../src/builder/params.js';
import { draftScopeProblem } from '../../src/builder/scope.js';
import { createTrial } from '../../src/builder/trial.js';
import { createModels, MODEL_IDS, type Models } from '../../src/loop/models.js';
import { emptyUsage, type RunUsage } from '../../src/runs/index.js';
import { cronMinGapSeconds, MIN_CRON_INTERVAL_S, parseSpec } from '../../src/specs/schema.js';
import { createSafeFetch } from '../../src/tools/safe-fetch.js';
import { runSandboxed } from '../../src/tools/sandbox.js';
import { createToolbox } from '../../src/tools/index.js';

// Opt-in, real model calls and real testnet reads, costs a few dollars (Opus). Kerem runs it, with the key in this process only:
//   cd apps/api && AGENTENACT_LIVE=1 OPENROUTER_API_KEY="$(osascript -e 'text returned of (display dialog "OpenRouter API key" default answer "" with hidden answer)')" \
//     bun test tests/e2e/builder.live.test.ts
// For each of the four example asks it drafts once with the signed-in Builder (Opus) and once with the anonymous one (DeepSeek),
// then trials the XLM draft once with the anonymous trial model. Never reads a .env file.
const live = process.env.AGENTENACT_LIVE === '1';
const WHO = ['builder', 'builderAnon'] as const;
type Who = (typeof WHO)[number];

const sum = (a: RunUsage, b: RunUsage): RunUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  steps: a.steps + b.steps,
  toolCalls: a.toolCalls + b.toolCalls,
});

describe.skipIf(!live)('the Builder against the real models', () => {
  let models: Models;
  const drafts = new Map<string, DraftOutcome>();
  const used: Record<Who, RunUsage> = { builder: emptyUsage(), builderAnon: emptyUsage() };
  let trialUsage = emptyUsage();
  const key = (who: Who, i: number) => `${who}:${i}`;

  beforeAll(async () => {
    models = createModels(); // OPENROUTER_API_KEY from this process's environment
    const builder = createBuilder({ models });
    // One draft per ask per model; the eight calls run together (they are independent).
    await Promise.all(
      WHO.flatMap((who) =>
        EXAMPLES.map(async ({ prompt }, i) => {
          const r = await builder.draft({ prompt, anonymous: who === 'builderAnon' });
          drafts.set(key(who, i), r);
          used[who] = sum(used[who], r.usage);
        }),
      ),
    );
  }, 600_000);

  afterAll(() => {
    if (!live) return;
    for (const who of WHO) console.log(JSON.stringify({ model: MODEL_IDS[who], role: 'drafts', usage: used[who] }));
    console.log(JSON.stringify({ model: MODEL_IDS.builderAnon, role: 'trial', usage: trialUsage }));
  });

  const ok = (who: Who, i: number): DraftResult => {
    const r = drafts.get(key(who, i));
    if (!r?.ok) throw new Error(`${who} "${EXAMPLES[i]!.prompt}": ${r ? r.code : 'no draft'}`);
    return r.draft;
  };

  for (const who of WHO) {
    describe(`${who} (${MODEL_IDS[who]})`, () => {
      EXAMPLES.forEach(({ prompt }, i) => {
        it(`"${prompt}" drafts a valid, in-scope agent`, () => {
          const r = drafts.get(key(who, i));
          expect({ ok: r?.ok, code: r && !r.ok ? r.code : undefined }).toEqual({ ok: true, code: undefined });
          const d = ok(who, i);
          const spec = parseSpec(d.spec);
          expect(spec.ok).toBe(true);
          expect(checkDraft(d)).toBeNull();
          expect(draftScopeProblem(d)).toBeNull();

          const t = d.spec.triggers[0]!;
          if (i === 0) {
            // XLM drop: a condition on stellar_price_change that honours the stale flag.
            expect(t.kind).toBe('condition');
            if (t.kind === 'condition') {
              expect(t.fetch.tool).toBe('stellar_price_change');
              expect(t.code).toContain('input.stale');
            }
          } else if (i === 1 || i === 2) {
            // Wallet and USDC asks watch payments.
            expect(t.kind).toBe('condition');
            if (t.kind === 'condition') expect(t.fetch.tool).toBe('stellar_payments');
          } else {
            // Digest: a cron of at least 15 minutes.
            expect(t.kind).toBe('cron');
            if (t.kind === 'cron') {
              const gap = cronMinGapSeconds(t.cron);
              expect(gap).not.toBeNull();
              expect(gap!).toBeGreaterThanOrEqual(MIN_CRON_INTERVAL_S);
            }
          }
        });

        it(`"${prompt}": applyParam on the first number param succeeds`, () => {
          const d = ok(who, i);
          const p = d.params.find((x) => x.kind === 'number');
          if (!p || p.kind !== 'number') return; // only the XLM ask has a number param; a draft without one has nothing to edit
          const next = p.value === p.max ? p.min : p.max;
          const r = applyParam(d, p.id, next);
          expect(r).toMatchObject({ ok: true });
        });
      });
    });
  }

  it('the XLM draft has a number param to edit (the example the panel shows)', () => {
    for (const who of WHO) expect(ok(who, 0).params.some((p) => p.kind === 'number')).toBe(true);
  });

  it('trial.run of the XLM draft ends done with a real read, using the anonymous trial model', async () => {
    const toolbox = createToolbox({
      safeFetch: createSafeFetch(),
      memory: { remember: async () => 'saved' },
      specs: { skillBody: async () => null },
      policy: { delivery: () => true, egress: () => true, paidSearch: () => true, trialSearch: () => true },
      webhookSecret: () => 'ab'.repeat(32),
      mailFrom: 'trial@example.com',
      env: { RESEND_API_KEY: 'unused-in-a-trial' }, // trial delivery is only recorded, never sent
    });
    const trial = createTrial({ model: models.builderAnon, toolbox, sandbox: runSandboxed });
    const draft = ok('builderAnon', 0);
    const r = await trial.run({ spec: draft.spec, scope: 'ip:live-test' });
    trialUsage = r.usage;
    console.log(JSON.stringify({ trial: r.status, condition: r.condition ? { held: r.condition.held, data: r.condition.data.slice(0, 200) } : null, wouldHave: r.wouldHave.length, text: r.text.slice(0, 200) }));
    expect(r.status).toBe('done');
    expect(r.condition).not.toBeNull();
    expect(r.condition!.held).not.toBeNull(); // the fetch and the sandbox both ran on real data
    expect(r.condition!.data).not.toBe('null');
    expect(r.text.length).toBeGreaterThan(0);
  }, 180_000);
});
