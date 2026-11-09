'use client';
import { Popover as P } from 'radix-ui';
import { useState } from 'react';
import { listModelsAction, setModelAction } from '@/app/actions/agent';
import { copy } from '@/copy';
import type { AgentModel, ModelChoice } from '@/lib/agent-types';

const M = copy.agent.model;

export type SaveModel = (model: string | null) => Promise<{ ok: boolean }>;
export type LoadModels = () => Promise<ModelChoice[] | null>;

/** At most this many search hits are drawn at once; the search narrows the rest. */
export const SHOW_MAX = 80;

/** The catalog models that match `q` (name or slug, any case), suggested ones left out (they are listed above). */
export function matchModels(all: readonly ModelChoice[], q: string): ModelChoice[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((c) => !c.suggested && words.every((w) => c.label.toLowerCase().includes(w) || c.id.toLowerCase().includes(w)));
}

/** The note under one choice: the same limit as the default, or how much faster it uses it. */
export const weightNote = (w: number): string => (w <= 1 ? M.same : M.faster(Number.isInteger(w) ? w : Math.round(w * 10) / 10));

/**
 * The model the agent thinks with, in its header: a quiet pill with the model's name that opens a short list. A pick saves
 * at once (no second "Save"): the next run uses it, the sheet closes and the pill shows the new name. The default goes back
 * to null on the api, so a later change of the platform default moves this agent too. Below the suggested ones, "Show all
 * models" loads the OpenRouter catalog with a search; those are marked as not tried. `save` and `load` are for tests.
 */
export function ModelPicker({ agentId, model, save, load }: { agentId: string; model: AgentModel; save?: SaveModel; load?: LoadModels }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<ModelChoice[] | 'loading' | 'failed' | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const go: SaveModel = save ?? ((m) => setModelAction(agentId, m));
  const fetchAll = async () => {
    setAll('loading');
    const list = await (load ?? listModelsAction)().catch(() => null);
    setAll(list ?? 'failed');
  };
  const current = model.choices.find((c) => c.id === model.current);

  const pick = async (id: string) => {
    if (id === model.current) return setOpen(false);
    setBusy(true);
    setMessage(null);
    const out = await go(id === model.defaultId ? null : id).catch(() => ({ ok: false }));
    setBusy(false);
    if (out.ok) setOpen(false);
    else setMessage(M.failed);
  };

  return (
    <P.Root
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        setMessage(null);
      }}
    >
      <P.Trigger asChild>
        <button
          type="button"
          data-model-picker={model.current}
          className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-line bg-white px-3 text-[13px] text-fg-2 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <span>{M.label}</span>
          <span className="truncate font-medium text-fg">{current?.label ?? model.current}</span>
          <Chevron />
        </button>
      </P.Trigger>
      <P.Portal>
        <P.Content
          align="start"
          sideOffset={8}
          collisionPadding={16}
          data-model-sheet=""
          className="fade-in z-50 flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-32px))] flex-col gap-3 overflow-y-auto rounded-2xl border border-line bg-white p-4 text-fg shadow-[0_24px_48px_-24px_rgb(0_0_0/0.8)]"
        >
          <div>
            <p className="text-sm font-medium">{M.title}</p>
            <p className="mt-1 text-[13px] text-fg-2">{M.body}</p>
          </div>
          <section aria-label={M.suggested} className="flex flex-col gap-1">
            <p className="px-3 text-[12px] text-fg-3">{M.suggested}</p>
            <ul role="list" className="flex flex-col gap-1">
              {model.choices.map((c) => (
                <Row key={c.id} c={c} on={c.id === model.current} isDefault={c.id === model.defaultId} busy={busy} pick={pick} />
              ))}
            </ul>
          </section>
          {model.catalog ? (
            all === null || all === 'failed' ? (
              <div className="flex flex-col gap-1">
                {all === 'failed' ? (
                  <p role="alert" className="px-3 text-[13px] text-danger">
                    {M.loadFailed}
                  </p>
                ) : null}
                <button type="button" data-model-show-all="" onClick={() => void fetchAll()} className="min-h-11 rounded-xl px-3 text-left text-sm text-fg-2 underline-offset-4 hover:text-fg hover:underline">
                  {M.showAll}
                </button>
              </div>
            ) : all === 'loading' ? (
              <p role="status" className="px-3 text-sm text-fg-2">
                {M.loading}
              </p>
            ) : (
              <section aria-label={M.all} data-model-all="" className="flex min-h-0 flex-col gap-2">
                <p className="px-3 text-[12px] text-fg-3">{M.all}</p>
                <input
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={M.search}
                  aria-label={M.search}
                  className="h-10 rounded-xl border border-line bg-transparent px-3 text-sm text-fg placeholder:text-fg-3"
                />
                <AllList all={all} q={q} current={model.current} busy={busy} pick={pick} />
              </section>
            )
          ) : null}
          {busy ? (
            <p role="status" className="text-sm text-fg-2">
              {M.saving}
            </p>
          ) : message ? (
            <p role="alert" className="text-sm text-danger">
              {message}
            </p>
          ) : null}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

function AllList({ all, q, current, busy, pick }: { all: ModelChoice[]; q: string; current: string; busy: boolean; pick: (id: string) => Promise<void> }) {
  const hits = matchModels(all, q);
  if (hits.length === 0) return <p className="px-3 text-[13px] text-fg-3">{M.noMatch}</p>;
  return (
    <ul role="list" className="flex flex-col gap-1">
      {hits.slice(0, SHOW_MAX).map((c) => (
        <Row key={c.id} c={c} on={c.id === current} isDefault={false} busy={busy} pick={pick} />
      ))}
    </ul>
  );
}

function Row({ c, on, isDefault, busy, pick }: { c: ModelChoice; on: boolean; isDefault: boolean; busy: boolean; pick: (id: string) => Promise<void> }) {
  return (
    <li>
      <button
        type="button"
        disabled={busy}
        aria-pressed={on}
        data-model-choice={c.id}
        onClick={() => void pick(c.id)}
        className={`flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors disabled:opacity-60 ${on ? 'bg-sand' : 'hover:bg-sand/60'}`}
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-fg">
            {c.label}
            {isDefault ? <span className="ml-2 text-[12px] font-normal text-fg-3">{M.default}</span> : null}
          </span>
          <span className="block truncate text-[12px] text-fg-3">
            {weightNote(c.weight)}
            {c.suggested ? null : ` · ${M.untried}`}
          </span>
        </span>
        {on ? <Check /> : null}
      </button>
    </li>
  );
}

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 6.5 8 10l3.5-3.5" />
    </svg>
  );
}

function Check() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}
