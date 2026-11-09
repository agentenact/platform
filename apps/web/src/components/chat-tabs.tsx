'use client';
import { Dialog as DialogPrimitive, DropdownMenu, Popover } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SealLoader } from '@/components/seal-loader';
import { copy } from '@/copy';
import { CHAT_TITLE_MAX, type ChatSessionInfo, type ChatTab } from '@/lib/chat';

const c = copy.chat;
const ICON = 'size-4 shrink-0';
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const IconPlus = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} {...stroke}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);
const IconDots = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="currentColor">
    <circle cx="3" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="13" cy="8" r="1.25" />
  </svg>
);
const IconTune = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} {...stroke}>
    <path d="M2.5 5h7M13 5h.5M2.5 11H3M6.5 11h7" />
    <circle cx="11" cy="5" r="1.6" />
    <circle cx="4.8" cy="11" r="1.6" />
  </svg>
);

const MENU_ITEM = 'flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-[14.5px] text-fg outline-none select-none data-[highlighted]:bg-line sm:min-h-9';
const SURFACE = 'chat-pop z-50 rounded-[14px] border border-[var(--raised-line)] bg-[var(--raised)] shadow-[0_24px_48px_-16px_rgb(0_0_0/0.7)] outline-none';

export interface TabActions {
  onOpen: (key: string) => void;
  onNew: () => void;
  onRename: (key: string) => void;
  onArchive: (key: string) => void;
  onUnarchive: (key: string) => void;
  onDelete: (key: string) => void;
}

/**
 * The owner's open chats as a strip of tabs that scrolls sideways (with snap on a phone). The open tab carries a "…" with
 * rename, archive and delete; a tab whose answer is being written carries the small seal, so it can be left and found again.
 */
export function ChatTabs({ tabs, active, disabled, settings, ...a }: TabActions & { tabs: ChatTab[]; active: string; disabled: boolean; settings: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  // The open tab stays in view. Scrolls the strip only: a scrollIntoView would move the page as well.
  useEffect(() => {
    const box = strip.current;
    const el = box?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
    if (!box || !el) return;
    if (el.offsetLeft < box.scrollLeft) box.scrollTo({ left: el.offsetLeft - 8 });
    else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollTo({ left: el.offsetLeft + el.offsetWidth - box.clientWidth + 8 });
  }, [active, tabs.length]);
  return (
    <div data-chat-bar="" className="chat-tabs sticky top-[68px] z-20 -mx-3 flex items-stretch gap-1 border-b border-line bg-[var(--ground)] pl-3 sm:top-[74px] sm:-mx-0 sm:pl-0">
      <div ref={strip} role="tablist" aria-label={c.tabs} className="relative flex min-w-0 flex-1 snap-x gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs.map((t) => {
          const on = t.key === active;
          const title = t.title ?? c.untitled;
          return (
            <div key={t.key || 'new'} data-chat-tab={t.key} data-on={on ? '' : undefined} className="chat-tab group relative flex max-w-[210px] shrink-0 snap-start items-center">
              <button
                type="button"
                role="tab"
                aria-selected={on}
                disabled={disabled}
                onClick={() => a.onOpen(t.key)}
                className={`flex h-11 min-w-0 items-center gap-2 pl-3 text-[14px] outline-none motion-safe:transition-colors focus-visible:text-fg ${t.session ? 'pr-2' : 'pr-3'} ${on ? 'font-medium text-fg' : 'text-fg-2 hover:text-fg'}`}
              >
                {t.live ? <SealLoader size={13} className="shrink-0 text-accent" /> : null}
                <span className="truncate">{title}</span>
              </button>
              {t.session ? <TabMenu tab={t} title={title} on={on} {...a} /> : null}
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 pr-3 sm:pr-0">
        <button type="button" data-chat-new="" aria-label={c.newChat} title={c.newChat} disabled={disabled} onClick={a.onNew} className="grid size-11 place-items-center rounded-full text-fg-2 hover:bg-line hover:text-fg disabled:opacity-40 sm:size-9">
          <IconPlus />
        </button>
        {settings}
      </div>
    </div>
  );
}

function TabMenu({ tab, title, on, onRename, onArchive, onUnarchive, onDelete }: Pick<TabActions, 'onRename' | 'onArchive' | 'onUnarchive' | 'onDelete'> & { tab: ChatTab; title: string; on: boolean }) {
  return (
    // Not modal: a modal menu locks the page's scroll, which moves this sticky strip under the menu as it opens.
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={c.options(title)}
        data-chat-tab-menu=""
        className={`mr-1 grid size-8 place-items-center rounded-full text-fg-3 outline-none hover:bg-line hover:text-fg focus-visible:opacity-100 data-[state=open]:opacity-100 ${on ? '' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto'}`}
      >
        <IconDots />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} collisionPadding={12} className={`${SURFACE} min-w-44 p-1.5`}>
          <DropdownMenu.Item className={MENU_ITEM} data-chat-rename="" onSelect={() => onRename(tab.key)}>
            {c.rename}
          </DropdownMenu.Item>
          {tab.archived ? (
            <DropdownMenu.Item className={MENU_ITEM} data-chat-unarchive="" onSelect={() => onUnarchive(tab.key)}>
              {c.unarchive}
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item className={MENU_ITEM} data-chat-archive="" onSelect={() => onArchive(tab.key)}>
              {c.archive}
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item className={`${MENU_ITEM} text-accent-ink`} data-chat-delete="" onSelect={() => onDelete(tab.key)}>
            {c.delete}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The chat's quiet settings: the seal switch with its privacy line, and the way to the archive. */
export function ChatSettings({ sealEach, onSealEach, onArchived }: { sealEach: boolean; onSealEach: (on: boolean) => void; onArchived: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label={c.settings} title={c.settings} data-chat-settings="" className="grid size-11 place-items-center rounded-full text-fg-2 outline-none hover:bg-line hover:text-fg focus-visible:bg-line sm:size-9">
        <IconTune />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={12} className={`${SURFACE} w-[min(320px,calc(100vw-24px))] p-1.5`}>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg p-3 hover:bg-line" data-chat-seal-each="">
            <input type="checkbox" className="chat-switch mt-0.5" checked={sealEach} onChange={(e) => onSealEach(e.target.checked)} />
            <span className="min-w-0">
              <span className="block text-[14.5px] text-fg">{c.sealEach}</span>
              <span className="mt-1 block text-[12.5px] leading-[1.5] text-fg-3">{c.sealEachNote}</span>
            </span>
          </label>
          <button
            type="button"
            data-chat-archived=""
            className={`${MENU_ITEM} w-full`}
            onClick={() => {
              setOpen(false);
              onArchived();
            }}
          >
            {c.archived}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The archive: open a chat to read it, unarchive it, or delete it. */
export function ArchivedList({ sessions, onBack, onOpen, onUnarchive, onDelete }: { sessions: ChatSessionInfo[] | null; onBack: () => void; onOpen: (id: string) => void; onUnarchive: (id: string) => void; onDelete: (id: string) => void }) {
  return (
    <div data-chat-archived-list="" className="chat-in py-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-fg">{c.archived}</h3>
        <button type="button" onClick={onBack} className="min-h-11 rounded-full px-3 text-[14px] text-fg-2 hover:text-fg">
          {c.back}
        </button>
      </div>
      {sessions === null ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-fg-2">
          <SealLoader size={14} className="text-accent" />
          {c.loading}
        </p>
      ) : sessions.length === 0 ? (
        <p className="mt-3 max-w-[56ch] text-sm leading-[1.6] text-fg-3">{c.archivedEmpty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {sessions.map((s) => (
            <li key={s.id} data-chat-archived-row={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-0 py-1">
              <button type="button" onClick={() => onOpen(s.id)} className="min-h-11 min-w-0 flex-1 basis-48 truncate rounded-lg text-left text-[14.5px] text-fg hover:text-accent-ink">
                {s.title ?? c.untitled}
              </button>
              <button type="button" onClick={() => onUnarchive(s.id)} className="min-h-11 rounded-full px-3 text-[13.5px] text-fg-2 hover:bg-line hover:text-fg">
                {c.unarchive}
              </button>
              <button type="button" onClick={() => onDelete(s.id)} className="min-h-11 rounded-full px-3 text-[13.5px] text-fg-3 hover:bg-line hover:text-accent-ink">
                {c.delete}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DialogShell({ open, onClose, title, children, describedBy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; describedBy?: string }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-backdrop fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          {...(describedBy ? { 'aria-describedby': describedBy } : { 'aria-describedby': undefined })}
          className="dialog-panel card fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto p-7 shadow-[0_40px_80px_-24px_rgb(0_0_0/0.7)] outline-none max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:rounded-t-[22px] max-sm:px-5 max-sm:pb-[calc(1.75rem+env(safe-area-inset-bottom))] sm:top-1/2 sm:left-1/2 sm:w-[min(460px,calc(100%-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[22px]"
        >
          <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded bg-[var(--raised-line)] sm:hidden" />
          <DialogPrimitive.Title className="headline text-[22px] break-words">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Says what will happen before it happens: a sealed chat loses its words and keeps its fingerprints; any other is gone. */
export function DeleteChatDialog({ title, sealed, onClose, onConfirm }: { title: string | null; sealed: boolean; onClose: () => void; onConfirm: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <DialogShell open title={c.deleteTitle} describedBy="delete-chat-note" onClose={() => !busy && onClose()}>
      <div id="delete-chat-note" data-chat-delete-note={sealed ? 'sealed' : 'plain'} className="mt-3 text-[14.5px] leading-[1.6] text-fg-2">
        {title ? <p className="mb-2 truncate text-fg">{title}</p> : null}
        <p>{sealed ? c.deleteSealed : c.deletePlain}</p>
      </div>
      {failed ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {c.deleteFailed}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {c.deleteKeep}
        </Button>
        <Button
          type="button"
          data-chat-delete-confirm=""
          busy={busy}
          className="border-danger bg-danger text-bg hover:border-danger hover:bg-danger/90"
          onClick={() => {
            setBusy(true);
            setFailed(false);
            void onConfirm().then((ok) => {
              setBusy(false);
              if (ok) onClose();
              else setFailed(true);
            });
          }}
        >
          {busy ? c.deleting : c.deleteConfirm}
        </Button>
      </div>
    </DialogShell>
  );
}

export function RenameChatDialog({ title, onClose, onSave }: { title: string; onClose: () => void; onSave: (title: string) => Promise<boolean> }) {
  const [value, setValue] = useState(title);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <DialogShell open title={c.renameTitle} onClose={() => !busy && onClose()}>
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() === '' || busy) return;
          setBusy(true);
          setFailed(false);
          void onSave(value).then((ok) => {
            setBusy(false);
            if (ok) onClose();
            else setFailed(true);
          });
        }}
      >
        <label htmlFor="rename-chat" className="text-sm text-fg-2">
          {c.renameLabel}
        </label>
        <Input id="rename-chat" className="mt-2" value={value} maxLength={CHAT_TITLE_MAX} autoComplete="off" onChange={(e) => setValue(e.target.value)} disabled={busy} />
        {failed ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {c.deleteFailed}
          </p>
        ) : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {c.close}
          </Button>
          <Button type="submit" busy={busy} disabled={value.trim() === ''}>
            {busy ? c.saving : c.save}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
