'use client';
import { Check, Copy, ExternalLink, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { openWalletAction } from '@/app/actions/wallets';
import { TECH } from '@/components/tech-logos';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { shortWallet, type AgentWallet, type OpenWalletOut } from '@/lib/wallets';

type Open = (network: string) => Promise<OpenWalletOut>;

/**
 * Circle's public faucet hands out test USDC on Stellar testnet and Base Sepolia; the owner pastes the address there.
 * No XLM faucet: friendbot only opens new accounts, and an agent buys its own XLM with USDC (api agents/reserve.ts).
 */
export const USDC_FAUCET = 'https://faucet.circle.com/';

const icon = 'grid size-8 shrink-0 place-items-center rounded-full text-fg-3 transition-colors hover:bg-line hover:text-fg focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none';

/**
 * The card for given wallets, as markup, so every state renders without a browser. Per network: its mark and name, the short
 * address (tap to copy), the USDC it can pay with set large, anything else it holds on one quiet line, and a way to add test USDC.
 */
export function WalletsCardView({
  wallets,
  busy = null,
  error = null,
  copied = null,
  funded = null,
  onOpen,
  onCopy,
  onFund,
}: {
  wallets: AgentWallet[];
  busy?: string | null;
  error?: string | null;
  /** The network whose address was just copied. */
  copied?: string | null;
  /** The network whose faucet was just opened. */
  funded?: string | null;
  onOpen?: (network: string) => void;
  onCopy?: (w: AgentWallet) => void;
  onFund?: (w: AgentWallet) => void;
}) {
  const c = copy.wallets;
  // Opened wallets first, in full; networks it could also pay on follow as one compact list, so more chains add rows, not height.
  const opened = wallets.filter((w) => w.address);
  const closed = wallets.filter((w) => !w.address);
  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-line" data-wallets="">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3.5 pb-1">
        <h2 className="text-sm font-semibold text-fg">{c.title}</h2>
        <span className="text-xs text-fg-3">{c.testnet}</span>
      </div>
      <ul className="divide-y divide-line">
        {opened.map((w) => (
          <li key={w.network} className="flex min-w-0 flex-col px-4 py-3.5" data-wallet={w.network}>
            <div className="flex min-h-8 items-center gap-2.5">
              <NetworkMark network={w.network} label={w.label} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{w.label}</span>
              {w.explorer ? (
                <a href={w.explorer} target="_blank" rel="noreferrer" className={icon} aria-label={c.explorer(w.label)} title={c.explorer(w.label)} data-wallet-explorer="">
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </div>
            <>
                <button
                  type="button"
                  onClick={() => onCopy?.(w)}
                  title={w.address!}
                  aria-label={c.copyAddress(w.label)}
                  className="-mx-1.5 mt-0.5 flex w-fit items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs text-fg-2 transition-colors outline-none hover:bg-line hover:text-fg focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  data-wallet-address=""
                >
                  {shortWallet(w.address!)}
                  {copied === w.network ? <Check className="size-3.5 text-fg" aria-hidden /> : <Copy className="size-3.5 opacity-70" aria-hidden />}
                  <span aria-live="polite" className={copied === w.network ? 'font-sans text-fg' : 'sr-only'}>
                    {copied === w.network ? c.copied : ''}
                  </span>
                </button>
                <Holdings w={w} />
                {w.reserve ? (
                  <p className="mt-2 text-xs text-fg-3" data-wallet-reserve={w.reserve}>
                    {c.reserve[w.reserve]}
                  </p>
                ) : null}
                <a
                  href={USDC_FAUCET}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => onFund?.(w)}
                  className="mt-3 inline-flex h-9 w-fit items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] font-medium text-fg transition-colors outline-none hover:bg-line focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  data-fund={w.network}
                >
                  <Plus className="size-3.5" aria-hidden />
                  {c.fund}
                </a>
                {funded === w.network ? (
                  <p role="status" className="mt-2 text-xs text-fg-2">
                    {c.funded(w.label)}
                  </p>
                ) : null}
            </>
          </li>
        ))}
      </ul>
      {closed.length > 0 ? (
        <div className="border-t border-line px-4 pt-3 pb-2" data-closed-wallets="">
          <p className="text-xs text-fg-3">{c.openHint}</p>
          <ul className="mt-1">
            {closed.map((w) => (
              <li key={w.network} className="flex min-h-11 items-center gap-2.5" data-wallet={w.network}>
                <NetworkMark network={w.network} label={w.label} dim />
                <span className="min-w-0 flex-1 truncate text-sm text-fg-2">{w.label}</span>
                <Button type="button" variant="quiet" className="h-8 px-3.5 text-[13px]" busy={busy === w.network} disabled={busy !== null} onClick={() => onOpen?.(w.network)} data-open-wallet={w.network} aria-label={c.openOn(w.label)}>
                  {busy === w.network ? c.opening : c.open}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="border-t border-line px-4 py-2.5 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <p className="border-t border-line px-4 py-2.5 text-xs text-fg-3">{c.note}</p>
    </section>
  );
}

/** "10000.00" → "10,000.00". */
const grouped = (a: string) => a.replace(/^\d+/, (i) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const isZero = (a: string) => !/[1-9]/.test(a);

/**
 * What an opened wallet holds. USDC, the money it hires with, comes first and large (0.00 when the chain lists none); every
 * other asset follows on one quiet line, native coin first. A failed read says so and never shows a zero.
 */
function Holdings({ w }: { w: AgentWallet }) {
  const c = copy.wallets;
  if (w.assets === null && w.usdc === null)
    return (
      <p className="mt-3 text-sm text-fg-3" data-wallet-usdc="">
        {c.unknown}
      </p>
    );
  const usdc = w.assets ? (w.assets.find((a) => a.symbol === 'USDC')?.amount ?? '0.00') : (w.usdc ?? '0.00');
  const rest = (w.assets ?? []).filter((a) => a.symbol !== 'USDC');
  return (
    <div className="mt-3" data-wallet-assets="">
      <p className="flex items-baseline gap-1.5" data-asset="USDC" data-wallet-usdc="">
        <span className={`text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums ${isZero(usdc) ? 'text-fg-3' : 'text-fg'}`}>{grouped(usdc)}</span>
        <span className="text-sm text-fg-2">USDC</span>
      </p>
      {w.assets && w.assets.length === 0 ? (
        <p className="mt-1.5 text-xs text-fg-3">{c.empty}</p>
      ) : rest.length > 0 ? (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-3">
          <span>{c.also}</span>
          {rest.map((a) => (
            <span key={a.symbol} className="text-fg-2 tabular-nums" data-asset={a.symbol}>
              {grouped(a.amount)} {a.symbol}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

const STELLAR = TECH.find((t) => t.name === 'Stellar')!.logo!;

/** Simple Icons paths (CC0) for the marks that have one there. */
const SOLANA =
  'm23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z';
const POLYGON =
  'm17.82 16.342 5.692-3.287A.98.98 0 0 0 24 12.21V5.635a.98.98 0 0 0-.488-.846l-5.693-3.286a.98.98 0 0 0-.977 0L11.15 4.789a.98.98 0 0 0-.489.846v11.747L6.67 19.686l-3.992-2.304v-4.61l3.992-2.304 2.633 1.52V8.896L7.158 7.658a.98.98 0 0 0-.977 0L.488 10.945a.98.98 0 0 0-.488.846v6.573a.98.98 0 0 0 .488.847l5.693 3.286a.981.981 0 0 0 .977 0l5.692-3.286a.98.98 0 0 0 .489-.846V6.618l.072-.041 3.92-2.263 3.99 2.305v4.609l-3.99 2.304-2.63-1.517v3.092l2.14 1.236a.981.981 0 0 0 .978 0v-.001Z';

/**
 * The network's own mark in one ink: Stellar's rocket arc, Base's square, Polygon's links. A network without a mark we can
 * draw faithfully gets its initial in a ring, never an imitation of its logo.
 */
function NetworkMark({ network, label, dim = false }: { network: string; label: string; dim?: boolean }) {
  const cls = `size-4 shrink-0 ${dim ? 'text-fg-3' : 'text-fg-2'}`;
  if (network.startsWith('stellar:'))
    return (
      <svg viewBox={STELLAR.viewBox} fill="currentColor" className={cls} aria-hidden>
        {STELLAR.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
      </svg>
    );
  if (network === 'eip155:84532' || network === 'eip155:8453')
    return (
      <svg viewBox="0 0 16 16" fill="currentColor" className={cls} aria-hidden>
        <rect x="1" y="1" width="14" height="14" rx="3" />
      </svg>
    );
  if (network === 'eip155:80002' || network === 'eip155:137')
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
        <path d={POLYGON} />
      </svg>
    );
  if (network.startsWith('solana:'))
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" className={cls} aria-hidden>
        <path d={SOLANA} />
      </svg>
    );
  return (
    <svg viewBox="0 0 16 16" className={cls} aria-hidden>
      <circle cx="8" cy="8" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="8" y="11.2" textAnchor="middle" fontSize="9" fontWeight="600" fill="currentColor" fontFamily="var(--font-sans)">
        {label.charAt(0)}
      </text>
    </svg>
  );
}

const writeClipboard = (text: string) => navigator.clipboard?.writeText(text).catch(() => undefined) ?? Promise.resolve();

export function WalletsCard({ agentId, wallets: first, onOpen }: { agentId: string; wallets: AgentWallet[]; onOpen?: Open }) {
  const [wallets, setWallets] = useState(first);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [funded, setFunded] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open: Open = onOpen ?? ((network) => openWalletAction(agentId, network));
  return (
    <WalletsCardView
      wallets={wallets}
      busy={busy}
      error={error}
      copied={copied}
      funded={funded}
      onCopy={(w) => {
        if (!w.address) return;
        void writeClipboard(w.address).then(() => {
          setCopied(w.network);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(null), 1500);
        });
      }}
      onFund={(w) => {
        if (!w.address) return;
        void writeClipboard(w.address);
        setFunded(w.network);
      }}
      onOpen={async (network) => {
        setBusy(network);
        setError(null);
        const out = await open(network);
        if (out.ok) setWallets(out.wallets);
        else setError(out.message);
        setBusy(null);
      }}
    />
  );
}
