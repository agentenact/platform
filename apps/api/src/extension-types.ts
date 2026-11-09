/** The shapes of the extension point (extensions.ts). */
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Karma } from './discovery/karma.js';
import type { Route } from './gateway/app.js';

export type ExtensionLog = (e: Record<string, string | number>) => void;

/** The global stop. `on` is read on every use, never cached. */
export interface KillSwitch {
  readonly on: boolean;
  /** Reads any stored state at boot. Fails closed: a failed read throws, so the boot aborts rather than start with the switch off. */
  load(): Promise<void>;
  /** Keeps the value fresh at runtime; returns stop. */
  start(): () => void;
}

export interface MountDeps {
  sql: Db;
  config: Config;
  log: ExtensionLog;
  karma: Karma;
  sponsorPublicKey: string;
  /** Sends one email through the toolbox's delivery. */
  mail: (to: string, subject: string, text: string, idempotencyKey: string) => Promise<unknown>;
  startedAt: Date;
}

export interface Mounted {
  /** Extra api routes, matched after the core routes and before the optional route groups (gateway/app.ts). */
  routes(h: { body<T>(req: Request): Promise<T> }): Route[];
  /** Runs on the leader's recovery tick; its result is logged with the tick's. Must not throw. */
  tick(): Promise<Record<string, unknown>>;
}

export interface Extensions {
  killSwitch: KillSwitch;
  mount(d: MountDeps): Mounted;
}
