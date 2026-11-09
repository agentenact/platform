'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { formatUsdc, getJson, paymentUrl, proofUrl, shortHash, timeAgo, type FeedItem, type FeedPage } from '@/lib/explore';
import { parsePasted, type Pasted } from '@/lib/verify-params';
import { AppLink } from '@/components/app-link';
import { Seal } from './seal';

export const RECENT_PROOFS = 5;

/** The newest paid outputs in the feed that carry a proof, at most `n`, each with its verify link. A bad ref is skipped. */
export function recentProofs(items: FeedItem[], n = RECENT_PROOFS): { item: FeedItem; ref: string; href: string }[] {
  const out: { item: FeedItem; ref: string; href: string }[] = [];
  for (const item of items) {
    if (out.length >= n) break;
    const l = item.link;
    if (item.kind !== 'paid' || l?.type !== 'proof') continue;
    try {
      out.push({ item, ref: l.ref, href: proofUrl(l) });
    } catch {
      /* malformed ref: never a broken row */
    }
  }
  return out;
}

/** The newest proofs to try, from the public feed. Hidden while loading and when the feed is unreachable. */
function RecentProofs() {
  const [rows, setRows] = useState<ReturnType<typeof recentProofs> | null>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const ac = new AbortController();
    getJson<FeedPage>('/public/feed?limit=50', { signal: ac.signal })
      .then((p) => {
        setNow(new Date());
        setRows(recentProofs(p.items));
      })
      .catch(() => undefined);
    return () => ac.abort();
  }, []);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="mt-14 max-w-2xl" aria-labelledby="recent-proofs">
      <h2 id="recent-proofs" className="text-[14px] text-fg-3">
        Or check a recent one
      </h2>
      <ul className="card mt-3 divide-y divide-line p-0">
        {rows.map(({ item, ref, href }) => (
          <li key={item.seq}>
            <AppLink href={href} prefetch={false} className="flex items-center gap-4 px-5 py-3 text-[14px] transition-colors hover:bg-fg/[0.04]">
              <Seal hash={ref} size={28} mark="var(--ground)" />
              <span className="min-w-0 flex-1 truncate">
                Agent #{item.agentId}
                {item.amount !== null ? <span className="text-fg-2"> · {formatUsdc(item.amount)} USDC</span> : null}
              </span>
              <span className="shrink-0 text-fg-3">{timeAgo(item.at, now)}</span>
              <span aria-hidden className="text-fg-3">
                →
              </span>
            </AppLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * /verify before anything is checked: paste a proof link, a payment hash or a record, or pick a recent proof.
 * `notice` says why the last attempt did not open a proof (a broken link, a proof we cannot find).
 */
export function VerifyStart({ notice, tx, onPasted }: { notice?: string; tx?: string | null; onPasted: (p: Exclude<Pasted, { kind: 'invalid' | 'signature' }>) => void }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState<false | 'invalid' | 'no_seal' | 'lookup_failed'>(false);
  const [looking, setLooking] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = parsePasted(value);
    if (p.kind === 'invalid') return setInvalid('invalid');
    setInvalid(false);
    if (p.kind !== 'signature') return onPasted(p);
    // Stellar cannot find a transaction by its signature; the api keeps the signature of every seal it sent.
    setLooking(true);
    try {
      const { tx } = await getJson<{ tx: string | null }>(`/public/seals/by-signature?sig=${encodeURIComponent(p.sig)}`);
      if (tx && /^[0-9a-f]{64}$/.test(tx)) onPasted({ kind: 'target', target: { kind: 'tx', tx } });
      else setInvalid('no_seal');
    } catch {
      setInvalid('lookup_failed');
    } finally {
      setLooking(false);
    }
  };
  const message =
    invalid === 'no_seal'
      ? "No AgentEnact seal has this signature. A signature finds only our agents' seals; for any other transaction, paste its hash or stellar.expert link."
      : invalid === 'lookup_failed'
        ? "We couldn't look this signature up just now. Try again, or paste the transaction hash or its stellar.expert link."
        : invalid
          ? "That isn't a proof link, a transaction hash, a signature or a record."
          : notice;
  return (
    <>
      <form onSubmit={(e) => void submit(e)} className="max-w-2xl" noValidate>
        <h2 className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">Check your own</h2>
        <p className="mt-3 text-[15px] text-fg-2">Got a proof from an agent you paid? Paste it here.</p>
        <label htmlFor={id} className="mt-6 block text-[15px]">
          Proof link or record
        </label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <input
            id={id}
            className="ex-search !m-0 w-full font-mono text-[14px] sm:flex-1"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="https://agentenact.io/verify?…"
            aria-invalid={invalid ? true : undefined}
            aria-describedby={`${id}-hint${message ? ` ${id}-msg` : ''}`}
          />
          <button type="submit" className="btn h-11 shrink-0 justify-center px-6" disabled={looking}>
            {looking ? 'Finding…' : 'Verify'}
          </button>
        </div>
        <p id={`${id}-hint`} className="mt-2.5 text-[14px] text-fg-3">
          A proof link from an agent&apos;s page, a transaction hash, stellar.expert link or seal signature, or a whole record (JSON). Every check runs in your browser.
        </p>
        {message ? (
          <p id={`${id}-msg`} role="status" className="mt-4 text-[15px] text-fg-2">
            {message}
          </p>
        ) : null}
        {tx && !invalid ? (
          <p className="mt-2 text-[14px]">
            <a href={paymentUrl(tx)} target="_blank" rel="noreferrer" className="text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
              See transaction <span className="font-mono text-[13px]">{shortHash(tx)}</span> on stellar.expert ↗
            </a>
          </p>
        ) : null}
      </form>
      <RecentProofs />
    </>
  );
}
