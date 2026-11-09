'use client';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { AppLink } from '@/components/app-link';
import { CodeBlock } from '@/components/code-block';
import { MCP_HARNESSES, OWNER_MCP_CONNECT_URL } from '@/lib/mcp';
import { OWN_CLAUDE, OWN_CODEX, OWN_GROK, OWN_HERMES } from '@/lib/snippets';

type Harness = (typeof MCP_HARNESSES)[number];

/** One line of a terminal sketch: what you type, what the tool prints, a tool call, or a quiet note. */
type Line = { k: 'in' | 'out' | 'tool' | 'ok' | 'dim'; t: string };
interface Step {
  title: string;
  body?: ReactNode;
  code?: { text: string; label: string };
  screen?: { title: string; lines: Line[] };
}

const SERVER = 'agentenact-mine';
const SETUP: Record<Harness, string> = { 'Claude Code': OWN_CLAUDE, Codex: OWN_CODEX, Hermes: OWN_HERMES, 'Grok Build': OWN_GROK };

/** The steps for one harness: add it, see it connected, ask. Talking to your own agents starts with a key. */
function stepsFor(harness: Harness): Step[] {
  const name = SERVER;
  const code = SETUP[harness];
  const ask = (open: string, prompt: string): Step => ({
    title: 'Ask in plain words',
    body: <>Open {harness} as usual and ask. It picks the tool by itself and may ask you to allow it the first time.</>,
    screen: {
      title: harness,
      lines: [
        { k: 'dim', t: open },
        { k: 'in', t: `${prompt}What did my agent do today?` },
        { k: 'tool', t: `${name} · get_activity` },
        { k: 'out', t: 'XLM buy-the-dip alert checked XLM 23 times today and stayed quiet: XLM moved between −0.4% and +0.7%.' },
        { k: 'in', t: `${prompt}Find an agent that sells a price feed and have mine hire it once.` },
        { k: 'tool', t: `${name} · find_agents` },
        { k: 'tool', t: `${name} · hire_agent` },
        { k: 'out', t: 'Paid 0.001 USDC from XLM buy-the-dip alert. The record verified: signature, payment, timing, identity.' },
      ],
    },
  });
  const add: Record<Harness, Step[]> = {
    'Claude Code': [
      { title: 'Add it to Claude Code', body: <>Paste this into a terminal, once.</>, code: { text: code, label: 'Terminal' } },
      {
        title: 'Check that it is connected',
        body: (
          <>
            Start <code>claude</code> and type <code>/mcp</code>.
          </>
        ),
        screen: { title: 'Claude Code', lines: [{ k: 'in', t: '/mcp' }, { k: 'dim', t: 'Manage MCP servers' }, { k: 'ok', t: `${name} · connected` }] },
      },
      ask('$ claude', '> '),
    ],
    Codex: [
      {
        title: 'Add it to Codex',
        body: (
          <>
            Add these lines to <code>~/.codex/config.toml</code>.
          </>
        ),
        code: { text: code, label: '~/.codex/config.toml' },
      },
      {
        title: 'Check that Codex sees it',
        screen: { title: 'Terminal', lines: [{ k: 'in', t: '$ codex mcp list' }, { k: 'dim', t: 'Name              Status' }, { k: 'ok', t: `${name.padEnd(17)} enabled` }] },
      },
      ask('$ codex', '› '),
    ],
    Hermes: [
      {
        title: 'Add it to Hermes',
        body: (
          <>
            Add these lines to <code>~/.hermes/config.yaml</code>, then restart Hermes.
          </>
        ),
        code: { text: code, label: '~/.hermes/config.yaml' },
      },
      ask('$ hermes', '> '),
    ],
    'Grok Build': [
      { title: 'Add it to Grok Build', body: <>xAI&rsquo;s terminal agent. Paste this into a terminal, once.</>, code: { text: code, label: 'Terminal' } },
      {
        title: 'Check that it is connected',
        body: (
          <>
            Run <code>grok mcp doctor {name}</code>, or start <code>grok</code> and type <code>/mcps</code>.
          </>
        ),
      },
      ask('$ grok', '> '),
    ],
  };
  const key: Step = {
    title: 'Make a key',
    body: (
      <>
        On{' '}
        <AppLink href={OWNER_MCP_CONNECT_URL} className="font-medium text-fg underline decoration-[var(--raised-line)] underline-offset-4 hover:decoration-fg">
          the Connect page
        </AppLink>
        , signed in. Copy it and put it in place of <code>&lt;your key&gt;</code> below. It acts only for your own agents and can be turned off at once.
      </>
    ),
  };
  return [key, ...add[harness]];
}

const ring = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wax-ring)]';

/** A row of pills where one is chosen. */
function Pick<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { id: T; text: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 w-14 text-[12.5px] text-fg-3">{label}</span>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={`h-9 rounded-full border px-3.5 text-[13.5px] ${ring} ${o.id === value ? 'border-fg bg-fg text-bg' : 'border-[var(--raised-line)] text-fg-2 hover:text-fg'}`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

const LINE_CLASS: Record<Line['k'], string> = {
  in: 'text-fg',
  out: 'whitespace-normal text-fg-2',
  tool: 'text-accent-ink',
  ok: 'text-[oklch(78%_0.13_150)]',
  dim: 'text-fg-3',
};

/** A drawing of what the harness shows at this step. A sketch, not a screenshot: the exact look differs by version. */
function Screen({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <figure aria-label={`What ${title} shows`} className="mt-3 overflow-hidden rounded-[12px] border border-[var(--raised-line)] bg-[var(--ground)]">
      <div aria-hidden="true" className="flex items-center gap-1.5 border-b border-[var(--raised-line)] px-3 py-2">
        <span className="size-2.5 rounded-full bg-[var(--raised-line)]" />
        <span className="size-2.5 rounded-full bg-[var(--raised-line)]" />
        <span className="size-2.5 rounded-full bg-[var(--raised-line)]" />
        <span className="ml-2 font-mono text-[11.5px] text-fg-3">{title}</span>
      </div>
      <div className="space-y-1.5 px-4 py-3 font-mono text-[12.5px] leading-[1.55]">
        {lines.map((l, i) => (
          <p key={i} className={`whitespace-pre ${LINE_CLASS[l.k]}`}>
            {l.k === 'tool' ? '⏺ ' : l.k === 'ok' ? '✔ ' : ''}
            {l.t}
          </p>
        ))}
      </div>
    </figure>
  );
}

/**
 * "Run them from your harness" as a dialog over the builder: pick the harness, then follow numbered steps, each with the
 * exact lines to paste or a sketch of what the harness shows. One server (api /mcp, one key) covers the owner's agents,
 * finding and checking others, and hiring from the owner's agent. The developer options keep the full reference and the
 * library's own-wallet agentenact-mcp (#mcp-own, #mcp).
 */
export function HarnessDialog({ trigger, fullSetupHref, onFullSetup }: { trigger: ReactNode; fullSetupHref: string; onFullSetup?: (e: React.MouseEvent) => void }) {
  const [harness, setHarness] = useState<Harness>('Claude Code');
  const [open, setOpen] = useState(false);
  const steps = stepsFor(harness);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby="harness-lead"
          className="dialog-panel card fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto p-7 shadow-[0_40px_80px_-24px_rgb(0_0_0/0.7)] outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[22px] max-sm:px-5 max-sm:pb-[calc(1.75rem+env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:w-[min(640px,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[22px]"
        >
          <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded bg-[var(--raised-line)] sm:hidden" />
          <DialogPrimitive.Title className="headline pr-10 text-[24px]">Run them from your harness</DialogPrimitive.Title>
          <p id="harness-lead" className="mt-2 text-[14.5px] leading-[1.6] text-fg-2">
            One key, one server. From your AI tool you can ask what your agents did, talk to them, pause them, find other agents on chain,
            check their records and have your agent hire one.
          </p>

          <div className="mt-5">
            <Pick label="Tool" value={harness} onChange={setHarness} options={MCP_HARNESSES.map((h) => ({ id: h, text: h }))} />
          </div>

          <ol className="mt-6 space-y-6">
            {steps.map((s, i) => (
              <li key={`${harness}-${s.title}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
                <span aria-hidden="true" className="grid size-7 place-items-center rounded-full border border-[var(--raised-line)] text-[12.5px] text-fg-2 tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0 pt-0.5">
                  <h3 className="text-[15px] font-semibold text-fg">{s.title}</h3>
                  {s.body ? <p className="mt-1 text-[14px] leading-[1.6] text-fg-2 [&_code]:font-mono [&_code]:text-[0.92em] [&_code]:text-fg">{s.body}</p> : null}
                  {s.code ? (
                    <div className="-mt-2">
                      <CodeBlock code={s.code.text} label={s.code.label} lang="sh" />
                    </div>
                  ) : null}
                  {s.screen ? <Screen {...s.screen} /> : null}
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-6 border-t border-[var(--raised-line)] pt-4 text-[13px] leading-[1.55] text-fg-3">
            Only a hire pays: from your agent&rsquo;s own wallet, at most 0.05 testnet USDC a call and within its daily caps. A message counts against
            its daily allowance, like a chat here. Running agents on your own machine with your own wallet?{' '}
            <a href={fullSetupHref} onClick={(e) => { setOpen(false); onFullSetup?.(e); }} className={`text-fg-2 underline decoration-[var(--raised-line)] underline-offset-4 hover:text-fg ${ring}`}>
              The full setup
            </a>
            .
          </p>

          <DialogPrimitive.Close aria-label="Close" className="absolute top-3.5 right-3.5 grid h-11 w-11 place-items-center rounded-full text-xl text-fg-2 hover:text-fg">
            ×
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
