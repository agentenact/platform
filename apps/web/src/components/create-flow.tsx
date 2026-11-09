'use client';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { localTimeZone, withTimeZone } from '@/lib/time-zone';
import { agentAction, createAgentAction, meAction, passkeyOptionsAction, passkeyRegisterAction, rejectAction, retryAction, signAction, signRequestsAction, walletAction } from '@/app/actions/create';
import { StepRing } from '@/components/step-ring';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { browserApprovalStore } from '@/lib/approval-store';
import { agentHref } from '@/lib/agent-href';
import { creationKey, forgetCreationKey, sessionStore } from '@/lib/creation-key';
import { initialCreateUi, reduceCreation, runCreation, type CreateUiState, type CreationDeps, type CreationStep } from '@/lib/creation';
import type { DraftData } from '@/lib/draft-types';
import { PUBLIC } from '@/lib/public-config';
import { scheduleArrival } from '@/lib/arrival';
import { onceAnswer } from '@/lib/once-answer';
import type { ConfirmAnswer, OwnerWallet } from '@/lib/signing-flow';

export interface ConfirmAsk {
  kind: 'register' | 'bind';
  summary: string;
  /** Answers this very question, once. A button rendered for an earlier question can never answer a later one. */
  answer?: (answer: ConfirmAnswer) => void;
}

const STEP_IDS: CreationStep[] = ['account_key', 'identity', 'ready'];

const STEP_KIND: Record<ConfirmAsk['kind'], CreationStep> = { register: 'identity', bind: 'ready' };

/**
 * The whole flow as markup for a given state, so every state can be rendered and scanned without a browser. The active step carries
 * its own action: pressing "Approve" answers the pending question with yes (that press is the user gesture the passkey prompt needs).
 * It sits inside a card the caller provides.
 */
export function CreateFlowView({
  ui,
  name,
  ask,
  onAnswer,
  onSetup,
  onRetry,
  onOpen,
  now,
}: {
  ui: CreateUiState;
  name: string;
  ask?: ConfirmAsk | undefined;
  onAnswer?: (answer: ConfirmAnswer) => void;
  /** The press on "Set up your account key": it starts the passkey prompt itself, inside the click. */
  onSetup?: () => void;
  onRetry?: () => void;
  onOpen?: () => void;
  /** Epoch ms for the time-left line; the page passes a ticking value, tests a fixed one. */
  now?: number;
}) {
  const c = copy.create;
  if (ui.done)
    return (
      <section data-create="flow" data-ready="" aria-live="polite" className="fade-in py-6 text-center sm:py-10">
        <div aria-hidden="true" className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-fg text-3xl text-bg">
          ✓
        </div>
        <h2 role="status" className="headline mt-5 break-words text-[28px]">
          {c.ready(name)}
        </h2>
        <p className="mt-2 text-[15px] text-fg-2">{c.readyLine}</p>
        <Button type="button" size="lg" onClick={onOpen} className="mt-6">
          {c.open}
        </Button>
      </section>
    );
  const failure = ui.failure;
  const say = (a: ConfirmAnswer) => (ask?.answer ?? onAnswer)?.(a);
  // Once the flow has failed (an expired approval, say) the question is gone: nothing is left to press.
  const open = failure ? undefined : ask;
  const asked = open ? STEP_KIND[open.kind] : undefined;
  // Step 1 asks with a button of its own, once the account and the passkey options are in hand (see runCreation).
  const setup = !failure && !open && ui.steps.account_key === 'asking';
  return (
    <section data-create="flow" aria-live="polite">
      <p className="eyebrow break-words">{c.eyebrow(name)}</p>
      <h2 className="headline mt-2 text-[28px]">{c.heading}</h2>
      <ol className="mt-5 grid gap-2">
        {STEP_IDS.map((id, i) => {
          const active = id === asked || (id === 'account_key' && setup);
          const step = ui.steps[id];
          // After a failure nothing is in progress: a step left mid-way reads as not started.
          const state = active ? 'asking' : failure && (step === 'asking' || step === 'working') ? 'idle' : step;
          const text = c.steps[i]!;
          return (
            <li
              key={id}
              data-step={id}
              data-state={state}
              data-active={active ? '' : undefined}
              className={`flex gap-3.5 rounded-[14px] border p-3.5 ${active ? 'border-accent-ink shadow-[inset_0_0_0_1px_var(--accent-ink)]' : 'border-line'}`}
            >
              <StepRing state={state} n={i + 1} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] font-semibold">{text.title}</span>
                  {state === 'working' || state === 'asking' || state === 'done' ? (
                    <span className={`shrink-0 text-[13px] ${active ? 'font-semibold text-accent-ink' : 'text-fg-2'}`}>{c.stepState[state]}</span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-sm text-fg-2">{text.line}</p>
                {id === 'account_key' && setup ? (
                  <div className="mt-3">
                    {ui.lastHiccup ? (
                      <p role="status" data-hiccup="" className="mb-2 text-sm text-fg">
                        {c.setUpAgain}
                      </p>
                    ) : null}
                    <Button type="button" size="lg" data-setup="" autoFocus onClick={onSetup}>
                      {c.setUp}
                    </Button>
                    {ui.lastHiccup ? (
                      <details data-advanced="" className="mt-1 text-sm">
                        <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-3">{c.confirm.details}</summary>
                        <p className="mt-1 break-words font-mono text-xs">{c.lastTry(ui.lastHiccup)}</p>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {active && open ? (
                  <div className="mt-3">
                    {ui.lastHiccup ? (
                      <p role="status" data-hiccup="" className="mb-2 text-sm text-fg">
                        {c.pressAgain}
                      </p>
                    ) : null}
                    {ui.approveBy !== undefined && now !== undefined ? (
                      <p data-time-left="" className="mb-2 text-[13px] text-fg-2">
                        {c.approveWithin(ui.approveBy - now)}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Button type="button" size="lg" data-answer="yes" autoFocus onClick={() => say('yes')}>
                        {c.confirm.yes}
                      </Button>
                      <button type="button" data-answer="later" onClick={() => say('later')} className="inline-flex min-h-11 items-center text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
                        {c.confirm.no}
                      </button>
                    </div>
                    <details data-advanced="" className="mt-1 text-sm">
                      <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-3">{c.confirm.details}</summary>
                      <p className="mt-1 break-words font-mono text-xs">{open.summary}</p>
                      {ui.lastHiccup ? <p className="mt-1 break-words font-mono text-xs">{c.lastTry(ui.lastHiccup)}</p> : null}
                    </details>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      {failure ? (
        <div className="mt-4">
          <p role="alert" data-failure={failure.failed}>
            {c.failed[failure.failed]}
          </p>
          {failure.detail ? (
            <details data-advanced="" className="mt-1 text-sm">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-fg-3">{c.confirm.details}</summary>
              <p data-failure-detail="" className="mt-1 break-words font-mono text-xs">{failure.detail}</p>
            </details>
          ) : null}
          {failure.retryable ? (
            <Button type="button" onClick={onRetry} className="mt-3">
              {c.tryAgain}
            </Button>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <button type="button" data-answer="stop" onClick={() => say('stop')} className="mt-3 inline-flex min-h-11 items-center text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg">
          {c.confirm.stop}
        </button>
      ) : null}
      <p className="mt-3 text-sm text-fg-2">{c.fine}</p>
    </section>
  );
}

type Doors = Pick<CreationDeps, 'api' | 'startRegistration' | 'connectWallet' | 'signing'>;

/**
 * The real doors: server actions for the api, the browser for WebAuthn and storage. The heavy SDKs load before the flow starts,
 * all of them, so that nothing is imported between a press and the passkey prompt (Safari drops the press across an await).
 */
async function realDoors(confirm: (kind: 'register' | 'bind', summary: string) => Promise<ConfirmAnswer>): Promise<Doors> {
  const [{ rpc }, { startRegistration }, { connectOwnerWallet }] = await Promise.all([
    import('@stellar/stellar-sdk'),
    import('@simplewebauthn/browser'),
    import('@/mirror/owner-client/wallet'),
  ]);
  const need = <T,>(r: { ok: true } & T | { ok: false }) => {
    if (!r.ok) throw new Error('api');
    return r;
  };
  return {
    api: {
      me: meAction,
      passkeyOptions: passkeyOptionsAction,
      passkeyRegister: passkeyRegisterAction,
      wallet: walletAction,
      // A draft's schedules get the person's own time zone here, the moment it becomes an agent.
      createAgent: (input) => createAgentAction({ ...input, spec: withTimeZone(input.spec, localTimeZone()) }),
      agent: agentAction,
      retry: retryAction,
    },
    // No await before the browser call: it runs inside the press.
    startRegistration: (optionsJSON) => startRegistration({ optionsJSON: optionsJSON as never }),
    connectWallet: async (w): Promise<OwnerWallet> => connectOwnerWallet({ rpId: PUBLIC.rpId, origin: window.location.origin, rpcUrl: PUBLIC.sorobanRpc }, w),
    signing: {
      listPending: async () => need(await signRequestsAction()).requests,
      post: async (id, xdr) => {
        const r = await signAction(id, xdr);
        // Keep the api's status and code on the error: the gate keeps its register approval unless the api said entry_mismatch.
        if (!r.ok) throw Object.assign(new Error('api'), { status: r.status, code: r.code });
      },
      reject: async (id) => void need(await rejectAction(id)),
      rpc: new rpc.Server(PUBLIC.sorobanRpc),
      confirm,
      store: browserApprovalStore(),
      uriPrefix: PUBLIC.uriPrefix,
    },
  };
}

/**
 * The three taps. It starts when it mounts (the visitor has just pressed "Create this agent"): it fetches what each tap needs
 * and shows each tap in one plain sentence. Every passkey prompt starts inside a press on the active step's own button (never from
 * an effect or after a network wait: Safari refuses those), and the gate's question is answered by that same button, not a dialog.
 * `doors` is for tests; the page uses the real ones.
 */
export function CreateFlow({
  draft,
  doors,
  navigate,
  resume,
  skillSet,
}: {
  draft: DraftData;
  doors?: Doors;
  /** Where "ready" goes; default: the new agent's own page. */
  navigate?: (agentId: string) => void;
  /** An agent already being created (its own page joins the flow): follow it, create nothing. */
  resume?: string;
  /** One of the owner's skill sets ("Start with a skill set"): the new agent starts with its skills. */
  skillSet?: { id: string; revision: number } | null;
}): ReactNode {
  const open = navigate ?? ((agentId: string) => window.location.assign(agentHref(agentId)));
  const made = useRef<string | undefined>(resume);
  const arrival = useRef<(() => void) | undefined>(undefined);
  const [ui, dispatch] = useReducer(reduceCreation, initialCreateUi);
  const [ask, setAsk] = useState<ConfirmAsk | undefined>();
  const answer = useRef<((a: ConfirmAnswer) => void) | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const unmounted = useRef(false);
  const running = useRef(false);
  const pressed = useRef<(() => void) | undefined>(undefined);

  // Step 1 waits here for the press on its button.
  const awaitPress = () =>
    new Promise<void>((resolve) => {
      pressed.current = () => {
        pressed.current = undefined;
        resolve();
      };
    });

  const confirm = (kind: 'register' | 'bind', summary: string) =>
    new Promise<ConfirmAnswer>((resolve) => {
      // The visitor already left: nothing may wait on a dialog that is gone, and the passkey must not be asked.
      if (unmounted.current) return resolve('later');
      const settle = onceAnswer<ConfirmAnswer>((a) => {
        if (answer.current === settle) answer.current = undefined;
        setAsk(undefined);
        resolve(a);
      });
      answer.current = settle;
      setAsk({ kind, summary, answer: settle });
    });

  async function run(): Promise<void> {
    if (running.current) return;
    running.current = true;
    dispatch({ reset: true });
    try {
      const d = doors ?? (await realDoors(confirm));
      const view = { sentence: draft.sentence, params: draft.params, bindings: draft.bindings };
      const input = { name: draft.name.trim(), spec: draft.spec, view };
      const signing = doors ? { ...d.signing, confirm } : d.signing;
      for await (const e of runCreation({
        // The key names this draft's creation; the set rides along without changing it.
        input: { ...input, key: creationKey(input, sessionStore()), ...(skillSet ? { skillSet } : {}) },
        ...(resume ? { resume } : {}),
        ...d,
        awaitPress,
        signing,
        // A left run ends at its next wait instead of polling on, so it releases its sign lock.
        sleep: (ms) => (unmounted.current ? Promise.reject(new Error('left')) : new Promise((r) => setTimeout(r, ms))),
        after: (ms) => {
          let id: ReturnType<typeof setTimeout> | undefined;
          const done = new Promise<void>((r) => (id = setTimeout(r, ms)));
          return { done, cancel: () => clearTimeout(id) };
        },
        now: () => Date.now(),
      })) {
        if (unmounted.current) break; // the visitor left: stop polling
        dispatch(e);
        // A failure (an expired approval, say) takes the question away: the stale Approve button must not stay.
        if ('failed' in e) answer.current?.('later');
        // A moment of arrival ("<name> is ready"), then the agent page opens by itself; "Open my agent" does it at once.
        if ('done' in e) {
          made.current = e.done.agentId;
          forgetCreationKey(sessionStore());
          arrival.current = scheduleArrival(() => open(e.done.agentId));
        }
      }
    } catch (e) {
      // The class name only: a thrown server action or a failed chunk load reads as such under Technical details.
      if (!unmounted.current) dispatch({ failed: 'unknown', retryable: true, detail: `client: ${e instanceof Error ? e.name : typeof e}` });
    } finally {
      running.current = false;
    }
  }

  // The time-left line moves about every 20 s while a question is open; no seconds countdown.
  useEffect(() => {
    if (!ask) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, [ask]);

  useEffect(() => {
    void run();
    return () => {
      unmounted.current = true;
      arrival.current?.();
      answer.current?.('later'); // an open dialog must not leave the run waiting forever
    };
    // Runs once on mount; the ref keeps React's development double-run from starting two creations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <CreateFlowView
      ui={ui}
      name={draft.name.trim()}
      ask={ask}
      now={now}
      onSetup={() => pressed.current?.()}
      onRetry={() => void run()}
      onOpen={() => {
        arrival.current?.();
        if (made.current) open(made.current);
      }}
    />
  );
}
