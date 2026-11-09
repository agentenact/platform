/**
 * Reschedule from the agent's header: one new time, end to end. It is the "What it does" screen's two steps in one: the
 * knob edit (the api rewrites the stored sentence and spec with the new time), then save-and-approve of exactly what came
 * back, with the person's own time zone on the schedule. No React, so it is testable on its own.
 */
import { copy } from '@/copy';
import { asDraft, type DraftData, type TimeParam } from './draft-types';
import { draftWithTimeZone } from './time-zone';

export type RescheduleOut = { ok: true } | { ok: false; message: string };

export interface RescheduleCalls {
  tap(param: string, value: string): Promise<{ ok: true; draft: unknown } | { ok: false; message: string }>;
  save(draft: DraftData): Promise<{ ok: boolean; message?: string }>;
}

/** The schedule's time knobs, in sentence order. Empty for an agent that watches a condition instead of a clock. */
export const timeParams = (d: DraftData | null | undefined): TimeParam[] => (d ? d.params.filter((p): p is TimeParam => p.kind === 'time') : []);

/** An IANA zone name as the browser gives it ("Europe/Istanbul", "UTC"); anything else is no zone (the api keeps UTC). */
export const okZone = (tz: unknown): string | undefined =>
  typeof tz === 'string' && tz.length <= 64 && /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) ? tz : undefined;

/** Taken only when both calls answered ok; a refused tap saves nothing. Never throws. */
export async function reschedule(c: RescheduleCalls, param: string, value: string, tz: string | undefined): Promise<RescheduleOut> {
  const failed = copy.agent.reschedule.failed;
  try {
    const t = await c.tap(param, value);
    if (!t.ok) return { ok: false, message: t.message };
    const d = asDraft(t.draft);
    if (!d) return { ok: false, message: failed };
    const s = await c.save(draftWithTimeZone(d, tz));
    return s.ok ? { ok: true } : { ok: false, message: s.message ?? failed };
  } catch {
    return { ok: false, message: failed };
  }
}
