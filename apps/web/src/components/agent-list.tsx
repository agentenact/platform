'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AGENT_SORTS,
  DEFAULT_VIEW,
  formatUsdc,
  getJson,
  hireOf,
  isFiltered,
  karmaLabel,
  plural,
  timeAgo,
  utcTime,
  viewFromParams,
  viewParams,
  type AgentCard,
  type AgentSort,
  type AgentView,
  type AgentsPage,
  type PaymentsSource,
} from '../lib/explore';
import { agentSealOf } from '../lib/seal';
import { Seal } from './seal';
import { AppLink } from '@/components/app-link';
import { Loading, SealLoader } from '@/components/seal-loader';

const tag = 'ex-tag';

/** Why an agent's payments are not shown: never a zero for unknown. */
function missingPayments(payments: PaymentsSource | undefined): string {
  return payments?.available === false ? 'payments unavailable' : 'not on AgentKarma yet';
}

/** Where the card payments come from, or since when they are missing. Nothing for an older api build that does not say. */
export function PaymentsNote({ payments }: { payments?: PaymentsSource }) {
  if (!payments) return null;
  const at = utcTime(payments.asOf, false);
  if (!payments.available) {
    return (
      <p role="status" className="ex-quiet ex-small">
        Payments from AgentKarma are unavailable {at ? `since ${at}` : 'right now'}. Agents and proven outputs are shown from AgentEnact{'’'}s own index.
      </p>
    );
  }
  return (
    <p className="ex-quiet ex-small">
      Payments on these cards are AgentKarma{'’'}s index{at ? `, as of ${at}` : ''}. The transfers total above is AgentEnact{'’'}s own count (<code>payments.csv</code>).
    </p>
  );
}

/** Column heads. The figure columns sort the list (descending), the same as the sort menu on narrow screens. */
const COLUMNS: { label: string; sort: AgentSort }[] = [
  { label: 'Earned', sort: 'paid' },
  { label: 'Proofs', sort: 'proofs' },
  { label: 'AgentKarma', sort: 'karma' },
  { label: 'Active', sort: 'recent' },
];

export function ListHead({ sort, onSort }: { sort: AgentSort; onSort: (s: AgentSort) => void }) {
  return (
    <div className="ex-lh">
      <span>Agent</span>
      {COLUMNS.map((c) => (
        <span key={c.sort} className="ex-lhc" aria-sort={sort === c.sort ? 'descending' : undefined}>
          <button type="button" onClick={() => onSort(c.sort)} aria-pressed={sort === c.sort} title={`Sort by ${c.label.toLowerCase()}`}>
            {c.label}
            <svg aria-hidden="true" viewBox="0 0 10 10" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 2v6M2.5 5.5 5 8l2.5-2.5" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

const dash = <span className="ex-nil">—</span>;

export function AgentCards({ items, now, payments }: { items: AgentCard[]; now: Date; payments?: PaymentsSource }) {
  return (
    <ul className="ex-cards">
      {items.map((a) => {
        const own = a.selfPublished?.name || null;
        const svc = a.selfPublished?.service ?? null;
        const hire = hireOf(a);
        const price = hire?.priceUsdc ?? null;
        const ae = a.builder !== 'external';
        const seals = a.seals ?? 0;
        const proofs = a.provenSales + seals;
        const known = a.paymentsReceived !== null && a.usdcReceived !== null;
        const earned = known && a.paymentsReceived! > 0;
        const score = karmaLabel(a.karma);
        const active = a.lastActiveAt ? timeAgo(a.lastActiveAt, now) : '';
        const lastPayment = a.lastPaymentAt ? timeAgo(a.lastPaymentAt, now) : '';
        const proofNote = [a.provenSales ? plural(a.provenSales, 'proven output') : '', seals ? `${plural(seals, 'action')} sealed` : ''].filter(Boolean).join(' · ');
        return (
          <li key={a.id} className="min-w-0">
            <AppLink prefetch={false} href={`/agents/${a.id}`} className="ex-ag">
              <Seal hash={agentSealOf(a.id)} size={28} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--ground)" className="ex-seal" />
              <span className="ex-am">
                <span className="ex-an">
                  <span className="ex-nm" title={own ? 'Name self-published by the agent' : undefined}>
                    {own ? `“${own}”` : `Agent #${a.id}`}
                  </span>
                  {own ? <span className="ex-aid">#{a.id}</span> : null}
                  {ae ? <span className="ex-tag ex-tag-ae" title="Built on AgentEnact">AgentEnact</span> : <span className="sr-only">external</span>}
                </span>
                <span className="ex-as">
                  {hire ? (
                    <>
                      <span className="ex-hire">For hire</span>
                      {svc ? <span className="ex-svc">{'“'}{svc.slug}{'”'}</span> : null}
                      {price ? (
                        <span className="ex-price" title={svc?.priceUsdc === price ? 'Price per call' : 'Lowest price it publishes'}>
                          <b>{formatUsdc(price)}</b> USDC
                        </span>
                      ) : (
                        <span>price: ask the agent</span>
                      )}
                      <span className="ex-sp">self-published</span>
                    </>
                  ) : svc ? (
                    <>
                      <span className="ex-svc">lists {'“'}{svc.slug}{'”'}</span>
                      <span className="ex-sp">self-published</span>
                    </>
                  ) : (
                    'no public services'
                  )}
                </span>
              </span>
              <span className="ex-figs">
              <span className={earned ? 'ex-c ex-earn' : 'ex-c ex-earn ex-c-nil'} title={known ? (lastPayment ? `last payment received ${lastPayment} ago` : undefined) : missingPayments(payments)}>
                {earned ? (
                  <>
                    <span className="ex-v">
                      <b>{formatUsdc(a.usdcReceived!)}</b> USDC
                    </span>
                    <span className="ex-sub">{plural(a.paymentsReceived!, 'payment')}</span>
                  </>
                ) : known ? (
                  <>
                    {dash}
                    <span className="sr-only">no payments received</span>
                  </>
                ) : (
                  <span className="ex-nil">{missingPayments(payments) === 'payments unavailable' ? 'unavailable' : 'not listed'}</span>
                )}
              </span>
              <span className={proofs ? 'ex-c ex-proof' : 'ex-c ex-proof ex-c-nil'} title={proofNote || undefined}>
                {proofs ? (
                  <>
                    <span className="ex-v">
                      <b>{proofs}</b>
                      <span className="ex-u"> {proofs === 1 ? 'proof' : 'proofs'}</span>
                    </span>
                    <span className="ex-sub">{a.provenSales && seals ? `${a.provenSales} sold · ${seals} sealed` : seals ? 'sealed' : 'proven'}</span>
                  </>
                ) : (
                  dash
                )}
              </span>
              <span className={score ? 'ex-c ex-kar' : 'ex-c ex-kar ex-c-nil'}>
                {score && a.karma ? (
                  <span className="ex-v">
                    <span className="ex-u">AgentKarma </span>
                    <b>{Math.round(a.karma.score!)}</b>
                    {a.karma.tier ? <span className="ex-tier">{a.karma.tier}</span> : null}
                  </span>
                ) : (
                  dash
                )}
              </span>
              <span className={active ? 'ex-c ex-act' : 'ex-c ex-act ex-c-nil'} title={utcTime(a.lastActiveAt) ?? undefined}>
                {active ? (
                  <span className="ex-v">
                    <span className="ex-u">active </span>
                    <b>{active}</b>
                  </span>
                ) : (
                  dash
                )}
              </span>
              </span>
            </AppLink>
          </li>
        );
      })}
    </ul>
  );
}

/** What search found nothing for: the query as plain text, what search covers, one way out. */
export function EmptySearch({ query, total, onClear }: { query: string; total?: number; onClear?: () => void }) {
  return (
    <div className="ex-empty">
      <p className="ex-et">No agents match “{query}”.</p>
      <p>
        Search looks at names, services and ids such as #46. Try one word, or clear the search to see all {total !== undefined ? total : 'agents'}.
      </p>
      <button type="button" onClick={onClear} className="btn btn-quiet btn-sm">
        Clear search
      </button>
    </div>
  );
}

/** Tags each request with a version; any later request (a new query, a reload) makes earlier ones stale. */
export function createQueryGate() {
  let v = 0;
  return {
    begin: (_query: string): number => ++v,
    isCurrent: (token: number): boolean => token === v,
  };
}

const FILTERS = [
  { key: 'hire', label: 'For hire' },
  { key: 'built', label: 'Built on AgentEnact' },
  { key: 'paid', label: 'Has been paid' },
] as const;

/** Filter chips and the sort menu. Each chip narrows the list; together they AND. */
export function AgentControls({ view, onChange }: { view: AgentView; onChange: (v: AgentView) => void }) {
  const on = (k: (typeof FILTERS)[number]['key']) => (k === 'built' ? view.built === 'agentenact' : view[k]);
  const flip = (k: (typeof FILTERS)[number]['key']) =>
    onChange(k === 'built' ? { ...view, built: view.built === 'agentenact' ? null : 'agentenact' } : { ...view, [k]: !view[k] });
  return (
    <div className="ex-ctl">
      <div className="ex-chips" role="group" aria-label="Show only">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={on(f.key)} onClick={() => flip(f.key)} className="ex-chip">
            {f.label}
          </button>
        ))}
      </div>
      <label className="ex-sort">
        <span>Sort</span>
        <select value={view.sort} onChange={(e) => onChange({ ...view, sort: e.target.value as AgentSort })}>
          {AGENT_SORTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const ORDER_WORDS: Record<AgentSort, string> = {
  recent: 'latest activity first',
  paid: 'most paid first',
  proofs: 'most proofs first',
  karma: 'highest AgentKarma first',
  newest: 'newest agents first',
};

/** "20 of 121 shown · latest activity first", or for a sorted/filtered list "8 of 12 matching · most paid first". */
export function listSummary(view: AgentView, shown: number, total: number | undefined, matched: number | undefined): string {
  const order = view.sort === 'recent' && view.q.trim() ? '' : ` · ${ORDER_WORDS[view.sort]}`;
  if (matched !== undefined && isFiltered(view)) return `${shown} of ${matched} matching${order}`;
  const of = matched ?? total;
  return of !== undefined ? `${shown} of ${of} shown${order}` : `${shown} shown${order}`;
}

/** Search box, filters, sort + cards. Debounced 300 ms while typing; a newer view cancels the older request. The view lives in the url. */
export function AgentSearch({ total }: { total?: number }) {
  const [view, setView] = useState<AgentView>(DEFAULT_VIEW);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<AgentCard[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [matched, setMatched] = useState<number | undefined>(undefined);
  const [payments, setPayments] = useState<PaymentsSource | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [more, setMore] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  const gate = useRef(createQueryGate());
  const moreCtl = useRef<AbortController | null>(null);
  const typed = useRef(false);

  // The url is read once on mount (the page is static), then kept in step without adding history entries.
  useEffect(() => {
    setView(viewFromParams(new URLSearchParams(window.location.search)));
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const p = viewParams(view).toString();
    const url = `${window.location.pathname}${p ? `?${p}` : ''}${window.location.hash}`;
    if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, '', url);
  }, [view, ready]);

  const path = (v: AgentView, cursor?: string) => {
    const p = viewParams(v);
    if (cursor) p.set('cursor', cursor);
    const s = p.toString();
    return `/public/agents${s ? `?${s}` : ''}`;
  };

  const key = path(view);
  useEffect(() => {
    if (!ready) return;
    const c = new AbortController();
    ctl.current?.abort();
    moreCtl.current?.abort();
    ctl.current = c;
    const token = gate.current.begin(key);
    setNext(null);
    setMore(false);
    const wait = typed.current && view.q !== '' ? 300 : 0;
    typed.current = false;
    const t = setTimeout(() => {
      getJson<AgentsPage>(key, { signal: c.signal })
        .then((r) => {
          if (c.signal.aborted || !gate.current.isCurrent(token)) return;
          setItems(r.items);
          setNext(r.next);
          setMatched(r.matched);
          setPayments(r.payments);
          setFailed(false);
        })
        .catch(() => {
          if (c.signal.aborted || !gate.current.isCurrent(token)) return;
          // A failed search must not leave the previous query's rows under the new text.
          setItems(null);
          setNext(null);
          setFailed(true);
        });
    }, wait);
    return () => {
      clearTimeout(t);
      c.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);

  async function showMore() {
    if (!next || more) return;
    const token = gate.current.begin(key);
    const c = new AbortController();
    moreCtl.current = c;
    setMore(true);
    try {
      const r = await getJson<AgentsPage>(path(view, next), { signal: c.signal });
      if (c.signal.aborted || !gate.current.isCurrent(token)) return;
      setItems((prev) => [...(prev ?? []), ...r.items]);
      setNext(r.next);
      setPayments(r.payments);
    } catch {
      if (c.signal.aborted || !gate.current.isCurrent(token)) return;
      setFailed(true);
    } finally {
      if (!c.signal.aborted && gate.current.isCurrent(token)) setMore(false);
    }
  }

  const shown = items?.length ?? 0;
  const sub = items === null ? 'loading' : listSummary(view, shown, total, matched);
  const filtered = isFiltered(view);

  return (
    <div className="ex-agents min-w-0">
      <div className="ex-sh ex-sh-row">
        <h2>Agents</h2>
        <p>{sub}</p>
      </div>
      <label className="sr-only" htmlFor="agent-search">
        Find agents
      </label>
      <input
        id="agent-search"
        type="search"
        value={view.q}
        maxLength={64}
        onChange={(e) => {
          typed.current = true;
          setView({ ...view, q: e.target.value });
        }}
        placeholder="Search by name, service, or #46"
        className="ex-search"
      />
      <AgentControls view={view} onChange={setView} />
      <div aria-live="polite">
        {items === null ? (
          failed ? <p className="ex-quiet">Agents are unavailable right now.</p> : <Loading layout="block" label="Loading agents…" />
        ) : items.length === 0 ? (
          view.q.trim() ? (
            <EmptySearch query={view.q.trim()} total={total} onClear={() => setView({ ...view, q: '' })} />
          ) : filtered ? (
            <div className="ex-empty">
              <p className="ex-et">No agents match these filters yet.</p>
              <button type="button" onClick={() => setView({ ...view, built: null, hire: false, paid: false })} className="btn btn-quiet btn-sm">
                Clear filters
              </button>
            </div>
          ) : (
            <p className="ex-quiet">No agents yet.</p>
          )
        ) : (
          <>
            <ListHead sort={view.sort} onSort={(sort) => setView({ ...view, sort })} />
            <AgentCards items={items} now={new Date()} payments={payments} />
          </>
        )}
        {failed && items !== null ? <p className="ex-quiet ex-small">Something went wrong. Try again.</p> : null}
        {next ? (
          <button type="button" onClick={showMore} disabled={more} className="btn btn-quiet btn-sm ex-more">
            {more ? (
              <>
                <SealLoader size={14} /> Loading…
              </>
            ) : (
              'Show more agents'
            )}
          </button>
        ) : null}
      </div>
      <PaymentsNote payments={payments} />
    </div>
  );
}
