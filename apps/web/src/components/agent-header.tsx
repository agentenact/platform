import { AgentLive } from '@/components/agent-live';
import { Countdown } from '@/components/countdown';
import { ModelPicker } from '@/components/model-picker';
import { PauseButton } from '@/components/pause-button';
import { Reschedule } from '@/components/reschedule';
import { RunNowButton } from '@/components/run-now';
import { RunProgress } from '@/components/run-progress';
import { copy, statusWord } from '@/copy';
import { ago, clockLeft, formatUsdc } from '@/lib/agent-format';
import type { Overview } from '@/lib/agent-types';
import type { DraftData } from '@/lib/draft-types';
import { pctText, usdText } from '@/lib/reading-cells';
import { plainText } from '@/lib/draft-display';

const DOT: Record<Overview['status'], string> = {
  watching: 'dot-green',
  paused: 'bg-fg-3',
  getting_ready: 'bg-fg-3 animate-pulse',
  stopped_today: 'bg-accent',
  setting_up: 'bg-fg-3',
  stopped: 'bg-fg-3',
};

const I = copy.agent.instruments;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The top of the agent's page, one sand panel: the name, a status pill, the owner's actions (Run now, Reschedule, Pause /
 * Resume), the plain sentence of what the agent does (when the page has it), and the live line: what it is doing now, when
 * it checks next, how the last check went. Run now shows while the agent is watching, and as Resume and run while it is paused; Reschedule only for an agent
 * that runs on a clock (its description has a time), paused or not. An agent getting ready (waiting for its first USDC)
 * has none of them: it starts on its own, and the live line says so. Under the sentence: the model it runs on, which the
 * owner can change (ModelPicker).
 */
export function AgentHeader({ agentId, o, now = Date.now(), sentence, draft }: { agentId: string; o: Overview; now?: number; sentence?: string; draft?: DraftData | undefined }) {
  const canPause = o.status === 'watching' || o.status === 'stopped_today' || o.status === 'paused';
  return (
    <header className="panel panel-sand p-5" data-agent-header="">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <p className="text-sm text-fg-2">{copy.agent.label}</p>
          <h1 className="headline mt-1 break-words text-3xl lg:text-[28px] lg:leading-[1.05]">{o.name}</h1>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:items-start">
          <p data-status={o.status} className="inline-flex h-9 items-center sm:mt-1 gap-2 rounded-full bg-white px-3.5 text-sm font-medium text-fg">
            <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT[o.status]}`} />
            {statusWord(o.status)}
          </p>
          {/* The owner's actions. A phone gives Run now the full width, with Reschedule and Pause side by side under it. */}
          <div data-agent-actions="" className="grid w-full grid-cols-2 items-start gap-2 sm:flex sm:w-auto sm:items-start">
            {o.status === 'watching' || o.status === 'paused' ? (
              <RunNowButton agentId={agentId} running={o.status === 'watching' && o.running} lastRun={o.lastRun} paused={o.status === 'paused'} />
            ) : null}
            {canPause && draft ? <Reschedule agentId={agentId} draft={draft} /> : null}
            {canPause ? <PauseButton key={String(o.status === 'paused')} agentId={agentId} paused={o.status === 'paused'} /> : null}
          </div>
        </div>
      </div>
      {sentence ? <p className="mt-4 line-clamp-3 max-w-[72ch] break-words text-[15px] text-fg">{sentence}</p> : null}
      {o.model && o.status !== 'stopped' ? (
        <div className="mt-3">
          <ModelPicker key={o.model.current} agentId={agentId} model={o.model} />
        </div>
      ) : null}
      <AgentLive o={o} now={now} />
      {o.status === 'watching' && o.running ? <RunProgress agentId={agentId} /> : null}
    </header>
  );
}

/** The newest reading as one short value ("XLM −0.40%", "$0.1913", "3 payments"), or null when there is nothing safe to show. */
export function readingValue(reading: Record<string, number | string> | null | undefined): string | null {
  if (!reading || reading.stale !== undefined) return null;
  const symbol = typeof reading.symbol === 'string' ? plainText(reading.symbol) : null;
  const pre = symbol ? `${symbol} ` : '';
  if (isNum(reading.changePct)) return `${pre}${pctText(reading.changePct)}`;
  if (isNum(reading.price)) return `${pre}${usdText(reading.price)}`;
  if (isNum(reading.count)) return I.payments(reading.count);
  return null;
}

function Cell({ label, value, note, dim = false, id }: { label: string; value: React.ReactNode; note?: React.ReactNode; dim?: boolean; id: string }) {
  return (
    <div data-instrument={id} className="flex min-w-0 flex-col gap-1.5 bg-raised px-4 py-3.5">
      <dt className="text-[12.5px] leading-tight text-fg-2">{label}</dt>
      <dd className="m-0 min-w-0">
        <span className={`block truncate font-mono text-[19px] leading-none font-medium tracking-[-0.02em] tabular-nums ${dim ? 'text-fg-3' : 'text-fg'}`}>{value}</span>
        {note ? <span className="mt-1.5 block truncate text-[12px] text-fg-3">{note}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The instrument row: what the agent is doing right now, every reading in the same place every time. Next check counts down
 * live; the rest moves with the page's 30-second refresh. A value it does not have yet is a dim dash, never a made-up zero.
 */
export function Instruments({ o, now }: { o: Overview; now: number }) {
  const watching = o.status === 'watching';
  const next =
    watching && o.running ? (
      <Cell id="next" label={I.nextCheck} value={I.running} />
    ) : !watching || !o.nextCheckAt ? (
      <Cell id="next" label={I.nextCheck} value={o.status === 'paused' ? I.paused : o.status === 'getting_ready' ? I.gettingReady : o.status === 'stopped_today' ? I.tomorrow : I.none} dim />
    ) : (
      <Cell id="next" label={I.nextCheck} value={<Countdown at={o.nextCheckAt} initial={clockLeft(Date.parse(o.nextCheckAt) - now) ?? I.due} due={I.due} />} />
    );
  const read = readingValue(o.latestCheck?.reading);
  const sold = o.salesCount > 0;
  return (
    <dl data-instruments="" className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-object)] border border-[var(--raised-line)] bg-[var(--raised-line)] sm:grid-cols-3 xl:grid-cols-6">
      {next}
      <Cell id="reading" label={I.lastReading} value={read ?? I.none} dim={!read} note={o.latestCheck ? ago(o.latestCheck.at, now) : undefined} />
      <Cell id="checks" label={I.checksToday} value={o.checksToday} dim={o.checksToday === 0} note={o.checksTotal > 0 ? I.inAll(o.checksTotal) : undefined} />
      <Cell id="alerts" label={o.watchesCondition ? I.alerts : I.runs} value={o.alertsThisWeek} dim={o.alertsThisWeek === 0} note={o.lastAlertAt ? I.lastAlert(ago(o.lastAlertAt, now)) : I.noAlert} />
      <Cell id="earned" label={I.earned} value={sold ? formatUsdc(o.earnedUsdc) : '0'} dim={!sold} note={sold ? I.sales(o.salesCount) : I.testnetUsdc} />
      <Cell id="budget" label={I.budget} value={`${o.budgetUsedPct}%`} dim={o.budgetUsedPct === 0 && o.status !== 'stopped_today'} note={<Meter pct={o.budgetUsedPct} />} />
    </dl>
  );
}

/** The share of today's free budget used, as a hairline that fills: a measurement, nothing more. */
function Meter({ pct }: { pct: number }) {
  return (
    <span aria-hidden="true" className="mt-0.5 block h-[3px] w-full overflow-hidden rounded-full bg-[var(--raised-line)]">
      <span className={`block h-full rounded-full ${pct >= 100 ? 'bg-accent' : 'bg-fg-2'}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}
