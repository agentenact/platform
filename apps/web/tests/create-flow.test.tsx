import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CreateFlowView } from '../src/components/create-flow';
import { onceAnswer } from '../src/lib/once-answer';
import { ARRIVAL_MS, scheduleArrival } from '../src/lib/arrival';
import { copy } from '../src/copy';
import { initialCreateUi, reduceCreation, type CreateUiState } from '../src/lib/creation';
import { bannedWord } from '../src/lib/words';
import { stripAdvanced, textOf } from './support/screens';

const SUMMARY = 'Create a new agent identity owned by your wallet, described at https://agentenact.io/a/0f8e/agent.json.';
const NAME = 'XLM drop alert';
const render = (ui: CreateUiState, ask?: { kind: 'register' | 'bind'; summary: string }) => renderToStaticMarkup(createElement(CreateFlowView, { ui, ask, name: NAME }));

describe('the three taps', () => {
  test('shows the three numbered steps, each with its one sentence', () => {
    const html = render(initialCreateUi);
    const items = [...html.matchAll(/<li[^>]*data-step="([a-z_]+)"/g)].map((m) => m[1]);
    expect(items).toEqual(['account_key', 'identity', 'ready']);
    const t = textOf(html);
    for (const s of copy.create.steps) {
      expect(t).toContain(s.title);
      expect(t).toContain(s.line);
    }
    expect(copy.create.steps.map((s) => s.title)).toEqual(['Set up your account key', "Approve your agent's identity", 'Let your agent work for you']);
  });

  test('"Testnet" is said once, in the fine line, in every creating state', () => {
    for (const ui of [initialCreateUi, reduceCreation(initialCreateUi, { failed: 'chain', retryable: true })]) {
      const t = textOf(stripAdvanced(render(ui)));
      expect(t.match(/testnet/gi)).toHaveLength(1);
      expect(t).toContain(copy.create.fine);
    }
  });

  test('the card holds the eyebrow, the heading, the steps and the fine line, nothing else', () => {
    const t = textOf(render(initialCreateUi));
    expect(t).toContain(`Creating ${NAME}`);
    expect(t).toContain("Three approvals and it's yours");
    for (const gone of ['Try it first', 'New idea', 'Advanced', 'Rename']) expect(t).not.toContain(gone);
    expect(render(initialCreateUi)).not.toContain('<input');
  });

  test('the step waiting for the person is visibly alive: wax ring with a ripple, the row marked active; no other step ripples', () => {
    for (const [step, ask] of [
      ['identity', { kind: 'register' as const, summary: SUMMARY }],
      ['ready', { kind: 'bind' as const, summary: SUMMARY }],
      ['account_key', undefined],
    ] as const) {
      const html = render(reduceCreation(initialCreateUi, { step, state: 'asking' }), ask);
      const li = html.match(new RegExp(`<li[^>]*data-step="${step}"[\\s\\S]*?</li>`))![0];
      expect(li).toMatch(/<li[^>]*data-active=""/);
      expect(li).toContain('data-ring="asking"');
      expect(li).toContain('data-halo=""');
      expect(html.match(/data-halo=""/g)).toHaveLength(1);
    }
    // Working never ripples: the arc travels, nobody is asked.
    expect(render(reduceCreation(initialCreateUi, { step: 'identity', state: 'working' }))).not.toContain('data-halo');
  });

  test('the waiting motion has a reduced-motion path and keyframes stay free of var()', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(reduce).toContain('.ring-asking .ring-draw');
    expect(reduce).toContain('@keyframes soft-deep');
    for (const name of ['ring-halo', 'step-call']) {
      const body = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n  \\}`).exec(css)?.[1] ?? '';
      expect(body.length).toBeGreaterThan(0);
      expect(body).not.toContain('var(');
    }
  });

  test('the active step says "Waiting for you" and holds the one Approve button; no dialog', () => {
    const ui = reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' });
    const html = render(ui, { kind: 'register', summary: SUMMARY });
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    const step = html.match(/<li[^>]*data-step="identity"[\s\S]*?<\/li>/)![0];
    expect(textOf(step)).toContain('Waiting for you');
    expect(step).toMatch(/<button[^>]*data-answer="yes"[^>]*>Approve</);
    expect(step).toMatch(/data-answer="later"[^>]*>Not now</);
    // The other steps carry no action.
    expect(html.match(/data-answer="yes"/g)).toHaveLength(1);
    expect(html.match(/<li[^>]*data-step="ready"[\s\S]*?<\/li>/)![0]).not.toContain('<button');
    // "Stop creating" is a link under the steps, not in a step.
    expect(html).toMatch(/data-answer="stop"[^>]*>Stop creating</);
    expect(step).not.toContain('data-answer="stop"');
    expect(html.indexOf('data-answer="stop"')).toBeGreaterThan(html.indexOf('</ol>'));
  });

  test('step 1 asks with its own button: the press that starts the Face ID prompt, not an effect', () => {
    const ui = reduceCreation(initialCreateUi, { step: 'account_key', state: 'asking' });
    const html = render(ui);
    const step = html.match(/<li[^>]*data-step="account_key"[\s\S]*?<\/li>/)![0];
    expect(step).toMatch(/<button[^>]*data-setup=""[^>]*>Set up your account key</);
    expect(textOf(step)).toContain('Waiting for you');
    expect(html.match(/data-setup=""/g)).toHaveLength(1);
    // No approval question is open, so no Approve button either.
    expect(html).not.toContain('data-answer="yes"');
  });

  test('step 1 shows no button before it asks (still fetching), after it moved on, or after a failure', () => {
    for (const ui of [
      initialCreateUi,
      reduceCreation(initialCreateUi, { step: 'account_key', state: 'working' }),
      reduceCreation(initialCreateUi, { step: 'account_key', state: 'done' }),
      reduceCreation(reduceCreation(initialCreateUi, { step: 'account_key', state: 'asking' }), { failed: 'cancelled', retryable: true }),
    ])
      expect(render(ui)).not.toContain('data-setup');
  });

  test('a press that did not open the prompt says "press again" on step 1, with the reason only in Technical details', () => {
    const ui = reduceCreation(reduceCreation(initialCreateUi, { step: 'account_key', state: 'asking' }), { hiccup: 'the passkey prompt did not open' });
    const html = render(ui);
    const step = html.match(/<li[^>]*data-step="account_key"[\s\S]*?<\/li>/)![0];
    expect(textOf(stripAdvanced(step))).toContain(copy.create.setUpAgain);
    expect(step).toContain('data-setup');
    expect(textOf(stripAdvanced(step))).not.toContain('did not open');
  });

  test('a bind puts the same action on the third step', () => {
    const html = render(reduceCreation(initialCreateUi, { step: 'ready', state: 'asking' }), { kind: 'bind', summary: 'Let agent #42 act with its own wallet GAAA.' });
    expect(html.match(/<li[^>]*data-step="ready"[\s\S]*?<\/li>/)![0]).toMatch(/data-answer="yes"/);
    expect(html.match(/<li[^>]*data-step="identity"[\s\S]*?<\/li>/)![0]).not.toContain('data-answer');
  });

  test('the technical summary stays reachable inside data-advanced, and nowhere else', () => {
    const html = render(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { kind: 'register', summary: SUMMARY });
    expect(html).toMatch(/<details[^>]*data-advanced[^>]*>[\s\S]*Technical details[\s\S]*agent\.json[\s\S]*<\/details>/);
    const open = textOf(stripAdvanced(html));
    expect(open).not.toContain('agent.json');
    expect(open).not.toContain('wallet');
    expect(bannedWord(open)).toBeNull();
  });

  test('success shows the ready state: "<name> is ready", the first-check line, a check mark and Open my agent', () => {
    const html = render(reduceCreation(initialCreateUi, { done: { agentId: 'x' } }));
    const t = textOf(html);
    expect(t).toContain(`${NAME} is ready`);
    expect(t).toContain('Its first check runs within a minute.');
    expect(t).toContain(copy.create.open);
    expect(html).toContain('data-ready=""');
    expect(html).not.toContain('data-step=');
    expect(bannedWord(textOf(stripAdvanced(html)))).toBeNull();
  });

  test('an answer settles its own question once; a second answer is a no-op', () => {
    const got: string[] = [];
    const a = onceAnswer<string>((x) => got.push(x));
    a('yes');
    a('stop');
    a('yes');
    expect(got).toEqual(['yes']);
  });

  test('the buttons answer through the ask they were rendered for, not a shared handler', () => {
    const html = render(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { kind: 'register', summary: SUMMARY });
    // Focus moves to Approve when it appears; the details region uses block elements only (no <p> in a <span>).
    expect(html).toMatch(/<button[^>]*data-answer="yes"/);
    expect(html).not.toMatch(/<span[^>]*>(?:(?!<\/span>)[\s\S])*<p[ >]/);
  });

  test('arrival is scheduled ~1.5 s out, can be cancelled, and fires once', () => {
    const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
    const setT = (fn: () => void, ms: number) => (timers.push({ fn, ms, cleared: false }), timers.length - 1);
    const clearT = (id: unknown) => void (timers[id as number]!.cleared = true);
    let pushed = 0;
    const cancel = scheduleArrival(() => pushed++, setT as never, clearT as never);
    expect(ARRIVAL_MS).toBe(1500);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(1500);
    expect(pushed).toBe(0);
    timers[0]!.fn();
    expect(pushed).toBe(1);
    const c2 = scheduleArrival(() => pushed++, setT as never, clearT as never);
    c2();
    expect(timers[1]!.cleared).toBe(true);
  });

  test('each state carries plain words only', () => {
    const states: CreateUiState[] = [
      initialCreateUi,
      reduceCreation(initialCreateUi, { step: 'account_key', state: 'asking' }),
      reduceCreation(initialCreateUi, { step: 'ready', state: 'working' }),
      reduceCreation(initialCreateUi, { done: { agentId: 'x' } }),
      ...(['cancelled', 'expired', 'refused', 'chain', 'operator', 'unknown'] as const).map((failed) => reduceCreation(initialCreateUi, { failed, retryable: true })),
    ];
    for (const ui of states) expect(bannedWord(textOf(stripAdvanced(render(ui, { kind: 'register', summary: SUMMARY }))))).toBeNull();
  });

  test('an expired approval says why in plain words and offers Try again; the Approve button is gone', () => {
    const ui = reduceCreation(initialCreateUi, { failed: 'expired', retryable: true });
    const html = render(ui);
    const t = textOf(html);
    expect(t).toContain('That waited too long, so nothing was signed.');
    expect(t).toContain('Press Try again and approve soon after it appears.');
    expect(t).toContain(copy.create.tryAgain);
    expect(html).not.toContain('data-answer="yes"');
    expect(bannedWord(t)).toBeNull();
  });

  test('after a failure no step still says it is working or waiting', () => {
    const ui = reduceCreation(reduceCreation(initialCreateUi, { step: 'account_key', state: 'asking' }), { failed: 'cancelled', retryable: true });
    const html = render(ui);
    expect(html).not.toMatch(/data-state="(asking|working)"/);
    expect(html).not.toMatch(/data-ring="(asking|working)"/);
    expect(textOf(html)).not.toContain(copy.create.stepState.asking);
  });

  test('a stale question is not shown once the flow has failed', () => {
    const ui = reduceCreation(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { failed: 'expired', retryable: true });
    expect(render(ui, { kind: 'register', summary: SUMMARY })).not.toContain('data-answer="yes"');
  });

  test('the asking step shows the time left in plain words, calmly rounded down', () => {
    const NOW = 1_000_000;
    const at = (ms: number) => {
      const ui = reduceCreation(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { approveBy: NOW + ms });
      return textOf(stripAdvanced(renderToStaticMarkup(createElement(CreateFlowView, { ui, ask: { kind: 'register', summary: SUMMARY }, name: NAME, now: NOW }))));
    };
    expect(at(4 * 60_000 + 40_000)).toContain('Approve within 4 minutes');
    expect(at(2 * 60_000 + 5_000)).toContain('Approve within 2 minutes');
    expect(at(80_000)).toContain('Approve within a minute');
    expect(at(20_000)).toContain('Approve within a minute');
    for (const ms of [4 * 60_000, 20_000]) expect(bannedWord(at(ms))).toBeNull();
    // Not asking: no line.
    expect(textOf(render(initialCreateUi))).not.toContain('Approve within');
  });

  test('a press that did not go through says so plainly, with the reason only in Technical details', () => {
    const ui = reduceCreation(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { hiccup: 'could not send the signature' });
    const html = render(ui, { kind: 'register', summary: SUMMARY });
    expect(textOf(stripAdvanced(html))).toContain(copy.create.pressAgain);
    expect(textOf(stripAdvanced(html))).not.toContain('could not send the signature');
    expect(html).toContain('could not send the signature');
    expect(bannedWord(textOf(stripAdvanced(html)))).toBeNull();
    expect(textOf(render(reduceCreation(initialCreateUi, { step: 'identity', state: 'asking' }), { kind: 'register', summary: SUMMARY }))).not.toContain(copy.create.pressAgain);
  });

  test('a failure names where it failed only under Technical details', () => {
    const html = render(reduceCreation(initialCreateUi, { failed: 'unknown', retryable: true, detail: 'create 503' }));
    expect(textOf(stripAdvanced(html))).toContain(copy.create.failed.unknown);
    expect(textOf(stripAdvanced(html))).not.toContain('create 503');
    expect(html).toContain('create 503');
    expect(render(reduceCreation(initialCreateUi, { failed: 'unknown', retryable: true }))).not.toContain('data-failure-detail');
  });

  test('a retryable failure offers Try again; an operator case does not', () => {
    expect(textOf(render(reduceCreation(initialCreateUi, { failed: 'cancelled', retryable: true })))).toContain(copy.create.tryAgain);
    const op = render(reduceCreation(initialCreateUi, { failed: 'operator', retryable: false }));
    expect(textOf(op)).toContain(copy.create.failed.operator);
    expect(textOf(op)).not.toContain(copy.create.tryAgain);
  });

  test('the reducer folds events into the three steps, a failure, and done', () => {
    let s = reduceCreation(initialCreateUi, { step: 'account_key', state: 'done' });
    s = reduceCreation(s, { step: 'identity', state: 'asking' });
    expect(s.steps).toEqual({ account_key: 'done', identity: 'asking', ready: 'idle' });
    expect(reduceCreation(s, { done: { agentId: 'a' } }).done).toEqual({ agentId: 'a' });
    expect(reduceCreation(s, { reset: true })).toEqual(initialCreateUi);
  });
});
