'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { formatUsdc, getJson, karmaLabel, plural, type AgentCard, type AgentsPage } from '../lib/explore';
import {
  CATEGORIES,
  EMPTY_VIEW,
  FLAGS,
  MARKET_PAGES,
  MARKET_SORTS,
  PRICE_CAPS,
  agentName,
  applyView,
  categoryLabel,
  categoryOf,
  forHire,
  isBrowsing,
  marketPath,
  marketViewFromParams,
  marketViewParams,
  narrowCount,
  priceOf,
  ratedOf,
  serviceOf,
  shelvesOf,
  sortCards,
  type CategoryId,
  type FlagId,
  type MarketSort,
  type MarketView,
  type PriceCap,
  type Shelf,
} from '../lib/market';
import { agentSealOf } from '../lib/seal';
import { AppLink } from '@/components/app-link';
import { HireButton } from '@/components/hire-button';
import { Seal } from '@/components/seal';
import { Loading } from '@/components/seal-loader';

/** The card's Hire: where to paste the prompt shows as a small note above the row, outside the flow, so the card never reflows. */
function CardHire({ agent }: { agent: AgentCard }) {
  return (
    <HireButton
      agent={agent}
      className="btn btn-sm mk-hire"
      tip={(copied) => (
        <span className="mk-tip" data-on={copied ? '' : undefined} role="status" aria-live="polite">
          {copied ? 'Copied. Paste it in your AI tool.' : ''}
        </span>
      )}
    />
  );
}

/** The track record line: what is on record, never a zero for what is unknown, never a low score for an agent nobody has paid. */
function facts(a: AgentCard): string[] {
  const paid = a.paymentsReceived ?? 0;
  const out = [paid > 0 ? `Hired ${plural(paid, 'time')}` : a.paymentsReceived === null ? 'Payments not listed yet' : 'New, not hired yet'];
  if (a.provenSales > 0) out.push(`${plural(a.provenSales, 'output')} with a proof`);
  const score = karmaLabel(ratedOf(a));
  if (score) out.push(score);
  return out;
}

/** One agent for hire: who it is, what it sells, what a call costs, its record, and the hire action. `pick`: the larger top-pick card. */
export function ServiceCard({ agent: a, pick = false }: { agent: AgentCard; pick?: boolean }) {
  const svc = serviceOf(a);
  const price = priceOf(a);
  const ae = a.builder !== 'external';
  return (
    <li className={pick ? 'mk-card mk-pick' : 'mk-card'}>
      <div className="mk-top">
        <Seal hash={agentSealOf(a.id)} size={pick ? 44 : 36} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--raised)" />
        <div className="mk-who">
          <h3 className="mk-name">{agentName(a)}</h3>
          <p className="mk-id">
            <span className="mk-kind">{categoryLabel(categoryOf(a))}</span>
            <span aria-hidden="true"> · </span>#{a.id}
            {ae ? <span className="mk-here"> · sealed</span> : null}
          </p>
        </div>
      </div>
      <div className="mk-svc">
        {svc ? <p className="mk-slug">{svc.slug}</p> : null}
        <p className="mk-desc">{svc?.description || a.selfPublished?.description || 'This agent has not said what it does yet. Its profile lists what it publishes.'}</p>
      </div>
      <p className="mk-price">
        {price ? (
          <>
            {price.per === 'from' ? <span className="mk-per">from </span> : null}
            <b>{formatUsdc(price.usdc)}</b> USDC{price.per === 'call' ? <span className="mk-per"> per call</span> : null}
          </>
        ) : (
          <span className="mk-ask">Price quoted when called</span>
        )}
      </p>
      <ul className="mk-facts">
        {facts(a).map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="mk-act">
        <CardHire agent={a} />
        <AppLink prefetch={false} href={`/agents/${a.id}`} className="btn btn-quiet btn-sm">
          Profile
        </AppLink>
      </div>
    </li>
  );
}

/** Which way a rail can still scroll; both false when it fits. Re-read on scroll and on resize. */
function useRailEdges(rail: RefObject<HTMLUListElement | null>): { back: boolean; on: boolean } {
  const [edges, setEdges] = useState({ back: false, on: false });
  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const read = () => {
      const max = el.scrollWidth - el.clientWidth;
      const next = { back: el.scrollLeft > 4, on: el.scrollLeft < max - 4 };
      setEdges((e) => (e.back === next.back && e.on === next.on ? e : next));
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  }, [rail]);
  return edges;
}

const Chevron = ({ back }: { back?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <path d={back ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A row of agents that scrolls sideways, with arrows (pointer devices) and "See all" opening the same cut as a full list. */
function ShelfRow({ shelf, onAll }: { shelf: Shelf; onAll: () => void }) {
  const rail = useRef<HTMLUListElement>(null);
  const edges = useRailEdges(rail);
  const page = (dir: 1 | -1) => {
    const el = rail.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>('.mk-card');
    const step = card ? card.offsetWidth + 14 : el.clientWidth;
    // whole cards per press, at least one, so a card is never left half in view by the button
    const by = Math.max(1, Math.floor((el.clientWidth + 14) / step)) * step;
    el.scrollBy({ left: dir * by, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  return (
    <section aria-labelledby={`mk-s-${shelf.id}`} className="mk-shelf">
      <div className="mk-shelf-head">
        <div>
          <h2 id={`mk-s-${shelf.id}`} className="mk-h2">
            {shelf.title}
          </h2>
          <p className="mk-note">{shelf.note}</p>
        </div>
        <div className="mk-nav">
          <button type="button" className="mk-all" onClick={onAll}>
            See all
          </button>
          {edges.back || edges.on ? (
            <span className="mk-arrows">
              <button type="button" className="mk-arrow" aria-label={`Previous in ${shelf.title}`} disabled={!edges.back} onClick={() => page(-1)}>
                <Chevron back />
              </button>
              <button type="button" className="mk-arrow" aria-label={`Next in ${shelf.title}`} disabled={!edges.on} onClick={() => page(1)}>
                <Chevron />
              </button>
            </span>
          ) : null}
        </div>
      </div>
      <ul ref={rail} className="mk-rail">
        {shelf.items.map((a) => (
          <ServiceCard key={a.id} agent={a} />
        ))}
      </ul>
    </section>
  );
}

type Load = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; items: AgentCard[]; cut: boolean };

/** Every agent for hire, read once (up to MARKET_PAGES pages of 50), so search and filters answer in the browser. */
function useMarket(): [Load, () => void] {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setLoad({ state: 'loading' });
    (async () => {
      const all: AgentCard[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < MARKET_PAGES; i++) {
        const r = await getJson<AgentsPage>(marketPath('', cursor), { signal: c.signal });
        all.push(...forHire(r.items));
        cursor = r.next ?? undefined;
        if (!cursor) break;
      }
      const seen = new Set<number>();
      const items = all.filter((a) => !seen.has(a.id) && seen.add(a.id));
      if (!c.signal.aborted) setLoad({ state: 'ready', items, cut: cursor !== undefined });
    })().catch(() => {
      if (!c.signal.aborted) setLoad({ state: 'failed' });
    });
    return () => c.abort();
  }, [attempt]);
  return [load, useCallback(() => setAttempt((n) => n + 1), [])];
}

/** The view, mirrored in the page url (replaceState: filtering is not navigation, Back leaves the page). */
function useView(): [MarketView, (next: Partial<MarketView>) => void] {
  // null until the url is read: writing the url back before that would wipe a shared link's view
  const [view, setView] = useState<MarketView | null>(null);
  useEffect(() => setView(marketViewFromParams(new URLSearchParams(window.location.search))), []);
  useEffect(() => {
    if (!view) return;
    const p = marketViewParams(view).toString();
    const url = `${window.location.pathname}${p ? `?${p}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', url);
  }, [view]);
  return [view ?? EMPTY_VIEW, useCallback((next: Partial<MarketView>) => setView((v) => ({ ...(v ?? EMPTY_VIEW), ...next })), [])];
}

/** The storefront: search, kinds, shelves while browsing, and a filtered, sorted list once the visitor narrows it. */
export function MarketList() {
  const [load, retry] = useMarket();
  const [view, set] = useView();
  const search = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);
  // one clock per visit, so "active this week" does not shift under the visitor's eyes
  const [now] = useState(() => Date.now());

  // "/" jumps to the search, as on most stores, unless the visitor is typing somewhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = load.state === 'ready' ? load.items : [];
  const browsing = isBrowsing(view);
  const results = useMemo(() => sortCards(applyView(items, view, now), view.sort, now, view.q), [items, view, now]);
  const discovery = useMemo(() => shelvesOf(items, now), [items, now]);
  const catCounts = useMemo(() => {
    const base = applyView(items, view, now, 'cat');
    const m = new Map<CategoryId, number>();
    for (const a of base) m.set(categoryOf(a), (m.get(categoryOf(a)) ?? 0) + 1);
    return { all: base.length, m };
  }, [items, view, now]);
  const flagCount = (id: FlagId) => applyView(items, { ...view, flags: [...view.flags.filter((f) => f !== id), id] }, now).length;
  const priceCount = (id: PriceCap) => applyView(items, { ...view, price: id }, now, 'price').length;

  const open = (next: Partial<MarketView>) => {
    set({ ...EMPTY_VIEW, all: true, ...next });
    top.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const toggleFlag = (id: FlagId) => set({ flags: view.flags.includes(id) ? view.flags.filter((f) => f !== id) : [...view.flags, id] });
  const n = narrowCount(view);

  /** What would come back if one narrowing were dropped: the way out of an empty list. */
  const relax: { label: string; count: number; drop: Partial<MarketView> }[] = [];
  if (results.length === 0 && load.state === 'ready') {
    if (view.cat) relax.push({ label: `Every kind`, count: applyView(items, view, now, 'cat').length, drop: { cat: null } });
    if (view.price) relax.push({ label: 'Any price', count: applyView(items, view, now, 'price').length, drop: { price: null } });
    for (const f of FLAGS) if (view.flags.includes(f.id)) relax.push({ label: `Without “${f.label}”`, count: applyView(items, view, now, f.id).length, drop: { flags: view.flags.filter((x) => x !== f.id) } });
    if (view.q.trim()) relax.push({ label: 'Without the search', count: applyView(items, { ...view, q: '' }, now).length, drop: { q: '' } });
  }

  return (
    <div ref={top} className="mk-market">
      <div className="mk-find" role="search">
        <label className="sr-only" htmlFor="mk-search">
          Search agents for hire
        </label>
        <svg className="mk-glass" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          ref={search}
          id="mk-search"
          type="search"
          value={view.q}
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set({ q: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && view.q) {
              e.preventDefault();
              set({ q: '' });
            }
          }}
          placeholder="What should an agent do for you? Try “wallet”, “price” or “logo”"
          className="mk-input"
        />
        <kbd className="mk-kbd" aria-hidden="true">
          /
        </kbd>
      </div>

      <nav aria-label="Kinds of agent" className="mk-kinds">
        <button type="button" className="mk-kindchip" aria-pressed={view.cat === null} onClick={() => set({ cat: null })}>
          All <span className="mk-count">{load.state === 'ready' ? catCounts.all : ''}</span>
        </button>
        {CATEGORIES.map((c) => {
          const count = catCounts.m.get(c.id) ?? 0;
          if (c.id === 'other' && count === 0 && view.cat !== 'other') return null;
          return (
            <button
              key={c.id}
              type="button"
              className="mk-kindchip"
              aria-pressed={view.cat === c.id}
              disabled={load.state === 'ready' && count === 0 && view.cat !== c.id}
              onClick={() => set({ cat: view.cat === c.id ? null : c.id })}
            >
              {c.label} <span className="mk-count">{load.state === 'ready' ? count : ''}</span>
            </button>
          );
        })}
      </nav>

      {load.state === 'loading' ? (
        <Loading layout="block" label="Loading agents for hire…" />
      ) : load.state === 'failed' ? (
        <div className="ex-empty">
          <p className="ex-et">Agents for hire are unavailable right now.</p>
          <p>The list could not be read. It usually comes back within a minute.</p>
          <button type="button" className="btn btn-quiet btn-sm" onClick={retry}>
            Try again
          </button>
        </div>
      ) : load.items.length === 0 ? (
        <div className="ex-empty">
          <p className="ex-et">No agents for hire yet.</p>
          <p>An agent shows up here once its registration names a price or says it takes x402 payments.</p>
        </div>
      ) : browsing ? (
        <>
          {discovery.picks.length ? (
            <section aria-labelledby="mk-picks" className="mk-shelf">
              <div className="mk-shelf-head">
                <div>
                  <h2 id="mk-picks" className="mk-h2">
                    Top picks
                  </h2>
                  <p className="mk-note">Ranked by what is on record: hires, proofs, rating and a clear price. Nobody pays to be here.</p>
                </div>
                <button type="button" className="mk-all" onClick={() => open({})}>
                  All {load.items.length} agents
                </button>
              </div>
              <ul className="mk-picks">
                {discovery.picks.map((a) => (
                  <ServiceCard key={a.id} agent={a} pick />
                ))}
              </ul>
            </section>
          ) : null}
          {discovery.shelves.map((s) => (
            <ShelfRow key={s.id} shelf={s} onAll={() => open(s.view)} />
          ))}
        </>
      ) : (
        <section aria-labelledby="mk-results" className="mk-results">
          <div className="mk-tools">
            <div className="mk-flags" role="group" aria-label="Show only">
              {FLAGS.map((f) => {
                const on = view.flags.includes(f.id);
                const count = on ? results.length : flagCount(f.id);
                return (
                  <button key={f.id} type="button" className="ex-chip mk-flag" aria-pressed={on} disabled={!on && count === 0} onClick={() => toggleFlag(f.id)}>
                    {f.label}
                    {!on ? <span className="mk-count">{count}</span> : null}
                  </button>
                );
              })}
            </div>
            <div className="mk-selects">
              <label className="ex-sort">
                <span>Price</span>
                <select value={view.price ?? ''} onChange={(e) => set({ price: (e.target.value || null) as PriceCap })}>
                  <option value="">Any price</option>
                  {PRICE_CAPS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} ({priceCount(c.id)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="ex-sort mk-sort">
                <span>Sort</span>
                <select value={view.sort} onChange={(e) => set({ sort: e.target.value as MarketSort })}>
                  {MARKET_SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="mk-sum">
            <h2 id="mk-results" className="mk-found" aria-live="polite">
              {results.length === 0 ? 'No agent matches' : plural(results.length, 'agent')}
              {view.q.trim() ? <span className="mk-for"> for “{view.q.trim()}”</span> : null}
              {view.cat ? <span className="mk-for"> in {categoryLabel(view.cat)}</span> : null}
            </h2>
            <button type="button" className="mk-all" onClick={() => set({ ...EMPTY_VIEW })}>
              {n || view.q.trim() ? `Clear${n ? ` (${n})` : ''} and browse` : 'Back to browsing'}
            </button>
          </div>

          {results.length === 0 ? (
            <div className="ex-empty mk-none">
              <p>Nothing for hire fits all of that. Loosen one thing:</p>
              <div className="mk-relax">
                {relax
                  .filter((r) => r.count > 0)
                  .map((r) => (
                    <button key={r.label} type="button" className="ex-chip" onClick={() => set(r.drop)}>
                      {r.label} <span className="mk-count">{r.count}</span>
                    </button>
                  ))}
              </div>
            </div>
          ) : (
            <ul className="mk-grid">
              {results.map((a) => (
                <ServiceCard key={a.id} agent={a} />
              ))}
            </ul>
          )}
          {load.cut ? <p className="ex-quiet ex-small">Showing the first {load.items.length} agents for hire.</p> : null}
        </section>
      )}
    </div>
  );
}
