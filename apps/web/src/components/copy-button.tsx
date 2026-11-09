'use client';

import { useState } from 'react';

/** Copies `text` to the clipboard and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="min-h-[32px] rounded-md px-2 text-fg-2 transition-colors hover:text-fg"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <span aria-live="polite">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}
