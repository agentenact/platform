'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { claimAction, draftAction, editAction, templateAction, trialAction } from '@/app/actions/builder';
import { Advanced } from '@/components/advanced';
import { agentHref } from '@/lib/agent-href';
import { SetPicker } from '@/components/skill-sets';
import { CreateFlow } from '@/components/create-flow';
import { DraftWaitLine } from '@/components/draft-wait-line';
import { DraftSentence } from '@/components/draft-sentence';
import { FlowSteps, type FlowStep } from '@/components/flow-steps';
import { SignInCard } from '@/components/sign-in';
import { TrialPanel } from '@/components/trial-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { bannedWord } from '@/lib/words';
import { createDraftController, type DraftActions } from '@/lib/draft-controller';
import { COMMUNITY_TEMPLATE_ID, draftReducer, initialState, saveStored, shouldSave, type DraftState, type SpecPatch } from '@/lib/draft-state';
import type { ActionResult, DraftData, OptionValue } from '@/lib/draft-types';
import type { Values } from '@/lib/template-values';
import { SealLoader } from '@/components/seal-loader';

export type { DraftActions };
const serverActions: DraftActions = {
  draft: (p) => draftAction(p) as Promise<ActionResult<{ draft: unknown }>>,
  edit: (d, p, v) => editAction(d, p, v) as Promise<ActionResult<{ draft: unknown }>>,
  trial: (s) => trialAction(s) as Promise<ActionResult<{ trial: unknown }>>,
  claim: (id) => claimAction(id) as Promise<ActionResult<{ draft: unknown }>>,
  template: (id) => templateAction(id) as Promise<ActionResult<{ draft: unknown }>>,
};

/** The real creation flow: three taps on the owner's device. */

export interface DraftHandlers {
  onTry?: () => void;
  onCreate?: () => void;
  /** Where the "ready" moment leads: the new agent's page. */
  onOpen?: (agentId: string) => void;
  onBack?: () => void;
  onRetry?: () => void;
  onShow?: () => void;
  onStartOver?: () => void;
  onRename?: (name: string) => void;
  onEdit?: (param: string, value: OptionValue) => Promise<boolean>;
  onSpec?: (patch: SpecPatch) => void;
}

const link = 'inline-flex min-h-11 items-center whitespace-nowrap text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg';

/** Steps above, one white card below (P0-3, P2-7: the card fades in on each state). */
function Frame({ at, children, below, bar }: { at: FlowStep; children: ReactNode; below?: ReactNode; bar?: ReactNode }) {
  return (
    <div>
      <FlowSteps at={at} />
      <section data-card="" className="card fade-in" aria-live="polite">
        {children}
      </section>
      {/* The fixed bar comes before the details in the DOM, so keyboard and screen-reader users reach Create first. */}
      {bar}
      {below}
      {bar ? <div aria-hidden="true" className="h-[calc(7.25rem+env(safe-area-inset-bottom))] sm:hidden" /> : null}
    </div>
  );
}

/** The card's header row: the agent's name with Rename on the left, the way back to a new idea on the right. */
function NameRow({ name, onRename, onStartOver }: { name: string; onRename?: ((name: string) => void) | undefined; onStartOver?: (() => void) | undefined }) {
  const [editing, setEditing] = useState(false);
  const c = copy.draft;
  const shown = editing || name.trim() === '';
  const tooTechnical = bannedWord(name) !== null;
  return (
    <>
    <div className="flex items-center justify-between gap-3">
      {shown ? (
        <Input
          id="draft-name"
          aria-label={c.nameLabel}
          value={name}
          maxLength={64}
          autoFocus={editing}
          onChange={(e) => onRename?.(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setEditing(false);
          }}
          className="h-11 min-w-0 flex-1"
        />
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1 font-display text-base font-semibold tracking-[-0.01em]">
          <span className="min-w-0 break-words">{name}</span>
          <button type="button" aria-label={`${c.rename} ${name}`} onClick={() => setEditing(true)} className="inline-flex min-h-11 items-center px-2 font-sans text-xs font-normal text-fg-3 hover:text-fg">
            {c.rename}
          </button>
        </span>
      )}
      <button type="button" onClick={onStartOver} className={link}>
        {c.newIdea}
      </button>
    </div>
    {tooTechnical ? (
      <p role="alert" data-name-error="" className="mt-2 text-sm text-danger">
        {c.nameTooTechnical}
      </p>
    ) : null}
    </>
  );
}

type Primary = { kind: 'create'; disabled: boolean } | { kind: 'add'; href: string } | { kind: 'finish' };

/** The two actions. The card shows them from `sm` up; the sticky bar shows them below it (same buttons, never both on screen). */
function ActionButtons({ primary, trying, onTry, onCreate, size }: { primary: Primary; trying: boolean; onTry?: (() => void) | undefined; onCreate?: (() => void) | undefined; size: 'lg' | 'full' }) {
  const c = copy.draft;
  const full = size === 'full' ? 'w-full' : '';
  return (
    <>
      {primary.kind === 'finish' ? (
        <a data-finish-agent="" data-variant="primary" href="/dashboard" className={`btn justify-center ${full}`}>
          {`${c.finishAgent} `}
          <span aria-hidden="true">→</span>
        </a>
      ) : primary.kind === 'add' ? (
        <a data-add-to-agent="" data-variant="primary" href={primary.href} className={`btn justify-center ${full}`}>
          {`${c.addToAgent} `}
          <span aria-hidden="true">→</span>
        </a>
      ) : (
        <Button type="button" size="lg" disabled={primary.disabled} onClick={onCreate} className={full}>
          {c.create}
          <span aria-hidden="true">→</span>
        </Button>
      )}
      <Button type="button" variant="quiet" size="lg" busy={trying} onClick={onTry} className={full}>
        {trying ? c.trying : c.tryFirst}
      </Button>
    </>
  );
}

/** The whole screen as markup for a given state, so every state can be rendered and scanned without a browser. */
export function DraftFlowView({
  state,
  signedIn,
  on = {},
  createFlow,
  full = false,
  unfinished = false,
  hasAgents = false,
  community = false,
  setPicker,
  skillSet,
}: {
  state: DraftState;
  /** "Start with a skill set" (skill-sets.tsx SetPicker), for an owner who already has agents. */
  setPicker?: ReactNode;
  /** The set picked there: creation starts the agent with it. */
  skillSet?: { id: string; revision: number } | null;
  signedIn: boolean;
  /** The plan came from a community template: say plainly that nobody here wrote or reviewed it. */
  community?: boolean;
  /** A signed-in owner at their account's agent limit: this can only become a new description for one of their agents. */
  full?: boolean;
  /** Full, and an agent's creation never finished: the primary action resumes it at /dashboard instead of adding to it. */
  unfinished?: boolean;
  /** The owner already has agents (under the limit): creating stays first, adding to one of them is offered beside it. */
  hasAgents?: boolean;
  on?: DraftHandlers;
  createFlow?: (p: { draft: DraftData }) => ReactNode;
}) {
  const c = copy.draft;
  switch (state.phase) {
    case 'booting':
    case 'empty':
      return null;
    case 'drafting':
      // No prompt means a parked draft is being opened, not written.
      return (
        <Frame at="describe">
          {state.prompt ? (
            <>
              <p className="eyebrow">{c.youAsked}</p>
              <p className="mt-2 break-words text-xl font-semibold tracking-[-0.015em]">{`"${state.prompt}"`}</p>
            </>
          ) : null}
          <div data-progress="" className={`progress ${state.prompt ? 'mt-5' : ''}`} aria-hidden="true">
            <i />
          </div>
          {state.prompt ? (
            <DraftWaitLine />
          ) : (
            <p role="status" className="mt-4 flex items-center gap-2.5 text-[15px] text-fg-2">
              <SealLoader size={18} className="text-accent" />
              {c.opening}
            </p>
          )}
        </Frame>
      );
    case 'waiting':
      return (
        <Frame at="describe">
          <h1 className="headline text-2xl">{c.waitingTitle}</h1>
          <p className="mb-4 mt-1 text-fg-2">{signedIn ? c.waitingNote : c.waitingSignIn}</p>
          {signedIn ? (
            <Button type="button" size="lg" onClick={on.onShow}>
              {c.showDraft}
            </Button>
          ) : (
            <div className="border-t border-line pt-5">
              <SignInCard {...(state.handoff ? { handoff: state.handoff } : {})} />
            </div>
          )}
        </Frame>
      );
    case 'limit':
      return (
        <Frame at="describe">
          <h1 className="headline text-2xl">{c.signInToKeepDrafting}</h1>
          <p className="mb-4 mt-1 text-fg-2">{c.limitNote}</p>
          <div className="border-t border-line pt-5">
            <SignInCard prompt={state.prompt} />
          </div>
          {state.prompt ? <p className="mt-3 text-sm text-fg-3">{c.kept}</p> : null}
        </Frame>
      );
    case 'failed':
      return (
        <Frame at="describe">
          <p role="alert" className="text-lg font-semibold tracking-[-0.01em]">
            {state.message ?? copy.errors.generic}
          </p>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            {state.failKind !== 'daily' && state.prompt ? (
              <Button type="button" size="lg" onClick={on.onRetry}>
                {c.tryAgain}
              </Button>
            ) : null}
            <Button type="button" variant="quiet" size="lg" onClick={on.onStartOver}>
              {c.startOver}
            </Button>
          </div>
        </Frame>
      );
    case 'ready': {
      const d = state.draft;
      if (!d) return null;
      const trying = state.trial.status === 'running';
      // Signed out, "Create this agent" turns the whole card into the sign-in step: no sentence, no Try.
      if (state.creating && !signedIn && !full)
        return (
          <Frame at="create">
            <div data-create="sign-in">
              <SignInCard draft={d} prompt={state.prompt} create={{ name: d.name, onBack: on.onBack }} />
            </div>
          </Frame>
        );
      // Creating: the card holds only the three taps. No sentence to edit, no Try, no Advanced, no way back to a stale copy.
      if (state.creating && signedIn && !full)
        return (
          <Frame at="create">
            {createFlow ? createFlow({ draft: d }) : <CreateFlow draft={d} skillSet={skillSet ?? null} {...(on.onOpen ? { navigate: on.onOpen } : {})} />}
          </Frame>
        );
      const primary: Primary = full
        ? unfinished
          ? { kind: 'finish' }
          : { kind: 'add', href: state.prompt ? `/dashboard?prompt=${encodeURIComponent(state.prompt)}` : '/dashboard' }
        : { kind: 'create', disabled: d.name.trim() === '' || bannedWord(d.name) !== null };
      const at: FlowStep = state.creating || state.trial.status === 'done' ? 'create' : 'try';
      const buttons = (size: 'lg' | 'full') => <ActionButtons primary={primary} trying={trying} onTry={on.onTry} onCreate={on.onCreate} size={size} />;
      return (
        <Frame
          at={at}
          below={<Advanced draft={d} {...(on.onSpec ? { onChange: on.onSpec } : {})} />}
          bar={
            state.creating ? null : (
              <div
                data-sticky=""
                className="fixed inset-x-0 bottom-0 z-30 grid gap-2 border-t border-line bg-bg/95 px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur sm:hidden"
              >
                {buttons('full')}
              </div>
            )
          }
        >
          <NameRow name={d.name} onRename={on.onRename} onStartOver={on.onStartOver} />
          {community ? (
            <p data-community="" className="mt-4 rounded-xl border border-line bg-bg px-3.5 py-2.5 text-sm text-fg-2">
              {c.communityNote}
            </p>
          ) : null}
          <p className="mt-4 text-sm text-fg-2">{c.caption}</p>
          <div className="mt-2">
            <DraftSentence draft={d} busy={state.edit.busy} message={state.edit.message} {...(on.onEdit ? { onEdit: on.onEdit } : {})} />
          </div>
          {state.edit.signIn ? (
            <div className="mt-5 border-t border-line pt-5">
              <p className="headline text-xl">{c.signInToKeepDrafting}</p>
              <div className="mt-3">
                <SignInCard draft={d} prompt={state.prompt} />
              </div>
            </div>
          ) : null}
          {hasAgents && signedIn && !full && !state.creating ? setPicker : null}
          {state.askCreate && signedIn && !full && !state.creating ? (
            <p data-ask-create="" className="mt-5 text-[15px] font-medium">
              {c.pressCreate}
            </p>
          ) : null}
          <div data-actions="" className="mt-6 hidden flex-wrap items-center gap-2.5 sm:flex">
            {buttons('lg')}
          </div>
          {state.creating ? null : <p className="mt-4 text-sm text-fg-2">{full ? (unfinished ? c.finishNote : c.fullNote) : signedIn ? c.fineSignedIn : c.fineSignedOut}</p>}
          {hasAgents && !full && !state.creating ? (
            <a data-add-to-agent="" href={state.prompt ? `/dashboard?prompt=${encodeURIComponent(state.prompt)}` : '/dashboard'} className="mt-2 inline-flex min-h-11 items-center text-sm text-fg-2 underline underline-offset-4 hover:text-fg">
              {c.addToOne}
            </a>
          ) : null}
          <TrialPanel trial={state.trial} draft={d} onRetry={on.onTry} />
        </Frame>
      );
    }
  }
}

/**
 * The draft screen. Client part of /draft: it keeps this tab's draft in sessionStorage, drafts from the prompt the page read
 * from the address, opens a parked draft on its own when the visitor is signed in (the claim needs their browser session, which a mail scanner never has), and talks to
 * the api through server actions. 5xx bodies never reach it (Traefik replaces them), so failures show generic copy.
 */
export function DraftFlow({
  prompt,
  handoff,
  template,
  values,
  intent,
  signedIn,
  full,
  unfinished,
  hasAgents,
  actions = serverActions,
  createFlow,
}: {
  prompt?: string | undefined;
  handoff?: string | undefined;
  /** An agent template id (`?template=`): its ready draft opens without a model call. */
  template?: string | undefined;
  /** The builder's values for that template (`p.<param>=`), applied with the same edit a tap makes. */
  values?: Values | undefined;
  /** "create": the visitor signed in from "Create this agent", so open creation as soon as the draft is back. */
  intent?: 'create' | undefined;
  signedIn: boolean;
  full?: boolean;
  unfinished?: boolean;
  hasAgents?: boolean;
  actions?: DraftActions;
  createFlow?: (p: { draft: DraftData }) => ReactNode;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(draftReducer, initialState);
  const [skillSet, setSkillSet] = useState<{ id: string; revision: number } | null>(null);
  const started = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctl = useMemo(
    () => createDraftController(actions, { getState: () => stateRef.current, dispatch, getWindow: () => window, replace: (u) => router.replace(u) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [actions],
  );

  // Runs once on arrival. The ref keeps React's development double-run from paying for two drafts.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // An owner at the agent limit adds to an agent instead, so creation is never opened for them.
    ctl.boot({ prompt, handoff, template, values, signedIn, intent: full ? undefined : intent, home: full || hasAgents ? '/dashboard' : '/' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep this tab's copy current (sessionStorage only; a reload resumes, nothing leaves the tab).
  useEffect(() => {
    if (shouldSave(state)) saveStored({ prompt: state.prompt, draft: state.draft });
  }, [state.phase, state.prompt, state.draft]);

  const on: DraftHandlers = {
    onShow: () => void ctl.onShow(),
    onRetry: () => void ctl.onRetry(),
    onStartOver: ctl.onStartOver,
    onRename: ctl.onRename,
    onSpec: ctl.onSpec,
    onEdit: ctl.onEdit,
    onTry: () => void ctl.onTry(),
    onCreate: ctl.onCreate,
    onOpen: (agentId) => router.push(agentHref(agentId)),
    onBack: ctl.onBack,
  };

  const community = template !== undefined && COMMUNITY_TEMPLATE_ID.test(template);
  const picker = hasAgents && signedIn && !full ? <SetPicker value={skillSet} onChange={setSkillSet} /> : null;
  return <DraftFlowView state={state} signedIn={signedIn} on={on} setPicker={picker} skillSet={skillSet} {...(community ? { community } : {})} {...(full ? { full } : {})} {...(unfinished ? { unfinished } : {})} {...(hasAgents ? { hasAgents } : {})} {...(createFlow ? { createFlow } : {})} />;
}

