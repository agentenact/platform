'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect } from 'react';
import { LazySignInDialog } from '@/components/sign-in-dialog-lazy';
import { headerMe, useHeaderMe } from '@/lib/header-me';
import { signinFromSearch, signinToOpen } from '@/lib/signin-mode';

function Opener() {
  const mode = signinFromSearch(useSearchParams());
  const me = useHeaderMe();
  useEffect(() => {
    if (mode) void headerMe.ensure();
  }, [mode]);
  const open = signinToOpen(mode, me);
  return open ? <LazySignInDialog defaultOpen expired={open === 'expired'} /> : null;
}

/** `/?signin=1|expired` opens the sign-in dialog over the homepage, in the browser (the page itself is static). */
export function HomeSignIn() {
  return (
    <Suspense fallback={null}>
      <Opener />
    </Suspense>
  );
}
