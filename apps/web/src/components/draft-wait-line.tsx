'use client';
import { useEffect, useState } from 'react';
import { createWaitClock, realWaitClock, waitLine, type WaitClock } from '@/lib/draft-wait';
import { SealLoader } from '@/components/seal-loader';

/** The drafting wait line: the plain one first, then an honest "still writing" once it runs long. */
export function DraftWaitLine({ clock = realWaitClock }: { clock?: WaitClock }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => createWaitClock(clock, setElapsed), [clock]);
  return (
    <p role="status" className="flex items-center gap-2.5 mt-4 text-[15px] text-fg-2">
      <SealLoader size={18} className="text-accent" />
      {waitLine(elapsed)}
    </p>
  );
}
