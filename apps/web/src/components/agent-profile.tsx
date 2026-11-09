'use client';

import { useEffect, useState } from 'react';
import {
  formatUsdc, getJson, karmaLabel, karmaUrl, paymentUrl, proofUrl, timeAgo, utcTime,
  type AgentProfile, type HistoryItem,
} from '../lib/explore';
import { shorten } from '../lib/format';
import { agentSealOf } from '../lib/seal';
import { Seal } from './seal';
import { AppLink } from '@/components/app-link';
import { HireButton } from '@/components/hire-button';
import { Loading } from '@/components/seal-loader';

const tag = 'rounded-md border px-2 py-1 font-sans text-[12px] font-normal leading-none tracking-normal';
const SELF = <span className={`${tag} border-line text-fg-3`}>self-published</span>;
const link = 'whitespace-nowrap text-accent-ink underline underline-offset-4';
const h2 = 'font-display text-[20px] font-semibold tracking-[-0.02em]';

/** The agent's site as it claims it: shown only when it is a plain https url. */
export const siteOf = (p: AgentProfile): string | null => {
  const u = p.site;
  if (!u || u.length > 300 || !/^https:\/\/[^\s"'<>`]+$/.test(u)) return null;
  try {
    return new URL(u).protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

/**
 * Hire, under the agent's name: the price, the button that copies the hire prompt, and where to get the tools. An
 * external agent with nothing we can call says so and points at its own site instead.
 */
function HireRow({ p }: { p: AgentProfile }) {
  if (p.hidden || !p.selfPublished) return null;
  const site = siteOf(p);
  if (p.hire) {
    const price = p.hire.priceUsdc ? `${formatUsdc(p.hire.priceUsdc)} USDC a call` : 'Price quoted when called';
    return (
      <section aria-label="Hire" className="mt-6 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
        <HireButton
          agent={{ id: p.id, hire: p.hire }}
          className="btn btn-sm min-h-[44px] min-w-[9rem] justify-center"
          tip={(copied) => (
            <p className="min-w-0 text-[14px] text-fg-2">
              <span className="text-fg">{price}</span>
              <span aria-hidden="true"> · </span>
              <span role="status" aria-live="polite">{copied ? 'Copied. Paste it in your AI tool.' : 'Copies a prompt for your AI tool.'}</span>{' '}
              <AppLink href="/connect" className={link}>Set up your AI tool</AppLink>
            </p>
          )}
        />
      </section>
    );
  }
  if (p.builder !== 'external') return null;
  return (
    <p className="mt-6 max-w-[60ch] min-w-0 text-[14px] text-fg-2">
      Not for hire here: this agent publishes no paid service we can call on testnet.
      {site ? (
        <>
          {' '}
          <a href={site} rel="noopener noreferrer nofollow" className={link}>Visit its site ↗</a>
        </>
      ) : null}
    </p>
  );
}

/** Only 1-10 digit ids are fetched. Anything else is "not found" without a request. */
export const parseId = (raw: string | null): number | null => (raw !== null && /^\d{1,10}$/.test(raw) ? Number(raw) : null);

/** "GABCD…WXYZ" for a long chain address; short values are returned as-is. */
export const shortAddr = (a: string): string => shorten(a, 4, 4);

/** The profile, or null when the api says 404. Other failures throw. */
export async function fetchProfile(id: number, o: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<AgentProfile | null> {
  try {
    return await getJson<AgentProfile>(`/public/agents/${id}`, o);
  } catch (e) {
    if (e instanceof Error && e.message === 'api 404') return null;
    throw e;
  }
}

function HistoryLine({ h, now }: { h: HistoryItem; now: Date }) {
  let proof: string | null = null;
  if (h.proof) {
    try {
      proof = proofUrl(h.proof);
    } catch {
      proof = null; // a malformed ref falls back to the payment link
    }
  }
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 py-3 text-[14px] leading-snug sm:grid-cols-[minmax(0,1fr)_5rem_6rem]">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {formatUsdc(h.amount)} USDC from <span title={h.payer} className="font-mono text-[13px]">{shortAddr(h.payer)}</span>
      </span>
      <span className="text-fg-3 tabular-nums max-sm:order-3">{timeAgo(h.at, now) || '—'}</span>
      <span className="text-right">
        {proof ? (
          <AppLink href={proof} className={link}>proof ↗</AppLink>
        ) : (
          <a href={paymentUrl(h.txHash)} className={link}>payment ↗</a>
        )}
      </span>
    </li>
  );
}

export function ProfileView({ profile: p, now }: { profile: AgentProfile; now: Date }) {
  const ae = p.builder !== 'external';
  const sp = p.hidden ? null : p.selfPublished;
  const name = sp?.name || null;
  const registeredOn = p.registered.at ? p.registered.at.slice(0, 10) : null;
  const missingSince = utcTime(p.payments?.asOf, false);
  const score = karmaLabel(p.karma);

  return (
    <article className="min-w-0">
      <header className="flex min-w-0 items-start gap-5">
        <Seal hash={agentSealOf(p.id)} size={72} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--ground)" className="mt-1 shrink-0 max-sm:size-14" />
        <div className="min-w-0">
          <h1 className="headline text-[clamp(1.75rem,4vw,2.5rem)] [overflow-wrap:anywhere]">Agent #{p.id}</h1>
          {p.hidden ? (
            <p className="mt-2 text-[16px] text-fg-2">Details hidden by the AgentEnact team.</p>
          ) : name ? (
            <p className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[18px] [overflow-wrap:anywhere]">
              <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
              {SELF}
            </p>
          ) : null}
          {sp?.description ? (
            <p className="mt-2 max-w-[60ch] min-w-0 text-[15px] text-fg-2 [overflow-wrap:anywhere]">
              {sp.description} {SELF}
            </p>
          ) : null}
          <HireRow p={p} />
        </div>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-14">
        <div className="min-w-0">
          {sp ? (
            <section className="min-w-0" aria-label="Services">
              <h2 className={`${h2} flex flex-wrap items-center gap-2`}>Services {SELF}</h2>
              {sp.services.length === 0 ? (
                <p className="mt-3 text-[14px] text-fg-2">No public services.</p>
              ) : (
                <ul className="card mt-4 divide-y divide-line p-0">
                  {sp.services.map((s) => (
                    <li key={s.slug} className="min-w-0 px-5 py-4 text-[14px] [overflow-wrap:anywhere]">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="font-mono text-[13.5px] text-fg">{s.slug}</span>
                        <span className="text-fg-2">{s.priceUsdc ? `${formatUsdc(s.priceUsdc)} USDC` : 'price: ask the agent'}</span>
                      </span>
                      {s.description ? <span className="mt-1 block text-fg-2">{s.description}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          <section className={sp ? 'mt-10 min-w-0' : 'min-w-0'} aria-label="History">
            <h2 className={h2}>History</h2>
            {p.history === null ? (
              <p role="status" className="mt-3 text-[14px] text-fg-2">
                Payments from AgentKarma are unavailable {missingSince ? `since ${missingSince}` : 'right now'}. Try again in a minute.
              </p>
            ) : p.history.length === 0 ? (
              <p className="mt-3 text-[14px] text-fg-2">No payments yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {p.history.map((h) => (
                  <HistoryLine key={h.id ?? h.txHash} h={h} now={now} />
                ))}
              </ul>
            )}
            {p.payments ? <p className="mt-3 text-[13px] text-fg-3">Payments as indexed by AgentKarma.</p> : null}
          </section>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start" aria-label="About this agent">
          <dl className="card divide-y divide-line p-0 text-[14px]">
            <div className="px-5 py-3.5">
              <dt className="text-fg-3">Network</dt>
              <dd className="mt-0.5">Testnet (stellar-8004 registry)</dd>
            </div>
            <div className="px-5 py-3.5">
              <dt className="text-fg-3">Built</dt>
              <dd className="mt-1">
                <span className={`${tag} ${ae ? 'border-accent-ink text-accent-ink' : 'border-line text-fg-2'}`}>{ae ? 'AgentEnact' : 'external'}</span>
              </dd>
            </div>
            <div className="px-5 py-3.5">
              <dt className="text-fg-3">{registeredOn ? `Registered ${registeredOn}` : 'Registered'}</dt>
              <dd className="mt-0.5">
                {p.registered.txHash ? (
                  <a href={paymentUrl(p.registered.txHash)} className={link}>registration ↗</a>
                ) : (
                  `registry record #${p.id}`
                )}
              </dd>
            </div>
          </dl>

          <section className="card mt-4 px-5 py-4" aria-label="Ratings">
            <h2 className="text-[14px] text-fg-3">Ratings</h2>
            {score ? <p className="mt-1 text-[14px]">{score.replace('AgentKarma', 'AgentKarma score')}</p> : null}
            <p className="mt-1 text-[14px]">
              <a href={karmaUrl(p.owner)} className={link}>See ratings on AgentKarma ↗</a>
            </p>
          </section>

          <details className="card mt-4 min-w-0 px-5 py-4">
            <summary className="cursor-pointer text-[14px] font-semibold">Advanced</summary>
            <h3 className="mt-3 text-[13px] font-semibold">Owner and address</h3>
            <dl className="mt-2 grid min-w-0 gap-2 text-[14px]">
              <div className="min-w-0">
                <dt className="text-fg-3">Owner</dt>
                <dd title={p.owner} className="font-mono text-[13px] [overflow-wrap:anywhere]">{shortAddr(p.owner)}</dd>
              </div>
              {p.wallet ? (
                <div className="min-w-0">
                  <dt className="text-fg-3">Bound address</dt>
                  <dd title={p.wallet} className="font-mono text-[13px] [overflow-wrap:anywhere]">{shortAddr(p.wallet)}</dd>
                </div>
              ) : null}
            </dl>
          </details>
        </aside>
      </div>

      <p className="mt-12 border-t border-line pt-4 text-[13px] text-fg-3">
        A proof shows who was paid, by whom, and for what amount. It does not say the output was good.
      </p>
    </article>
  );
}

function NotFound({ id }: { id: string | null }) {
  return (
    <div className="py-8">
      <h1 className="headline text-[clamp(1.75rem,6vw,3rem)] [overflow-wrap:anywhere]">
        {id !== null && /^\d{1,10}$/.test(id) ? <>We can{'’'}t find agent #{id}.</> : <>We can{'’'}t find that agent.</>}
      </h1>
      <p className="mt-4">
        <AppLink href="/explore" className={link}>Back to explore</AppLink>
      </p>
    </div>
  );
}

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error' } | { kind: 'ok'; profile: AgentProfile };

/** `raw` is the `[id]` segment of /agents/<id>; the profile is still fetched in the browser from the public api. */
export function ProfileLoader({ raw }: { raw: string | null }) {
  const id = parseId(raw);
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (id === null) return;
    const c = new AbortController();
    setState({ kind: 'loading' });
    fetchProfile(id, { signal: c.signal })
      .then((profile) => {
        if (!c.signal.aborted) setState(profile ? { kind: 'ok', profile } : { kind: 'missing' });
      })
      .catch(() => {
        if (!c.signal.aborted) setState({ kind: 'error' });
      });
    return () => c.abort();
  }, [id]);

  if (id === null || state.kind === 'missing') return <NotFound id={raw} />;
  // The room the profile will take, so the footer does not jump when it arrives.
  if (state.kind === 'loading') return <Loading layout="page" label="Loading the agent…" className="min-h-[70vh]" />;
  if (state.kind === 'error') {
    return (
      <p className="py-8 text-[14px] text-fg-2" role="status">
        This agent is unavailable right now. Try again in a minute. <AppLink href="/explore" className={link}>Back to explore</AppLink>
      </p>
    );
  }
  return <ProfileView profile={state.profile} now={new Date()} />;
}
