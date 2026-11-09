'use client';
import { useEffect, useRef, useState } from 'react';
import { handoffAction } from '@/app/actions/builder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { createParker } from '@/lib/sign-in-park';
import { nextFor, retryOnce, signInFailure } from '@/lib/sign-in-next';
import { safeNext } from '@/lib/safe-next';
import { supabaseBrowser } from '@/lib/supabase/browser';

export type SignInPhase = 'idle' | 'sending' | 'sent';

/** Seconds before "Send again" turns on. */
export const RESEND_WAIT = 30;

/** Pause before the one automatic retry of a link the sign-in service failed to send. */
export const RETRY_AFTER_MS = 1500;

/** Set when the card is the sign-in step of creating an agent: the agent's name for the eyebrow, and the way back. */
export interface CreateStep {
  name: string;
  onBack?: (() => void) | undefined;
}

const link = 'inline-flex min-h-11 items-center whitespace-nowrap text-sm text-fg-2 underline decoration-line underline-offset-4 hover:text-fg';

/**
 * The card as markup only, so every state can be rendered and scanned without a browser. With `create` it is the sign-in
 * step of creating (eyebrow, heading, line, way back); without it, the bare field and button for the places that title the
 * card themselves. The email is echoed as text only.
 */
export function SignInView({
  phase,
  error,
  email = '',
  saved = false,
  resendIn = RESEND_WAIT,
  create,
  onSubmit,
  onResend,
  onChangeEmail,
}: {
  phase: SignInPhase;
  error?: string;
  /** The address the link went to (sent state). */
  email?: string;
  /** A draft was actually parked, so the link works on any device. */
  saved?: boolean;
  /** Seconds left before "Send again" is allowed. */
  resendIn?: number;
  create?: CreateStep | undefined;
  onSubmit?: (email: string) => void;
  onResend?: () => void;
  onChangeEmail?: () => void;
}) {
  const c = copy.signIn;
  const eyebrow = create ? <p className="eyebrow">{c.createEyebrow(create.name)}</p> : null;
  if (phase === 'sent')
    return (
      <section aria-live="polite">
        {eyebrow}
        <h2 className="headline text-2xl">{c.sent}</h2>
        <p className="mt-2 break-words text-fg-2">{c.sentTo(email)}{saved ? ` ${c.saved}` : ''}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <Button type="button" variant="quiet" disabled={resendIn > 0} onClick={onResend}>
            {resendIn > 0 ? `${c.resend} ${c.resendIn(resendIn)}` : c.resend}
          </Button>
          <button type="button" onClick={onChangeEmail} className={link}>
            {c.otherEmail}
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </section>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(String(new FormData(e.currentTarget).get('email') ?? ''));
      }}
    >
      {eyebrow}
      {create ? <h2 className="headline text-2xl">{c.createTitle}</h2> : null}
      {create ? <p className="mb-4 mt-2 text-fg-2">{c.createLine}</p> : null}
      <label htmlFor="sign-in-email" className="block text-sm text-fg-2">
        {c.email}
      </label>
      <div className="mt-1 flex flex-col gap-3 sm:flex-row">
        <Input id="sign-in-email" name="email" type="email" autoComplete="email" required disabled={phase === 'sending'} className="sm:flex-1" />
        <Button type="submit" size="lg" busy={phase === 'sending'}>
          {phase === 'sending' ? c.sending : c.send}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {create?.onBack ? (
        <div className="mt-3">
          <button type="button" onClick={create.onBack} className={link}>
            {c.backToDraft}
          </button>
        </div>
      ) : null}
    </form>
  );
}

/**
 * Email field and "Send me a link". With a draft, the draft is parked first (handoffAction, together with the typed email so only that account can claim it) and its id rides in the link's
 * redirect, so signing in on any device lands on it. The id is the claim secret, single use; nothing is kept in browser storage.
 * With only a prompt (the draft limit: nothing to park yet) the prompt rides in the link instead and /draft drafts it again.
 * If parking fails the link still goes out (carrying the prompt if there is one): the sign-in must not depend on it.
 * As the create step (`create`) the link also carries intent=create, so /draft opens straight into creating. "Send again"
 * goes through the same send, reusing the draft already parked (the draft cannot change behind this card).
 */
/** `next`: a same-origin path to land on after the link (checked with safeNext), for pages that are not a draft, such as the pause confirmation. */
export function SignInCard({ draft, prompt, handoff, create, next: landOn }: { draft?: unknown; prompt?: string | undefined; handoff?: string | undefined; create?: CreateStep | undefined; next?: string | undefined }) {
  const [phase, setPhase] = useState<SignInPhase>('idle');
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState('');
  const [saved, setSaved] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  // The wait before "Send again" counts down one second at a time while the sent state is showing.
  useEffect(() => {
    if (phase !== 'sent' || resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, resendIn]);

  // The draft is bound to the email it was sent to, so it is parked once per address (a resend to the same address reuses it;
  // a failed park is tried again).
  const park = useRef(createParker(handoffAction)).current;

  async function send(raw: string, again = false) {
    const to = raw.trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) return setError(copy.signIn.badEmail);
    setError(undefined);
    if (again) setResendIn(RESEND_WAIT);
    else setPhase('sending');
    const parkedId = await park(draft, to);
    const next = landOn ? safeNext(landOn) : nextFor({ parkedId, handoff, prompt, ...(create ? { intent: 'create' as const } : {}) });
    const ask = async () => {
      try {
        return (
          await supabaseBrowser().auth.signInWithOtp({
            email: to,
            options: { emailRedirectTo: `${window.location.origin}/auth/confirm?next=${encodeURIComponent(next)}` },
          })
        ).error;
      } catch (e) {
        // A throw (not an answer) means the request never got through: the same as no answer.
        return { status: 0, name: e instanceof Error ? e.name : undefined };
      }
    };
    let err = await ask();
    // The sign-in service drops a request now and then when it cannot reach its database in time; one quiet retry hides
    // most of those. A 504 or a 429 is not retried (see retryOnce).
    if (err && retryOnce(signInFailure(err))) {
      await new Promise((r) => setTimeout(r, RETRY_AFTER_MS));
      err = await ask();
    }
    if (err) {
      if (again) setResendIn(0);
      else setPhase('idle');
      const why = signInFailure(err);
      // The status and code ride along for a failure we cannot name, so a screenshot says which one it was (this call goes
      // straight from the browser to GoTrue, so no log of ours sees it).
      const tag = [err.status, (err as { code?: string }).code].filter((x) => x !== undefined && x !== '').join(' ');
      const text = why === 'generic' ? copy.errors.generic : copy.signIn[why];
      return setError(why === 'busy' || why === 'generic' ? `${text}${tag ? ` (${tag})` : ''}` : text);
    }
    setEmail(to);
    setSaved(Boolean(parkedId ?? handoff));
    if (!again) setResendIn(RESEND_WAIT);
    setPhase('sent');
  }

  return (
    <SignInView
      phase={phase}
      email={email}
      saved={saved}
      resendIn={resendIn}
      create={create}
      {...(error ? { error } : {})}
      onSubmit={(v) => void send(v)}
      onResend={() => void send(email, true)}
      onChangeEmail={() => {
        setError(undefined);
        setPhase('idle');
      }}
    />
  );
}
