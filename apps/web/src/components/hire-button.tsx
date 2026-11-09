'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentCard, HireOffer } from '../lib/explore';
import { hirePrompt } from '../lib/market';

type Target = { id: number; hire?: HireOffer | null; selfPublished?: AgentCard['selfPublished'] };

/**
 * Hire: copies the hire prompt (hirePrompt) for an AI tool connected to AgentEnact. The label stays short ("Hire" /
 * "Copied") so the button never changes width; `tip` renders where to paste it, as the caller lays it out.
 */
export function HireButton({ agent, className, tip }: { agent: Target; className: string; tip: (copied: boolean) => React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          void navigator.clipboard?.writeText(hirePrompt(agent)).then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2500);
          });
        }}
      >
        <span>{copied ? 'Copied' : 'Hire'}</span>
      </button>
      {tip(copied)}
    </>
  );
}
