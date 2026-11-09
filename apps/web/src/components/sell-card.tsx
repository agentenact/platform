'use client';
import { useEffect, useState } from 'react';
import { offerAction } from '@/app/actions/sell';
import { Button } from '@/components/ui/button';
import { copy } from '@/copy';
import type { SellSuggestion } from '@/lib/agent-types';
import { browserStorage, hiddenNow, hideForAWeek, initialSell, runOffer, type Offer, type SellState } from '@/lib/sell';

export interface SellHandlers {
  onOffer?: () => void;
  onNotNow?: () => void;
}

/** The card for a given state, as markup, so every state can be rendered and scanned without a browser. */
export function SellCardView({ suggestion, state = initialSell, on = {} }: { suggestion: SellSuggestion; state?: SellState; on?: SellHandlers }) {
  const c = copy.sell;
  if (state.phase === 'hidden') return null;
  if (state.phase === 'done')
    return (
      <p role="status" data-sell-done="" className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm font-medium text-proven">
        {c.offered}
      </p>
    );
  if (state.phase === 'stale')
    return (
      <p role="status" data-sell-stale="" className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm text-fg-2">
        {c.stale}
      </p>
    );
  return (
    <section className="mt-4 rounded-2xl border border-dashed border-fg-3/60 px-4 py-3" data-sell="" data-version={suggestion.version}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-sm text-fg">{c.banner}</p>
        <p className="order-3 basis-full break-words text-sm text-fg-2">
          <span data-sell-name="">{suggestion.label}</span> · <span data-sell-price="">{c.price(suggestion.price)}</span>. {c.note}
        </p>
        <div className="order-2 flex items-center gap-1">
          <Button type="button" variant="ghost" disabled={state.busy} onClick={on.onNotNow} data-not-now="">
            {c.notNow}
          </Button>
          <Button type="button" variant="quiet" busy={state.busy} onClick={on.onOffer} data-offer="">
            {state.busy ? c.offering : c.offer}
          </Button>
        </div>
      </div>
      {state.message ? (
        <p role="alert" data-sell-message="" className="mt-2 text-sm text-danger">
          {state.message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * "Other agents could pay for this agent's summary. Offer it?" One tap publishes exactly the version shown; if the description
 * has changed since, the card gives way to a plain note. "Not now" hides it for 7 days (browser storage, optional).
 */
export function SellCard({ agentId, suggestion, onPublish }: { agentId: string; suggestion: SellSuggestion; onPublish?: Offer }) {
  const [state, setState] = useState<SellState>(initialSell);
  useEffect(() => {
    if (hiddenNow(browserStorage(), agentId, Date.now())) setState({ phase: 'hidden' });
  }, [agentId]);
  const offer: Offer = onPublish ?? ((version) => offerAction(agentId, version));
  return (
    <SellCardView
      suggestion={suggestion}
      state={state}
      on={{
        onOffer: () => {
          if (state.phase !== 'card' || state.busy) return;
          setState({ phase: 'card', busy: true, message: null });
          void runOffer(offer, suggestion.version).then(setState);
        },
        onNotNow: () => {
          hideForAWeek(browserStorage(), agentId, Date.now());
          setState({ phase: 'hidden' });
        },
      }}
    />
  );
}
