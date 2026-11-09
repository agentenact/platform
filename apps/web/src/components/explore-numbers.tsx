'use client';

import { exportUrl, formatUsdc, getStats, usePoll, utcTime, type ExportName, type Stats } from '../lib/explore';
import type { ReactNode } from 'react';
import { AppLink } from '@/components/app-link';

const count = (n: number) => formatUsdc(String(n));
const isZero = (v: string) => /^0(\.0+)?$/.test(v);

/** The counts: one definition each, used by the strip labels and the ledger rows. */
const LABEL = {
  agents: 'Agents registered',
  seals: 'Agent checks sealed on chain',
  payments: 'Payments to agents',
  proven: 'Paid outputs with a proof',
  usdc: 'USDC paid for proven outputs',
  active: 'Agents with payment activity, last hour',
} as const;

/** `18:11 UTC`: the start of the rolling hour that ends at `asOf`. */
function hourStart(asOf: string): string | null {
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? null : utcTime(new Date(t - 3_600_000).toISOString(), false);
}

function Download({ csv, label, note }: { csv: ExportName; label: string; note: string }) {
  return (
    <td className="ex-dl">
      <a className="ex-rows" href={exportUrl(csv)} aria-label={`Download the rows behind ${label} (CSV)`}>
        rows ↓
      </a>
      <span className="ex-fn">{note}</span>
    </td>
  );
}

/**
 * The counts. `strip` is one small link to /explore. `full` is a real table: the count, what it
 * counts, how it is counted, and the rows to download. A zero keeps its definition and says "none yet".
 * `stale` only changes the first column head, so the figures name the time they are as of.
 */
export function Numbers({ stats, variant, stale = false }: { stats: Stats; variant: 'strip' | 'full'; stale?: boolean }) {
  const proven = stats.usdcProven;
  const transfers = stats.usdcTransfers;

  if (variant === 'strip') {
    // Until the first proven sale the three money counts are all zero; a row of zeros under the hero says less than
    // the one real number, so the homepage shows only the registry count (the full ledger lives on /explore).
    // The on-chain counts (seals, payments) show once they are above zero; an api without them shows only the rest.
    const chain: { label: string; value: string; key: string }[] = [];
    // Once the hero shows the community seal count (test accounts left out), the strip does not repeat a second, larger total.
    if (stats.seals && !stats.community) chain.push({ label: 'agent checks sealed on chain', value: count(stats.seals), key: 'seals' });
    if (stats.payments) chain.push({ label: 'payments to agents', value: count(stats.payments), key: 'payments' });
    const agents = { label: 'agents registered', value: count(stats.agents), key: 'agents' };
    const money = [
      { label: 'paid outputs with a proof', value: count(stats.provenOutputs), key: 'proven' },
      { label: 'USDC paid for proven outputs', value: formatUsdc(proven), key: 'usdc' },
      { label: 'agents with payment activity, last hour', value: count(stats.activeLastHour), key: 'active' },
    ];
    const figures = stats.provenOutputs > 0 ? [agents, ...money] : [agents, ...chain];
    return (
      <AppLink href="/explore" className="group block rounded-[14px]">
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          {figures.map((f) => (
            <div key={f.key} className="min-w-0">
              <p className="headline text-[28px] leading-none tabular-nums sm:text-[32px]">{f.value}</p>
              <p className="mt-2 text-[13px] leading-snug text-fg-2">{f.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-fg-3 transition-colors group-hover:text-fg">
          <span className="ex-dot mr-2 inline-block align-middle" aria-hidden />
          Testnet · live numbers · Open explorer <span aria-hidden>→</span>
        </p>
      </AppLink>
    );
  }

  const asOf = utcTime(stats.indexedThrough ?? stats.asOf, false);
  const since = hourStart(stats.asOf);
  const noProven = stats.provenOutputs === 0;
  const provenNote = noProven ? 'proven-sales.csv · header only' : 'proven-sales.csv';

  return (
    <div className="ex-ledger">
      <table className="ex-lt">
        <thead>
          <tr>
            <th scope="col">{stale && asOf ? `count · as of ${asOf}` : 'count'}</th>
            <th scope="col">what it counts</th>
            <th scope="col">how it is counted</th>
            <th scope="col">download</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="ex-fig">
              <span className="ex-n">{count(stats.agents)}</span>
              {stats.agents === 0 ? <span className="ex-none">none yet</span> : null}
            </td>
            <td className="ex-what">
              <h3>{LABEL.agents}</h3>
              <p>Every agent in the stellar-8004 testnet registry.</p>
            </td>
            <td className="ex-how">
              One row in <code>agents.csv</code> per registry entry, whether or not the agent has a wallet or has done anything.
            </td>
            <Download csv="agents" label={LABEL.agents} note={stats.agents === 0 ? 'agents.csv · header only' : 'agents.csv'} />
          </tr>
          {stats.seals !== undefined ? (
            <tr>
              <td className="ex-fig">
                <span className="ex-n">{count(stats.seals)}</span>
                {stats.seals === 0 ? <span className="ex-none">none yet</span> : null}
              </td>
              <td className="ex-what">
                <h3>{LABEL.seals}</h3>
                <p>
                  Each check or decision an agent made on AgentEnact, committed as its own Stellar testnet transaction. A seal shows when the agent
                  committed to it, never that the reading was right.
                </p>
              </td>
              <td className="ex-how">
                One transaction per seal that was sent, from the agent&rsquo;s own account. Deleted agents stay in the count: their transactions stay on
                chain. Each agent&rsquo;s own count is in the agents list.
              </td>
              <td className="ex-dl">
                <span className="ex-fn">per agent, in the list</span>
              </td>
            </tr>
          ) : null}
          {stats.payments !== undefined ? (
            <tr>
              <td className="ex-fig">
                <span className="ex-n">{count(stats.payments)}</span>
                {stats.payments === 0 ? <span className="ex-none">none yet</span> : null}
              </td>
              <td className="ex-what">
                <h3>{LABEL.payments}</h3>
                <p>
                  USDC transfers to agents from any sender, {formatUsdc(transfers)} USDC together. Owner top-ups, self-payments and sponsors are left
                  out.
                </p>
              </td>
              <td className="ex-how">
                One row in <code>payments.csv</code> per counted transfer, proven or not.
              </td>
              <Download csv="payments" label={LABEL.payments} note={stats.payments === 0 ? 'payments.csv · header only' : 'payments.csv'} />
            </tr>
          ) : null}
          <tr>
            <td className="ex-fig">
              <span className="ex-n">{count(stats.provenOutputs)}</span>
              {noProven ? <span className="ex-none">none yet</span> : null}
            </td>
            <td className="ex-what">
              <h3>{LABEL.proven}</h3>
              <p>Enactment Records that checked out against the payment that bought the output.</p>
              {noProven ? (
                <p className="ex-zero">
                  None yet. This changes when an agent sells an output and its record verifies. <AppLink href="/verify" className="whitespace-nowrap">Verify a record</AppLink>
                </p>
              ) : null}
            </td>
            <td className="ex-how">
              One row in <code>proven-sales.csv</code> per record that verified. A record that fails a check is not listed.
            </td>
            <Download csv="proven-sales" label={LABEL.proven} note={provenNote} />
          </tr>
          <tr>
            <td className="ex-fig">
              <span className="ex-n">{formatUsdc(proven)}</span>
              <span className="ex-unit">USDC</span>
              {proven !== null && isZero(proven) ? <span className="ex-none">none yet</span> : null}
            </td>
            <td className="ex-what">
              <h3>{LABEL.usdc}</h3>
              <p>Payments that settled a proven output. Nothing else counts.</p>
              <p className="ex-ctx">
                Not part of the count: <b>{formatUsdc(transfers)} USDC</b> in transfers to agents from any sender (owner top-ups, self-payments and
                sponsors excluded). <a href={exportUrl('payments')}>transfers ↓</a>
              </p>
            </td>
            <td className="ex-how">
              The <code>amount_usdc</code> column of <code>proven-sales.csv</code>, added up. A payment no record points to is not in it.
            </td>
            <Download csv="proven-sales" label={LABEL.usdc} note={provenNote} />
          </tr>
          <tr>
            <td className="ex-fig">
              <span className="ex-n">{count(stats.activeLastHour)}</span>
              {stats.activeLastHour === 0 ? <span className="ex-none">none this hour</span> : null}
            </td>
            <td className="ex-what">
              <h3>{LABEL.active}</h3>
              <p>Agents that sent or received a payment, or sold a proven output, in the last 60 minutes.</p>
              {stats.activeLastHour === 0 ? (
                <p className="ex-zero">No payment sent, received or sold{since ? ` since ${since}` : ' in the last 60 minutes'}.</p>
              ) : null}
            </td>
            <td className="ex-how">
              Distinct <code>agent_id</code> in <code>activity.csv</code>. A row is a payment sent, a payment received, or a sale. Registrations and
              wallet binds are left out. The window rolls.
            </td>
            <Download csv="activity" label={LABEL.active} note={stats.activeLastHour === 0 ? 'activity.csv · header only' : 'activity.csv'} />
          </tr>
        </tbody>
      </table>
      <p className="ex-amend">
        Definitions changed 14 Oct 2026. Before that, “paid” counted every transfer to an agent and “working” counted registrations.
      </p>
    </div>
  );
}

/**
 * The counts as a compact row at the top of /explore. Same labels as the ledger; a zero says "none yet"
 * in a quieter tone instead of standing as a large figure. How each is counted lives in the ledger below.
 */
export function Overview({ stats, stale = false }: { stats: Stats; stale?: boolean }) {
  const tiles: { key: string; value: string; unit?: string; label: string; zero: boolean; none: string }[] = [
    { key: 'agents', value: count(stats.agents), label: LABEL.agents, zero: stats.agents === 0, none: 'none yet' },
    ...(stats.seals !== undefined ? [{ key: 'seals', value: count(stats.seals), label: LABEL.seals, zero: stats.seals === 0, none: 'none yet' }] : []),
    ...(stats.payments !== undefined
      ? [{ key: 'payments', value: count(stats.payments), label: LABEL.payments, zero: stats.payments === 0, none: 'none yet' }]
      : []),
    { key: 'proven', value: count(stats.provenOutputs), label: LABEL.proven, zero: stats.provenOutputs === 0, none: 'none yet' },
    {
      key: 'usdc', value: formatUsdc(stats.usdcProven), unit: 'USDC', label: LABEL.usdc,
      zero: stats.usdcProven !== null && isZero(stats.usdcProven), none: 'none yet',
    },
    { key: 'active', value: count(stats.activeLastHour), label: LABEL.active, zero: stats.activeLastHour === 0, none: 'none this hour' },
  ];
  return (
    <dl className={stale ? 'ex-ov ex-ov-stale' : 'ex-ov'} data-tiles={tiles.length}>
      {tiles.map((t) => (
        <div key={t.key} className={t.zero ? 'ex-ovt ex-ovz' : 'ex-ovt'}>
          <dt>{t.label}</dt>
          <dd>
            <span className="ex-ovn">{t.value}</span>
            {t.unit ? <span className="ex-ovu">{t.unit}</span> : null}
            {t.zero ? <span className="ex-ovnone">{t.none}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Stand-in for the overview row while stats load. */
export function OverviewSkeleton() {
  return (
    <div className="ex-ov" aria-hidden data-skeleton data-tiles={6}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="ex-ovt">
          <div className="h-[13px] w-2/3 rounded-full bg-line opacity-50" />
          <div className="mt-3 h-[30px] w-16 rounded-[8px] bg-line opacity-50" />
        </div>
      ))}
    </div>
  );
}

/** Quiet stand-in for the ledger while stats load: six rows of the same shape, muted blocks, no animation. */
export function NumbersSkeleton() {
  return (
    <div className="ex-ledger" aria-hidden data-skeleton>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="ex-sk-row" data-skeleton-block>
          <div className="ex-sk-fig bg-line opacity-50" />
          <div className="min-w-0">
            <div className="h-[20px] w-2/3 rounded-full bg-line opacity-50" />
            <div className="mt-3 h-[15px] w-full max-w-[46ch] rounded-full bg-line opacity-50" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The homepage figures, set in the header of "The network, as it happens". Renders `fallback` while loading, on error,
 * or when the index is stale, so the homepage never shows a broken number.
 */
export function NumbersStrip({ fallback = null }: { fallback?: ReactNode }) {
  const { data } = usePoll(getStats, 30_000);
  if (!data || data.stale) return <>{fallback}</>;
  return (
    <div className="numbers-fade">
      <Numbers stats={data} variant="strip" />
    </div>
  );
}
