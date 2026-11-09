import { AppLink } from '@/components/app-link';
import { agentHref } from '@/lib/agent-href';
import { Seal } from '@/components/seal';
import { copy } from '@/copy';
import type { AgentSummary } from '@/server/agent-data';

const c = copy.myAgents;
const ROW = 'flex min-h-14 items-center gap-3 rounded-2xl px-4 py-3';

/** The account's slots as a row of marks: one filled per agent, one hollow per free slot. Decorative; the line beside it says it in words. */
function SlotMarks({ used, limit }: { used: number; limit: number }) {
  return (
    <span aria-hidden="true" data-slot-marks="" className="flex gap-1">
      {Array.from({ length: limit }, (_, i) => (
        <span key={i} className={`h-1.5 w-5 rounded-full ${i < used ? 'bg-fg' : 'border border-line'}`} />
      ))}
    </span>
  );
}

/**
 * /dashboard for an owner with several agents: one row per agent, oldest first, each opening its own page. The account's limit
 * is on the page, not discovered at a refusal: the line under the title counts the slots, every free slot is a row of its
 * own that creates an agent, and at the limit "New agent" stays in place, inactive, with the reason under the title.
 * With a `prompt` (an idea from the draft screen to add to an agent) each row opens that agent's editor with the idea in
 * the box instead, and nothing offers creating.
 */
export function MyAgentsView({ agents, limit, prompt }: { agents: AgentSummary[]; limit: number | null; prompt?: string | undefined }) {
  const full = limit !== null && agents.length >= limit;
  const free = limit === null || prompt ? 0 : Math.max(0, limit - agents.length);
  const href = (id: string) => (prompt ? agentHref(id, 'whatItDoes', { prompt }) : agentHref(id));
  return (
    <section data-my-agents="">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="headline text-2xl">{c.title}</h1>
          <p className="mt-1.5 flex items-center gap-2.5 text-sm text-fg-3">
            {limit !== null ? <SlotMarks used={Math.min(agents.length, limit)} limit={limit} /> : null}
            <span data-slot-count="">{c.count(agents.length, limit)}</span>
          </p>
        </div>
        {prompt ? null : full ? (
          <span role="link" aria-disabled="true" data-new-agent="full" className="btn h-11 cursor-not-allowed px-4 text-[14px] opacity-40">
            {c.newAgent}
          </span>
        ) : (
          <AppLink href="/create" className="btn h-11 px-4 text-[14px]" data-new-agent="">
            {c.newAgent}
          </AppLink>
        )}
      </div>
      {prompt ? (
        <p className="mt-4 text-[15px] text-fg-2">{c.addTo}</p>
      ) : full && limit !== null ? (
        <p data-full="" className="mt-4 text-sm text-fg-2">
          {c.full(limit)}
        </p>
      ) : null}
      <ul className="mt-4 grid gap-2">
        {agents.map((a) => (
          <li key={a.id}>
            <AppLink href={href(a.id)} prefetch={false} data-agent-row={a.id} className={`${ROW} border border-line hover:bg-line/40`}>
              <Seal hash={`owner-agent:${a.id}`} size={28} mark="var(--ground)" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg">{a.name}</span>
              <span className="shrink-0 text-sm text-fg-3">{c.status[a.status] ?? c.status.provisioning}</span>
              <span aria-hidden="true" className="text-fg-3">→</span>
            </AppLink>
          </li>
        ))}
        {Array.from({ length: free }, (_, i) => (
          <li key={`free-${i}`}>
            <AppLink href="/create" data-free-slot="" className={`${ROW} border border-dashed border-line text-fg-3 hover:border-fg-3 hover:text-fg`}>
              <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-current text-base leading-none">+</span>
              <span className="min-w-0 flex-1 text-[15px]">{c.freeSlot}</span>
              <span className="shrink-0 text-sm">{c.freeSlotAction}</span>
              <span aria-hidden="true">→</span>
            </AppLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
