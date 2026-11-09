/** Runs the package's own verifier on a fetched record (the same calls as the home page's live proof). */
export type CheckName = 'signature' | 'settlement' | 'timing' | 'identity';
export type CheckState = 'pass' | 'fail' | 'skipped';

export interface VerifierModule {
  verifyRecord: (input: unknown, adapter: unknown, opts?: { windowSeconds?: number }) => Promise<{
    ok: boolean;
    checks: Record<CheckName, CheckState>;
    failure?: { check: string; reason: string };
  }>;
  createStellarAdapter: (opts?: { network?: 'pubnet' | 'testnet' }) => { resolveIdentity(agentId: string): Promise<{ owner: string; wallet: string | null } | null> };
}

export interface CheckResult {
  ok: boolean;
  checks: Record<CheckName, CheckState>;
  failure?: { check: string; reason: string };
  /** The agent's owner read from the registry now; null when unknown (never invented). */
  owner: string | null;
}

/** Long enough for a slow Horizon and RPC, short enough that a dead network shows Try again instead of an endless check. */
export const CHECK_TIMEOUT_MS = 30_000;

/** A check starting or ending, as the verifier reaches it (its adapter calls run in order: signature, payment, owner). */
export interface StepEvent {
  step: CheckName;
  state: 'running' | CheckState;
}

export async function checkRecord(
  record: unknown,
  mod: VerifierModule,
  o: { timeoutMs?: number; onStep?: (e: StepEvent) => void } = {},
): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), o.timeoutMs ?? CHECK_TIMEOUT_MS)));
  try {
    return await Promise.race([check(record, mod, o.onStep ?? (() => undefined)), late]);
  } finally {
    clearTimeout(timer);
  }
}

type Fn = (...a: unknown[]) => Promise<unknown>;

/**
 * The adapter the verifier calls, watched: each call marks where the verifier is, so the page can show the checks as they
 * happen. Only progress comes from here; the states shown at the end are the verifier's own result.
 */
export function watchAdapter<A extends object>(adapter: A, emit: (e: StepEvent) => void): A {
  const a = adapter as unknown as Record<string, Fn>;
  const wrap = (name: string, before: () => void, after: (v: unknown) => void): Fn | undefined =>
    typeof a[name] === 'function'
      ? async (...args) => {
          before();
          const v = await a[name]!(...args);
          after(v);
          return v;
        }
      : undefined;
  const w: Record<string, unknown> = { ...a };
  const verify = wrap('verify', () => emit({ step: 'signature', state: 'running' }), (ok) => emit({ step: 'signature', state: ok ? 'pass' : 'fail' }));
  const settle = wrap('readSettlement', () => emit({ step: 'settlement', state: 'running' }), (p) => {
    const found = Array.isArray(p) && p.length > 0;
    emit({ step: 'settlement', state: found ? 'pass' : 'fail' });
    if (found) emit({ step: 'timing', state: 'running' });
  });
  // The verifier checks timing in memory between the payment and the owner, and stops at a failed one: reaching the owner
  // means timing passed.
  const owner = wrap('resolveIdentity', () => (emit({ step: 'timing', state: 'pass' }), emit({ step: 'identity', state: 'running' })), (b) => emit({ step: 'identity', state: b ? 'pass' : 'fail' }));
  if (verify) w.verify = verify;
  if (settle) w.readSettlement = settle;
  if (owner) w.resolveIdentity = owner;
  return w as unknown as A;
}

async function check(record: unknown, mod: VerifierModule, emit: (e: StepEvent) => void): Promise<CheckResult> {
  const adapter = mod.createStellarAdapter({ network: 'testnet' });
  const agentId = (record as { agent?: { agentId?: unknown } } | null)?.agent?.agentId;
  const [result, owner] = await Promise.all([
    mod.verifyRecord(record, watchAdapter(adapter, emit), { windowSeconds: 86_400 }),
    typeof agentId === 'string' ? adapter.resolveIdentity(agentId).then((b) => b?.owner ?? null, () => null) : Promise.resolve(null),
  ]);
  // Verified means every check that applies passed: a skipped signature, payment or timing never counts, and the owner
  // check may be skipped only when the record names no agent id (a library agent without an identity).
  const core = (['signature', 'settlement', 'timing'] as const).every((k) => result.checks[k] === 'pass');
  const identity = typeof agentId === 'string' ? result.checks.identity === 'pass' : result.checks.identity !== 'fail';
  const ok = result.ok && !result.failure && core && identity;
  return { ok, checks: result.checks, ...(result.failure ? { failure: result.failure } : {}), owner };
}
