'use client';
import { useEffect, useState } from 'react';
import { onTabClick } from '@/components/agent-tabs';
import { Button } from '@/components/ui/button';
import { agentHref } from '@/lib/agent-href';
import { copy } from '@/copy';
import { browserStorage } from '@/lib/sell';
import { hideSkillsForAWeek, skillsHiddenNow } from '@/lib/skills';

/** The card as markup, so it can be rendered and scanned without a browser. */
export function SkillsCardView({ agentId, hidden = false, onNotNow }: { agentId: string; hidden?: boolean; onNotNow?: () => void }) {
  const c = copy.skills;
  if (hidden) return null;
  return (
    <section className="mt-4 rounded-2xl border border-dashed border-fg-3/60 px-4 py-3" data-skills-card="">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-sm text-fg">{c.cardBanner}</p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" onClick={onNotNow} data-not-now="">
            {c.notNow}
          </Button>
          <Button asChild variant="quiet">
            <a href={agentHref(agentId, 'skills')} onClick={(e) => onTabClick(e, agentHref(agentId, 'skills'))} data-see-skills="">
              {c.cardOpen}
            </a>
          </Button>
        </div>
      </div>
    </section>
  );
}

/** "Skills from skills.sh could help your agent." Opens the Skills tab; "Not now" hides it for 7 days (browser storage, optional). */
export function SkillsCard({ agentId }: { agentId: string }) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (skillsHiddenNow(browserStorage(), agentId, Date.now())) setHidden(true);
  }, [agentId]);
  return (
    <SkillsCardView
      agentId={agentId}
      hidden={hidden}
      onNotNow={() => {
        hideSkillsForAWeek(browserStorage(), agentId, Date.now());
        setHidden(true);
      }}
    />
  );
}
