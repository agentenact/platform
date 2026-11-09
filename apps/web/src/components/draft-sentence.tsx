'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { clockText, currentNumber, parseNumber, parseTime, pillAndRest, parseText, rangeText, stepFrom, timeValue, WEEKDAYS } from '@/lib/draft-display';
import type { DraftData, OptionValue, ParamSpec, TimeParam } from '@/lib/draft-types';
import { localTimeZone, zoneFor, zonePlace } from '@/lib/time-zone';

/** The value a parameter's editor starts with: a time as its clock ("08:00"). */
const startValue = (p: ParamSpec): string => {
  if (p.kind !== 'time') return String(p.value);
  const t = parseTime(p.value);
  if (!t) return '';
  return t.weekday === null ? clockText(t) : `${clockText(t)} ${t.weekday}`;
};

interface EditUi {
  clearMessage: () => void;
  close: () => void;
  restore: () => void;
  setMessage: (m: string) => void;
}

/** Ask the api for an edit: taken closes the editor; refused (or no handler) restores the shown value and keeps it open. */
export async function applyEdit(onEdit: ((param: string, value: OptionValue) => Promise<boolean>) | undefined, p: ParamSpec, value: OptionValue, ui: Pick<EditUi, 'clearMessage' | 'close' | 'restore'>): Promise<void> {
  ui.clearMessage();
  const ok = (await onEdit?.(p.id, value)) ?? false;
  if (ok) ui.close();
  else ui.restore();
}

/** A typed number or text: checked here first; a bad one shows its plain message and the api is not asked. */
export async function submitEdit(p: ParamSpec, raw: string, onEdit: ((param: string, value: OptionValue) => Promise<boolean>) | undefined, ui: EditUi): Promise<void> {
  if (p.kind === 'number') {
    const n = parseNumber(raw, p);
    if (n === null) return ui.setMessage(copy.draft.outOfRange(p.min, p.max));
    return applyEdit(onEdit, p, n, ui);
  }
  if (p.kind === 'text') {
    const t = parseText(raw);
    if (t === null) return ui.setMessage(copy.draft.notAText);
    return applyEdit(onEdit, p, t, ui);
  }
  if (p.kind === 'time') {
    const v = timeFrom(raw, p);
    if (v === null) return ui.setMessage(copy.draft.notATime);
    return applyEdit(onEdit, p, v, ui);
  }
}

/** A typed clock ("07:30") and, for a weekly time, a weekday ("07:30 2") as the schedule; null when it is not one. */
export function timeFrom(raw: string, p: TimeParam): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?: ([0-6]))?$/.exec(raw.trim());
  const was = parseTime(p.value);
  if (!m || !was) return null;
  const weekday = was.weekday === null ? null : m[3] !== undefined ? Number(m[3]) : was.weekday;
  return timeValue({ hour: Number(m[1]), minute: Number(m[2]), weekday });
}

/**
 * The time editor: the quick picks with their hour ("morning 08:00"), then "Other time" for any minute and hour (and,
 * for a weekly time, any weekday). The times are the person's own: the zone shows under the label.
 */
export function TimeEditor({ param, draft, raw, setRaw, busy, commit }: { param: TimeParam; draft: DraftData; raw: string; setRaw: (v: string) => void; busy: boolean; commit: (v: string) => void }) {
  const preset = param.presets.find((o) => o.value === param.value);
  const [other, setOther] = useState(!preset);
  const now = parseTime(param.value);
  const zone = zoneFor(draft, param.id, localTimeZone());
  const [clock, day] = raw.split(' ');
  const weekly = now !== null && now.weekday !== null;
  // A settings list, one choice per row: the name on the left and its hour on the right, so no label ever has to wrap.
  const row = (on: boolean) =>
    `flex min-h-12 w-full items-center gap-3 px-4 text-left transition-colors duration-150 disabled:opacity-60 ${on ? 'bg-line/60' : 'hover:bg-line/40'}`;
  const check = (on: boolean) => (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-4 shrink-0 ${on ? 'text-accent' : 'invisible'}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>
  );
  const field = 'h-11 min-w-0 rounded-full border border-line bg-bg px-3 text-[16px] sm:px-4 font-semibold tabular-nums [color-scheme:inherit]';
  return (
    <div className="w-full min-w-0 basis-full">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-sm text-fg-2">{param.label}</p>
        {zone ? <p data-zone="" className="text-[13px] text-fg-3">{copy.draft.zone(zonePlace(zone))}</p> : null}
      </div>
      <div role="group" aria-label={param.label} data-time-list="" className="overflow-hidden rounded-[14px] border border-line bg-white divide-y divide-line">
        {param.presets.map((o) => {
          const on = !other && o.value === param.value;
          const t = parseTime(o.value);
          return (
            <button key={o.value} type="button" aria-pressed={on} disabled={busy} onClick={() => (setOther(false), commit(o.value))} className={row(on)}>
              {check(on)}
              <span className="min-w-0 flex-1 truncate text-[15px] font-semibold first-letter:uppercase">{o.label}</span>
              {t ? <span className="shrink-0 text-[15px] tabular-nums text-fg-2">{clockText(t)}</span> : null}
            </button>
          );
        })}
        <div>
          <button type="button" aria-pressed={other} disabled={busy} onClick={() => setOther(true)} className={row(other)}>
            {check(other)}
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{copy.draft.otherTime}</span>
            {!preset && now ? <span className="shrink-0 text-[15px] tabular-nums text-fg-2">{clockText(now)}</span> : null}
          </button>
          {other ? (
            <div data-other-time="" className="flex flex-wrap items-center gap-2 px-4 pt-1 pb-4 sm:flex-nowrap">
              <div className="flex min-w-0 flex-1 basis-full gap-2 sm:flex-none sm:basis-auto">
                {weekly ? (
                  <select aria-label={copy.draft.weekday} disabled={busy} value={day ?? String(now!.weekday)} onChange={(e) => setRaw(`${clock ?? ''} ${e.target.value}`)} className={`${field} flex-1 sm:w-40 sm:flex-none`}>
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </select>
                ) : null}
                <input
                  aria-label={copy.draft.timeOfDay}
                  disabled={busy}
                  type="time"
                  step={300}
                  required
                  value={clock ?? ''}
                  onChange={(e) => setRaw(weekly ? `${e.target.value} ${day ?? now!.weekday}` : e.target.value)}
                  className={`${field} flex-[1.4] sm:w-40 sm:flex-none`}
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full sm:w-auto">
                {copy.draft.done}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The agent says what it will do in one sentence. Each parameter is a highlighted button with its value (and unit); tapping
 * one opens an editor under the sentence. `onEdit` asks the api and answers whether the edit was taken; a refused edit leaves
 * the draft as it was, the editor shows the old value again and the parent shows the plain message.
 */
export function DraftSentence({
  draft,
  onEdit,
  busy = false,
  message,
  initialOpen,
}: {
  draft: DraftData;
  onEdit?: (param: string, value: OptionValue) => Promise<boolean>;
  busy?: boolean;
  message?: string | undefined;
  initialOpen?: string;
}) {
  const [open, setOpen] = useState<string | undefined>(initialOpen);
  const [raw, setRaw] = useState(() => {
    const p = draft.params.find((x) => x.id === initialOpen);
    return p ? startValue(p) : '';
  });
  const [local, setLocal] = useState<string>();
  const param = draft.params.find((p) => p.id === open);

  function openEditor(p: ParamSpec) {
    setLocal(undefined);
    setRaw(startValue(p));
    setOpen(p.id === open ? undefined : p.id);
  }
  const ui = (p: ParamSpec): EditUi => ({ clearMessage: () => setLocal(undefined), close: () => setOpen(undefined), restore: () => setRaw(startValue(p)), setMessage: setLocal });
  const commit = (p: ParamSpec, value: OptionValue) => void applyEdit(onEdit, p, value, ui(p));
  const submit = (p: ParamSpec) => void submitEdit(p, raw, onEdit, ui(p));

  // A unit the sentence writes right after a value sits in that value's pill, so the text after it starts past the unit.
  const textAt = (i: number): string => {
    const seg = draft.sentence[i];
    const prev = draft.sentence[i - 1];
    if (typeof seg !== 'string' || prev === undefined || typeof prev === 'string') return typeof seg === 'string' ? seg : '';
    const p = draft.params.find((x) => x.id === prev.param);
    return p ? pillAndRest(p, seg).rest : seg;
  };

  return (
    <div>
      <p className="break-words text-xl font-semibold leading-[1.55] tracking-[-0.015em] sm:text-2xl">
        {draft.sentence.map((seg, i) => {
          if (typeof seg === 'string') return <span key={i}>{textAt(i)}</span>;
          const p = draft.params.find((x) => x.id === seg.param);
          if (!p) return null;
          const next = draft.sentence[i + 1];
          const shown = pillAndRest(p, typeof next === 'string' ? next : '').pill;
          return (
            <button
              key={i}
              type="button"
              data-param={p.id}
              aria-expanded={open === p.id}
              aria-label={`${p.label}: ${shown}`}
              disabled={busy}
              onClick={() => openEditor(p)}
              className="value-pill"
            >
              {shown}
            </button>
          );
        })}
      </p>
      {param ? (
        <form
          data-editor={param.id}
          noValidate
          className="fade-in mt-4 flex flex-wrap items-center gap-3 rounded-[14px] bg-bg p-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit(param);
          }}
        >
          {/* The segmented choice labels itself; a second group with the same label would be read twice. */}
          <div {...((param.kind === 'choice' && param.options.length <= 4) || param.kind === 'time' ? {} : { role: 'group', 'aria-label': param.label })} className="contents">
            {param.kind === 'time' ? null : (
              <p className="min-w-0 flex-1 basis-48 text-sm text-fg-2">
                {param.kind === 'number' ? copy.draft.range(param.label, rangeText(param)) : param.label}
              </p>
            )}
            {param.kind === 'time' ? (
              <TimeEditor key={param.id} param={param} draft={draft} raw={raw} setRaw={setRaw} busy={busy} commit={(v) => commit(param, v)} />
            ) : param.kind === 'choice' && param.options.length <= 4 ? (
              <div role="group" aria-label={param.label} data-segmented="" className="inline-flex max-w-full flex-wrap gap-1 rounded-[22px] border border-line bg-white p-1">
                {param.options.map((o) => {
                  const on = o.value === param.value;
                  return (
                    <button
                      key={String(o.value)}
                      type="button"
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() => commit(param, o.value)}
                      className={`min-h-11 min-w-0 rounded-full px-4 text-[15px] font-semibold break-words transition-colors duration-150 ${on ? 'bg-fg text-bg' : 'text-fg hover:bg-line'}`}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            ) : param.kind === 'choice' ? (
              <ul className="flex w-full flex-col gap-1">
                {param.options.map((o) => (
                  <li key={String(o.value)}>
                    <label className="flex min-h-11 items-center gap-3 rounded-lg px-2 text-base">
                      <input
                        type="radio"
                        disabled={busy}
                        name={`param-${param.id}`}
                        checked={o.value === param.value}
                        onChange={() => commit(param, o.value)}
                        className="size-5 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 break-words">{o.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : param.kind === 'number' ? (
              <>
                <span data-stepper="" className="inline-flex h-11 items-center rounded-full border border-line bg-white">
                  <button
                    type="button"
                    aria-label={`${copy.draft.less} ${param.label}`}
                    disabled={busy || currentNumber(raw, param) <= param.min}
                    onClick={() => setRaw(stepFrom(raw, -1, param))}
                    className="size-11 rounded-full text-xl disabled:opacity-30"
                  >
                    {'\u2212'}
                  </button>
                  <input
                    aria-label={param.label}
                    disabled={busy}
                    type="number"
                    inputMode="decimal"
                    min={param.min}
                    max={param.max}
                    step="any"
                    value={raw}
                    onChange={(e) => setRaw(e.target.value)}
                    className="h-11 w-16 min-w-0 bg-transparent text-center text-[17px] font-semibold outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    aria-label={`${copy.draft.more} ${param.label}`}
                    disabled={busy || currentNumber(raw, param) >= param.max}
                    onClick={() => setRaw(stepFrom(raw, 1, param))}
                    className="size-11 rounded-full text-xl disabled:opacity-30"
                  >
                    +
                  </button>
                </span>
                <Button type="submit" disabled={busy}>{copy.draft.done}</Button>
              </>
            ) : (
              <>
                <Input aria-label={param.label} disabled={busy} type="text" maxLength={100} value={raw} onChange={(e) => setRaw(e.target.value)} className="min-w-0 flex-1 basis-56" />
                <Button type="submit" disabled={busy}>{copy.draft.done}</Button>
              </>
            )}
          </div>
          {local || message ? (
            <p role="alert" className="basis-full text-sm text-danger">
              {local ?? message}
            </p>
          ) : null}
        </form>
      ) : message ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}
