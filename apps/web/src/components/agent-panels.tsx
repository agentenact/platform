import { Suspense } from 'react';
import { EarningsList } from '@/components/earnings-list';
import { EditDescription } from '@/components/edit-description';
import { SkillsPanel } from '@/components/skills-panel';
import { copy } from '@/copy';
import type { Overview } from '@/lib/agent-types';
import { loadEarningsPanel, loadEditPanel, loadSkillsPanel, type LoadPanel } from '@/server/panel-data';
import type { SaleItem } from '@/lib/agent-types';
import type { SpecShown } from '@/lib/edit';
import type { SkillsHeld } from '@/lib/skills';

export interface PanelLoaders {
  edit: LoadPanel<SpecShown>;
  skills: LoadPanel<SkillsHeld>;
  earnings: LoadPanel<SaleItem[]>;
}

export const panelLoaders: PanelLoaders = { edit: loadEditPanel, skills: loadSkillsPanel, earnings: loadEarningsPanel };

/** One tab's own read failed: the page and the other tabs carry on; the next refresh tries again. */
function PanelError() {
  return (
    <p role="alert" data-panel-error="" className="card text-sm text-fg-2">
      {copy.agent.panelError}
    </p>
  );
}

/** The rough shape of a panel while its read streams in: never a spinner. */
export function PanelSkeleton() {
  return (
    <div aria-busy="true" role="status" className="card space-y-4">
      <span className="sr-only">{copy.shell.loading}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden className="soft h-4 rounded-full bg-line" style={{ width: `${88 - i * 18}%` }} />
      ))}
    </div>
  );
}

export async function EditSlot({ id, name, prompt, load }: { id: string; name: string; prompt: string; load: PanelLoaders['edit'] }) {
  const data = await load(id, name);
  return data ? <EditDescription agentId={id} active={data.active} pending={data.pending} initialPrompt={prompt} /> : <PanelError />;
}

export async function SkillsTabSlot({ id, name, now, load }: { id: string; name: string; now: number; load: PanelLoaders['skills'] }) {
  const data = await load(id, name);
  return data ? <SkillsPanel agentId={id} held={data} now={now} /> : <PanelError />;
}

export async function EarningsSlot({ id, o, now, load }: { id: string; o: Overview; now: number; load: PanelLoaders['earnings'] }) {
  const data = await load(id, o.name);
  return data ? <EarningsList overview={o} sales={data} now={now} /> : <PanelError />;
}

/**
 * The bodies of What it does, Skills and Earnings, each streamed in on its own behind the page (Activity and Chat need no
 * read of their own). They all arrive with the first load, so a tab switch later never waits on the server.
 */
export function streamedPanels({ id, o, now, prompt = '', load = panelLoaders }: { id: string; o: Overview; now: number; prompt?: string; load?: PanelLoaders }) {
  return {
    whatItDoes: (
      <Suspense fallback={<PanelSkeleton />}>
        <EditSlot id={id} name={o.name} prompt={prompt} load={load.edit} />
      </Suspense>
    ),
    skills: (
      <Suspense fallback={<PanelSkeleton />}>
        <SkillsTabSlot id={id} name={o.name} now={now} load={load.skills} />
      </Suspense>
    ),
    earnings: (
      <Suspense fallback={<PanelSkeleton />}>
        <EarningsSlot id={id} o={o} now={now} load={load.earnings} />
      </Suspense>
    ),
  };
}
