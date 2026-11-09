import { describe, expect, test } from 'bun:test';
import { applyParam } from '../../api/src/builder/params';
import { dailyDigest, weeklyRecap } from '../../api/src/builder/examples';
import { coerceValue } from '../src/lib/template-values';
import { localTimeZone, withTimeZone, zoneFor, zonePlace } from '../src/lib/time-zone';
import type { DraftData } from '../src/lib/draft-types';

describe('time zones', () => {
  test('the browser gives a zone', () => {
    expect(typeof localTimeZone()).toBe('string');
  });
  test('withTimeZone fills only cron triggers without one, and leaves odd shapes alone', () => {
    const spec = { triggers: [{ kind: 'cron', cron: '0 8 * * *', mission: 'm' }, { kind: 'cron', cron: '0 9 * * *', tz: 'UTC', mission: 'm' }, { kind: 'condition', every_s: 300 }] };
    expect(withTimeZone(spec, 'Europe/Istanbul').triggers).toEqual([{ kind: 'cron', cron: '0 8 * * *', mission: 'm', tz: 'Europe/Istanbul' }, spec.triggers[1], spec.triggers[2]]);
    expect(spec.triggers[0]).not.toHaveProperty('tz');
    expect(withTimeZone(spec, undefined)).toBe(spec);
    expect(withTimeZone('x', 'UTC')).toBe('x');
  });
  test('zoneFor reads the stored zone, else the local one', () => {
    const d = dailyDigest() as unknown as DraftData;
    expect(zoneFor(d, 'when', 'Europe/Istanbul')).toBe('Europe/Istanbul');
    expect(zoneFor({ ...d, spec: withTimeZone(d.spec, 'Asia/Tokyo') }, 'when', 'Europe/Istanbul')).toBe('Asia/Tokyo');
    expect(zonePlace('America/New_York')).toBe('New York');
  });
});

describe('a time value from a link matches the api', () => {
  test('coerceValue takes what applyParam takes, in the same form', () => {
    for (const [draft, raw] of [
      [dailyDigest(), '05 09 * * *'],
      [dailyDigest(), '0 9 * * 1'],
      [dailyDigest(), '*/5 * * * *'],
      [weeklyRecap(), '15 9 * * 2'],
      [weeklyRecap(), '15 9 * * *'],
    ] as const) {
      const p = draft.params.find((x) => x.id === 'when')!;
      const web = coerceValue(p as never, raw);
      const api = applyParam(draft, 'when', raw);
      expect(web === null).toBe(!api.ok);
      if (api.ok) expect(web).toBe(api.draft.params.find((x) => x.id === 'when')!.value);
    }
  });
});
