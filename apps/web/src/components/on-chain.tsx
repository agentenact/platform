import { copy } from '@/copy';
import { ago } from '@/lib/agent-format';
import { explorerTx } from '@/lib/agent-types';
import { shortWallet } from '@/lib/wallets';
import type { ChainHistory, HistoryTx, Move } from '@/lib/wallet-history';

/** "10000.5" → "10,000.5". */
const grouped = (a: string) => a.replace(/^\d+/, (i) => i.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const moveText = (m: Move) => `${grouped(m.amount)} ${m.symbol ?? copy.onChain.unlisted}`;
const list = (ms: Move[]) => ms.map(moveText).join(' and ');

/** One plain sentence for what the transaction did, from the agent's side. */
export function sentence(t: HistoryTx): string {
  const c = copy.onChain;
  if (!t.ok) return c.failed;
  const out = t.moves.filter((m) => m.direction === 'out');
  const inn = t.moves.filter((m) => m.direction === 'in');
  const who = t.counterparty ? shortWallet(t.counterparty) : null;
  if (t.kind === 'hire') return c.hire(list(out), who);
  if (t.kind === 'swap') return c.swap(list(out), list(inn));
  if (t.kind === 'sent') return c.sent(list(out), who);
  if (t.kind === 'received') return c.received(list(inn), who);
  return c.other;
}

/**
 * What the agent did on chain from its own wallets, per network, newest first: hires, trades, coins in and out. Each row links
 * to the chain's explorer, and a hire links to its decision sealed on Stellar. A network that could not be read says so.
 */
export function OnChain({ chains, now }: { chains: ChainHistory[]; now: number }) {
  const c = copy.onChain;
  if (chains.length === 0) return null;
  return (
    <section className="mt-6" data-on-chain="">
      <div className="mb-2.5 flex items-baseline justify-between gap-4 px-1">
        <h2 className="text-lg font-semibold text-fg">{c.title}</h2>
        <p className="text-sm text-fg-3">{c.span}</p>
      </div>
      <div className="flex flex-col gap-3">
        {chains.map((ch) => (
          <div key={ch.network} className="rounded-2xl border border-line" data-chain={ch.network}>
            <h3 className="border-b border-line px-4 py-2 text-sm font-medium text-fg-2">{ch.label}</h3>
            {ch.state === 'unavailable' ? (
              <p className="px-4 py-3 text-sm text-fg-3" data-unavailable="">{c.unavailable}</p>
            ) : ch.txs.length === 0 ? (
              <p className="px-4 py-3 text-sm text-fg-3">{c.none}</p>
            ) : (
              <ul className="divide-y divide-line">
                {ch.txs.map((t) => {
                  const href = explorerTx(t.tx);
                  const sealed = t.decision ? explorerTx(t.decision) : null;
                  return (
                    <li key={t.tx.hash} data-kind={t.kind} data-ok={t.ok ? 'yes' : 'no'} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                      <span className={`min-w-0 break-words ${t.ok ? 'text-fg' : 'text-fg-3'}`}>{sentence(t)}</span>
                      <span className="flex shrink-0 items-baseline gap-x-3 text-xs text-fg-3">
                        <time dateTime={t.at}>{ago(t.at, now)}</time>
                        {sealed ? (
                          <a href={sealed} target="_blank" rel="noopener noreferrer" title={c.decisionTitle} data-decision-link="" className="underline decoration-[var(--raised-line)] underline-offset-4 hover:text-fg">
                            {c.decision}
                          </a>
                        ) : null}
                        {href ? (
                          <a href={href} target="_blank" rel="noopener noreferrer" className="underline decoration-[var(--raised-line)] underline-offset-4 hover:text-fg">
                            {c.view}
                          </a>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
