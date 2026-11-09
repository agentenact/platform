'use client';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';
import { SignInCard } from '@/components/sign-in';
import { copy } from '@/copy';

/** What the dialog holds: a title, the expired line when a link had run out, and the email step. */
export function SignInDialogBody({ expired = false, inDialog = false }: { expired?: boolean; inDialog?: boolean }) {
  const heading = <h2 className="headline text-[28px]">{copy.signIn.title}</h2>;
  return (
    <div>
      {inDialog ? <DialogPrimitive.Title asChild>{heading}</DialogPrimitive.Title> : heading}
      {expired ? (
        <p role="alert" className="mt-2 text-[15px] text-danger">
          {copy.signIn.expired}
        </p>
      ) : (
        <p className="mt-2 text-sm text-fg-2">{copy.signIn.dialogNote}</p>
      )}
      <div className="mt-4">
        <SignInCard />
      </div>
    </div>
  );
}

/** Closing a dialog opened by `?signin=…` takes the query off the address, so a reload does not open it again. */
function dropSigninQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('signin')) return;
  url.searchParams.delete('signin');
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Sign in over the page: a centered dialog, a bottom sheet below `sm`. Esc, the close button or a click outside closes
 * it; focus stays inside while open (Radix). It mounts only in the browser, so a server render leaves a marker.
 * Uncontrolled with `defaultOpen` (the `?signin=` links), or controlled with `open`/`onOpenChange` (the header).
 */
export function SignInDialog({
  defaultOpen = false,
  expired = false,
  open,
  onOpenChange,
}: {
  defaultOpen?: boolean;
  expired?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inBrowser, setInBrowser] = useState(false);
  useEffect(() => setInBrowser(true), []);
  if (!inBrowser) return defaultOpen ? <span hidden data-signin-dialog={expired ? 'expired' : 'open'} /> : null;
  const changed = (next: boolean) => {
    if (!next) dropSigninQuery();
    onOpenChange?.(next);
  };
  return (
    <DialogPrimitive.Root defaultOpen={defaultOpen} {...(open === undefined ? {} : { open })} onOpenChange={changed}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop fixed inset-0 z-50 bg-[oklch(20%_0.012_50/0.32)] backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="dialog-panel fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto bg-white p-7 shadow-[0_40px_80px_-24px_oklch(20%_0.012_50/0.55)] outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:rounded-t-[22px] max-sm:pb-[calc(1.75rem+env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:w-[min(440px,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[22px]"
        >
          <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded bg-line sm:hidden" />
          <SignInDialogBody expired={expired} inDialog />
          <DialogPrimitive.Close aria-label={copy.signIn.close} className="absolute top-3.5 right-3.5 grid h-11 w-11 place-items-center rounded-full text-xl text-fg-2 hover:text-fg">
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
