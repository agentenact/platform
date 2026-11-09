'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPacer } from '@/lib/pace';
import { START_STEPS, type Steps, type StepsRecord } from './verify-steps';
import { parseVerifyParams, recordUrl, verifySearch, type Pasted } from '@/lib/verify-params';
import { getJson } from '@/lib/explore';
import { checkRecord, type VerifierModule } from '@/lib/verify-record';
import { AppLink } from '@/components/app-link';
import { VerifyView, type ShownRecord, type VerifyState } from './verify-view';
import { VerifyStart } from './verify-start';
import { LiveProof, loadVerifier } from './live-proof';
import { SealView } from './verify-seal-view';
import { agentByWallet, isSeal, readTx } from '@/lib/verify-seal';
import type { CapturedProof } from '@/lib/proof-types';

/** How long each step stays before the next one lands, and how long the finished list holds before the result. */
const STEP_GAP_MS = 750;
const RESULT_HOLD_MS = 900;

const apiAnswers = (): Promise<boolean> =>
  getJson('/public/stats').then(
    () => true,
    () => false,
  );

const NOTICE: Partial<Record<VerifyState['phase'], string>> = {
  bad_link: "That link doesn't point to a proof.",
  not_found: "We can't find a proof for this. A transaction hash finds only records shared publicly; for a hosted agent's proof, paste the link from its page.",
  no_tx: "Stellar testnet has no transaction with this hash. It may be on another network, or older than the testnet's last reset.",
};

/** No record shared for this hash: what the chain says about it. A seal names its agent when the public api knows it. */
async function fromChain(hash: string): Promise<Exclude<VerifyState, { phase: 'done' | 'loading' | 'checking' }>> {
  const tx = await readTx(hash);
  if (!tx) return { phase: 'no_tx' };
  if (!isSeal(tx)) return { phase: 'chain_tx', tx };
  return { phase: 'seal', tx, agentId: await agentByWallet(tx.source) };
}

/**
 * Reads the target from the address bar, fetches the record by status only, then runs the package's verifier. The
 * verifier bundle is fetched alongside the record, not after it, since this page always needs it. With no target the
 * page asks for one: a pasted link becomes the address (so it can be shared), a pasted record is checked in place.
 */
function VerifyFromBar({ verifierSrc, sample }: { verifierSrc: string; sample: CapturedProof }) {
  const search = useSearchParams().toString();
  const router = useRouter();
  const [state, setState] = useState<VerifyState>({ phase: 'loading' });

  const runId = useRef(0);
  const check = useCallback(
    async (get: () => Promise<ShownRecord | Exclude<VerifyState, { phase: 'done' | 'loading' | 'checking' }> | 'not_found' | 'error'>) => {
      const id = ++runId.current;
      const live = () => id === runId.current;
      // Each step gets a moment on screen even when the network answers at once; none with less motion.
      const still = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const pacer = createPacer(still ? 0 : STEP_GAP_MS);
      let steps: Steps = { ...START_STEPS };
      let shown: StepsRecord | null = null;
      // Only real changes take a turn on screen: the verdict repeats states the progress already showed.
      let target: Steps = { ...steps };
      const show = (patch: Partial<Steps>) => {
        if (Object.entries(patch).every(([k, v]) => target[k as keyof Steps] === v)) return;
        target = { ...target, ...patch };
        pacer.push(() => {
          steps = { ...steps, ...patch };
          if (live()) setState({ phase: 'checking', steps, record: shown });
        });
      };
      setState({ phase: 'checking', steps, record: null });
      const verifier = loadVerifier(verifierSrc);
      verifier.catch(() => undefined); // awaited below; a failure there is the same error screen
      try {
        const record = await get();
        if (!live()) return;
        if (typeof record === 'string') return setState({ phase: record });
        if ('phase' in record) return setState(record);
        shown = record;
        show({ record: 'pass' });
        const mod = (await verifier) as unknown as VerifierModule;
        const result = await checkRecord(record, mod, { onStep: (e) => show({ [e.step]: e.state }) });
        // The verifier's own verdict is what stays: every step ends as it says, whatever the progress showed.
        for (const k of ['signature', 'settlement', 'timing', 'identity'] as const) show({ [k]: result.checks[k] });
        await pacer.idle();
        if (!still) await new Promise((r) => setTimeout(r, RESULT_HOLD_MS));
        if (live()) setState({ phase: 'done', record, result });
      } catch {
        if (live()) setState({ phase: 'error' });
      }
    },
    [verifierSrc],
  );

  const run = useCallback(async () => {
    if (search === '') return setState({ phase: 'empty' });
    const target = parseVerifyParams(search);
    if (!target) return setState({ phase: 'bad_link' });
    await check(async () => {
      let res: Response;
      try {
        res = await fetch(recordUrl(target), { headers: { accept: 'application/json' } });
      } catch (e) {
        // The api's 404 reaches the browser as an html page without CORS headers, so an unknown public ref fails like a
        // network error. If the api answers otherwise, it was a missing record, not a dead network.
        if (target.kind !== 'hosted' && (await apiAnswers())) return target.kind === 'tx' ? fromChain(target.tx) : 'not_found';
        throw e;
      }
      if (res.status === 404) return target.kind === 'tx' ? fromChain(target.tx) : 'not_found';
      if (!res.ok) return 'error';
      return (await res.json()) as ShownRecord;
    });
  }, [search, check]);

  useEffect(() => {
    void run();
  }, [run]);

  const onPasted = (p: Exclude<Pasted, { kind: 'invalid' | 'signature' }>) => {
    if (p.kind === 'record') return void check(async () => p.record);
    const next = verifySearch(p.target);
    if (next === `?${search}`) void run();
    else router.push(`/verify${next}`, { scroll: false });
  };

  if (state.phase === 'seal') return <SealView key={search} tx={state.tx} agentId={state.agentId} />;
  if (state.phase === 'empty' || state.phase === 'bad_link' || state.phase === 'not_found' || state.phase === 'no_tx') {
    // A hash we hold no record for may still be a real transaction (a check seal from an email, a plain payment).
    const target = state.phase === 'not_found' ? parseVerifyParams(search) : null;
    const tx = target?.kind === 'public' ? target.ref : target?.kind === 'tx' ? target.tx : null;
    const form = <VerifyStart key={search} notice={NOTICE[state.phase]} tx={tx} onPasted={onPasted} />;
    // Arriving with no link: your own check beside a real proof checking itself. With a link that did not open, the
    // field and why come first, the demo below.
    return state.phase === 'empty' ? (
      <div className="mt-12">
        <LiveProof proof={sample} verifierSrc={verifierSrc} bare lead={form} />
      </div>
    ) : (
      <>
        <div className="mt-10">{form}</div>
        <div className="mt-24">
          <LiveProof proof={sample} verifierSrc={verifierSrc} bare />
        </div>
      </>
    );
  }
  return (
    <>
      <VerifyView state={state} onRetry={() => void run()} />
      {state.phase === 'done' ? (
        <p className="mt-12 text-[14px]">
          <AppLink href="/verify" className="text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
            Check another proof
          </AppLink>
        </p>
      ) : null}
    </>
  );
}

/** The page is static; the record to check comes from the query, read in the browser (and again when a link changes it). */
export function VerifyRecord({ verifierSrc, sample }: { verifierSrc: string; sample: CapturedProof }) {
  return (
    <Suspense fallback={<VerifyView state={{ phase: 'loading' }} onRetry={() => undefined} />}>
      <VerifyFromBar verifierSrc={verifierSrc} sample={sample} />
    </Suspense>
  );
}
