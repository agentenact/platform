/**
 * Operator settings: alert thresholds for the api, and limits for the vault.
 *
 * The vault limits can only TIGHTEN what the code allows. Each one has a ceiling in code (the vault's own constant), and the
 * vault clamps whatever the table says to that ceiling (`effectiveVaultLimits`). The api writes the table, so an api that is
 * taken over can at most set every limit back to its ceiling: no worse than before this table existed.
 * Spacing (credit_every_h) works the other way round: a longer wait is tighter, so the code value is a floor.
 *
 * Stored in app.ops_settings as numeric text (alert_email as text). A row that is missing, or unreadable, means the default.
 */
import type { Db } from '../db/index.js';

type Num = { kind: 'number'; min: number; max: number; default: number; step: number; group: 'alert' | 'vault'; label: string; unit: string };
type Text = { kind: 'email'; default: string; group: 'alert'; label: string };

export const SETTINGS = {
  alert_email: { kind: 'email', default: '', group: 'alert', label: 'Alert email' },
  alert_sponsor_xlm: { kind: 'number', min: 0, max: 1_000_000, default: 2000, step: 1, group: 'alert', label: 'Sponsor balance alert below', unit: 'XLM' },
  alert_openrouter_usd: { kind: 'number', min: 0, max: 100_000, default: 20, step: 0.01, group: 'alert', label: 'OpenRouter balance alert below', unit: 'USD' },
  vault_sponsor_day_fee_xlm: { kind: 'number', min: 0, max: 1000, default: 1000, step: 0.1, group: 'vault', label: 'Sponsor fees per UTC day', unit: 'XLM' },
  vault_credits_per_day: { kind: 'number', min: 0, max: 50, default: 50, step: 1, group: 'vault', label: 'Testnet credits per UTC day', unit: 'credits' },
  vault_credit_every_h: { kind: 'number', min: 2, max: 168, default: 2, step: 1, group: 'vault', label: 'Hours between credits to one agent', unit: 'hours' },
  vault_agent_day_usdc: { kind: 'number', min: 0, max: 1, default: 1, step: 0.01, group: 'vault', label: 'Payments per agent per UTC day', unit: 'USDC' },
  vault_seals_per_agent_day: { kind: 'number', min: 0, max: 1000, default: 1000, step: 1, group: 'vault', label: 'Seals per agent per UTC day', unit: 'seals' },
} as const satisfies Record<string, Num | Text>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];
export type Settings = { alert_email: string } & { [K in Exclude<SettingKey, 'alert_email'>]: number };

const EMAIL = /^[^\s@<>,;"]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/i;

export const defaults = (): Settings => Object.fromEntries(SETTING_KEYS.map((k) => [k, SETTINGS[k].default])) as Settings;

/** One stored value, checked: a bad or out-of-range value is null (the caller falls back to the default). */
export function parseSetting(key: SettingKey, raw: unknown): string | number | null {
  const def = SETTINGS[key];
  if (def.kind === 'email') {
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    return v === '' || EMAIL.test(v) ? v.toLowerCase() : null;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,9}(\.\d{1,7})?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < def.min || n > def.max) return null;
  return n;
}

/** Every setting, stored values over defaults. Throws when the table cannot be read; callers decide what that means. */
export async function readSettings(sql: Db): Promise<Settings> {
  const rows = (await sql`select key, value from app.ops_settings`) as { key: string; value: string }[];
  const out = defaults() as Record<string, string | number>;
  for (const r of rows) {
    if (!(SETTING_KEYS as string[]).includes(r.key)) continue;
    const v = parseSetting(r.key as SettingKey, r.value);
    if (v !== null) out[r.key] = v;
  }
  return out as Settings;
}

/** What the vault enforces, in its own units: never looser than its code constants. */
export interface VaultLimits {
  sponsorDayFeeStroops: bigint;
  creditsPerDay: number;
  creditEveryH: number;
  agentDayUnits: bigint;
  sealsPerAgentDay: number;
}

export function effectiveVaultLimits(s: Pick<Settings, 'vault_sponsor_day_fee_xlm' | 'vault_credits_per_day' | 'vault_credit_every_h' | 'vault_agent_day_usdc' | 'vault_seals_per_agent_day'>, ceil: VaultLimits): VaultLimits {
  const units = (n: number) => BigInt(Math.round(n * 1e7));
  const minB = (a: bigint, b: bigint) => (a < b ? a : b);
  return {
    sponsorDayFeeStroops: minB(units(s.vault_sponsor_day_fee_xlm), ceil.sponsorDayFeeStroops),
    creditsPerDay: Math.min(Math.floor(s.vault_credits_per_day), ceil.creditsPerDay),
    creditEveryH: Math.max(s.vault_credit_every_h, ceil.creditEveryH),
    agentDayUnits: minB(units(s.vault_agent_day_usdc), ceil.agentDayUnits),
    sealsPerAgentDay: Math.min(Math.floor(s.vault_seals_per_agent_day), ceil.sealsPerAgentDay),
  };
}
