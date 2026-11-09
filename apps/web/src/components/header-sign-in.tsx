'use client';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LazySignInDialog, preloadSignIn } from '@/components/sign-in-dialog-lazy';
import { copy } from '@/copy';

/**
 * The header's Sign in: opens the sign-in dialog over the current page. It is a link to `/?signin=1` underneath, so it
 * still works before the page's script runs. On /draft it is left out: the draft screen has its own sign-in step
 * (Create, or the limit notice) that keeps the draft. The dialog's code loads on the first hover, focus or click.
 */
export function HeaderSignIn() {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  if (usePathname() === '/draft') return null;
  return (
    <>
      <a
        href="/?signin=1"
        className="btn btn-quiet h-11 px-4 text-[14px] sm:px-5"
        onPointerEnter={preloadSignIn}
        onFocus={preloadSignIn}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          setUsed(true);
          setOpen(true);
        }}
      >
        {copy.shell.signIn}
      </a>
      {used ? <LazySignInDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
