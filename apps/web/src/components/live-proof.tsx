'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CapturedProof, EnactmentRecordJson } from '@/lib/proof-types';
import { forge, shorten } from '@/lib/format';
import { formatUsdc } from '@/lib/explore';
import { HashLine } from './hash-line';
import { WalletChain } from './wallet-chain';
import { Seal } from './seal';

type CheckState = 'pending' | 'pass' | 'fail' | 'skipped';
type CheckName = 'signature' | 'settlement' | 'timing' | 'identity';
type Checks = Record<CheckName, CheckState>;

type Phase = 'idle' | 'running' | 'done' | 'error';
type Mode = 'original' | 'tampered';

interface VerifierModule {
  verifyRecord: (input: unknown, adapter: unknown, opts?: { windowSeconds?: number }) => Promise<{
    ok: boolean;
    checks: Checks;
    failure?: { check: string; reason: string };
  }>;
  createStellarAdapter: (opts?: { network?: 'pubnet' | 'testnet' }) => StellarAdapter;
  sha256Hex: (bytes: Uint8Array) => Promise<string>;
}

interface StellarAdapter {
  resolveIdentity(agentId: string): Promise<{ owner: string; wallet: string | null } | null>;
}

const PENDING: Checks = { signature: 'pending', settlement: 'pending', timing: 'pending', identity: 'pending' };

// Long enough for the progress line to travel, so a fast Horizon reply doesn't flash.
const MIN_SWEEP_MS = 1100;
const RETRY_DELAY_MS = 800;
/** How far below the viewport the section may be when the verifier starts downloading. */
export const WARM_MARGIN_PX = 800;

let cachedModule: VerifierModule | null = null;
let cachedAdapter: StellarAdapter | null = null;

export async function loadVerifier(src: string): Promise<VerifierModule> {
  if (cachedModule) return cachedModule;
  // Bare global `Buffer.from(...)` calls inside src/adapters/stellar.ts (Node
  // convention) need a browser polyfill in place before sign/verify run —
  // see site/verifier/README.md.
  const { Buffer } = await import('buffer');
  (globalThis as unknown as { Buffer?: unknown }).Buffer ??= Buffer;

  const url = `${window.location.origin}${src}`;
  // Magic comments stop Next/Turbopack from statically resolving this at
  // build time — it's a public static asset, not part of the module graph.
  const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as VerifierModule;
  cachedModule = mod;
  return mod;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Tampering forges output.sha256 inside the signed record, so the signature check fails for real. */
function recordFor(proof: CapturedProof, mode: Mode): EnactmentRecordJson {
  const record: EnactmentRecordJson = structuredClone(proof.record);
  if (mode === 'tampered') record.output.sha256 = forge(record.output.sha256);
  return record;
}

/** One full verification against the chain. Throws on network or bundle failure; a forged record resolves with ok: false. */
async function verifyOnce(proof: CapturedProof, mode: Mode, verifierSrc: string) {
  const mod = await loadVerifier(verifierSrc);
  cachedAdapter ??= mod.createStellarAdapter({ network: 'testnet' });
  const adapter = cachedAdapter;
  const record = recordFor(proof, mode);
  const agentId = proof.record.agent.agentId;
  const [result, inputHash, outputHash, binding] = await Promise.all([
    mod.verifyRecord(record, adapter, { windowSeconds: 86_400 }),
    mod.sha256Hex(new TextEncoder().encode(proof.input)),
    mod.sha256Hex(new TextEncoder().encode(proof.output)),
    // The owner shown in the chain is read from the registry here, never hard-coded.
    agentId ? adapter.resolveIdentity(agentId).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    result,
    // Same rule as the package's `hire`: all checks pass AND both texts hash to the record.
    consistent: result.ok && !result.failure && inputHash === record.input.sha256 && outputHash === record.output.sha256,
    owner: binding?.owner ?? null,
  };
}

/** `verifierSrc` carries a content hash (see page.tsx), so a CDN's browser TTL can never serve a stale bundle. */
/**
 * `bare`: no page gutter or top spacing of its own, for a page (/verify) that already lays it out. `lead`: content that
 * takes the place of the section's own heading and text, beside the record card (/verify puts its paste field there).
 */
export function LiveProof({ proof, verifierSrc, bare = false, lead }: { proof: CapturedProof; verifierSrc: string; bare?: boolean; lead?: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('original');
  const [checks, setChecks] = useState<Checks>(PENDING);
  const [consistent, setConsistent] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const runId = useRef(0);

  const settled = proof.verification.settlement;
  const amount = `${formatUsdc(settled.amount)} ${settled.asset.split(':')[0]}`;
  const tx = proof.settlement.transaction;

  async function run(nextMode: Mode) {
    const id = ++runId.current;
    setMode(nextMode);
    setPhase('running');
    setChecks(PENDING);
    setErrorDetail(null);
    const started = performance.now();

    try {
      let outcome: Awaited<ReturnType<typeof verifyOnce>>;
      try {
        outcome = await verifyOnce(proof, nextMode, verifierSrc);
      } catch (first) {
        // One automatic retry: a dropped request or a busy testnet RPC should not greet a visitor with an error.
        console.warn('[agentenact] live verification failed once, retrying', first);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        if (id !== runId.current) return;
        outcome = await verifyOnce(proof, nextMode, verifierSrc);
      }
      const { result, consistent, owner } = outcome;

      const wait = prefersReducedMotion() ? 0 : MIN_SWEEP_MS - (performance.now() - started);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (id !== runId.current) return;

      setChecks(result.checks);
      setOwner(owner);
      setConsistent(consistent);
      setPhase('done');
    } catch (err) {
      if (id !== runId.current) return;
      // Surface the real cause: a blocked request, an RPC error and a bad bundle look alike otherwise.
      console.error('[agentenact] live verification failed', err);
      setErrorDetail(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  // The verifier bundle (~1 MB) is fetched only when the section comes near, a
  // screen or so before it shows, so the check can start at once when it does.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        near.disconnect();
        loadVerifier(verifierSrc).catch(() => undefined); // run() reports a failure; this is only a head start
      },
      { rootMargin: `${WARM_MARGIN_PX}px 0px` },
    );
    near.observe(el);
    return () => near.disconnect();
  }, [verifierSrc]);

  // Run once, the first time the section is well into view. run() only reads
  // the static proof, so observing once on mount is intended.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          void run('original');
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows: Array<{ key: CheckName; label: string; detail?: string; passLabel: string }> = [
    { key: 'signature', label: 'Agent signature', detail: shorten(proof.record.agent.address, 5, 5), passLabel: 'Valid' },
    { key: 'settlement', label: 'Payment', detail: `${amount} · Stellar`, passLabel: 'Settled' },
    { key: 'timing', label: 'Timing', passLabel: 'Valid' },
    { key: 'identity', label: 'Owner', detail: proof.record.agent.agentId ? `agent #${proof.record.agent.agentId}` : undefined, passLabel: 'Bound' },
  ];

  const shown = phase === 'done';

  return (
    <section id="verify" ref={sectionRef} className={bare ? undefined : 'px-5'}>
      <div className={`mx-auto grid max-w-6xl gap-14 ${bare ? '' : 'pt-24 '}lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16`}>
        <div className="min-w-0">
          {lead ?? (
            <>
          <p className="eyebrow">Live proof · Stellar testnet</p>
          <h2 className="headline mt-5 text-[clamp(1.75rem,3.2vw,2.5rem)]">
            Don&apos;t trust us.
            <br />
            <em>Check it.</em>
          </h2>
          <p className="mt-6 max-w-md text-[17px] leading-[1.55] text-fg-2">
            A real paid call, verified in your browser against the chain. Two wallets are checked: the agent that signed it, and the owner the
            agent belongs to.
          </p>
            </>
          )}
          {lead ? (
            <p className="mt-12 border-t border-line pt-8 text-[15px] text-fg-2">
              <span className="eyebrow mb-2 block">Live proof · Stellar testnet</span>
              Or watch one: a real paid call on the right, checked in your browser. Tamper with it and the proof fails.
            </p>
          ) : null}

          <p className={`headline ${lead ? 'mt-5' : 'mt-10'} min-h-[1em] text-[clamp(1.5rem,2.4vw,1.875rem)]`} aria-live="polite">
            {phase === 'done' ? (
              consistent ? (
                <span className="settle block">Consistent.</span>
              ) : (
                <span className="settle block text-danger">Invalid.</span>
              )
            ) : phase === 'running' ? (
              <em className="settle block">Checking…</em>
            ) : phase === 'error' ? (
              <span className="block font-sans text-[15px] font-normal tracking-normal text-fg-2">
                Couldn&apos;t reach Stellar testnet. Try again.
                {errorDetail ? <span className="mt-2 block font-mono text-[12px] break-all text-fg-3">{errorDetail.slice(0, 160)}</span> : null}
              </span>
            ) : (
              <em>—</em>
            )}
          </p>
          <div className="mt-5 flex flex-wrap gap-2.5">
            {/* Each button always does one thing: the real record, or the forged one. */}
            <button type="button" className="btn btn-sm" disabled={phase === 'running'} onClick={() => run('original')}>
              Verify again
            </button>
            <button type="button" className="btn btn-sm btn-accent" disabled={phase === 'running'} onClick={() => run('tampered')}>
              Tamper with it
            </button>
          </div>
          {mode === 'tampered' && phase === 'done' ? (
            <p className="mt-4 max-w-md text-[14px] leading-[1.55] text-fg-2">
              One character of the record changed. The signature no longer matches, so the proof fails.
            </p>
          ) : null}
          <p className="mt-10 font-mono text-[12px] text-fg-3">
            tx {shorten(tx, 8, 8)} ·{' '}
            <a href={proof.explorer} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4 hover:text-fg">
              stellar.expert ↗
            </a>
          </p>
        </div>

        {/* The record card, sealed in the corner with the seal of its own output hash. */}
        <div className="card relative min-w-0 p-6 sm:p-8">
          <Seal
            hash={mode === 'tampered' ? forge(proof.record.output.sha256) : proof.record.output.sha256}
            mark={mode === 'tampered' && phase === 'done' ? 'var(--danger)' : 'var(--raised)'}
            className="absolute -top-8 -right-3 size-[68px] sm:-top-9 sm:-right-6 sm:size-[80px]"
          />
          <WalletChain
            running={phase === 'running'}
            signature={shown ? checks.signature : 'pending'}
            identity={shown ? checks.identity : 'pending'}
            agent={proof.record.agent.address}
            agentId={proof.record.agent.agentId}
            owner={owner}
          />

          <div className="mt-12" aria-busy={phase === 'running'}>
            <div className="flex items-baseline justify-between gap-4 py-3.5 text-[14px]">
              <span>
                Signed record
                <span className="ml-3 hidden font-mono text-[11px] text-fg-3 sm:inline">output.sha256</span>
              </span>
              <HashLine value={mode === 'tampered' ? forge(proof.record.output.sha256) : proof.record.output.sha256} baseline={proof.record.output.sha256} />
            </div>
            {rows.map((row, i) => {
              const state = checks[row.key];
              const value = state === 'pass' ? row.passLabel : state === 'fail' ? 'Invalid' : '—';
              const tone = state === 'fail' ? 'text-danger' : state === 'pass' ? 'text-fg-2' : 'text-fg-3';
              return (
                <div key={row.key} className="flex items-baseline justify-between gap-4 border-t border-line py-3.5 text-[14px]">
                  <span>
                    {row.label}
                    {row.detail ? <span className="ml-3 font-mono text-[11px] text-fg-3">{row.detail}</span> : null}
                  </span>
                  {shown ? (
                    <span className={`resolve ${tone}`} style={{ animationDelay: `${i * 70}ms` }}>
                      {value}
                    </span>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </div>
              );
            })}
          </div>
          {/* One hairline under the rows: it advances while the chain is read and completes when the answer lands. */}
          <div aria-hidden className="mt-1 h-px bg-line">
            <div className="progress h-full" data-phase={phase} data-ok={phase === 'done' ? consistent : undefined} />
          </div>
        </div>
      </div>
    </section>
  );
}
