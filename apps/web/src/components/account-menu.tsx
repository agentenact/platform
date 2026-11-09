'use client';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { signOutAction } from '@/app/actions/session';
import { copy } from '@/copy';
import { headerMe } from '@/lib/header-me';
import { AppLink } from '@/components/app-link';

const c = copy.shell;

/**
 * The signed-in account button and its menu. The button names the person (their email), never an agent: an account can
 * own several agents, listed under My agents. Closes on Escape, an outside click and choosing an item.
 */
export function AccountMenu({ email, agentName }: { email: string; agentName?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const path = usePathname();
  const label = email;

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div ref={box} className="relative min-w-0">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border border-line bg-white py-0 pr-1.5 pl-3 text-[14px] font-medium text-fg"
      >
        <span className="sr-only">{c.account}: </span>
        <span className="min-w-0 max-w-[6rem] truncate sm:max-w-[14rem]">{label}</span>
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-sand text-[12px] font-semibold">
          {label.charAt(0).toUpperCase()}
        </span>
      </button>
      <div hidden={!open} className="absolute top-12 right-0 z-50 w-56 rounded-2xl border border-line bg-white p-1.5 text-[14px] shadow-[0_18px_40px_-20px_oklch(20%_0.012_50/0.45)]">
        {/* The button truncates on a phone; the menu shows the whole address. */}
        <p className="truncate px-3 pt-2 pb-1.5 text-[12px] text-fg-3">{email}</p>
        {agentName ? (
          <AppLink href="/dashboard" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-xl px-3 hover:bg-bg">
            {c.myAgents}
          </AppLink>
        ) : null}
        {agentName ? (
          <AppLink href="/dashboard/skill-sets" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-xl px-3 hover:bg-bg">
            {c.skillSets}
          </AppLink>
        ) : null}
        {agentName ? (
          <AppLink href="/connect" onClick={() => setOpen(false)} className="flex min-h-11 items-center rounded-xl px-3 hover:bg-bg">
            {c.connect}
          </AppLink>
        ) : null}
        {/* The header outlives the redirect on static pages: tell it the visitor is gone. */}
        <form action={signOutAction} onSubmit={() => headerMe.set(null)}>
          <button type="submit" className="flex min-h-11 w-full items-center rounded-xl px-3 text-left hover:bg-bg">
            {c.signOut}
          </button>
        </form>
      </div>
    </div>
  );
}
