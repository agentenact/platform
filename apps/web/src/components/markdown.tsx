import { Fragment } from 'react';
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown';

function Spans({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((x, i) =>
        x.t === 'text' ? (
          <Fragment key={i}>{x.v}</Fragment>
        ) : x.t === 'code' ? (
          <code key={i} className="rounded-[5px] bg-line px-1 py-px font-mono text-[0.92em]">
            {x.v}
          </code>
        ) : x.t === 'strong' ? (
          <strong key={i} className="font-semibold text-fg">
            <Spans c={x.c} />
          </strong>
        ) : (
          <em key={i}>
            <Spans c={x.c} />
          </em>
        ),
      )}
    </>
  );
}

function BlockView({ b }: { b: Block }) {
  if (b.t === 'h')
    return (
      <p role="heading" aria-level={b.level + 2} className="mt-1 font-semibold text-fg first:mt-0">
        <Spans c={b.c} />
      </p>
    );
  if (b.t === 'p')
    return (
      <p>
        {b.lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 ? <br /> : null}
            <Spans c={l} />
          </Fragment>
        ))}
      </p>
    );
  if (b.t === 'hr') return <hr className="border-line" />;
  if (b.t === 'code')
    return (
      <pre tabIndex={0} className="overflow-x-auto rounded-[10px] border border-line bg-deep px-3.5 py-3 font-mono text-[13px] leading-[1.6] text-fg">
        <code>{b.v}</code>
      </pre>
    );
  if (b.t === 'table')
    return (
      <div tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[0.94em] tabular-nums">
          <thead>
            <tr className="border-b border-line">
              {b.head.map((c, i) => (
                <th key={i} scope="col" className="py-1.5 pr-5 font-semibold whitespace-nowrap text-fg last:pr-0">
                  <Spans c={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-b-0">
                {r.map((c, j) => (
                  <td key={j} className="py-1.5 pr-5 align-top last:pr-0">
                    <Spans c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  const items = b.items.map((it, i) => (
    <li key={i} className="pl-1">
      <Spans c={it} />
    </li>
  ));
  return b.t === 'ul' ? (
    <ul className="ml-4 flex list-disc flex-col gap-1 marker:text-fg-3">{items}</ul>
  ) : (
    <ol start={b.start} className="ml-5 flex list-decimal flex-col gap-1 marker:text-fg-3 marker:tabular-nums">
      {items}
    </ol>
  );
}

/**
 * What an agent wrote, formatted: headings, paragraphs, lists, bold, italic and code, read by a parser that only ever
 * makes plain data (lib/markdown.ts). Nothing the model wrote becomes HTML or a link.
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div data-markdown="" className={`flex min-w-0 flex-col gap-2.5 break-words ${className}`}>
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}
