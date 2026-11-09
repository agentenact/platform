'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { reviewSkillAction, searchSkillsAction } from '@/app/actions/skills';
import {
  addToSkillSetAction,
  agentSkillSetsAction,
  applySkillSetAction,
  approvedSkillsAction,
  createSkillSetAction,
  createSkillSetWithAction,
  listSkillSetsAction,
  removeFromSkillSetAction,
  removeSkillSetAction,
  renameSkillSetAction,
} from '@/app/actions/skill-sets';
import { AppLink } from '@/components/app-link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { needsRisk, type SkillOut, type SkillReviewShown, type SkillSuggested } from '@/lib/skills';
import { MAX_SET_SKILLS, MAX_SKILL_SETS, SET_NAME_MAX, setStanding, toggledPicks, type AgentSet, type AgentSets, type ApprovedSkill, type SkillSet } from '@/lib/skill-sets';

/**
 * Actions return their failures, so one that throws never reached its code: almost always a tab opened before a release
 * (Next: "Failed to find Server Action"), whose actions no longer exist on the server. A reload is what fixes it.
 */
export const safely = async <T,>(p: () => Promise<SkillOut<T>>): Promise<SkillOut<T>> => {
  try {
    return await p();
  } catch {
    return { ok: false, message: copy.skillSets.stale };
  }
};

const VERDICT_DOT: Record<string, string> = { clear: 'bg-proven', caution: 'bg-fg-2', blocked: 'bg-accent', unaudited: 'bg-accent' };

/** A small round mark; `tone` is a background class. */
const Dot = ({ tone }: { tone: string }) => <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${tone}`} />;

/** Skill names as quiet tokens after a short verb ("Adds market-brief chart-notes"). */
function Names({ verb, names }: { verb: string; names: string[] }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px]">
      <span className="mr-0.5 text-fg-3">{verb}</span>
      {names.map((n) => (
        <span key={n} className="rounded-md bg-line/60 px-2 py-0.5 text-fg">
          {n}
        </span>
      ))}
    </p>
  );
}

export interface AgentSetsUi {
  phase: 'loading' | 'ready' | 'failed';
  data: AgentSets | null;
  /** The id of the set being applied, or 'copy' while a set is made from this agent. */
  busy: string | null;
  message: string | null;
  note: string | null;
  /** The "Make a set from these skills" form is open. */
  copyOpen: boolean;
  copyName: string;
}

export const initialAgentSetsUi: AgentSetsUi = { phase: 'loading', data: null, busy: null, message: null, note: null, copyOpen: false, copyName: '' };

export interface AgentSetsHandlers {
  onApply?: (setId: string) => void;
  onCopyOpen?: (open: boolean) => void;
  onCopyName?: (v: string) => void;
  onCopy?: () => void;
}

/** One set as this agent sees it: name, what giving it would do, and the one button when it would do something. */
function SetRow({ s, ui, on }: { s: AgentSet; ui: AgentSetsUi; on: AgentSetsHandlers }) {
  const c = copy.skillSets;
  const st = setStanding(s);
  const total = s.add.length + s.update.length + s.same.length + s.conflicts.length;
  return (
    <li data-agent-set={s.id} data-standing={st.state} className="grid gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[15px] font-medium break-words">{s.name}</p>
          <span className="text-[13px] text-fg-3">{c.skills(total)}</span>
          {st.changed ? (
            <span className="rounded-full border border-line px-2 py-px text-xs text-fg-2" data-set-changed="">
              {c.changedTag}
            </span>
          ) : null}
        </div>
        {st.state === 'ready' ? (
          <>
            {s.add.length > 0 ? <Names verb={c.adds} names={s.add} /> : null}
            {s.update.length > 0 ? <Names verb={c.moves} names={s.update} /> : null}
          </>
        ) : st.state === 'blocked' ? (
          <ul className="mt-2 space-y-1 text-[13px] text-fg-2">
            {s.conflicts.map((k) => (
              <li key={k.name} className="flex items-baseline gap-2">
                <Dot tone="bg-accent translate-y-[-1px]" />
                {k.reason === 'edited' ? c.conflictEdited(k.name) : c.conflictTaken(k.name)}
              </li>
            ))}
            {!s.fits ? (
              <li className="flex items-baseline gap-2">
                <Dot tone="bg-accent translate-y-[-1px]" />
                {c.tooMany}
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="mt-1 text-[13px] text-fg-3">{st.state === 'empty' ? c.empty : c.current}</p>
        )}
        {st.changed && st.state === 'ready' ? <p className="mt-2 text-xs text-fg-3">{c.changed}</p> : null}
      </div>
      {st.state === 'ready' ? (
        <Button type="button" variant="quiet" className="justify-self-start" disabled={ui.busy !== null} busy={ui.busy === s.id} onClick={() => on.onApply?.(s.id)} data-apply-set={s.id}>
          {ui.busy === s.id ? c.applying : st.changed ? c.applyAgain : c.apply}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * The agent's sets, as markup for a given state: each of the owner's sets with what giving it to this agent would do, and
 * "Make a set from these skills" when the agent holds approved skills. `canCopy`: the agent has skills from skills.sh.
 */
export function AgentSkillSetsView({ ui, canCopy, on = {} }: { ui: AgentSetsUi; canCopy: boolean; on?: AgentSetsHandlers }) {
  const c = copy.skillSets;
  const sets = ui.data?.sets ?? [];
  const copyRow =
    canCopy && ui.phase === 'ready' ? (
      <div className="border-t border-line px-4 py-3 sm:px-6" data-copy-set="">
        {ui.copyOpen ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              on.onCopy?.();
            }}
          >
            <Input
              aria-label={c.fromAgentName}
              placeholder={c.fromAgentPlaceholder}
              maxLength={SET_NAME_MAX}
              value={ui.copyName}
              onChange={(e) => on.onCopyName?.(e.target.value)}
              className="min-w-0 flex-1 basis-48"
              autoFocus
              data-copy-name=""
            />
            <Button type="submit" variant="quiet" disabled={ui.busy !== null || ui.copyName.trim() === ''} busy={ui.busy === 'copy'} data-copy-make="">
              {ui.busy === 'copy' ? c.creating : c.create}
            </Button>
            <Button type="button" variant="ghost" className="px-3" onClick={() => on.onCopyOpen?.(false)}>
              {c.cancel}
            </Button>
          </form>
        ) : (
          <Button type="button" variant="ghost" className="-ml-3 px-3 text-sm font-medium" onClick={() => on.onCopyOpen?.(true)} data-copy-open="">
            {c.fromAgent}
          </Button>
        )}
      </div>
    ) : null;

  return (
    <section className="mt-8" data-skill-sets="">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="eyebrow">{c.title}</h2>
        <AppLink href="/dashboard/skill-sets" className="text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg" data-manage-sets="">
          {c.manage}
        </AppLink>
      </div>
      {ui.note ? (
        <p role="status" data-sets-note="" className="mt-3 text-sm font-medium text-proven">
          {ui.note}
        </p>
      ) : null}
      {ui.message ? (
        <p role="alert" data-sets-message="" className="mt-3 text-sm text-accent-ink">
          {ui.message}
        </p>
      ) : null}
      {ui.phase === 'loading' ? <p className="card mt-2 text-sm text-fg-3">{c.loading}</p> : null}
      {ui.phase === 'ready' ? (
        <div className="card mt-2 !p-0">
          {sets.length === 0 ? (
            <p className="px-4 py-4 text-sm text-fg-2 sm:px-6" data-no-sets="">
              {c.none}
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {sets.map((s) => (
                <SetRow key={s.id} s={s} ui={ui} on={on} />
              ))}
            </ul>
          )}
          {copyRow}
        </div>
      ) : null}
    </section>
  );
}

export interface AgentSetsCalls {
  load: () => Promise<SkillOut<AgentSets>>;
  apply: (setId: string, a: { version: number; revision: number }) => Promise<SkillOut<{ version: number; added: string[]; updated: string[] }>>;
  copy: (name: string) => Promise<SkillOut<{ id: string; revision: number }>>;
}

/**
 * The Skills tab's sets. Read once on open and again after every write here (and whenever the agent's version moves, since
 * a skill added one by one changes what a set would do). Giving a set sends the agent version and set revision this list
 * showed; the server refuses anything that moved on since.
 */
export function AgentSkillSets({ agentId, version, canCopy, calls }: { agentId: string; version: number; canCopy: boolean; calls?: AgentSetsCalls }) {
  const api = useRef<AgentSetsCalls>(
    calls ?? { load: () => agentSkillSetsAction(agentId), apply: (setId, a) => applySkillSetAction(agentId, setId, a), copy: (name) => createSkillSetAction(name, agentId) },
  ).current;
  const [ui, setUi] = useState<AgentSetsUi>(initialAgentSetsUi);
  const patch = (p: Partial<AgentSetsUi>) => setUi((u) => ({ ...u, ...p }));
  const load = () =>
    void safely(api.load).then((r) => setUi((u) => (r.ok ? { ...u, phase: 'ready', data: r.data } : { ...u, phase: u.data ? 'ready' : 'failed', message: u.data ? u.message : r.message })));
  useEffect(load, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AgentSkillSetsView
      ui={ui}
      canCopy={canCopy}
      on={{
        onApply: (setId) => {
          const s = ui.data?.sets.find((x) => x.id === setId);
          if (!s || !ui.data || ui.busy !== null) return;
          patch({ busy: setId, message: null, note: null });
          void safely(() => api.apply(setId, { version: ui.data!.version, revision: s.revision })).then((out) => {
            patch(out.ok ? { busy: null, note: copy.skillSets.applied(s.name, out.data.added.length, out.data.updated.length) } : { busy: null, message: out.message });
            load();
          });
        },
        onCopyOpen: (open) => patch({ copyOpen: open, ...(open ? {} : { copyName: '' }) }),
        onCopyName: (v) => patch({ copyName: v }),
        onCopy: () => {
          const name = ui.copyName.trim();
          if (!name || ui.busy !== null) return;
          patch({ busy: 'copy', message: null, note: null });
          void safely(() => api.copy(name)).then((out) => {
            patch(out.ok ? { busy: null, copyOpen: false, copyName: '', note: copy.skillSets.made(name) } : { busy: null, message: out.message });
            if (out.ok) load();
          });
        },
      }}
    />
  );
}

export interface AddToSetCalls {
  list: () => Promise<SkillOut<SkillSet[]>>;
  create: (name: string) => Promise<SkillOut<{ id: string; revision: number }>>;
  add: (setId: string, a: { id: string; commit: string; contentHash: string; revision: number; acceptRisk: boolean }) => Promise<SkillOut<{ revision: number }>>;
}
const serverAddCalls: AddToSetCalls = { list: listSkillSetsAction, create: (name) => createSkillSetAction(name), add: addToSkillSetAction };

const NEW = 'new';

/**
 * "Add to a set" beside "Add this skill" in a skill's checks: the same review, the same commit and fingerprint, the same
 * risk tick, kept in one of the owner's sets instead of given to this agent. "New set…" makes the set first.
 */
export function AddToSet({ r, acceptRisk, calls, startOpen = false }: { r: SkillReviewShown; acceptRisk: boolean; calls?: AddToSetCalls; startOpen?: boolean }) {
  const c = copy.skillSets;
  const api = useRef(calls ?? serverAddCalls).current;
  const [sets, setSets] = useState<SkillSet[] | null>(null);
  const [pick, setPick] = useState<string>('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(startOpen);
  useEffect(() => {
    void safely(api.list).then((out) => {
      const list = out.ok ? out.data : [];
      setSets(list);
      setPick(list[0]?.id ?? NEW);
    });
  }, [api]);
  if (sets === null) return null;
  const allowed = !needsRisk(r.verdict) || acceptRisk;
  const ready = allowed && !busy && (pick !== NEW || name.trim() !== '');

  const add = async () => {
    setBusy(true);
    setSaid(null);
    let target = sets.find((s) => s.id === pick);
    if (!target) {
      const made = await safely(() => api.create(name.trim()));
      if (!made.ok) {
        setBusy(false);
        return setSaid({ ok: false, text: made.message });
      }
      target = { id: made.data.id, name: name.trim(), revision: made.data.revision, updatedAt: new Date().toISOString(), skills: [] };
    }
    const t = target;
    const out = await safely(() => api.add(t.id, { id: r.id, commit: r.commit, contentHash: r.contentHash, revision: t.revision, acceptRisk }));
    setBusy(false);
    if (!out.ok) return setSaid({ ok: false, text: out.message });
    const next = [...sets.filter((s) => s.id !== t.id), { ...t, revision: out.data.revision }];
    setSets(next);
    setPick(t.id);
    setName('');
    setOpen(false);
    setSaid({ ok: true, text: c.addedTo(r.name, t.name) });
  };

  if (!open)
    return (
      <div className="contents" data-add-to-set="">
        <Button type="button" variant="ghost" className="px-3" disabled={!allowed} onClick={() => setOpen(true)} data-add-to-set-open="">
          {c.addTo}
        </Button>
        {said ? (
          <p role={said.ok ? 'status' : 'alert'} className={`basis-full text-sm ${said.ok ? 'text-proven' : 'text-accent-ink'}`} data-add-to-set-said="">
            {said.text}
          </p>
        ) : null}
      </div>
    );

  return (
    <div className="mt-1 flex basis-full flex-wrap items-center gap-2 rounded-xl bg-line/40 p-2" data-add-to-set="">
      <label className="sr-only" htmlFor={`set-${r.id}`}>
        {c.addToLabel}
      </label>
      <select
        id={`set-${r.id}`}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="h-11 min-w-0 flex-1 basis-full rounded-full border border-line bg-bg px-4 text-sm sm:basis-40"
        data-set-pick=""
      >
        {sets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        <option value={NEW}>{c.newSet}</option>
      </select>
      {pick === NEW ? (
        <Input aria-label={c.newSetName} placeholder={c.fromAgentPlaceholder} maxLength={SET_NAME_MAX} value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 basis-full sm:basis-40" autoFocus data-new-set-name="" />
      ) : null}
      <div className="ml-auto flex items-center gap-1">
        <Button type="button" variant="ghost" className="px-3" onClick={() => setOpen(false)}>
          {c.cancel}
        </Button>
        <Button type="button" variant="quiet" disabled={!ready} busy={busy} onClick={() => void add()} data-add-to-set-button="">
          {busy ? c.addingTo : c.addConfirm}
        </Button>
      </div>
      {said ? (
        <p role="alert" className="basis-full px-2 text-sm text-accent-ink" data-add-to-set-said="">
          {said.text}
        </p>
      ) : null}
    </div>
  );
}

/** "Start with a skill set" before creating an agent: shown only to an owner who has a set with skills in it. */
export function SetPicker({ value, onChange, calls }: { value: { id: string; revision: number } | null; onChange: (v: { id: string; revision: number } | null) => void; calls?: Pick<AddToSetCalls, 'list'> }) {
  const c = copy.skillSets;
  const api = useRef(calls ?? serverAddCalls).current;
  const [sets, setSets] = useState<SkillSet[]>([]);
  useEffect(() => {
    void safely(api.list).then((out) => setSets(out.ok ? out.data.filter((s) => s.skills.length > 0) : []));
  }, [api]);
  if (sets.length === 0) return null;
  return (
    <div className="mt-5 border-t border-line pt-4" data-set-picker="">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <label htmlFor="start-set" className="text-[15px] font-medium">
          {c.pickTitle}
        </label>
        <select
          id="start-set"
          value={value?.id ?? ''}
          onChange={(e) => {
            const s = sets.find((x) => x.id === e.target.value);
            onChange(s ? { id: s.id, revision: s.revision } : null);
          }}
          className="h-11 w-full rounded-full border border-line bg-bg px-4 text-sm sm:w-64"
        >
          <option value="">{c.pickNone}</option>
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {c.skills(s.skills.length)}
            </option>
          ))}
        </select>
      </div>
      {value ? <p className="mt-2 text-[13px] text-fg-3">{c.pickNote}</p> : null}
    </div>
  );
}

/** One skill from skills.sh once ticked: its checks being read, read, or unreadable. */
export type FoundReview = { phase: 'loading' } | { phase: 'failed'; message: string } | { phase: 'ready'; review: SkillReviewShown; acceptRisk: boolean };

export interface NewSetUi {
  phase: 'loading' | 'ready' | 'failed';
  skills: ApprovedSkill[];
  name: string;
  /** The ids of the skills picked, from either list, in the order they were picked. */
  picks: string[];
  busy: boolean;
  message: string | null;
  query: string;
  /** `found` stays through the next search and a failed one: a pick must stay on screen to stay undoable. */
  search: { phase: 'loading' | 'ready' | 'failed'; found: SkillSuggested[]; message?: string };
  reviews: Record<string, FoundReview>;
}

export const initialNewSetUi: NewSetUi = { phase: 'loading', skills: [], name: '', picks: [], busy: false, message: null, query: '', search: { phase: 'loading', found: [] }, reviews: {} };

/** What skills.sh offers beyond what the owner's agents already hold: one skill, one row. */
const foundOf = (ui: NewSetUi): SkillSuggested[] => ui.search.found.filter((f) => !ui.skills.some((k) => k.id === f.id));

/** A new search's answer, with what is already picked kept on top: a pick must stay visible to stay undoable. */
export function withPickedFound(ui: NewSetUi, answer: SkillSuggested[]): SkillSuggested[] {
  const kept = foundOf(ui).filter((f) => ui.picks.includes(f.id));
  return [...kept, ...answer.filter((f) => !kept.some((k) => k.id === f.id))];
}

/** The set can be made: it has a name, and every pick from skills.sh is read, fits, and has its risk tick where it needs one. */
export function newSetReady(ui: NewSetUi): boolean {
  if (ui.busy || ui.name.trim() === '') return false;
  return ui.picks.every((id) => {
    if (ui.skills.some((k) => k.id === id)) return true;
    const r = ui.reviews[id];
    return r?.phase === 'ready' && r.review.fits && (!needsRisk(r.review.verdict) || r.acceptRisk);
  });
}

/** The picks as the server takes them: a held skill by its fingerprint, a reviewed one with the commit and tick shown. */
export function picksToSend(ui: NewSetUi): { id: string; contentHash: string; commit?: string; acceptRisk?: boolean }[] {
  return ui.picks.flatMap((id) => {
    const held = ui.skills.find((k) => k.id === id);
    if (held) return [{ id, contentHash: held.contentHash }];
    const r = ui.reviews[id];
    return r?.phase === 'ready' ? [{ id, contentHash: r.review.contentHash, commit: r.review.commit, acceptRisk: r.acceptRisk }] : [];
  });
}

export interface NewSetHandlers {
  onName?: (v: string) => void;
  onPick?: (id: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onQuery?: (v: string) => void;
  onSearch?: () => void;
  onAcceptRisk?: (id: string, v: boolean) => void;
}

const PICK_ROW = 'grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 px-4 py-3.5 text-sm sm:px-6';
const PICK_BOX = 'mt-[3px] size-4 accent-[var(--fg)]';
const canPick = (ui: NewSetUi, id: string) => ui.picks.includes(id) || ui.picks.length < MAX_SET_SKILLS;

/** One approved skill to tick; the whole row is the target. */
function PickRow({ k, ui, on }: { k: ApprovedSkill; ui: NewSetUi; on: NewSetHandlers }) {
  const c = copy.skillSets;
  const open = canPick(ui, k.id);
  return (
    <li>
      <label className={`${PICK_ROW} ${open ? 'cursor-pointer hover:bg-line/40' : 'opacity-50'}`}>
        <input type="checkbox" className={PICK_BOX} checked={ui.picks.includes(k.id)} disabled={!open || ui.busy} onChange={() => on.onPick?.(k.id)} data-pick-skill={k.name} />
        <span className="min-w-0">
          <span className="block font-medium break-words">{k.name}</span>
          <span className="mt-0.5 line-clamp-2 block break-words text-fg-2">{k.description}</span>
          <span className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
            <Dot tone={VERDICT_DOT[k.verdict]!} />
            <span className="min-w-0 break-words">
              {copy.skills.verdict[k.verdict]} · {c.heldBy(k.agents)}
            </span>
          </span>
        </span>
      </label>
    </li>
  );
}

/** What ticking a skill from skills.sh found: the verdict, and the risk tick where the checks ask for one. */
function FoundChecks({ id, r, on }: { id: string; r: FoundReview; on: NewSetHandlers }) {
  const s = copy.skills;
  if (r.phase === 'loading') return <p className="mt-1 text-xs text-fg-3">{s.reading}</p>;
  if (r.phase === 'failed') return <p role="alert" className="mt-1 text-xs text-accent-ink">{r.message}</p>;
  const k = r.review;
  return (
    <div className="mt-1" data-found-checks={k.verdict}>
      <p className="break-words text-fg-2">{k.description}</p>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-fg-3">
        <Dot tone={VERDICT_DOT[k.verdict]!} />
        <span className="min-w-0 break-words">
          {s.verdict[k.verdict]} · {s.summary(k.audits.filter((a) => a.status === 'pass').length, k.audits.length, k.findings.length)}
        </span>
      </p>
      {!k.fits ? (
        <p className="mt-1 text-xs text-accent-ink" data-found-too-long="">
          {s.tooLong}
        </p>
      ) : needsRisk(k.verdict) ? (
        <label className="mt-2 flex cursor-pointer items-start gap-2 text-[13px]">
          <input type="checkbox" className={PICK_BOX} checked={r.acceptRisk} onChange={(e) => on.onAcceptRisk?.(id, e.target.checked)} data-found-risk={id} />
          <span>{s.acceptRisk}</span>
        </label>
      ) : null}
    </div>
  );
}

function FoundRow({ f, ui, on }: { f: SkillSuggested; ui: NewSetUi; on: NewSetHandlers }) {
  const s = copy.skills;
  const picked = ui.picks.includes(f.id);
  const open = canPick(ui, f.id);
  const review = picked ? ui.reviews[f.id] : undefined;
  return (
    <li className={`${PICK_ROW} ${open ? '' : 'opacity-50'}`}>
      <input type="checkbox" id={`found-${f.id}`} className={PICK_BOX} checked={picked} disabled={!open || ui.busy} onChange={() => on.onPick?.(f.id)} data-pick-found={f.id} />
      <div className="min-w-0">
        <label htmlFor={`found-${f.id}`} className={`block font-medium break-words ${open ? 'cursor-pointer' : ''}`}>
          {f.name}
        </label>
        <p className="mt-0.5 text-xs break-words text-fg-3">
          {s.by(f.source)} · {s.installs(f.installs)} ·{' '}
          <a href={f.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {s.onSkillsSh}
          </a>
        </p>
        {review ? <FoundChecks id={f.id} r={review} on={on} /> : null}
      </div>
    </li>
  );
}

/** The new-set form for a given state, as markup: a name, the skills the owner's agents hold, skills.sh, and save. */
export function NewSetFormView({ ui, on = {} }: { ui: NewSetUi; on?: NewSetHandlers }) {
  const c = copy.skillSets;
  const s = copy.skills;
  const found = foundOf(ui);
  return (
    <form
      className="card mt-6 !p-0"
      data-new-set=""
      onSubmit={(e) => {
        e.preventDefault();
        on.onSave?.();
      }}
    >
      <div className="px-4 py-4 sm:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[17px] font-semibold">{c.newSetTitle}</h2>
          <span className="text-[13px] text-fg-3" data-new-set-chosen="">
            {c.chosen(ui.picks.length)}
          </span>
        </div>
        <Input aria-label={c.newSetName} placeholder={c.fromAgentPlaceholder} maxLength={SET_NAME_MAX} value={ui.name} onChange={(e) => on.onName?.(e.target.value)} className="mt-3 w-full" autoFocus data-new-set-name="" />
      </div>
      {ui.phase === 'loading' || ui.skills.length > 0 ? (
        <section className="border-t border-line" data-from-agents="">
          <h3 className="px-4 pt-4 pb-1 text-[15px] font-medium sm:px-6">{c.pickSkills}</h3>
          {ui.phase === 'loading' ? (
            <p className="px-4 pb-4 text-sm text-fg-3 sm:px-6">{c.approvedLoading}</p>
          ) : (
            <>
              <p className="px-4 pb-3 text-[13px] text-fg-3 sm:px-6">{c.pickSkillsNote}</p>
              <ul className="divide-y divide-line border-t border-line">
                {ui.skills.map((k) => (
                  <PickRow key={k.id} k={k} ui={ui} on={on} />
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      <section className="border-t border-line" data-from-skills-sh="">
        <h3 className="px-4 pt-4 pb-1 text-[15px] font-medium sm:px-6">{c.pickFound}</h3>
        <p className="px-4 text-[13px] text-fg-3 sm:px-6">{c.pickFoundNote}</p>
        <div className="flex gap-2 px-4 py-3 sm:px-6">
          <Input
            aria-label={s.searchLabel}
            placeholder={s.searchPlaceholder}
            maxLength={60}
            value={ui.query}
            onChange={(e) => on.onQuery?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              on.onSearch?.();
            }}
            className="min-w-0 flex-1"
            data-found-query=""
          />
          <Button type="button" variant="quiet" busy={ui.search.phase === 'loading'} onClick={on.onSearch} data-found-search="">
            {ui.search.phase === 'loading' ? s.searching : s.search}
          </Button>
        </div>
        {ui.search.phase === 'failed' ? (
          <p role="alert" className="px-4 pb-4 text-sm text-accent-ink sm:px-6" data-found-failed="">
            {ui.search.message}
          </p>
        ) : null}
        {ui.search.phase === 'ready' && found.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-fg-2 sm:px-6" data-found-none="">
            {s.noneFound}
          </p>
        ) : null}
        {found.length > 0 ? (
          <ul className="divide-y divide-line border-t border-line">
            {found.map((f) => (
              <FoundRow key={f.id} f={f} ui={ui} on={on} />
            ))}
          </ul>
        ) : null}
      </section>
      {ui.message ? (
        <p role="alert" className="border-t border-line px-4 py-3 text-sm text-accent-ink sm:px-6" data-new-set-message="">
          {ui.message}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-1 border-t border-line px-4 py-3 sm:px-6">
        <Button type="button" variant="ghost" className="px-3" onClick={on.onCancel}>
          {c.cancel}
        </Button>
        <Button type="submit" disabled={!newSetReady(ui)} busy={ui.busy} data-new-set-save="">
          {ui.busy ? c.creating : c.create}
        </Button>
      </div>
    </form>
  );
}

/** Reads what can be picked when it opens (never on the page's own load); the server copies or re-reads each pick on save. */
function NewSetForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [ui, setUi] = useState<NewSetUi>(initialNewSetUi);
  const patch = (p: Partial<NewSetUi>) => setUi((u) => ({ ...u, ...p }));
  // Only the newest search may answer: an older, slower one would replace what the owner asked for last.
  const lastSearch = useRef(0);
  const search = (query?: string) => {
    const n = ++lastSearch.current;
    setUi((u) => ({ ...u, search: { phase: 'loading', found: u.search.found } }));
    void safely(() => searchSkillsAction(query)).then((out) => {
      if (n !== lastSearch.current) return;
      setUi((u) => ({ ...u, search: out.ok ? { phase: 'ready', found: withPickedFound(u, out.data) } : { phase: 'failed', found: u.search.found, message: out.message } }));
    });
  };
  const setReview = (id: string, r: FoundReview) => setUi((u) => ({ ...u, reviews: { ...u.reviews, [id]: r } }));
  useEffect(() => {
    void safely(approvedSkillsAction).then((out) => setUi((u) => (out.ok ? { ...u, phase: 'ready', skills: out.data } : { ...u, phase: 'failed', message: out.message })));
    search();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <NewSetFormView
      ui={ui}
      on={{
        onName: (v) => patch({ name: v }),
        onQuery: (v) => patch({ query: v }),
        onSearch: () => search(ui.query),
        onAcceptRisk: (id, v) =>
          setUi((u) => {
            const r = u.reviews[id];
            return r?.phase === 'ready' ? { ...u, reviews: { ...u.reviews, [id]: { ...r, acceptRisk: v } } } : u;
          }),
        onPick: (id) => {
          // Names decide "one per set", across both lists.
          setUi((u) => ({ ...u, picks: toggledPicks([...u.skills, ...foundOf(u)], u.picks, id) }));
          const isFound = !ui.skills.some((k) => k.id === id);
          const known = ui.reviews[id];
          if (!isFound || ui.picks.includes(id) || known?.phase === 'ready' || known?.phase === 'loading') return;
          setReview(id, { phase: 'loading' });
          void safely(() => reviewSkillAction(id)).then((out) => setReview(id, out.ok ? { phase: 'ready', review: out.data, acceptRisk: false } : { phase: 'failed', message: out.message }));
        },
        onCancel,
        onSave: () => {
          const name = ui.name.trim();
          if (!newSetReady(ui)) return;
          patch({ busy: true, message: null });
          void safely(() => createSkillSetWithAction(name, picksToSend(ui))).then((out) => {
            if (out.ok) return onDone();
            patch({ busy: false, message: out.message });
          });
        },
      }}
    />
  );
}

/** /dashboard/skill-sets: the owner's sets, made, renamed, emptied or deleted here. */
export function SkillSetsManager({ sets }: { sets: SkillSet[] }) {
  const router = useRouter();
  return <SkillSetsEditor sets={sets} refresh={() => router.refresh()} />;
}

/** The sets page's body; `refresh` reloads the page's data after a write. */
export function SkillSetsEditor({ sets, refresh }: { sets: SkillSet[]; refresh: () => void }) {
  const c = copy.skillSets;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [making, setMaking] = useState(false);
  const run = async (key: string, p: () => Promise<SkillOut<unknown>>) => {
    setBusy(key);
    setMessage(null);
    const out = await safely(p);
    setBusy(null);
    if (!out.ok) return setMessage(out.message);
    setEditing(null);
    refresh();
  };
  return (
    <div data-skill-sets-page="">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="headline text-[28px]">{c.pageTitle}</h1>
        {sets.length > 0 && sets.length < MAX_SKILL_SETS && !making ? (
          <Button type="button" variant="quiet" onClick={() => setMaking(true)} data-new-set-open="">
            {c.newSetOpen}
          </Button>
        ) : null}
      </div>
      <p className="mt-2 max-w-[60ch] text-[15px] text-fg-2">{c.pageIntro}</p>
      {message ? (
        <p role="alert" className="mt-4 text-sm text-accent-ink" data-sets-message="">
          {message}
        </p>
      ) : null}
      {making ? (
        <NewSetForm
          onCancel={() => setMaking(false)}
          onDone={() => {
            setMaking(false);
            refresh();
          }}
        />
      ) : sets.length === 0 ? (
        <div className="card mt-6 text-sm text-fg-2">
          <p>{c.pageNone}</p>
          <Button type="button" className="mt-4" onClick={() => setMaking(true)} data-new-set-open="">
            {c.newSetOpen}
          </Button>
        </div>
      ) : null}
      <div className="mt-6 space-y-4">
        {sets.map((s) => (
          <section key={s.id} className="card !p-0" data-set={s.id}>
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-4 sm:px-6">
              {editing?.id === s.id ? (
                <form
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(`rename:${s.id}`, () => renameSkillSetAction(s.id, editing.name));
                  }}
                >
                  <Input aria-label={c.rename} maxLength={SET_NAME_MAX} value={editing.name} onChange={(e) => setEditing({ id: s.id, name: e.target.value })} className="min-w-0 flex-1 basis-48" autoFocus />
                  <Button type="submit" variant="quiet" busy={busy === `rename:${s.id}`} disabled={editing.name.trim() === ''}>
                    {c.save}
                  </Button>
                  <Button type="button" variant="ghost" className="px-3" onClick={() => setEditing(null)}>
                    {c.cancel}
                  </Button>
                </form>
              ) : (
                <>
                  <h2 className="min-w-0 break-words">
                    <span className="text-[17px] font-semibold">{s.name}</span>
                    <span className="ml-2 text-[13px] text-fg-3">{c.skills(s.skills.length)}</span>
                  </h2>
                  <div className="-mr-3 flex items-center">
                    <Button type="button" variant="ghost" className="px-3 text-sm" disabled={busy !== null} onClick={() => setEditing({ id: s.id, name: s.name })} data-rename={s.id}>
                      {c.rename}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      className="px-3 text-sm hover:text-accent-ink"
                      disabled={busy !== null}
                      busy={busy === `delete:${s.id}`}
                      onClick={() => {
                        if (window.confirm(c.deleteConfirm(s.name))) void run(`delete:${s.id}`, () => removeSkillSetAction(s.id));
                      }}
                      data-delete-set={s.id}
                    >
                      {busy === `delete:${s.id}` ? c.deleting : c.delete}
                    </Button>
                  </div>
                </>
              )}
            </header>
            {s.skills.length === 0 ? (
              <p className="border-t border-line px-4 py-4 text-sm text-fg-2 sm:px-6">{c.noSkills}</p>
            ) : (
              <ul className="divide-y divide-line border-t border-line">
                {s.skills.map((k) => (
                  <li key={k.id} data-set-skill={k.name} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3.5 text-sm sm:px-6">
                    <span className="pt-[7px]" title={copy.skills.verdict[k.verdict]}>
                      <Dot tone={VERDICT_DOT[k.verdict]!} />
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium break-words">{k.name}</p>
                      <p className="mt-0.5 break-words text-fg-2">{k.description}</p>
                      <p className="mt-1 text-xs break-words text-fg-3">
                        {copy.skills.verdict[k.verdict]} · {k.id}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      className="-mr-3 px-3 text-sm"
                      disabled={busy !== null}
                      busy={busy === `take:${s.id}:${k.name}`}
                      onClick={() => void run(`take:${s.id}:${k.name}`, () => removeFromSkillSetAction(s.id, k.name, s.revision))}
                      data-take={k.name}
                    >
                      {busy === `take:${s.id}:${k.name}` ? c.taking : c.take}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
