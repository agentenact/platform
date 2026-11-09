import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TOOL_NAMES } from '../../api/src/specs/schema';
import { TrialPanel } from '../src/components/trial-panel';
import { copy } from '../src/copy';
import { asTrial, type TrialData } from '../src/lib/draft-types';
import { stepWords } from '../src/lib/run-words';
import { scrollIntoViewIfNeeded } from '../src/lib/scroll';
import { bannedWord } from '../src/lib/words';
import { sampleDraft } from './support/draft';
import { stripAdvanced, textOf } from './support/screens';

const T = copy.draft.trial;
const base: TrialData = {
  status: 'done',
  condition: { held: false, data: '' },
  text: 'XLM fell about 5% in the last hour.',
  wouldHave: [{ kind: 'email', summary: 'Subject: XLM is down' }],
  steps: [
    { n: 1, tools: ['stellar_price', 'market_price'] },
    { n: 2, tools: ['send_email'] },
    { n: 3, tools: [] },
  ],
};
const show = (result: TrialData) => renderToStaticMarkup(createElement(TrialPanel, { trial: { status: 'done', result }, draft: sampleDraft() }));

describe('stepWords', () => {
  test('covers every tool the api knows, in plain words', () => {
    for (const t of TOOL_NAMES) {
      const w = stepWords([t]);
      expect(w.length).toBeGreaterThan(0);
      expect(bannedWord(w)).toBeNull();
      expect(w).not.toContain('_');
    }
  });
  test('the exact map', () => {
    expect(stepWords(['stellar_price'])).toBe('Read the price');
    expect(stepWords(['stellar_price_change'])).toBe('Read the price');
    expect(stepWords(['market_price'])).toBe('Read the price');
    expect(stepWords(['stellar_read'])).toBe('Looked up an account');
    expect(stepWords(['stellar_payments'])).toBe('Read recent payments');
    expect(stepWords(['web_search'])).toBe('Searched the web');
    expect(stepWords(['web_read'])).toBe('Read a web page');
    expect(stepWords(['compute'])).toBe('Worked something out');
    expect(stepWords(['send_email'])).toBe('Emailed you');
    expect(stepWords(['send_webhook'])).toBe('Called your webhook');
    expect(stepWords(['hire_agent'])).toBe('Paid another agent for help');
    expect(stepWords(['remember'])).toBe('Made a note for next time');
    expect(stepWords([])).toBe('Thought it over');
  });
  test('several tools join with ", then " and a trial email is only written', () => {
    expect(stepWords(['web_search', 'web_read'])).toBe('Searched the web, then read a web page');
    expect(stepWords(['send_email'], { trial: true })).toBe("Wrote the email I'd send");
    expect(stepWords(['stellar_price', 'send_email'], { trial: true })).toBe("Read the price, then wrote the email I'd send");
  });
  test('an unknown tool never leaks its name', () => {
    expect(stepWords(['mystery_tool'])).toBe('Thought it over');
  });
  test('names from the prototype chain are unknown tools too', () => {
    for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(stepWords([n])).toBe('Thought it over');
      expect(stepWords([n], { trial: true })).toBe('Thought it over');
    }
  });
});

describe('the trial result', () => {
  test('is a hairline section with the "Tried just now" eyebrow, not a nested box', () => {
    const html = show(base);
    expect(textOf(html)).toContain('Tried just now');
    expect(html).toContain('data-trial="done"');
    expect(html).not.toContain('bg-bg');
  });
  test('held false: the quiet verdict with a green dot; held true: the attention verdict', () => {
    const quiet = show(base);
    expect(T.quiet).toBe("Nothing to tell you right now, so I'd stay quiet.");
    expect(textOf(quiet)).toContain(T.quiet);
    expect(quiet).toContain('data-dot="green"');
    expect(quiet).not.toContain('style=');
    const held = show({ ...base, condition: { held: true, data: '' } });
    expect(textOf(held)).toContain(T.attention);
    expect(textOf(held)).not.toContain(T.quiet);
    expect(held).not.toContain('data-dot="green"');
  });
  test('unknown or no condition gets a neutral line, never the quiet one', () => {
    expect(textOf(show({ ...base, condition: { held: null, data: '' } }))).toContain(T.unknown);
    const cron = textOf(show({ ...base, condition: null }));
    expect(cron).toContain(T.ran);
    expect(cron).not.toContain(T.quiet);
    expect(cron).not.toContain(T.attention);
  });
  test('the message is an email-like block marked "Preview, not sent"', () => {
    const html = show(base);
    expect(html).toContain('data-mail=""');
    expect(textOf(html)).toContain("If it happens, this is what you'd get");
    expect(textOf(html)).toContain('Preview, not sent');
    expect(textOf(html)).toContain('XLM fell about 5% in the last hour.');
    expect(textOf(show({ ...base, condition: null }))).toContain("This is what you'd get");
    expect(textOf(show({ ...base, condition: null }))).not.toContain('If it happens');
  });
  test('a hidden message falls back to a plain line with the original inside Advanced', () => {
    const html = show({ ...base, text: 'The trigger condition holds.' });
    expect(textOf(stripAdvanced(html))).toContain(T.hidden);
    expect(textOf(stripAdvanced(html))).not.toContain('trigger');
    expect(html).toMatch(/<details data-advanced=""[^>]*>[\s\S]*The trigger condition holds\.[\s\S]*<\/details>/);
    expect(bannedWord(textOf(stripAdvanced(html)))).toBeNull();
  });
  test('"How I decided" is an ordered list: a line per step, the would-have lines, then the closing line', () => {
    const html = show(base);
    expect(textOf(html)).toContain('How I decided');
    const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]!).replace(/\s+/g, ' ').replace(/ :/g, ':').trim());
    expect(html).toContain('<ol');
    expect(items).toEqual([stepWords(['stellar_price', 'market_price']), "Wrote the email I'd send", 'Thought it over', `${T.email}: Subject: XLM is down`, T.nothingSent]);
    expect(items.at(-1)).toBe(T.nothingSent);
  });
  test('no steps still ends with "Nothing was sent or paid."', () => {
    const items = [...show({ ...base, steps: [], wouldHave: [] }).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => textOf(m[1]!));
    expect(items).toEqual([T.nothingSent]);
  });
  test('the fine line explains what is real and what is only shown, in plain words', () => {
    expect(copy.draft.tryNote).toBe('Reads are real. Emails and payments are only shown, never sent.');
    expect(textOf(show(base))).toContain(copy.draft.tryNote);
    expect(bannedWord(copy.draft.tryNote)).toBeNull();
  });
  test('an unfinished run says so and never "Nothing to send" or a verdict', () => {
    for (const status of ['error', 'budget'] as const) {
      const text = textOf(show({ ...base, status, text: '' }));
      expect(text).toContain(T.failed);
      expect(text).not.toContain(T.empty);
      expect(text).not.toContain(T.quiet);
      expect(text).not.toContain('Preview, not sent');
      expect(text).not.toContain(T.howTitle);
      expect(text).not.toContain(T.nothingSent);
    }
  });
  test('all visible copy passes the plain-words filter', () => {
    for (const r of [base, { ...base, condition: { held: true, data: '' } }, { ...base, condition: null }, { ...base, text: '' }]) {
      expect(bannedWord(textOf(stripAdvanced(show(r))))).toBeNull();
    }
  });
});

describe('the trial readings', () => {
  const change = { symbol: 'XLM', changePct: -0.42, from: 0.1921, to: 0.1913 };
  const withReading = (reading: Record<string, number | string> | null, line: string | null = 'XLM moved −0.42% in the last hour') =>
    ({ ...base, condition: { held: false, data: '', line, reading } }) as TrialData;
  const grid = (html: string) => html.match(/<div data-readings=""[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  const cellsOf = (html: string) => textOf(grid(html)).replace(/\s+/g, ' ').trim();

  test('a price change reading shows the change, the limit from the draft and the price now, under the verdict line', () => {
    const html = show(withReading(change));
    const t = textOf(html).replace(/\s+/g, ' ');
    expect(t).toContain(T.quiet);
    expect(t).toContain('XLM moved −0.42% in the last hour');
    expect(cellsOf(html)).toBe('Change −0.42% Your limit 5% Price now $0.1913');
    expect(bannedWord(t)).toBeNull();
  });
  test('the limit is skipped when no parameter is bound to the condition', () => {
    const noKnob = sampleDraft({ bindings: [{ param: 'every', path: '/triggers/0/every_s' }, { param: 'how', path: '/delivery/email' }] });
    const html = renderToStaticMarkup(createElement(TrialPanel, { trial: { status: 'done', result: withReading(change) }, draft: noKnob }));
    expect(cellsOf(html)).toBe('Change −0.42% Price now $0.1913');
  });
  test('a bound number that is not a size of move or a price (hours) gives no limit cell', () => {
    const hours = sampleDraft({ params: [{ id: 'every', label: 'How often', kind: 'choice', options: [{ label: '5 minutes', value: 300 }], value: 300 }, { id: 'drop', label: 'Window', kind: 'number', value: 2, min: 1, max: 24, unit: 'hours' }, { id: 'how', label: 'How', kind: 'text', value: 'email' }] });
    const html = renderToStaticMarkup(createElement(TrialPanel, { trial: { status: 'done', result: withReading(change) }, draft: hours }));
    expect(cellsOf(html)).toBe('Change −0.42% Price now $0.1913');
    expect(textOf(html)).not.toContain('2 hours');
  });
  test('a price reading takes a price-unit limit, not a percent one', () => {
    const price = withReading({ symbol: 'XLM', price: 0.1913 }, 'XLM is at $0.1913');
    expect(cellsOf(show(price))).toBe('Price now $0.1913');
    const usdDraft = sampleDraft({ params: [{ id: 'every', label: 'How often', kind: 'choice', options: [{ label: '5 minutes', value: 300 }], value: 300 }, { id: 'drop', label: 'Below', kind: 'number', value: 0.15, min: 0, max: 5, unit: '$' }, { id: 'how', label: 'How', kind: 'text', value: 'email' }] });
    expect(cellsOf(renderToStaticMarkup(createElement(TrialPanel, { trial: { status: 'done', result: price }, draft: usdDraft })))).toBe('Price now $0.1913 Your limit $0.15');
  });
  test('a price and a payments reading each get their own cells', () => {
    expect(cellsOf(show(withReading({ symbol: 'XLM', price: 0.1913 }, 'XLM is at $0.1913')))).toContain('Price now $0.1913');
    expect(cellsOf(show(withReading({ count: 2, largest: '5 USDC' }, '2 payments, the largest 5 USDC')))).toBe('Payments 2 Largest 5 USDC');
  });
  test('without a reading nothing extra shows, and a held null still gets its plain line', () => {
    for (const r of [base, { ...base, condition: { held: false, data: '' } }, withReading(null, null), { ...base, condition: null }]) {
      const html = show(r as TrialData);
      expect(html).not.toContain('data-readings');
    }
    expect(textOf(show({ ...base, condition: { held: null, data: '', line: null, reading: null } })).replace(/\s+/g, ' ')).toContain(T.unknown);
  });
  test('a stale or odd reading, and a line with a technical word, show nothing technical', () => {
    expect(show(withReading({ ...change, stale: 1 }, 'XLM price is out of date, last seen −0.42%'))).not.toContain('data-readings');
    expect(show(withReading({ count: 1, largest: 'hash 5 USDC' }, '1 payment'))).not.toContain('hash');
    expect(textOf(show(withReading(change, 'the settlement hash is fine')))).not.toContain('settlement');
  });
  test('asTrial keeps the line and the numbers of a reading', () => {
    const got = asTrial({ status: 'done', text: 't', wouldHave: [], condition: { held: false, data: 'x', line: 'XLM moved −0.42%', reading: { ...change, bad: [1] } } })!;
    expect(got.condition).toEqual({ held: false, data: '', line: 'XLM moved −0.42%', reading: change });
    expect(asTrial({ status: 'done', text: 't', wouldHave: [], condition: { held: true, line: 3, reading: 'x' } })!.condition).toEqual({ held: true, data: '', line: null, reading: null });
  });
});

describe('the other trial states', () => {
  const panel = (trial: Parameters<typeof TrialPanel>[0]['trial'], onRetry?: () => void) =>
    renderToStaticMarkup(createElement(TrialPanel, { trial, draft: sampleDraft(), ...(onRetry ? { onRetry } : {}) }));
  test('running: a status line with the thin progress bar, no old box', () => {
    const html = panel({ status: 'running' });
    expect(textOf(html)).toContain(copy.draft.trying);
    expect(html).toContain('data-progress');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('bg-bg');
  });
  test('limit: the sign-in prompt in a hairline section', () => {
    const html = panel({ status: 'limit', message: 'm' });
    expect(textOf(html)).toContain(copy.draft.signInToKeepDrafting);
    expect(html).toContain('type="email"');
    expect(html).not.toContain('bg-bg');
  });
  test('failed: a plain line and Try again', () => {
    const html = panel({ status: 'failed', message: copy.errors.status5xx }, () => {});
    expect(textOf(html)).toContain(copy.errors.status5xx);
    expect(textOf(html)).toContain(copy.draft.tryAgain);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('bg-bg');
  });
  test('idle renders nothing', () => {
    expect(panel({ status: 'idle' })).toBe('');
  });
});

describe('asTrial steps', () => {
  const raw = { status: 'done', text: 't', condition: null, wouldHave: [] };
  test('keeps well-formed steps and ignores anything else', () => {
    expect(asTrial({ ...raw, steps: [{ n: 1, tools: ['web_search'], inputTokens: 5 }, { n: 'x', tools: [] }, { n: 2, tools: 'web_read' }, null, { n: 3, tools: ['a', 7, 'b'] }] })?.steps).toEqual([
      { n: 1, tools: ['web_search'] },
      { n: 3, tools: ['a', 'b'] },
    ]);
  });
  test('missing or not an array is []', () => {
    expect(asTrial(raw)?.steps).toEqual([]);
    expect(asTrial({ ...raw, steps: 'nope' })?.steps).toEqual([]);
  });
});

describe('scrollIntoViewIfNeeded', () => {
  const win = (reduced: boolean, h = 800) => ({ innerHeight: h, matchMedia: (q: string) => ({ matches: reduced && q.includes('reduce') }) });
  const el = (top: number, bottom: number) => {
    const calls: unknown[] = [];
    return { calls, getBoundingClientRect: () => ({ top, bottom }), scrollIntoView: (o: unknown) => void calls.push(o) };
  };
  test('scrolls smoothly to the start when part of it is out of view', () => {
    const e = el(600, 900);
    scrollIntoViewIfNeeded(e, win(false));
    expect(e.calls).toEqual([{ block: 'start', behavior: 'smooth' }]);
  });
  test('uses auto behavior under reduced motion', () => {
    const e = el(-20, 300);
    scrollIntoViewIfNeeded(e, win(true));
    expect(e.calls).toEqual([{ block: 'start', behavior: 'auto' }]);
  });
  test('the sticky header at the top does not count as visible', () => {
    const e = el(40, 300);
    scrollIntoViewIfNeeded(e, win(false));
    expect(e.calls).toEqual([{ block: 'start', behavior: 'smooth' }]);
  });
  test('the mobile action bar at the bottom does not count as visible', () => {
    const e = el(300, 740);
    scrollIntoViewIfNeeded(e, win(false), 116);
    expect(e.calls).toEqual([{ block: 'start', behavior: 'smooth' }]);
    const f = el(300, 600);
    scrollIntoViewIfNeeded(f, win(false), 116);
    expect(f.calls).toEqual([]);
  });
  test('does nothing when it is fully visible', () => {
    const e = el(100, 500);
    scrollIntoViewIfNeeded(e, win(false));
    expect(e.calls).toEqual([]);
  });
});
