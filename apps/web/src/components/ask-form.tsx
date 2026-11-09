'use client';

import { useEffect, useState } from 'react';
import { panelUrl } from '@/lib/panel-url';
import { SealLoader } from './seal-loader';

/** Example sentences for the box, one picked per visit. Each is something a ready agent already does, worded upbeat. */
export const ASK_EXAMPLES = [
  'Tell me when XLM rises 5% in an hour',
  'Email me when USDC lands in my Stellar wallet',
  'Send me BTC, ETH and XLM prices every morning',
  'Tell me when XLM is 10% cheaper than last week',
  'Remind me to top up when my wallet has under 20 USDC',
  'Send me a weekly summary of what my wallet spent',
  'Email me my wallet balance every evening',
  'Tell me when someone moves over 50,000 USDC on Stellar',
  'Write me a short crypto recap every Friday',
  'Send me a weekly brief on AI agents that pay and get paid',
] as const;

/** One sentence in, the draft flow (/draft) out, in this app. Without script the form still GETs /draft?prompt=. The homepage hero and /create share it; `id` keeps their inputs distinct. */
export function AskForm({ id = 'create-prompt', className = '', label }: { id?: string; className?: string; label?: string }) {
  const [text, setText] = useState('');
  // The server renders the first example; the browser swaps in a random one after mount, so hydration always matches.
  const [example, setExample] = useState<string>(ASK_EXAMPLES[0]);
  useEffect(() => setExample(ASK_EXAMPLES[Math.floor(Math.random() * ASK_EXAMPLES.length)]!), []);
  // The draft page takes a moment to open; the button turns the seal until it does. Coming back (bfcache) resets it.
  const [going, setGoing] = useState(false);
  useEffect(() => {
    const reset = () => setGoing(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  return (
    <form
      className={className}
      action="/draft"
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        const to = panelUrl(text);
        // A blank Create on /create itself would only reload it: point at the box instead.
        if (to === window.location.pathname) {
          document.getElementById(id)?.focus();
          return;
        }
        setGoing(true);
        window.location.assign(to);
      }}
    >
      {label ? (
        <label htmlFor={id} className="mb-2.5 block text-[15px] font-medium text-fg">
          {label}
        </label>
      ) : (
        <label htmlFor={id} className="mb-2.5 block font-mono text-[12px] tracking-[0.12em] text-fg-2 uppercase">
          &gt; Describe your agent
        </label>
      )}
      <div className="ask">
        <input
          id={id}
          name="prompt"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          autoComplete="off"
          placeholder={example}
        />
        <button type="submit" className="btn btn-wax h-[54px] rounded-[12px] px-6" aria-busy={going || undefined} data-busy={going ? '' : undefined}>
          Create {going ? <SealLoader size={18} /> : <span aria-hidden>→</span>}
        </button>
      </div>
      <p className="mt-3 text-[13px] text-fg-3">Free to try. You see your agent before you sign up.</p>
    </form>
  );
}
