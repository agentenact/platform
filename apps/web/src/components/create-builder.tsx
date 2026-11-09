'use client';

import { useSearchParams } from 'next/navigation';
import { flushSync } from 'react-dom';
import { Suspense, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { AskForm } from '@/components/ask-form';
import { CodeBlock } from '@/components/code-block';
import { CreateNav, type NavGroup } from '@/components/create-nav';
import { CreateSection } from '@/components/create-section';
import { DraftSentence } from '@/components/draft-sentence';
import { HarnessDialog } from '@/components/harness-dialog';
import { TemplateIcon } from '@/components/template-icon';
import { copy } from '@/copy';
import { DESCRIBE, editDraft, readBuilderParams, viewForHash, type View } from '@/lib/builder';
import type { DraftData, OptionValue } from '@/lib/draft-types';
import { byline, communityHref, loadCommunity, type CommunityTemplate } from '@/lib/community';
import { builderUrl, templateUrl } from '@/lib/panel-url';
import { MCP_HARNESSES, OWNER_MCP_LIVE } from '@/lib/mcp';
import { hostedSnippet } from '@/lib/snippets';
import { changedValues, withValues, type Values } from '@/lib/template-values';
import { SOON_GROUPS, TEMPLATE_FACTS, TEMPLATE_GROUPS } from '@/lib/template-facts';
import { walletMismatch } from '@/lib/wallet-fit';
import { findTemplate, TEMPLATES, type HostedTemplate } from '@/lib/templates';

const NAV: NavGroup[] = [
  { title: 'This agent', items: [{ id: 'this-agent', label: 'As code' }] },
  {
    title: 'Library',
    items: [
      { id: 'install', label: 'Install' },
      { id: 'library', label: 'Templates' },
      { id: 'identity', label: 'Create the identity' },
      { id: 'serve', label: 'Serve and get paid' },
      { id: 'verify-record', label: 'Verify a record' },
      { id: 'community', label: 'Share a template' },
    ],
  },
  {
    title: 'Orchestrate',
    items: [{ id: 'mcp', label: 'MCP server' }, ...(OWNER_MCP_LIVE ? [{ id: 'mcp-own', label: 'Talk to your own agents' }] : [])],
  },
  { title: 'Your own wallet', items: [{ id: 'own-wallet-intro', label: 'Create in the browser' }] },
];

const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wax-ring)]';

const STEPS = [
  { title: 'Pick or describe', line: 'A ready agent, or one sentence of your own.' },
  { title: 'Try it on real data', line: 'See what it would tell you right now. Nothing is sent.' },
  { title: 'Create it', line: 'Your email, then your device’s screen lock: a PIN or password works, Face ID is optional.' },
];

const Down = () => (
  <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </svg>
);

/** Opens over the page (a dialog), unlike Down, which moves down the page. */
const Open = () => (
  <svg aria-hidden viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

const PenIcon = () => (
  <svg aria-hidden viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
  </svg>
);

/** Builder or Code: a pair of links (they work without scripts and keep the agent and its values), handled in place. */
function ViewToggle({ view, href, show, wide }: { view: View; href: (v: View) => string; show: (v: View) => (e: MouseEvent) => void; wide?: boolean }) {
  return (
    <nav aria-label="View" className={`${wide ? 'flex w-full' : 'inline-flex'} rounded-full border border-line bg-raised p-1`} data-view-toggle="">
      {(
        [
          ['builder', 'Builder'],
          ['code', 'Code'],
        ] as const
      ).map(([v, label]) => (
        <a
          key={v}
          href={href(v)}
          aria-current={view === v ? 'page' : undefined}
          data-view={v}
          onClick={show(v)}
          className={`${wide ? 'flex-1 justify-center' : ''} inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-[14px] font-medium text-fg-2 transition-colors hover:text-fg aria-[current=page]:bg-fg aria-[current=page]:text-bg`}
        >
          {v === 'code' ? (
            <span aria-hidden className="font-mono text-[12px]">
              {'</>'}
            </span>
          ) : null}
          {label}
        </a>
      ))}
    </nav>
  );
}

/** Stacked only: the toggle (and in code, the section strip) stays under the site header while the face scrolls past. */
function Bar({ children }: { children: ReactNode }) {
  return <div className="sticky top-[4.25rem] z-10 -mx-4 mt-4 border-b border-[var(--raised-line)] bg-[var(--raised)] px-4 py-2.5 sm:-mx-7 sm:px-7 lg:hidden">{children}</div>;
}

const COMMUNITY = 'Community';

function CommunityGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
      <path d="M16 5.5a3 3 0 0 1 0 5M21 19c0-2.6-1.6-4.5-4-5.2" />
    </svg>
  );
}

/**
 * The ready agents, searchable and filtered by kind, then "Describe your own". Every row is a link to that agent in the
 * builder, so the list works without scripts; a plain click picks it in place. Up and down move through it, as in any picker.
 */
function ReadyList({ selected, choose, className = '' }: { selected: string; choose: (id: string) => (e: MouseEvent) => void; className?: string }) {
  const [group, setGroup] = useState<string>('All');
  const [query, setQuery] = useState('');
  const [community, setCommunity] = useState<CommunityTemplate[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const q = query.trim().toLowerCase();
  const inCommunity = group === COMMUNITY;
  const soon = SOON_GROUPS.find((g) => g.name === group && g.agents);
  const coming = soon?.agents?.filter((t) => !q || `${t.title} ${t.summary}`.toLowerCase().includes(q)) ?? [];
  const list = inCommunity || soon ? [] : TEMPLATES.filter((t) => (group === 'All' || TEMPLATE_FACTS[t.id]?.group === group) && (!q || `${t.title} ${t.summary}`.toLowerCase().includes(q)));
  const shared = inCommunity ? community.filter((t) => !q || `${t.title} ${t.summary} ${t.name ?? ''}`.toLowerCase().includes(q)) : [];
  const rows = inCommunity ? shared.map((t) => `c-${t.sha256}`) : [...list.map((t) => t.id), DESCRIBE];

  // Community templates come from the public index; when it is slow or down the chip simply does not appear.
  useEffect(() => {
    const ac = new AbortController();
    void loadCommunity(ac.signal).then(setCommunity);
    return () => ac.abort();
  }, []);

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const at = rows.indexOf(selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (!next) return;
    e.preventDefault();
    listRef.current?.querySelector<HTMLAnchorElement>(`[data-template="${next}"]`)?.click();
    listRef.current?.querySelector<HTMLAnchorElement>(`[data-template="${next}"]`)?.focus();
  };

  return (
    <nav id="ready" aria-labelledby="ready-h" className={`card order-2 flex min-h-0 min-w-0 scroll-mt-24 flex-col overflow-hidden lg:order-1 ${className}`}>
      <div className="border-b border-[var(--raised-line)] p-4">
        <h2 id="ready-h" className="flex items-baseline justify-between text-[15px] font-semibold text-fg">
          {inCommunity ? 'Community templates' : soon ? `${soon.name} agents` : 'Ready agents'}{' '}
          <span className="text-[13px] font-normal text-fg-3 tabular-nums">
            {inCommunity ? shared.length : soon ? coming.length : list.length === TEMPLATES.length ? TEMPLATES.length : `${list.length} of ${TEMPLATES.length}`}
          </span>
        </h2>
        <label htmlFor="ready-search" className="sr-only">
          {inCommunity ? 'Search community templates' : 'Search ready agents'}
        </label>
        <input
          id="ready-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={inCommunity ? 'Search community templates' : 'Search ready agents'}
          autoComplete="off"
          className="mt-3 h-10 w-full rounded-[10px] border border-[var(--raised-line)] bg-[var(--ground)] px-3 text-[14px] text-fg placeholder:text-fg-3 focus-visible:border-[var(--wax-ring)] focus-visible:outline-none"
        />
        <div role="group" aria-label="Show" className="mt-3 flex flex-wrap gap-1.5">
          {['All', ...TEMPLATE_GROUPS, ...(community.length > 0 ? [COMMUNITY] : [])].map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={group === g}
              onClick={() => setGroup(g)}
              className={`rounded-full border border-[var(--raised-line)] px-2.5 py-1 text-[12.5px] text-fg-2 transition-colors hover:text-fg aria-pressed:border-[var(--wax-edge)] aria-pressed:bg-[var(--wax-tint)] aria-pressed:text-fg ${ring}`}
            >
              {g}
            </button>
          ))}
          {SOON_GROUPS.map((g) =>
            g.agents ? (
              <button
                key={g.name}
                type="button"
                aria-pressed={group === g.name}
                onClick={() => setGroup(g.name)}
                data-soon=""
                className={`inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--raised-line)] px-2.5 py-1 text-[12.5px] text-fg-2 transition-colors hover:text-fg aria-pressed:border-solid aria-pressed:border-[var(--wax-edge)] aria-pressed:bg-[var(--wax-tint)] aria-pressed:text-fg ${ring}`}
              >
                {g.name}
                <span className="text-[10.5px] font-medium tracking-wide text-accent-ink/80">Soon</span>
              </button>
            ) : (
              <span
                key={g.name}
                title={`${g.note} Coming soon.`}
                data-soon=""
                className="inline-flex cursor-default items-center gap-1.5 rounded-full border border-dashed border-[var(--raised-line)] px-2.5 py-1 text-[12.5px] text-fg-3"
              >
                {g.name}
                <span className="text-[10.5px] font-medium tracking-wide text-accent-ink/80">Soon</span>
                <span className="sr-only">: {g.note}</span>
              </span>
            ),
          )}
        </div>
      </div>
      <ul ref={listRef} onKeyDown={onKey} data-chooser="" className="min-h-0 flex-1 overflow-y-auto p-2">
        {inCommunity ? (
          <>
            <li className="px-2.5 pt-1 pb-2 text-[12.5px] leading-[1.5] text-fg-3">{copy.community.note}</li>
            {shared.map((t) => (
              <li key={t.sha256}>
                <a
                  href={communityHref(t.sha256)}
                  data-template={`c-${t.sha256}`}
                  className={`flex w-full items-center gap-3 rounded-[12px] border border-transparent px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--hover)] ${ring}`}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] border border-dashed border-[var(--raised-line)] text-fg-2">
                    <CommunityGlyph />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium text-fg">{t.title}</span>
                    <span className="block truncate text-[12.5px] text-fg-3">
                      {copy.community.by} {byline(t)}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-full border border-[var(--raised-line)] px-2 py-0.5 text-[11px] text-fg-3">{copy.community.badge}</span>
                </a>
              </li>
            ))}
          </>
        ) : null}
        {soon ? (
          <>
            <li className="px-2.5 pt-1 pb-2 text-[12.5px] leading-[1.5] text-fg-3">Coming soon: these can&rsquo;t be created yet.</li>
            {coming.map((t) => (
              <li key={t.id} data-soon-agent={t.id} className="flex items-center gap-3 rounded-[12px] px-2.5 py-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-[9px] border border-dashed border-[var(--raised-line)] text-fg-2">
                  <TemplateIcon id={t.id} size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium text-fg-2">{t.title}</span>
                  <span className="block text-[12.5px] leading-[1.45] text-fg-3">{t.summary}</span>
                </span>
              </li>
            ))}
          </>
        ) : null}
        {!inCommunity && !soon && list.length === 0 ? (
          <li className="px-3 py-6 text-center text-[14px] leading-[1.5] text-fg-3">No ready agent matches. Describe it in your own words instead.</li>
        ) : null}
        {(inCommunity ? [] : [...list, null]).map((t) => {
          const id = t?.id ?? DESCRIBE;
          return (
            <li key={id} className={t ? '' : 'mt-2 border-t border-[var(--raised-line)] pt-2'}>
              <a
                href={builderUrl({ template: id })}
                aria-current={id === selected ? 'true' : undefined}
                data-template={id}
                onClick={choose(id)}
                className={`flex w-full items-center gap-3 rounded-[12px] border border-transparent px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--hover)] aria-[current=true]:border-[var(--wax-edge)] aria-[current=true]:bg-[var(--wax-tint)] ${ring}`}
              >
                <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[var(--wax-tint)] text-accent-ink">
                  {t ? <TemplateIcon id={t.id} size={18} /> : <span className="text-[17px] leading-none">+</span>}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium text-fg">{t?.title ?? 'Describe your own'}</span>
                  <span className="block truncate text-[12.5px] text-fg-3">{t?.summary ?? 'Say what it should do, in one sentence.'}</span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

type Show = (v: View, to?: string) => (e: MouseEvent) => void;

/** The right column's builder face: how it goes, then the two ways into the code view (the MCP server, the developer options). */
function Steps({ hidden, codeHref, show }: { hidden: boolean; codeHref: string; show: Show }) {
  const mcp = OWNER_MCP_LIVE ? 'mcp-own' : 'mcp';
  return (
    <div id="steps" hidden={hidden} aria-labelledby="steps-h" className="flex min-h-0 flex-1 flex-col">
      <h2 id="steps-h" className="text-[15px] font-semibold text-fg">
        How it goes
      </h2>
      <ol className="mt-4 space-y-5">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3" {...(i === 0 ? { 'aria-current': 'step' as const } : {})}>
            <span
              className={`grid size-7 shrink-0 place-items-center rounded-full border text-[12.5px] tabular-nums ${i === 0 ? 'border-[var(--wax)] bg-[var(--wax)] text-[var(--wax-on)]' : 'border-[var(--raised-line)] text-fg-3'}`}
            >
              {i + 1}
            </span>
            <span className="min-w-0">
              <span className="block text-[14.5px] font-medium text-fg">{s.title}</span>
              <span className="mt-0.5 block text-[13px] leading-[1.5] text-fg-3">{s.line}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-auto border-t border-[var(--raised-line)] pt-4 max-lg:mt-6">
        <HarnessDialog
          fullSetupHref={`${codeHref}#${mcp}`}
          onFullSetup={show('code', mcp)}
          trigger={
            <button type="button" className={`flex w-full cursor-pointer items-center justify-between rounded-md text-left text-[14px] font-medium text-fg hover:text-accent-ink ${ring}`}>
              Run them from your harness <Open />
            </button>
          }
        />
        <p className="mt-1 text-[12.5px] leading-[1.5] text-fg-3">
          {MCP_HARNESSES.join(', ').replace(/, ([^,]*)$/, ' or $1')} can find, hire and check agents over MCP, inside a budget you set
          {OWNER_MCP_LIVE ? ', and talk to the agents you made here.' : '.'}
        </p>
      </div>
      <div className="mt-4 border-t border-[var(--raised-line)] pt-4">
        <a href={codeHref} onClick={show('code')} className={`flex items-center justify-between rounded-md text-[14px] text-fg-2 hover:text-fg ${ring}`}>
          Developer options <Down />
        </a>
        <p className="mt-1 text-[12.5px] text-fg-3">This agent as code, the library, your own wallet.</p>
      </div>
    </div>
  );
}

/** The right column's code face: the index of the code sections, then the way back. */
function CodeIndex({ hidden, builderHref, show }: { hidden: boolean; builderHref: string; show: Show }) {
  return (
    <div id="code-index" hidden={hidden} className="flex min-h-0 flex-1 flex-col">
      <h2 className="text-[15px] font-semibold text-fg">On this page</h2>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        <CreateNav groups={NAV} only="list" />
      </div>
      <div className="mt-4 border-t border-[var(--raised-line)] pt-4">
        <a href={builderHref} onClick={show('builder')} className={`flex items-center justify-between rounded-md text-[14px] text-fg-2 hover:text-fg ${ring}`}>
          Back to the builder <span aria-hidden>←</span>
        </a>
        <p className="mt-1 text-[12.5px] text-fg-3">Same agent, same values.</p>
      </div>
    </div>
  );
}

/**
 * Turns the cards over: each one turns edge-on, the faces swap while nobody can see them, and it turns back flat (a short
 * crossfade instead with reduced motion, and a plain swap where the Web Animations API is missing). Left to right, a beat apart.
 */
async function turn(cards: (HTMLElement | null)[], dir: 1 | -1, swap: () => void) {
  const els = cards.filter((el): el is HTMLElement => !!el && typeof el.animate === 'function');
  if (els.length === 0) return swap();
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const p = 'perspective(1800px)';
  const away = calm ? [{ opacity: 1 }, { opacity: 0 }] : [{ transform: `${p} rotateY(0deg)` }, { transform: `${p} rotateY(${90 * dir}deg)` }];
  const back = calm ? [{ opacity: 0 }, { opacity: 1 }] : [{ transform: `${p} rotateY(${-90 * dir}deg)` }, { transform: `${p} rotateY(0deg)` }];
  const ms = calm ? 120 : 190;
  const out = els.map((el, i) => el.animate(away, { duration: ms, delay: i * 60, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'both' }));
  await Promise.all(out.map((a) => a.finished.catch(() => {})));
  flushSync(swap);
  els.forEach((el, i) => el.animate(back, { duration: ms, delay: i * 60, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', fill: 'backwards' }));
  out.forEach((a) => a.cancel());
}

/** A plain click (no modifier, main button): the builder handles it in place; any other click follows the link. */
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** Each ready agent's draft with the address bar's values on the selected one. */
function startDrafts(selected: string, values: Values): Record<string, DraftData> {
  return Object.fromEntries(TEMPLATES.map((t) => [t.id, t.id === selected ? withValues(t.draft, values) : t.draft]));
}

/** The address bar's query as `readBuilderParams` takes it (repeated keys become arrays). */
export function searchRecord(search: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(search)) {
    const had = out[k];
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return out;
}

/** Reports the address bar's query, now and on every change. Its own Suspense boundary keeps the rest of the page static. */
function SearchWatch({ onSearch }: { onSearch: (search: string) => void }) {
  const search = useSearchParams().toString();
  useEffect(() => onSearch(search), [search, onSearch]);
  return null;
}

/**
 * /create: one cockpit, two faces. The builder by default (ready agents on the left, the selected one's sentence with its
 * values in the centre, how it goes on the right, then straight into the draft flow with those values); Code turns the centre
 * and right cards over to the same agent as code, the library's setup, MCP and the in-browser flow, with their index on the
 * right. The list stays, so picking another agent changes its code. Both faces stay mounted, so switching keeps the values and
 * the in-browser flow's progress. `code` holds the library sections, rendered (and highlighted) on the server.
 */
export function CreateBuilder({ selected: initialSelected, values: initialValues, view: initialView, code }: { selected: string; values: Values; view: View; code: ReactNode }) {
  const [selected, setSelected] = useState(initialSelected);
  const [view, setView] = useState<View>(initialView);
  const [drafts, setDrafts] = useState(() => startDrafts(initialSelected, initialValues));
  // The page is static, so the query is read here. Until it has been, the address bar is left alone; afterwards a query
  // this component wrote itself (below) is not read back, only one that came from a link.
  const [fromBar, setFromBar] = useState(false);
  const wrote = useRef<string | null>(null);
  const onSearch = useRef((search: string) => {
    if (search === wrote.current) return;
    const p = readBuilderParams(searchRecord(search));
    setSelected(p.selected);
    setDrafts(startDrafts(p.selected, p.values));
    if (viewForHash(window.location.hash) !== 'code') setView(p.view);
    setFromBar(true);
  }).current;

  const template = findTemplate(selected);
  const draft = template ? drafts[template.id]! : null;
  const values = template && draft ? changedValues(draft, template.draft) : {};

  const centreRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const turning = useRef(false);
  /** Scrolls a code section into view: inside the centre card while the cockpit fills the screen (the page stays put), else the page. */
  const reveal = (id: string) => {
    const el = document.getElementById(id);
    const card = centreRef.current;
    if (!el) return;
    if (!card || !window.matchMedia('(min-width: 1024px)').matches) return el.scrollIntoView({ block: 'start' });
    card.scrollTo({ top: card.scrollTop + el.getBoundingClientRect().top - card.getBoundingClientRect().top - 24 });
    window.scrollTo({ top: 0 });
  };

  // A hash naming a code section (the old /create anchors, /developers → #own-wallet, the index's links) opens the code view there.
  useEffect(() => {
    const follow = () => {
      if (viewForHash(window.location.hash) !== 'code') return;
      setView('code');
      const id = window.location.hash.slice(1);
      // After the code view is shown: a hidden section has no place to scroll to.
      setTimeout(() => reveal(id), 50);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The address bar follows the choice, so a link or a reload opens the same agent, values and view.
  const valuesKey = JSON.stringify(values);
  useEffect(() => {
    if (!fromBar) return;
    try {
      // A code anchor in the bar while the builder still shows: the hash effect is about to open the code view.
      if (view === 'builder' && viewForHash(window.location.hash) === 'code') return;
      const hash = view === 'code' ? window.location.hash : '';
      const next = `${builderUrl({ template: selected === TEMPLATES[0]!.id && valuesKey === '{}' ? undefined : selected, values, view })}${hash}`;
      wrote.current = new URL(next, window.location.origin).searchParams.toString();
      if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', next);
    } catch {
      /* a locked-down history: the address bar stays as it was */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, valuesKey, view, fromBar]);

  const choose = (id: string) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    setSelected(id);
    // Stacked (small screens): the centre card sits above the list, so bring the chosen agent into view.
    if (window.matchMedia('(max-width: 1023px)').matches) centreRef.current?.scrollIntoView({ block: 'start' });
  };
  /** Builder or Code: the cockpit stays, its centre and right cards turn over to the other face. `to` is a code section to open at. */
  const show: Show = (v, to) => (e) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    if (turning.current) return;
    // Back to the builder drops a code anchor from the bar, so the address keeps saying what is shown.
    if (v === 'builder' && window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    const swap = () => {
      setView(v);
      centreRef.current?.scrollTo({ top: 0 });
      if (to) reveal(to);
      else if (window.matchMedia('(max-width: 1023px)').matches) centreRef.current?.scrollIntoView({ block: 'start' });
      else window.scrollTo({ top: 0 });
    };
    if (v === view) return swap();
    turning.current = true;
    void turn([centreRef.current, sideRef.current], v === 'code' ? 1 : -1, swap).finally(() => (turning.current = false));
  };

  /** A tap's change, kept here (lib/builder.ts editDraft): the draft flow gets it through the link. */
  const onEdit = async (param: string, value: OptionValue): Promise<boolean> => {
    if (!template || !draft) return false;
    const next = editDraft(draft, param, value);
    if (!next) return false;
    setDrafts((all) => ({ ...all, [template.id]: next }));
    return true;
  };

  const tryHref = template ? templateUrl(template.id, values) : '/draft';
  const viewHref = (v: View) => builderUrl({ template: template?.id ?? DESCRIBE, values, view: v });

  return (
    <main className="mx-auto max-w-[1440px] px-3 pt-3 pb-16 sm:px-5">
      <Suspense fallback={null}>
        <SearchWatch onSearch={onSearch} />
      </Suspense>

      <div className="grid gap-3 lg:h-[calc(100dvh-6.75rem)] lg:min-h-[620px] lg:grid-cols-[300px_minmax(0,1fr)_260px]">
        {/* Stacked, the code face runs long: the list (and the right card's index, already at the top) would sit far below it. */}
        <ReadyList selected={selected} choose={choose} className={view === 'code' ? 'max-lg:hidden' : ''} />

        <section ref={centreRef} aria-label={view === 'code' ? 'Build it yourself' : 'Create an agent'} data-window={selected} className="card order-1 flex min-h-0 min-w-0 scroll-mt-24 flex-col p-4 sm:p-7 lg:order-2 lg:overflow-y-auto">
          <div id="builder" hidden={view !== 'builder'}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <div>
                <h1 className="headline text-[2rem]">Create an agent</h1>
                <p className="mt-1 text-[13px] text-fg-3">Free · no code · reads any network, runs on Stellar testnet</p>
              </div>
              <div className="max-lg:hidden">
                <ViewToggle view={view} href={viewHref} show={show} />
              </div>
            </div>
            <Bar>
              <ViewToggle view={view} href={viewHref} show={show} wide />
            </Bar>

            <div className="mt-6 flex items-center gap-4 border-t border-[var(--raised-line)] pt-6 max-lg:mt-3 max-lg:border-t-0 max-lg:pt-3">
              <span className="grid size-14 shrink-0 place-items-center rounded-[14px] bg-[var(--wax-tint)] text-accent-ink">
                {template ? <TemplateIcon id={template.id} size={28} /> : <PenIcon />}
              </span>
              <div className="min-w-0">
                <h2 id="window-h" className="text-[20px] font-semibold text-fg">
                  {template?.title ?? 'Describe your own'}
                </h2>
                <p className="text-[13.5px] text-fg-3">{template ? `Ready agent · ${TEMPLATE_FACTS[template.id]?.network ?? ''}` : 'One sentence is enough. You see the draft before you sign up.'}</p>
              </div>
              {/* Stacked, the list sits below this card: one tap down to it, and picking there brings you back up. */}
              <button
                type="button"
                onClick={() => document.getElementById('ready')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
                className={`ml-auto shrink-0 cursor-pointer rounded-full border border-line px-3 py-1.5 text-[13px] text-fg-2 hover:text-fg lg:hidden ${ring}`}
              >
                Change
              </button>
            </div>

            <div className="mt-6">
              {template && draft ? (
                <TemplateWindow key={template.id} template={template} draft={draft} onEdit={onEdit} tryHref={tryHref} onCode={show('code')} codeHref={viewHref('code')} />
              ) : (
                <AskForm id="builder-prompt" className="max-w-[620px]" label="Describe it in one sentence" />
              )}
            </div>
          </div>

          <div id="code" hidden={view !== 'code'}>
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <div>
                <h1 className="headline text-[2rem]">Build it yourself</h1>
                <p className="mt-1 text-[13px] text-fg-3">This agent as code · the library · MCP · your own wallet</p>
              </div>
              <div className="max-lg:hidden">
                <ViewToggle view={view} href={viewHref} show={show} />
              </div>
            </div>
            <Bar>
              <ViewToggle view={view} href={viewHref} show={show} wide />
              <div className="mt-2 -mb-2">
                <CreateNav groups={NAV} only="strip" />
              </div>
            </Bar>
            <div className="mt-6 border-t border-[var(--raised-line)] pt-6 max-lg:mt-3 max-lg:border-t-0 max-lg:pt-3">
              <CreateSection id="this-agent" eyebrow="This agent · hosted" title={template ? `${template.title}, as code` : 'Your own agent, as code'}>
                {template && draft ? (
                  <>
                    <p>
                      A hosted agent is a description, not a program you deploy: the runtime reads it, checks on schedule and emails you. This is the
                      one the builder creates, with your values in it.
                    </p>
                    <CodeBlock code={hostedSnippet(draft)} label={`${template.id}.json`} lang="json" />
                    <p>
                      The same setup as a link: <code className="break-all">{tryHref}</code>
                    </p>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <a href={tryHref} className="btn btn-wax h-11 px-5 text-[14px]">
                        Try it on real data <span aria-hidden>→</span>
                      </a>
                      <a href={viewHref('builder')} onClick={show('builder')} className="text-[14px] text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
                        Change the values
                      </a>
                    </div>
                  </>
                ) : (
                  <p>
                    A sentence becomes a description like the ready agents&rsquo; once it is drafted. Pick a ready agent on the left to see one, or run your
                    own paid agent with the library below.
                  </p>
                )}
              </CreateSection>
              {code}
            </div>
          </div>
        </section>

        <aside ref={sideRef} aria-label={view === 'code' ? 'On this page' : 'How it goes'} className={`card order-3 flex min-h-0 flex-col p-5 ${view === 'code' ? 'max-lg:hidden' : ''}`}>
          <Steps hidden={view !== 'builder'} codeHref={viewHref('code')} show={show} />
          <CodeIndex hidden={view !== 'code'} builderHref={viewHref('builder')} show={show} />
        </aside>
      </div>
    </main>
  );
}

/** The centre window for a ready agent: its sentence with the values to tap, then into the draft flow with them. */
function TemplateWindow({
  template,
  draft,
  onEdit,
  tryHref,
  onCode,
  codeHref,
}: {
  template: HostedTemplate;
  draft: DraftData;
  onEdit: (param: string, value: OptionValue) => Promise<boolean>;
  tryHref: string;
  onCode: (e: MouseEvent) => void;
  codeHref: string;
}) {
  const facts = TEMPLATE_FACTS[template.id];
  const mismatch = walletMismatch(draft);
  return (
    <div data-config={template.id}>
      <p className="text-sm text-fg-2">{copy.draft.caption}</p>
      <div className="mt-3">
        <DraftSentence draft={draft} onEdit={onEdit} />
      </div>
      {mismatch ? (
        <p role="status" className="mt-3 text-[13.5px] text-accent-ink">
          This wallet is not a {mismatch} address. Paste one from {mismatch}, or pick its network.
        </p>
      ) : null}
      {facts ? (
        <dl className="mt-6 grid grid-cols-3 divide-x divide-[var(--raised-line)] rounded-[12px] border border-[var(--raised-line)]">
          {[
            ['Checks', facts.checks],
            ['Reads', facts.reads],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0 px-3.5 py-3">
              <dt className="text-[12px] text-fg-3">{k}</dt>
              <dd className="mt-0.5 text-[14px] font-medium text-fg">{v}</dd>
            </div>
          ))}
          <div className="min-w-0 px-3.5 py-3">
            <dt className="text-[12px] text-fg-3">
              <label htmlFor={`tells-${template.id}`}>
                Tells you
              </label>
            </dt>
            <dd className="relative mt-0.5">
              {/* Email is the only channel today; Telegram is listed so people see it coming, and cannot be picked. */}
              <select
                id={`tells-${template.id}`}
                data-tells=""
                defaultValue="email"
                className={`block w-full min-w-0 cursor-pointer appearance-none truncate rounded-[6px] border-0 bg-transparent p-0 pr-5 text-[14px] leading-[inherit] font-medium text-fg ${ring}`}
              >
                <option value="email">By email</option>
                <option value="telegram" disabled>
                  On Telegram (Soon)
                </option>
              </select>
              <span aria-hidden className="pointer-events-none absolute top-1/2 right-0 -translate-y-1/2 text-[11px] text-fg-3">
                ▾
              </span>
            </dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <a href={tryHref} data-try="" className="btn btn-wax h-12 px-6 text-[15px] max-sm:w-full max-sm:justify-center">
          Try it on real data <span aria-hidden>→</span>
        </a>
        <a href={codeHref} onClick={onCode} className="btn btn-quiet h-12 px-5 text-[15px] max-sm:w-full max-sm:justify-center">
          <span aria-hidden className="font-mono text-[12px]">
            {'</>'}
          </span>
          See it as code
        </a>
      </div>
      <p className="mt-4 max-w-xl text-[13.5px] leading-[1.55] text-fg-3">
        Trying it is free and needs no account. Then you create it with your email and your device&rsquo;s screen lock: a PIN or password
        works, Face ID is optional.
      </p>
      {facts ? (
        <figure className="mt-7 rounded-[12px] border border-dashed border-[var(--raised-line)] p-4">
          <figcaption className="text-[12px] text-fg-3">An example of the email it sends</figcaption>
          <p className="mt-2 text-[14.5px] font-medium text-fg">{facts.email.subject}</p>
          <p className="mt-1 text-[14px] leading-[1.5] text-fg-2">{facts.email.body}</p>
        </figure>
      ) : null}
    </div>
  );
}
