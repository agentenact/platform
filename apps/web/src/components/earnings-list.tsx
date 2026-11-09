import { copy } from '@/copy';
import { ago, formatUsdc, safeUrl } from '@/lib/agent-format';
import type { Overview, SaleItem } from '@/lib/agent-types';

/** What the agent has earned: the total and count (from the overview) and each proven sale with its proof. */
export function EarningsList({ overview, sales, now }: { overview: Pick<Overview, 'earnedUsdc' | 'salesCount'>; sales: SaleItem[]; now: number }) {
  return (
    <section className="mt-5" data-earnings="">
      <h2 className="eyebrow">{copy.earnings.title}</h2>
      {overview.salesCount === 0 && sales.length === 0 ? (
        <p className="card mt-2 text-sm text-fg-2">{copy.earnings.empty}</p>
      ) : (
        <>
          <p className="headline mt-2 text-3xl" data-total="">
            {copy.earnings.total(formatUsdc(overview.earnedUsdc))}
          </p>
          <p className="mt-1 text-sm text-fg-2">{copy.agent.numbers.sales(overview.salesCount)}</p>
          <ul className="card mt-4 divide-y divide-line !p-0">
            {sales.map((s, i) => {
              const href = safeUrl(s.proofUrl);
              return (
                <li key={`${s.at}-${i}`} data-item="sale" className="min-w-0 px-4 py-3 text-sm sm:px-6">
                  <span className="block text-xs text-fg-3">{ago(s.at, now)}</span>
                  <span className="flex flex-wrap items-baseline justify-between gap-x-4 font-medium text-proven">
                    <span className="min-w-0 break-words">{copy.earnings.sale(formatUsdc(s.usdc))}</span>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        {copy.earnings.proof}
                      </a>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="mt-4 text-xs text-fg-3">{copy.earnings.note}</p>
    </section>
  );
}
