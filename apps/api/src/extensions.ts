/**
 * The extension point: features a build adds on top of the core. This build adds none. A build that carries more replaces
 * this file; the core only calls the two hooks below, in this order:
 *
 *   1. `bootExtensions` early, before the runtime is built: it owns the kill switch, so an extension may add a stop of its own.
 *   2. `mount` once the app's parts exist: the extra api routes, and work for the leader's recovery tick.
 *
 * A hook that throws aborts the boot (servel keeps the previous version running).
 */
import type { Db } from './db/index.js';
import type { ExtensionLog, Extensions } from './extension-types.js';

export type * from './extension-types.js';

/** The core alone: the kill switch is RUNTIME_KILL_SWITCH=1 (a deploy to lift), no extra routes, nothing on the tick. */
export function bootExtensions(_sql: Db, d: { env: boolean; log: ExtensionLog }): Extensions {
  return {
    killSwitch: { on: d.env, load: async () => undefined, start: () => () => undefined },
    mount: () => ({ routes: () => [], tick: async () => ({}) }),
  };
}
