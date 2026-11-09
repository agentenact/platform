import { MorningNote } from '@/components/morning-note';
import { copy } from '@/copy';
import { dayWord } from '@/lib/agent-format';
import { daysWatching } from '@/lib/agent-moment';
import type { FeedItem, Overview } from '@/lib/agent-types';
import { plainText } from '@/lib/draft-display';
import type { DraftData } from '@/lib/draft-types';
import { limitText } from '@/lib/reading-cells';

const T = copy.today;

/**
 * A quiet day made visible: how many checks, what the reading stayed between against the owner's own line, how long the agent
 * has been watching, and the one question about a morning note. Every number is the api's: the day's count from the overview,
 * the range from today's quiet row, the limit from the agent's description.
 */
export function TodayCard({ agentId, o, feed, draft, now }: { agentId: string; o: Overview; feed: FeedItem[]; draft?: DraftData | null; now: number }) {
  const today = feed.filter((i) => dayWord(i.at.slice(0, 10), now) === 'today');
  const alertsToday = today.filter((i) => i.type === 'alert').length;
  const quiet = feed.find((i): i is Extract<FeedItem, { type: 'quiet' }> => i.type === 'quiet' && dayWord(i.day, now) === 'today');
  const range = quiet?.range ? plainText(quiet.range) : null;
  const kind = range?.includes('%') ? 'pct' : range?.includes('$') ? 'usd' : null;
  const limit = kind ? limitText(draft, kind) : null;
  const days = daysWatching(o.watchingSince, now);
  return (
    <section data-today="" data-card="" className="card fade-in">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="eyebrow">{T.eyebrow}</p>
        {days === null ? null : <p className="text-sm text-fg-2">{T.daysWatching(days)}</p>}
      </div>
      <p className="headline mt-1 break-words text-xl">
        {T.checks(o.checksToday)} {alertsToday > 0 ? T.alertsToday(alertsToday) : T.nothing}
      </p>
      {range ? (
        <p data-range="" className="mt-2 break-words text-sm text-fg-2">
          {T.stayed(range)}
          {limit ? ` ${T.yourLimit(limit)}` : ''}
        </p>
      ) : null}
      <p className="mt-2 text-sm text-fg-2">
        {copy.agent.alertsThisWeek(o.alertsThisWeek)} · {T.quietIsFree}
      </p>
      <MorningNote agentId={agentId} answer={o.morningNote} />
    </section>
  );
}
