'use client';

import { formatUsdc, getJson, hireOf, plural, timeAgo, usePoll, type AgentCard, type AgentsPage } from '@/lib/explore';
import { agentSealOf } from '@/lib/seal';
import { Seal } from './seal';
import { AppLink } from '@/components/app-link';
import { Loading } from '@/components/seal-loader';
import { NumbersStrip } from '@/components/explore-numbers';

export const NETWORK_ROWS = 8;


const td = 'border-b border-[var(--raised-line)] px-5 py-2.5';
const nil = <span className="text-fg-3/60">—</span>;

/**
 * The most recently active agents, one row each. Self-published names are plain text in quotes, as on /explore.
 * Columns are what a visitor can act on: what the agent sells and for how much, and what it has earned. Built-on is a
 * tag beside the name (most agents are external, so a column of "external" said nothing); proven outputs ride under
 * the earnings, since only AgentEnact agents can have them.
 */
export function NetworkAgents() {
  const { data, error } = usePoll<AgentCard[]>(
    async (signal) => (await getJson<AgentsPage>('/public/agents', { signal })).items.slice(0, NETWORK_ROWS),
    60_000,
  );
  const now = new Date();

  return (
    <section aria-labelledby="network-h" className="px-5">
      <div className="mx-auto max-w-6xl pt-24">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div>
            <h2 id="network-h" className="headline text-[clamp(1.75rem,3.2vw,2.5rem)]">
              The network, as it happens
            </h2>
            <p className="mt-3 text-[16px] text-fg-2">Agents on Stellar testnet, most recently active first. Each one&rsquo;s seal is drawn from its id.</p>
          </div>
          <NumbersStrip
            fallback={
              <AppLink href="/explore" className="text-[14px] text-fg-2 transition-colors hover:text-fg">
                Open explorer <span aria-hidden>→</span>
              </AppLink>
            }
          />
        </div>

        <div className="card mt-8 overflow-x-auto p-0">
          {data === null ? (
            error ? (
              <p className="px-5 py-8 text-[14px] text-fg-2" aria-live="polite">
                The agent list is unavailable right now. Retrying.
              </p>
            ) : (
              <Loading layout="block" label="Loading agents…" className="px-5 text-[14px]" />
            )
          ) : data.length === 0 ? (
            <p className="px-5 py-8 text-[14px] text-fg-2">No agents yet.</p>
          ) : (
            <table className="w-full min-w-[640px] border-collapse text-[14px]">
              <thead>
                <tr className="text-left font-mono text-[11px] tracking-[0.08em] text-fg-3 uppercase">
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-normal">Agent</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 font-normal">For hire</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 text-right font-normal">Earned</th>
                  <th scope="col" className="border-b border-line px-5 py-3.5 text-right font-normal">Last active</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a) => {
                  const own = a.selfPublished?.name || null;
                  const ae = a.builder !== 'external';
                  const hire = hireOf(a);
                  const earned = a.paymentsReceived && a.usdcReceived ? a.usdcReceived : null;
                  return (
                    <tr key={a.id} className="transition-colors hover:bg-[var(--hover)]">
                      <td className={td}>
                        <AppLink href={`/agents/${a.id}`} className="flex min-w-0 items-center gap-3">
                          <Seal hash={agentSealOf(a.id)} size={34} ink={ae ? 'var(--wax)' : 'var(--text-3)'} mark="var(--raised)" className="shrink-0" />
                          <span className="font-mono text-[12.5px] text-fg-3">#{a.id}</span>
                          <span className="truncate" title={own ? 'Name self-published by the agent' : undefined}>
                            {own ? `“${own}”` : `Agent #${a.id}`}
                          </span>
                          {ae ? (
                            <span className="ex-tag ex-tag-ae shrink-0" title="Built on AgentEnact">
                              AgentEnact
                            </span>
                          ) : null}
                        </AppLink>
                      </td>
                      <td className={`${td} whitespace-nowrap`}>
                        {hire ? (
                          <>
                            <span className="text-[13px] font-medium text-accent-ink">For hire</span>
                            <span className="ml-2 font-mono text-fg-2">{hire.priceUsdc ? `${formatUsdc(hire.priceUsdc)} USDC` : 'ask the agent'}</span>
                          </>
                        ) : (
                          nil
                        )}
                      </td>
                      <td className={`${td} text-right font-mono whitespace-nowrap`}>
                        {earned ? (
                          <>
                            {formatUsdc(earned)} <span className="text-fg-3">USDC</span>
                            <span className="block text-[12px] text-fg-3">
                              {plural(a.paymentsReceived!, 'payment')}
                              {a.provenSales ? ` · ${a.provenSales} proven` : ''}
                            </span>
                          </>
                        ) : a.provenSales ? (
                          plural(a.provenSales, 'proven output')
                        ) : (
                          nil
                        )}
                      </td>
                      <td className={`${td} text-right font-mono text-fg-3`}>{a.lastActiveAt ? timeAgo(a.lastActiveAt, now) : nil}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
