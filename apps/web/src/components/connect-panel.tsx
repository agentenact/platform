'use client';
import { useState } from 'react';
import { issueTokenAction, revokeTokenAction } from '@/app/actions/tokens';
import { Button } from '@/components/ui/button';
import { DesktopSetup } from '@/components/desktop-setup';
import { Input } from '@/components/ui/input';
import { copy } from '@/copy';
import { HARNESS_SETUPS, KEY_PLACEHOLDER } from '@/lib/connect-config';
import type { TokenView } from '@/lib/key-types';

const c = copy.connect;

/** "28 Oct 2026". A calendar day in UTC, so the server render and the browser agree. */
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * Make a key, see it once, paste the setup lines, turn keys off. `fresh` is the key just made: it lives in this
 * component's state only, is never stored by the panel, and is gone on reload.
 */
export function ConnectPanel({ keys: initial, fresh: initialFresh = null }: { keys: TokenView[]; fresh?: string | null }) {
  const [keys, setKeys] = useState(initial);
  const [fresh, setFresh] = useState<string | null>(initialFresh);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<'make' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function make(e: React.FormEvent) {
    e.preventDefault();
    setBusy('make');
    setError(null);
    const out = await issueTokenAction(name || c.namePlaceholder);
    setBusy(null);
    if (!out.ok) return setError(out.status === 409 ? c.tooMany : c.failed);
    setFresh(out.token);
    setKeys([out.view, ...keys]);
    setName('');
  }

  async function turnOff(id: string) {
    setBusy(id);
    setError(null);
    const out = await revokeTokenAction(id);
    setBusy(null);
    if (!out.ok && out.status !== 404) return setError(c.failed);
    setKeys(keys.filter((k) => k.id !== id));
  }

  async function copyText(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((v) => (v === id ? null : v)), 2000);
    } catch {
      /* the text stays selectable */
    }
  }

  const key = fresh ?? KEY_PLACEHOLDER;
  return (
    <div className="space-y-6">
      <section data-card="" className="card space-y-4">
        <form onSubmit={make} className="space-y-3">
          <label htmlFor="key-name" className="block text-sm font-medium">
            {c.nameLabel}
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input id="key-name" value={name} maxLength={64} placeholder={c.namePlaceholder} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" size="lg" disabled={busy !== null} busy={busy === 'make'}>
              {busy === 'make' ? c.making : c.make}
            </Button>
          </div>
        </form>
        {fresh ? (
          <div className="space-y-2" aria-live="polite">
            <p className="text-sm text-fg-2">{c.shownOnce}</p>
            <div className="flex items-center gap-2">
              <code data-advanced="" className="min-w-0 flex-1 truncate rounded-xl border border-line bg-bg px-3 py-2.5 font-mono text-[13px] select-all">
                {fresh}
              </code>
              <Button type="button" variant="quiet" onClick={() => copyText('key', fresh)}>
                {copied === 'key' ? c.copied : c.copy}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{c.setupTitle}</h2>
        <h3 className="font-medium">{c.desktopTitle}</h3>
        <p className="text-sm text-fg-2">{c.desktopNote}</p>
        <DesktopSetup apiKey={key} />
        <h3 className="pt-4 font-medium">{c.terminalTitle}</h3>
        {HARNESS_SETUPS.map((h) => {
          const lines = h.lines(key);
          return (
            <div key={h.id} data-card="" className="card space-y-2">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">
                  {h.label} <span className="text-sm font-normal text-fg-3">{h.where}</span>
                </p>
                <Button type="button" variant="ghost" onClick={() => copyText(h.id, lines)}>
                  {copied === h.id ? c.copied : c.copy}
                </Button>
              </div>
              <pre data-advanced="" className="overflow-x-auto rounded-xl bg-bg p-3 font-mono text-[12.5px] leading-relaxed">
                {lines}
              </pre>
            </div>
          );
        })}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{c.keysTitle}</h2>
        {keys.length === 0 ? (
          <p className="text-fg-2">{c.none}</p>
        ) : (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-white">
            {keys.map((k) => (
              <li key={k.id} data-key-row="" className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{k.name}</p>
                  <p className="text-sm text-fg-3">
                    {c.made(day(k.createdAt))}, {k.lastUsedAt ? c.lastUsed(day(k.lastUsedAt)) : c.neverUsed}, {c.expires(day(k.expiresAt))}
                  </p>
                </div>
                <Button type="button" variant="quiet" disabled={busy !== null} busy={busy === k.id} onClick={() => turnOff(k.id)}>
                  {busy === k.id ? c.revoking : c.revoke}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-fg-3">{c.revokeNote}</p>
      </section>
    </div>
  );
}
