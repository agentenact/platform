'use client';
import { useState } from 'react';
import { setPausedAction } from '@/app/actions/agent';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import { runPause, type PauseState, type RunPause } from '@/lib/pause';

/**
 * Pause or Resume. A press answers at once ("Pausing…" with the turning seal, the button held); the label flips only after
 * the server has answered 204 (no optimistic flip); a failure leaves the button as it was and says so in one plain line. `run` is for tests; the page uses the server action.
 */
export function PauseButton({ agentId, paused, run }: { agentId: string; paused: boolean; run?: RunPause }) {
  const [s, setS] = useState<PauseState>({ paused, busy: false, message: null });
  const go = run ?? ((want: boolean) => setPausedAction(agentId, want));
  return (
    <div className="flex flex-col items-stretch gap-1 sm:items-end">
      <Button
        type="button"
        variant="quiet"
        busy={s.busy}
        data-pause={s.busy ? 'busy' : ''}
        onClick={() => {
          setS({ ...s, busy: true, message: null });
          void runPause(s, go).then(setS);
        }}
      >
        {s.busy ? (s.paused ? copy.agent.resuming : copy.agent.pausing) : s.paused ? copy.agent.resume : copy.agent.pause}
      </Button>
      {s.message ? (
        <p role="alert" className="text-sm text-danger">
          {s.message}
        </p>
      ) : null}
    </div>
  );
}
