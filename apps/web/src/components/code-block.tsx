import { highlight, type Lang } from '@/lib/highlight';
import { CopyButton } from './copy-button';

/**
 * A code sample on a raised panel, highlighted (lib/highlight.ts: escaped HTML, Night colours) with a copy button. `label`
 * names it (a file, a shell). No client code of its own: on a server page the highlighting happens on the server, and only
 * the copy button is sent to the browser.
 */
export function CodeBlock({ code, label, lang = 'ts' }: { code: string; label?: string; lang?: Lang }) {
  return (
    <figure className="card my-4 overflow-hidden p-0">
      <figcaption className="flex items-center justify-between gap-3 border-b border-[var(--raised-line)] px-4 py-2 font-mono text-[11.5px] text-fg-3">
        <span>{label ?? ''}</span>
        <CopyButton text={code} />
      </figcaption>
      <pre className="code overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.65] text-fg">
        <code data-lang={lang} dangerouslySetInnerHTML={{ __html: highlight(code, lang) }} />
      </pre>
    </figure>
  );
}
