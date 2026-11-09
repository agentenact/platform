'use client';
import { useState } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { deleteAgentAction } from '@/app/actions/agent';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';

/** The server action's answer (server/agent-actions.ts DeleteOut). */
export type DeleteOut = { ok: true } | { ok: false; status: number };

const c = copy.agent.remove;

/** The plain line for a refused delete: still being set up (409), anything else a retry. */
export const deleteFailure = (out: DeleteOut): string | null => (out.ok ? null : out.status === 409 ? c.settingUp : c.failed);

/**
 * "Delete this agent": a quiet link at the foot of the agent's page that opens a confirmation. The owner types the agent's
 * name before the button wakes, because this cannot be undone. On success the page goes back to My agents. `run` is for tests.
 */
export function DeleteAgent({ agentId, name, run }: { agentId: string; name: string; run?: (agentId: string) => Promise<DeleteOut> }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const go = run ?? deleteAgentAction;
  const ready = typed.trim() === name.trim() && !busy;

  async function confirm() {
    setBusy(true);
    setMessage(null);
    let out: DeleteOut;
    try {
      out = await go(agentId);
    } catch {
      out = { ok: false, status: 503 };
    }
    if (out.ok) {
      // A full load: the deleted agent's page must not linger in the client cache.
      window.location.assign('/dashboard');
      return;
    }
    setBusy(false);
    setMessage(deleteFailure(out));
  }

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        if (!o) (setTyped(''), setMessage(null));
      }}
    >
      <DialogPrimitive.Trigger asChild>
        <button type="button" data-delete-agent="" className="self-start rounded-full px-1 py-2 text-sm text-fg-3 underline decoration-line underline-offset-4 hover:text-danger">
          {c.open}
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby="delete-agent-points"
          className="dialog-panel card fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto p-7 shadow-[0_40px_80px_-24px_rgb(0_0_0/0.7)] outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[22px] max-sm:px-5 max-sm:pb-[calc(1.75rem+env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:w-[min(520px,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[22px]"
        >
          <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded bg-[var(--raised-line)] sm:hidden" />
          <DialogPrimitive.Title className="headline pr-10 text-[24px] break-words">{c.title(name)}</DialogPrimitive.Title>
          <ul id="delete-agent-points" className="mt-4 space-y-2.5 text-[14.5px] leading-[1.6] text-fg-2">
            {c.points.map((p) => (
              <li key={p} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-2">
                <span aria-hidden="true" className="mt-[0.7em] h-1 w-1 rounded-full bg-fg-3" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) void confirm();
            }}
          >
            <label htmlFor="delete-agent-name" className="text-sm text-fg-2">
              {c.confirmLabel(name)}
            </label>
            <Input id="delete-agent-name" className="mt-2" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy} />
            {message ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                {message}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <DialogPrimitive.Close asChild>
                <Button type="button" variant="ghost" disabled={busy}>
                  {c.cancel}
                </Button>
              </DialogPrimitive.Close>
              <Button type="submit" data-delete-confirm="" disabled={!ready} busy={busy} className="border-danger bg-danger text-bg hover:border-danger hover:bg-danger/90">
                {busy ? c.busy : c.confirm}
              </Button>
            </div>
          </form>
          <DialogPrimitive.Close aria-label="Close" className="absolute top-3.5 right-3.5 grid h-11 w-11 place-items-center rounded-full text-xl text-fg-2 hover:text-fg">
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
