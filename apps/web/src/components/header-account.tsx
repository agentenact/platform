'use client';
import { useEffect } from 'react';
import { AccountMenu } from '@/components/account-menu';
import { HeaderSignIn } from '@/components/header-sign-in';
import { copy } from '@/copy';
import { headerMe, useHeaderMe, type HeaderMe, type HeaderMeState } from '@/lib/header-me';
import { AppLink } from '@/components/app-link';

/** Re-ask after the tab comes back if the last answer is older than this (a session can end in another tab). */
const RECHECK_MS = 60_000;

/**
 * The visitor as the header shows it. A page the server rendered with the session passes `me` (null or the visitor) and
 * shares it with the tab; a static page passes nothing and asks `/api/header-me` once after it loads. Until then the
 * header is the signed-out one, which is what nearly every visitor of a static page is.
 */
function useResolvedMe(me: HeaderMeState): HeaderMe | null {
  const shared = useHeaderMe();
  const key = me === undefined ? undefined : JSON.stringify(me);
  useEffect(() => {
    if (me !== undefined) {
      headerMe.set(me);
      return;
    }
    void headerMe.ensure();
    const onVisible = () => {
      if (!document.hidden) void headerMe.ensure(RECHECK_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
    // `key` stands for `me`: a new object with the same contents is the same visitor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (me === undefined ? shared : me) ?? null;
}

/** Signed in with an agent: a Dashboard link to the owner's area. */
export function HeaderDashboardLink({ me, className }: { me?: HeaderMeState; className: string }) {
  const known = useResolvedMe(me);
  if (!known?.agentName) return null;
  return (
    <AppLink href="/dashboard" className={className}>
      {copy.shell.dashboard}
    </AppLink>
  );
}

/** The account button and its menu when signed in, else Sign in. */
export function HeaderAccount({ me }: { me?: HeaderMeState }) {
  const known = useResolvedMe(me);
  return known ? <AccountMenu email={known.email} agentName={known.agentName} /> : <HeaderSignIn />;
}
