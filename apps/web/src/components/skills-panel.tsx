'use client';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { approveSkillAction, removeSkillAction, reviewSkillAction, setOfferSkillsAction, suggestSkillsAction } from '@/app/actions/skills';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { ago } from '@/lib/agent-format';
import { MAX_OFFER_SKILLS, needsRisk, toggledSkills, type SkillOut, type SkillReviewShown, type SkillsHeld, type SkillSuggestions } from '@/lib/skills';
import { Loading } from '@/components/seal-loader';
import { AddToSet, AgentSkillSets } from '@/components/skill-sets';

export type SuggestState = { phase: 'loading' } | { phase: 'ready'; data: SkillSuggestions } | { phase: 'failed'; message: string };
export type OpenState =
  | null
  | { id: string; phase: 'loading' }
  | { id: string; phase: 'failed'; message: string }
  | { id: string; phase: 'ready'; review: SkillReviewShown; acceptRisk: boolean };

export interface SkillsUi {
  version: number;
  suggest: SuggestState;
  query: string;
  open: OpenState;
  /** 'add', the name of the skill being removed, or `offer:<slug>` while an offer's skills are saved. */
  busy: string | null;
  message: string | null;
  note: string | null;
}

export const initialSkillsUi = (version: number): SkillsUi => ({ version, suggest: { phase: 'loading' }, query: '', open: null, busy: null, message: null, note: null });

export interface SkillsHandlers {
  onQuery?: (q: string) => void;
  onSearch?: () => void;
  onLook?: (id: string) => void;
  /** The pointer rests on, or focus reaches, "See its checks": start reading them so the click finds them ready. */
  onPeek?: (id: string) => void;
  onUnpeek?: () => void;
  /** The checks dialog closes: Esc, the backdrop, or its close button. */
  onClose?: () => void;
  onAcceptRisk?: (v: boolean) => void;
  onAdd?: () => void;
  onRemove?: (name: string) => void;
  onOffer?: (slug: string, name: string, on: boolean) => void;
}

const VERDICT_TONE: Record<string, string> = { clear: 'text-proven', caution: 'text-fg', blocked: 'text-accent-ink', unaudited: 'text-accent-ink' };

const VERDICT_DOT: Record<string, string> = { clear: 'bg-proven', caution: 'bg-fg-2', blocked: 'bg-accent', unaudited: 'bg-accent' };

/**
 * One skill's checks: one verdict line with a one-line summary under it, and the way to add it. Everything behind the verdict
 * (each checker's words, what we noticed, the files it will not use, the instructions themselves) folds into "See the details".
 * The dialog passes its own title so the name labels it; alone (tests) the name is a plain heading. `actions` sit beside "Add this skill".
 */
export function SkillChecks({
  r,
  ui,
  on,
  title,
  actions,
}: {
  r: SkillReviewShown;
  ui: SkillsUi & { open: { phase: 'ready' } };
  on: SkillsHandlers;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  const c = copy.skills;
  const risky = needsRisk(r.verdict);
  const canAdd = r.fits && (!risky || ui.open.acceptRisk) && ui.busy === null;
  const passed = r.audits.filter((a) => a.status === 'pass').length;
  return (
    <div data-review={r.id} data-verdict={r.verdict}>
      {title ?? <h2 className="pr-10 text-lg font-semibold break-words">{r.name}</h2>}
      <p className="mt-1 line-clamp-3 text-sm break-words text-fg-2">{r.description}</p>

      <div className="mt-4 flex items-start gap-3 rounded-xl bg-line/40 px-4 py-3" data-verdict-line="">
        <span aria-hidden="true" className={`mt-[7px] inline-block size-2.5 shrink-0 rounded-full ${VERDICT_DOT[r.verdict]}`} />
        <div className="min-w-0">
          <p className={`text-[15px] font-semibold ${VERDICT_TONE[r.verdict]}`}>{c.verdict[r.verdict]}</p>
          <p className="mt-0.5 text-sm text-fg-2" data-verdict-summary="">
            {c.summary(passed, r.audits.length, r.findings.length)}
          </p>
        </div>
      </div>

      {ui.message ? (
        <p role="alert" data-skills-message="" className="mt-4 text-sm text-accent-ink">
          {ui.message}
        </p>
      ) : null}

      {r.fits ? (
        <div className="mt-4">
          {risky ? (
            <label className="mb-3 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={ui.open.acceptRisk} onChange={(e) => on.onAcceptRisk?.(e.target.checked)} data-accept-risk="" />
              <span>{c.acceptRisk}</span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" disabled={!canAdd} busy={ui.busy === 'add'} onClick={on.onAdd} data-add="">
              {ui.busy === 'add' ? c.adding : c.add}
            </Button>
            {actions}
          </div>
          <p className="mt-2 text-xs text-fg-3">{c.pinned}</p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-accent-ink" data-too-long="">
          {c.tooLong}
        </p>
      )}

      <details className="mt-5 border-t border-line pt-4" data-details="">
        <summary className="cursor-pointer text-sm font-medium text-fg-2 hover:text-fg">{c.details}</summary>

        <h4 className="mt-4 text-sm font-semibold">{c.auditsTitle}</h4>
        {r.audits.length === 0 ? (
          <p className="mt-1 text-sm text-fg-2">{c.noAudits}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {r.audits.map((a) => (
              <li key={a.provider} data-audit={a.status} className="text-sm">
                <span className="font-medium">{a.provider}</span> · {c.auditStatus[a.status]}
                {a.riskLevel ? ` · ${c.risk(a.riskLevel)}` : ''}
                {a.summary ? <span className="block break-words text-fg-2">{a.summary}</span> : null}
              </li>
            ))}
          </ul>
        )}

        <h4 className="mt-4 text-sm font-semibold">{c.oursTitle}</h4>
        {r.findings.length === 0 ? (
          <p className="mt-1 text-sm text-fg-2">{c.oursNone}</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {r.findings.map((f, i) => (
              <li key={`${f.code}-${f.path}-${i}`} data-finding={f.code} className="text-sm break-words">
                {c.finding[f.code]} <span className="text-fg-3">({f.path})</span>
              </li>
            ))}
          </ul>
        )}

        {r.unused.length > 0 ? (
          <>
            <h4 className="mt-4 text-sm font-semibold">{c.unusedTitle}</h4>
            <p className="mt-1 text-sm break-words text-fg-2" data-unused="">
              {r.unused.join(', ')}
            </p>
          </>
        ) : null}

        <details className="mt-4" data-advanced="">
          <summary className="cursor-pointer text-sm font-medium">{c.instructionsTitle}</summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-line/40 p-3 text-xs whitespace-pre-wrap break-words">{r.instructions}</pre>
          <dl className="mt-2 text-xs text-fg-3">
            <dt>{copy.advanced.skillCommit}</dt>
            <dd className="break-all">{r.commit}</dd>
            <dt className="mt-1">{copy.advanced.skillContentHash}</dt>
            <dd className="break-all">{r.contentHash}</dd>
          </dl>
        </details>
      </details>
    </div>
  );
}

/**
 * The checks over the list, which stays as it was underneath: a centred dialog, a bottom sheet on a phone. Radix traps focus
 * and closes on Esc or the backdrop; on close focus goes back to the row's "See its checks", or to the search when the skill
 * was just added and its row is gone.
 */
function SkillChecksDialog({ ui, on, actions }: { ui: SkillsUi; on: SkillsHandlers; actions?: ChecksActions | undefined }) {
  const open = ui.open?.phase === 'ready' ? (ui as SkillsUi & { open: { phase: 'ready' } }) : null;
  const lastId = useRef<string | null>(null);
  if (open) lastId.current = open.open.id;
  return (
    <DialogPrimitive.Root open={open !== null} onOpenChange={(v) => (v ? undefined : on.onClose?.())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            const back =
              document.querySelector<HTMLElement>(`[data-look="${CSS.escape(lastId.current ?? '')}"]`) ?? document.querySelector<HTMLElement>('[data-query]');
            if (!back) return;
            e.preventDefault();
            back.focus({ preventScroll: true });
          }}
          data-checks-dialog=""
          className="card fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto p-7 shadow-[0_40px_80px_-24px_rgb(0_0_0/0.7)] outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[22px] max-sm:rounded-b-none max-sm:px-5 max-sm:pb-[calc(1.75rem+env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:w-[min(640px,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[22px]"
        >
          <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded bg-[var(--raised-line)] sm:hidden" />
          {open ? (
            <SkillChecks
              r={open.open.review}
              ui={open}
              on={on}
              title={<DialogPrimitive.Title className="pr-10 text-lg font-semibold break-words">{open.open.review.name}</DialogPrimitive.Title>}
              actions={actions?.(open.open.review, open.open.acceptRisk)}
            />
          ) : null}
          <DialogPrimitive.Close
            aria-label={copy.skills.close}
            className="absolute top-3.5 right-3.5 grid h-11 w-11 place-items-center rounded-full text-xl text-fg-2 hover:text-fg"
          >
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** More ways to keep a reviewed skill, beside "Add this skill" (skill sets: AddToSet). */
export type ChecksActions = (r: SkillReviewShown, acceptRisk: boolean) => ReactNode;

/**
 * The Skills tab for a given state, as markup, so every state can be rendered and scanned without a browser. `sets` sits
 * between the agent's skills and the search (skill sets: AgentSkillSets); `checksActions` goes into a skill's checks.
 */
export function SkillsView({ held, ui, now, on = {}, sets, checksActions }: { held: SkillsHeld; ui: SkillsUi; now: number; on?: SkillsHandlers; sets?: ReactNode; checksActions?: ChecksActions }) {
  const c = copy.skills;
  const open = ui.open;
  return (
    <div data-skills="">
      <p className="mt-2 text-sm text-fg-2">{c.intro}</p>

      {ui.note ? (
        <p role="status" data-skills-note="" className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm font-medium text-proven">
          {ui.note}
        </p>
      ) : null}
      {ui.message && open?.phase !== 'ready' ? (
        <p role="alert" data-skills-message="" className="mt-4 text-sm text-accent-ink">
          {ui.message}
        </p>
      ) : null}

      <section className="mt-5" data-held="">
        <h2 className="eyebrow">{c.heldTitle}</h2>
        {held.skills.length === 0 ? (
          <p className="card mt-2 text-sm text-fg-2">{c.none}</p>
        ) : (
          <ul className="card mt-2 divide-y divide-line !p-0">
            {held.skills.map((s) => (
              <li key={s.name} data-skill={s.name} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-6">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium break-words">{s.name}</p>
                  <p className="break-words text-fg-2">{s.description}</p>
                  <p className="mt-1 text-xs break-words text-fg-3">
                    {s.source ? `${c.fromSkillsSh(s.source.id)} · ${c.approvedOn(ago(s.source.approvedAt, now))}` : c.ownSkill}
                  </p>
                  {s.source?.edited ? (
                    <p className="mt-1 text-xs text-accent-ink" data-edited="">
                      {c.edited}
                    </p>
                  ) : null}
                  {s.source && !s.source.edited && held.offers.length > 0 ? (
                    <fieldset className="mt-3" data-offers={s.name}>
                      <legend className="text-xs font-semibold text-fg-2">{c.offersTitle}</legend>
                      {held.offers.map((o) => {
                        const picked = o.skills.includes(s.name);
                        const full = !picked && o.skills.length >= MAX_OFFER_SKILLS;
                        return (
                          <label key={o.slug} className="mt-1 flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={picked}
                              disabled={full || ui.busy !== null}
                              onChange={(e) => on.onOffer?.(o.slug, s.name, e.target.checked)}
                              data-offer={o.slug}
                            />
                            <span className="min-w-0 break-words">
                              {o.description}
                              {full ? <span className="text-fg-3"> · {c.offerFull}</span> : null}
                              {ui.busy === `offer:${o.slug}` ? <span className="text-fg-3"> · {c.offerSaving}</span> : null}
                            </span>
                          </label>
                        );
                      })}
                      <p className="mt-1 text-xs text-fg-3">{c.offersNote}</p>
                    </fieldset>
                  ) : null}
                </div>
                <Button type="button" variant="quiet" disabled={ui.busy !== null} busy={ui.busy === s.name} onClick={() => on.onRemove?.(s.name)} data-remove={s.name}>
                  {ui.busy === s.name ? c.removing : c.remove}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {sets}

      <section className="mt-6" data-find="">
        <h2 className="eyebrow">{c.findTitle}</h2>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            on.onSearch?.();
          }}
        >
          <Input aria-label={c.searchLabel} placeholder={c.searchPlaceholder} maxLength={60} value={ui.query} onChange={(e) => on.onQuery?.(e.target.value)} data-query="" />
          <Button type="submit" variant="quiet" busy={ui.suggest.phase === 'loading'} data-search="">
            {ui.suggest.phase === 'loading' ? c.searching : c.search}
          </Button>
        </form>
        {open?.phase === 'failed' ? (
          <p role="alert" className="mt-3 text-sm text-accent-ink" data-review-failed="">
            {open.message}
          </p>
        ) : null}
        {ui.suggest.phase === 'loading' ? (
          <p className="mt-3 text-sm text-fg-2">
            <Loading label={c.searching} />
          </p>
        ) : ui.suggest.phase === 'failed' ? (
          <p role="alert" className="mt-3 text-sm text-accent-ink" data-suggest-failed="">
            {ui.suggest.message}
          </p>
        ) : ui.suggest.data.suggestions.length === 0 ? (
          <p className="card mt-3 text-sm text-fg-2" data-none-found="">
            {c.noneFound}
          </p>
        ) : (
          <ul className="card mt-3 divide-y divide-line !p-0">
            {ui.suggest.data.suggestions.map((s) => (
              <li key={s.id} data-suggestion={s.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 text-sm sm:px-6">
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium break-words">{s.name}</p>
                  <p className="text-xs break-words text-fg-3">
                    {c.by(s.source)} · {c.installs(s.installs)} ·{' '}
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                      {c.onSkillsSh}
                    </a>
                  </p>
                </div>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={open?.phase === 'loading'}
                  busy={open?.phase === 'loading' && open.id === s.id}
                  onClick={() => on.onLook?.(s.id)}
                  onPointerEnter={() => on.onPeek?.(s.id)}
                  onPointerLeave={() => on.onUnpeek?.()}
                  onFocus={() => on.onPeek?.(s.id)}
                  data-look={s.id}
                >
                  {open?.phase === 'loading' && open.id === s.id ? c.reading : c.look}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SkillChecksDialog ui={ui} on={on} actions={checksActions} />
    </div>
  );
}

export interface SkillsCalls {
  suggest: (q?: string) => Promise<SkillOut<SkillSuggestions>>;
  review: (id: string) => Promise<SkillOut<SkillReviewShown>>;
  approve: (a: { id: string; commit: string; contentHash: string; version: number; acceptRisk: boolean }) => Promise<SkillOut<{ version: number }>>;
  remove: (name: string, version: number) => Promise<SkillOut<{ version: number }>>;
  setOffer: (slug: string, names: string[], version: number) => Promise<SkillOut<{ version: number }>>;
}

const serverCalls = (agentId: string): SkillsCalls => ({
  suggest: (q) => suggestSkillsAction(agentId, q),
  review: (id) => reviewSkillAction(id),
  approve: (a) => approveSkillAction(agentId, a),
  remove: (name, version) => removeSkillAction(agentId, name, version),
  setOffer: (slug, names, version) => setOfferSkillsAction(agentId, slug, names, version),
});

const safely = async <T,>(p: () => Promise<SkillOut<T>>): Promise<SkillOut<T>> => {
  try {
    return await p();
  } catch {
    return { ok: false, message: copy.errors.generic };
  }
};

/**
 * The Skills tab. Suggestions are asked for once on open (and on each search); "See its checks" reads one skill's review;
 * "Add this skill" sends back exactly the commit and fingerprint the owner saw, with the description version the page
 * showed. The server re-reads that commit and refuses anything that differs. A blocked or unaudited skill needs the tick.
 */
export function SkillsPanel({ agentId, held, now, calls }: { agentId: string; held: SkillsHeld; now: number; calls?: SkillsCalls }) {
  const api = useRef(calls ?? serverCalls(agentId)).current;
  const [ui, setUi] = useState<SkillsUi>(() => initialSkillsUi(held.version));
  const patch = (p: Partial<SkillsUi>) => setUi((u) => ({ ...u, ...p }));

  // The page re-renders with fresh data after a write; its version is the one to send next.
  useEffect(() => setUi((u) => (held.version > u.version ? { ...u, version: held.version } : u)), [held.version]);

  // Each skill's checks are read once per visit, whether a hover started the read or the click did; a failed read is forgotten.
  const reviews = useRef(new Map<string, Promise<SkillOut<SkillReviewShown>>>()).current;
  const readReview = (id: string) => {
    let p = reviews.get(id);
    if (!p) {
      p = safely(() => api.review(id)).then((r) => (r.ok || reviews.delete(id), r));
      reviews.set(id, p);
    }
    return p;
  };
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unpeek = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  useEffect(() => unpeek, []);

  const search = (q?: string) => {
    patch({ suggest: { phase: 'loading' } });
    void safely(() => api.suggest(q)).then((r) => patch({ suggest: r.ok ? { phase: 'ready', data: r.data } : { phase: 'failed', message: r.message } }));
  };
  useEffect(() => search(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SkillsView
      held={held}
      ui={ui}
      now={now}
      sets={<AgentSkillSets agentId={agentId} version={ui.version} canCopy={held.skills.some((k) => k.source !== null && !k.source.edited)} />}
      checksActions={(r, acceptRisk) => <AddToSet r={r} acceptRisk={acceptRisk} />}
      on={{
        onQuery: (q) => patch({ query: q }),
        onSearch: () => search(ui.query.trim() || undefined),
        // A short rest, not a pass over the list: moving the pointer down the rows reads nothing.
        onPeek: (id) => {
          unpeek();
          peekTimer.current = setTimeout(() => void readReview(id), 150);
        },
        onUnpeek: unpeek,
        onLook: (id) => {
          unpeek();
          patch({ open: { id, phase: 'loading' }, message: null, note: null });
          void readReview(id).then((r) =>
            setUi((u) => (u.open?.id !== id ? u : { ...u, open: r.ok ? { id, phase: 'ready', review: r.data, acceptRisk: false } : { id, phase: 'failed', message: r.message } })),
          );
        },
        onClose: () => patch({ open: null, message: null }),
        onAcceptRisk: (v) => setUi((u) => (u.open?.phase === 'ready' ? { ...u, open: { ...u.open, acceptRisk: v } } : u)),
        onAdd: () => {
          const o = ui.open;
          if (o?.phase !== 'ready' || ui.busy !== null) return;
          const r = o.review;
          patch({ busy: 'add', message: null, note: null });
          void safely(() => api.approve({ id: r.id, commit: r.commit, contentHash: r.contentHash, version: ui.version, acceptRisk: o.acceptRisk })).then((out) => {
            if (!out.ok) return patch({ busy: null, message: out.message });
            setUi((u) => ({
              ...u,
              busy: null,
              open: null,
              version: out.data.version,
              note: copy.skills.added(r.name),
              suggest: u.suggest.phase === 'ready' ? { phase: 'ready', data: { ...u.suggest.data, suggestions: u.suggest.data.suggestions.filter((s) => s.id !== r.id) } } : u.suggest,
            }));
          });
        },
        onOffer: (slug, name, want) => {
          const offer = held.offers.find((o) => o.slug === slug);
          const names = offer ? toggledSkills(offer, name, want) : null;
          if (!names || ui.busy !== null) return;
          patch({ busy: `offer:${slug}`, message: null, note: null });
          void safely(() => api.setOffer(slug, names, ui.version)).then((out) =>
            out.ok ? patch({ busy: null, version: out.data.version }) : patch({ busy: null, message: out.message }),
          );
        },
        onRemove: (name) => {
          if (ui.busy !== null) return;
          patch({ busy: name, message: null, note: null });
          void safely(() => api.remove(name, ui.version)).then((out) =>
            out.ok ? patch({ busy: null, version: out.data.version, note: copy.skills.removed(name) }) : patch({ busy: null, message: out.message }),
          );
        },
      }}
    />
  );
}
