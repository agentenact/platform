/**
 * Runs untrusted JS (the `compute` tool, condition trigger code) in QuickJS inside a pooled child process
 * (see isolate.ts). The in-runtime 2 s interrupt fires only at interpreter check points, so the host also
 * SIGKILLs the child SANDBOX_HARD_KILL_MS after dispatch. Never throws.
 */
import { runIsolated, type IsolateFault } from './isolate.js';

/** `fault` is `platform` only for the pool's own outcomes (busy, unavailable, ...); see IsolateFault. */
export type SandboxResult = { ok: true; value: unknown } | { ok: false; error: string; fault: IsolateFault };

export const SANDBOX_HARD_KILL_MS = 3_000;

const strict = (_k: string, v: unknown) => {
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') throw new TypeError('bad input');
  return v;
};

export async function runSandboxed(code: string, input: unknown, o: { hardKillMs?: number; params?: Record<string, number | string | boolean> } = {}): Promise<SandboxResult> {
  let inputJson: string | undefined;
  let paramsJson: string | undefined;
  try {
    inputJson = JSON.stringify(input ?? null, strict);
    if (o.params && Object.keys(o.params).length > 0) paramsJson = JSON.stringify(o.params, strict);
  } catch {
    // falls through
  }
  if (typeof inputJson !== 'string' || (o.params && Object.keys(o.params).length > 0 && typeof paramsJson !== 'string') || typeof code !== 'string') return { ok: false, error: 'bad input', fault: 'platform' };
  return runIsolated('js', { code, input: inputJson, ...(paramsJson !== undefined ? { params: paramsJson } : {}) }, o.hardKillMs ?? SANDBOX_HARD_KILL_MS);
}
