/**
 * The person's time zone. A schedule reads in the zone stored on its cron trigger (`tz`); a draft has none yet, so the
 * panel fills the browser's zone on create and on save. A schedule stored before zones existed has none and runs in UTC
 * until its next save. No React, so every step is testable on its own.
 */
import type { DraftData } from './draft-types';

/** The browser's IANA zone ("Europe/Istanbul"), or undefined when it gives none. */
export function localTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 ? tz : undefined;
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The spec with `tz` set on every cron trigger that has none. A copy; a spec not shaped like one comes back unchanged. */
export function withTimeZone<T>(spec: T, tz: string | undefined): T {
  if (!tz || !isObj(spec) || !Array.isArray(spec.triggers)) return spec;
  const triggers = spec.triggers.map((t) => (isObj(t) && t.kind === 'cron' && t.tz === undefined ? { ...t, tz } : t));
  return { ...spec, triggers } as T;
}

/** The draft with its spec's schedules in `tz` (see withTimeZone). */
export const draftWithTimeZone = (d: DraftData, tz: string | undefined): DraftData => ({ ...d, spec: withTimeZone(d.spec, tz) });

/** The zone a time parameter reads in: its schedule's stored zone, else the one it will get (the browser's). */
export function zoneFor(d: DraftData, param: string, local: string | undefined): string | undefined {
  const path = d.bindings.find((b) => b.param === param && /^\/triggers\/\d+\/cron$/.test(b.path))?.path;
  const t = path && Array.isArray(d.spec.triggers) ? d.spec.triggers[Number(path.split('/')[2])] : undefined;
  return isObj(t) && typeof t.tz === 'string' ? t.tz : local;
}

/** A zone as a person names it: "Istanbul", "New York", "UTC". */
export const zonePlace = (tz: string): string => (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
