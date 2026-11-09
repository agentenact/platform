import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeBlock } from '../src/components/code-block';
import { CreateBuilder } from '../src/components/create-builder';
import { DraftFlowView } from '../src/components/draft-flow';
import { TemplateIcon } from '../src/components/template-icon';
import { copy } from '../src/copy';
import { CODE_ANCHORS, DESCRIBE, editDraft, readBuilderParams, viewForHash } from '../src/lib/builder';
import { createDraftController, type DraftActions } from '../src/lib/draft-controller';
import { draftReducer, initialState, planBoot, readDraftParams, type DraftAction, type DraftState } from '../src/lib/draft-state';
import type { ActionResult, DraftData } from '../src/lib/draft-types';
import { escapeHtml, highlight } from '../src/lib/highlight';
import { builderUrl, templateUrl } from '../src/lib/panel-url';
import { hostedSnippet } from '../src/lib/snippets';
import { changedValues, coerceValue, readValues, withValues } from '../src/lib/template-values';
import { SOON_GROUPS, TEMPLATE_FACTS, TEMPLATE_GROUPS } from '../src/lib/template-facts';
import { findTemplate, TEMPLATES } from '../src/lib/templates';

const XSS = '<script>alert(1)</script>';
const tpl = (id: string) => findTemplate(id)!;
const ok = <T extends object>(v: T): ActionResult<T> => ({ ok: true, ...v });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const builder = (o: { selected?: string; values?: Record<string, string>; view?: 'builder' | 'code' } = {}) =>
  renderToStaticMarkup(createElement(CreateBuilder, { selected: o.selected ?? 'xlm-drop', values: o.values ?? {}, view: o.view ?? 'builder', code: createElement('div', { id: 'library-slot' }) }));
/** One face of the cockpit: the code face is the centre's #code and the right's #code-index; the builder face is the rest. */
const part = (html: string, face: 'builder' | 'code') => {
  const centre = [html.indexOf('id="code"'), html.indexOf('id="steps"')] as const;
  const side = html.indexOf('id="code-index"');
  return face === 'code' ? html.slice(...centre) + html.slice(side) : html.slice(0, centre[0]) + html.slice(centre[1], side);
};

describe('the template list', () => {
  test('mirrors the hosted templates: ids, wording and every ready draft', async () => {
    const { agentTemplates } = await import('../../api/src/builder/templates');
    expect(JSON.parse(JSON.stringify(TEMPLATES))).toEqual(JSON.parse(JSON.stringify(agentTemplates())));
  });
  test('the sidebar shows each one with its name, one line and its icon, then "Describe your own"', () => {
    const html = part(builder(), 'builder');
    const order: number[] = [];
    for (const t of TEMPLATES) {
      const at = html.indexOf(`data-template="${t.id}"`);
      expect([t.id, at >= 0]).toEqual([t.id, true]);
      order.push(at);
      expect(html).toContain(t.title);
      expect(html).toContain(t.summary);
      expect(html).toContain(`href="/create?template=${t.id}"`);
      expect(html).toContain(renderToStaticMarkup(createElement(TemplateIcon, { id: t.id, size: 18 })));
    }
    const own = html.indexOf(`data-template="${DESCRIBE}"`);
    expect(own).toBeGreaterThan(Math.max(...order));
    expect(html).toContain('Describe your own');
    expect(html.match(/data-template="/g)).toHaveLength(TEMPLATES.length + 1);
  });
  test('the selected one is marked and its sentence is the configuration window', () => {
    const html = part(builder({ selected: 'big-usdc' }), 'builder');
    expect(html).toMatch(/aria-current="true"[^>]*data-template="big-usdc"/);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toContain('data-config="big-usdc"');
    expect(html).toContain('data-param="account"');
    expect(html).toContain('data-param="size"');
  });
  test('"Describe your own" shows the free sentence box, which goes to the draft flow', () => {
    const html = part(builder({ selected: DESCRIBE }), 'builder');
    expect(html).toMatch(/<form[^>]*action="\/draft"/);
    expect(html).toContain('name="prompt"');
    expect(html).not.toContain('data-config=');
  });
});

describe('the cockpit', () => {
  test('every ready agent has its group, readings and example email, and nothing else does', () => {
    expect(Object.keys(TEMPLATE_FACTS).sort()).toEqual(TEMPLATES.map((t) => t.id).sort());
    for (const f of Object.values(TEMPLATE_FACTS)) expect(TEMPLATE_GROUPS as readonly string[]).toContain(f.group);
  });
  test('every ready agent has an icon of its own, never the fallback spark', () => {
    const spark = renderToStaticMarkup(createElement(TemplateIcon, { id: 'no-such-template' }));
    for (const t of TEMPLATES) expect([t.id, renderToStaticMarkup(createElement(TemplateIcon, { id: t.id })) === spark]).toEqual([t.id, false]);
  });
  test('a wallet agent names only networks it offers: no network in its facts that the choice lacks', () => {
    for (const t of TEMPLATES) {
      const chain = t.draft.params.find((p) => p.id === 'chain');
      if (!chain || chain.kind !== 'choice') continue;
      const labels = chain.options.map((o) => o.label);
      const named = TEMPLATE_FACTS[t.id]!.network.replace(/\s*\(.*\)$/, '').replace(/ and more$/, '').split(/, | and /);
      for (const n of named) expect([t.id, n, labels.includes(n)]).toEqual([t.id, n, true]);
    }
  });
  test('the window shows what it checks and reads, the Try link, and the example email labelled as one', () => {
    const html = part(builder({ selected: 'big-usdc' }), 'builder');
    const f = TEMPLATE_FACTS['big-usdc']!;
    expect(html).toContain(f.checks);
    expect(html).toContain(f.reads);
    expect(html).toContain('An example of the email it sends');
    expect(html).toContain(escapeHtml(f.email.subject));
    expect(html).toContain('Create an agent');
  });
  test('"Tells you" picks email; Telegram is listed as Soon and cannot be chosen', () => {
    const html = part(builder({ selected: 'big-usdc' }), 'builder');
    const select = html.slice(html.indexOf('<select'), html.indexOf('</select>'));
    expect(html).toMatch(/<label for="tells-big-usdc">Tells you<\/label>/);
    expect(select).toMatch(/<option value="email" selected="">By email<\/option>/);
    expect(select).toMatch(/<option value="telegram" disabled="">On Telegram \(Soon\)<\/option>/);
    expect(select.match(/<option /g)).toHaveLength(2);
  });
  test('the list can be searched and filtered by kind, and the steps open the MCP setup over the page and lead to the code view', () => {
    const html = part(builder(), 'builder');
    expect(html).toContain('id="ready-search"');
    for (const g of ['All', ...TEMPLATE_GROUPS]) expect(html).toContain(`>${g}</button>`);
    // Coming kinds show with a Soon badge and are not buttons, so they can't be picked.
    // A coming kind that lists its agents opens like a filter; the rest are plain labels. Both carry the Soon badge.
    for (const g of SOON_GROUPS) {
      const tag = g.agents ? 'button' : 'span';
      expect(html).toMatch(new RegExp(`<${tag} [^>]*data-soon=""[^>]*>${g.name}<span [^>]*>Soon</span>`));
    }
    expect(SOON_GROUPS.find((g) => g.name === 'Trade')?.agents?.map((t) => t.title)).toEqual([
      'Arbitrage Agent',
      'Yield Agent',
      'LP Rebalancer Agent',
      'Volume Agent',
      'Trade Agent',
      'Market Maker Agent',
    ]);
    // Coming agents are never ready agents, so none can be opened in the builder.
    for (const g of SOON_GROUPS) for (const t of g.agents ?? []) expect(findTemplate(t.id)).toBeUndefined();
    for (const g of SOON_GROUPS) expect(TEMPLATE_GROUPS as readonly string[]).not.toContain(g.name);
    expect(html).toContain('How it goes');
    expect(html).toMatch(/<button [^>]*aria-haspopup="dialog"[^>]*>Run them from your harness/);
    expect(html).not.toContain('view=code#mcp"');
    expect(html).toContain('href="/create?template=xlm-drop&amp;view=code"');
  });
});

describe('values in the builder', () => {
  test('withValues binds a value exactly as the api param engine does', async () => {
    const { applyParam } = await import('../../api/src/builder/params');
    const cases: [string, string, string | number][] = [
      ['xlm-drop', 'drop', 12],
      ['wallet-watch', 'account', `G${'B'.repeat(55)}`],
      ['big-usdc', 'size', '100000'],
      ['big-usdc', 'account', `G${'C'.repeat(55)}`],
      ['daily-digest', 'when', '0 18 * * *'],
    ];
    for (const [id, param, value] of cases) {
      const api = applyParam(tpl(id).draft as never, param, value);
      expect(api.ok).toBe(true);
      const web = withValues(tpl(id).draft, { [param]: String(value) });
      expect([id, JSON.parse(JSON.stringify(web))]).toEqual([id, JSON.parse(JSON.stringify((api as { draft: unknown }).draft))]);
    }
  });
  test('a value is checked like the draft flow checks it: range, options, length', () => {
    const drop = tpl('xlm-drop').draft.params[0]!;
    expect(coerceValue(drop, '12')).toBe(12);
    for (const bad of ['0', '51', 'x', '', ' ']) expect(coerceValue(drop, bad)).toBeNull();
    const size = tpl('big-usdc').draft.params[2]!;
    expect(coerceValue(size, '1000')).toBe('1000');
    expect(coerceValue(size, '5')).toBeNull();
    const account = tpl('wallet-watch').draft.params[0]!;
    expect(coerceValue(account, 'x'.repeat(101))).toBeNull();
    expect(editDraft(tpl('xlm-drop').draft, 'drop', 99)).toBeNull();
    expect(editDraft(tpl('xlm-drop').draft, 'nope', 1)).toBeNull();
  });
  test('the address bar carries only well-formed values, and only changed ones go in a link', () => {
    expect(readValues({ 'p.drop': '12', 'p.Bad': '1', drop: '3', 'p.x': 'y'.repeat(101), template: 'xlm-drop' })).toEqual({ drop: '12' });
    const d = editDraft(tpl('big-usdc').draft, 'size', '1000')!;
    expect(changedValues(d, tpl('big-usdc').draft)).toEqual({ size: '1000' });
    expect(changedValues(tpl('big-usdc').draft, tpl('big-usdc').draft)).toEqual({});
  });
  test('?template=, p.<param>= and ?view= deep-link the builder; anything unknown falls back to the first ready agent', () => {
    expect(readBuilderParams({ template: 'daily-digest', 'p.when': '0 18 * * *', view: 'code' })).toEqual({ selected: 'daily-digest', values: { when: '0 18 * * *' }, view: 'code' });
    expect(readBuilderParams({})).toEqual({ selected: 'xlm-drop', values: {}, view: 'builder' });
    expect(readBuilderParams({ template: 'nope' }).selected).toBe('xlm-drop');
    expect(readBuilderParams({ template: '../x' }).selected).toBe('xlm-drop');
    expect(readBuilderParams({ template: DESCRIBE, 'p.drop': '3' })).toEqual({ selected: DESCRIBE, values: {}, view: 'builder' });
    expect(builderUrl({ template: 'xlm-drop', values: { drop: '12' }, view: 'code' })).toBe('/create?template=xlm-drop&p.drop=12&view=code');
    expect(builderUrl()).toBe('/create');
  });
  test('a deep-linked value shows in the sentence and in the Try link', () => {
    const html = part(builder({ selected: 'xlm-drop', values: { drop: '12' } }), 'builder');
    expect(html).toContain('aria-label="Dip: 12%"');
    expect(html).toContain(`href="${templateUrl('xlm-drop', { drop: '12' }).replace(/&/g, '&amp;')}"`);
    expect(templateUrl('xlm-drop', { drop: '12' })).toBe('/draft?template=xlm-drop&p.drop=12');
  });
});

describe('values carry into the draft flow', () => {
  test('/draft reads the values with a template, and never without one', () => {
    const url = new URL(templateUrl('big-usdc', { account: `G${'B'.repeat(55)}`, size: '1000' }), 'https://x.test');
    expect(readDraftParams(Object.fromEntries(url.searchParams))).toEqual({ template: 'big-usdc', values: { account: `G${'B'.repeat(55)}`, size: '1000' } });
    expect(readDraftParams({ 'p.drop': '12' })).toEqual({});
    expect(readDraftParams({ template: 'xlm-drop' })).toEqual({ template: 'xlm-drop' });
    expect(planBoot({ template: 'xlm-drop', values: { drop: '12' }, stored: null })).toEqual({ kind: 'template', id: 'xlm-drop', values: { drop: '12' } });
  });

  function rig(opts: { template?: DraftActions['template']; edit?: DraftActions['edit']; href?: string } = {}) {
    const calls: unknown[][] = [];
    const writes: string[] = [];
    const log: DraftAction[] = [];
    let state: DraftState = initialState;
    const base = (id: string) => findTemplate(id)?.draft;
    const actions: DraftActions = {
      draft: async () => (calls.push(['draft']), ok({ draft: {} as unknown })),
      claim: async () => (calls.push(['claim']), ok({ draft: {} as unknown })),
      trial: async () => (calls.push(['trial']), ok({ trial: {} })),
      template: opts.template ?? (async (id) => (calls.push(['template', id]), ok({ draft: structuredClone(base(id)) as unknown }))),
      // The api's param engine stands in: the same binding the real edit writes.
      edit: opts.edit ?? (async (d, p, v) => (calls.push(['edit', p, v]), ok({ draft: withValues(d as DraftData, { [p]: String(v) }) as unknown }))),
    };
    const m = new Map<string, string>();
    const ctl = createDraftController(actions, {
      getState: () => state,
      dispatch: (a) => (log.push(a), (state = draftReducer(state, a))),
      getWindow: () => ({ location: { href: opts.href ?? 'https://app.test/draft?template=xlm-drop&p.drop=12&utm=x' }, history: { state: null, replaceState: (_s: unknown, _u: string, url: string) => void writes.push(url) } }),
      replace: () => {},
      store: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) },
    });
    return { ctl, calls, writes, log, get state() { return state; } };
  }

  test('the template opens with the values applied through the edit a tap makes, typed as the param takes them', async () => {
    const r = rig();
    r.ctl.boot({ template: 'xlm-drop', values: { drop: '12' } });
    await flush();
    expect(r.calls).toEqual([['template', 'xlm-drop'], ['edit', 'drop', 12]]);
    expect(r.state.phase).toBe('ready');
    expect(r.state.draft?.params[0]?.value).toBe(12);
    expect((r.state.draft?.spec.triggers as { params: { drop_pct: number } }[])[0]!.params.drop_pct).toBe(12);
    expect(r.state.edit.message).toBeUndefined();
    // The template and its values leave the address bar; anything else stays.
    expect(r.writes).toEqual(['/draft?utm=x']);
  });
  test('several values go one after the other; an unchanged one costs no edit', async () => {
    const r = rig({ href: 'https://app.test/draft?template=big-usdc&p.account=x&p.size=1000' });
    const account = `G${'B'.repeat(55)}`;
    r.ctl.boot({ template: 'big-usdc', values: { account, size: '1000' } });
    await flush();
    expect(r.calls).toEqual([['template', 'big-usdc'], ['edit', 'account', account], ['edit', 'size', '1000']]);
    expect(r.state.draft?.params.map((p) => p.value)).toEqual([account, 'stellar', '1000']);
    const r2 = rig();
    r2.ctl.boot({ template: 'xlm-drop', values: { drop: '5' } });
    await flush();
    expect(r2.calls).toEqual([['template', 'xlm-drop']]);
  });
  test('a value that does not fit is skipped and said; the plan still opens', async () => {
    const r = rig();
    r.ctl.boot({ template: 'xlm-drop', values: { drop: '99' } });
    await flush();
    expect(r.calls).toEqual([['template', 'xlm-drop']]);
    expect([r.state.phase, r.state.draft?.params[0]?.value, r.state.edit.message]).toEqual(['ready', 5, copy.errors.badEdit]);
  });
  test('a refused edit keeps the last good draft and shows the plain message', async () => {
    const r = rig({ edit: async () => ({ ok: false, kind: 'failed', message: copy.errors.badEdit }) });
    r.ctl.boot({ template: 'wallet-watch', values: { account: XSS } });
    await flush();
    expect([r.state.phase, r.state.draft?.params[0]?.value, r.state.edit.message]).toEqual(['ready', tpl('wallet-watch').draft.params[0]!.value, copy.errors.badEdit]);
  });
  test('Retry after a failed open opens the template again with the same values', async () => {
    let n = 0;
    const r = rig({ template: async (id) => (++n === 1 ? { ok: false, kind: 'failed', message: copy.errors.notFound } : ok({ draft: structuredClone(tpl(id).draft) as unknown })) });
    r.ctl.boot({ template: 'xlm-drop', values: { drop: '12' } });
    await flush();
    expect(r.state.phase).toBe('failed');
    await r.ctl.onRetry();
    await flush();
    expect(r.state.draft?.params[0]?.value).toBe(12);
  });
});

describe('values carry into the code view', () => {
  test('the code view shows the selected agent with the same values, and its link', () => {
    const html = part(builder({ selected: 'xlm-drop', values: { drop: '12' }, view: 'code' }), 'code');
    expect(html).toContain('xlm-drop.json');
    expect(html).toMatch(/<span class="tk-p">&quot;drop_pct&quot;<\/span>: <span class="tk-n">12<\/span>/);
    expect(html).toContain('/draft?template=xlm-drop&amp;p.drop=12');
    expect(html).toContain('id="library-slot"');
  });
  test('a change made in the builder is what the code view and the Try link show', () => {
    const d = editDraft(tpl('daily-digest').draft, 'when', '0 18 * * *')!;
    expect(hostedSnippet(d)).toContain('"cron": "0 18 * * *"');
    expect(hostedSnippet(tpl('daily-digest').draft)).toContain('"cron": "0 8 * * *"');
    expect(templateUrl('daily-digest', changedValues(d, tpl('daily-digest').draft))).toBe('/draft?template=daily-digest&p.when=0+18+*+*+*');
    const html = part(builder({ selected: 'daily-digest', values: { when: '0 18 * * *' }, view: 'code' }), 'code');
    expect(html).toContain('0 18 * * *');
  });
  test('the snippet leaves out empty lists but keeps what the agent does', () => {
    const s = JSON.parse(hostedSnippet(tpl('xlm-drop').draft));
    expect(Object.keys(s)).toEqual(['name', 'persona', 'system_prompt', 'tools', 'triggers', 'delivery']);
  });
});

describe('views, deep links and anchors', () => {
  test('the builder is the default; ?view=code opens the code view; one of them is hidden', () => {
    const b = builder();
    expect(b).toMatch(/id="builder"(?![^>]*hidden)/);
    expect(b).toMatch(/id="code" hidden=""/);
    const c = builder({ view: 'code' });
    expect(c).toMatch(/id="builder" hidden=""/);
    expect(c).toMatch(/id="code"(?![^>]*hidden)/);
    expect(c).toMatch(/aria-current="page"[^>]*data-view="code"/);
  });
  test('the toggle is a pair of links, so it works without scripts and keeps the template and values', () => {
    const html = builder({ selected: 'xlm-drop', values: { drop: '12' } });
    expect(html).toContain('href="/create?template=xlm-drop&amp;p.drop=12&amp;view=code"');
    expect(html).toContain('href="/create?template=xlm-drop&amp;p.drop=12"');
  });
  test('the old /create anchors (and /developers → #own-wallet) open the code view', () => {
    for (const h of ['#install', '#own-wallet', '#library', '#identity', '#serve', '#verify-record']) expect([h, viewForHash(h)]).toEqual([h, 'code']);
    for (const h of ['', '#', '#builder', '#paths']) expect(viewForHash(h)).toBeUndefined();
    expect(CODE_ANCHORS).toContain('this-agent');
  });
  test('every code anchor exists on the page', async () => {
    const { default: CreatePage } = await import('../src/app/(site)/create/page');
    const html = renderToStaticMarkup(CreatePage());
    for (const id of CODE_ANCHORS) expect([id, html.includes(`id="${id}"`)]).toEqual([id, true]);
    // 0.2.0 is on npm with the MCP server: no "not yet" notes, and both MCP setups are there.
    expect(html).not.toContain('Not on npm yet.');
    expect(html).not.toContain('Not published yet.');
    expect(html).toContain('agentenact-mcp');
    expect(html).toContain('href="/connect"');
    expect(html).not.toContain('app.agentenact.io');
    expect(html).toContain('<span class="tk-k">import</span>');
    expect(html).toContain('process.env.SPONSOR_SECRET');
  });
});

describe('the highlighter', () => {
  test('outputs escaped HTML: text never becomes markup', () => {
    for (const lang of ['ts', 'json', 'sh'] as const) {
      const out = highlight(`const a = "${XSS}"; // ${XSS}\n${XSS} & 'x'`, lang);
      expect(out).not.toContain('<script');
      expect(out).toContain('&lt;script&gt;');
      // Removing the spans leaves exactly the escaped source.
      expect(out.replace(/<span class="tk-[a-z]">|<\/span>/g, '')).toBe(escapeHtml(`const a = "${XSS}"; // ${XSS}\n${XSS} & 'x'`));
    }
  });
  test('marks keywords, strings, numbers, comments and calls', () => {
    const out = highlight("import { x } from 'y';\nconst n = f(1); // hi", 'ts');
    expect(out).toContain('<span class="tk-k">import</span>');
    expect(out).toContain('<span class="tk-s">&#39;y&#39;</span>');
    expect(out).toContain('<span class="tk-n">1</span>');
    expect(out).toContain('<span class="tk-c">// hi</span>');
    expect(out).toContain('<span class="tk-f">f</span>');
    expect(highlight('bun add agentenact # core', 'sh')).toBe('<span class="tk-k">bun</span> add agentenact <span class="tk-c"># core</span>');
  });
  test('a code block keeps its copy button and the raw code to copy', () => {
    const html = renderToStaticMarkup(createElement(CodeBlock, { code: XSS, label: 'x.ts' }));
    expect(html).toContain('copy');
    expect(html).not.toContain('<script');
  });
  test('a <script> text value renders inert in the builder, the code view and the draft flow', () => {
    const html = builder({ selected: 'wallet-watch', values: { account: XSS } });
    expect(html).not.toContain('<script');
    expect(part(html, 'builder')).toContain('&lt;script&gt;');
    expect(part(html, 'code')).toContain('&lt;script&gt;');
    const d = withValues(tpl('wallet-watch').draft, { account: XSS });
    const flow = renderToStaticMarkup(createElement(DraftFlowView, { state: { ...initialState, phase: 'ready', draft: d }, signedIn: false }));
    expect(flow).not.toContain('<script');
    expect(flow).toContain('&lt;script&gt;');
  });
});
