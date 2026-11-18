import { Archive, ArchiveRestore, Pencil, Pin, PinOff, Plus, Search, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ConversationListItem } from '@shared/types';
import { relativeTime } from '../lib/tree';
import { useStore } from '../store';
import { Button, IconButton, Logo, cx } from './ui';

function Item({ c }: { c: ConversationListItem }) {
  const active = useStore((s) => s.currentId === c.id);
  const streaming = useStore((s) => !!s.streams[c.id]);
  const select = useStore((s) => s.select);
  const patch = useStore((s) => s.patchConversation);
  const remove = useStore((s) => s.removeConversation);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [title, setTitle] = useState(c.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const commit = () => {
    setRenaming(false);
    if (title.trim() && title.trim() !== c.title) void patch({ title: title.trim() }, c.id);
    else setTitle(c.title);
  };

  return (
    <div
      className={cx('group relative rounded-md', active ? 'bg-hover' : 'hover:bg-hover/60', c.archived && 'opacity-60')}
      data-conversation-id={c.id}
    >
      {active && <span aria-hidden className="brand-bright absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full" />}
      {renaming ? (
        <input
          ref={input}
          className="field m-1 !w-[calc(100%-8px)] !py-1"
          value={title}
          aria-label="Conversation title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setTitle(c.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <>
          <button type="button" className="block w-full px-2.5 py-1.5 text-left" onClick={() => void select(c.id)} onDoubleClick={() => setRenaming(true)} aria-current={active}>
            <span className="flex items-center gap-1.5">
              {c.pinned && <Pin size={11} className="shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {streaming ? (
                <span className="brand-bright h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" aria-label="Generating" />
              ) : (
                <span className="shrink-0 text-[11px] text-faint group-hover:invisible">{relativeTime(c.updatedAt)}</span>
              )}
            </span>
            {c.snippet && <span className="block truncate text-[11.5px] text-muted">{c.snippet}</span>}
          </button>
          <div className="absolute top-0.5 right-1 hidden items-center rounded-md bg-hover group-focus-within:flex group-hover:flex">
            <IconButton label={c.pinned ? 'Unpin' : 'Pin'} className="h-6 w-6" onClick={() => void patch({ pinned: !c.pinned }, c.id)}>
              {c.pinned ? <PinOff size={12} /> : <Pin size={12} />}
            </IconButton>
            <IconButton label="Rename" className="h-6 w-6" onClick={() => setRenaming(true)}>
              <Pencil size={12} />
            </IconButton>
            <IconButton label={c.archived ? 'Unarchive' : 'Archive'} className="h-6 w-6" onClick={() => void patch({ archived: !c.archived }, c.id)}>
              {c.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}
            </IconButton>
            <IconButton
              label={confirming ? 'Click again to delete' : 'Delete'}
              className={cx('h-6 w-6', confirming && '!bg-danger-soft !text-danger')}
              onClick={() => (confirming ? void remove(c.id) : setConfirming(true))}
            >
              <Trash2 size={12} />
            </IconButton>
          </div>
        </>
      )}
    </div>
  );
}

export function Sidebar() {
  const conversations = useStore((s) => s.conversations);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const newChat = useStore((s) => s.newChat);
  const openSettings = useStore((s) => s.openSettings);

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-panel" aria-label="Conversations">
      <div className="px-3.5 pt-3.5 pb-1">
        <Logo size={24} />
      </div>
      <div className="flex items-center gap-2 p-2.5">
        <Button className="flex-1" onClick={() => void newChat()} title="New chat (Ctrl+N)">
          <Plus size={14} /> New chat
        </Button>
        <IconButton label="Settings (Ctrl+,)" onClick={() => openSettings('providers')} className="h-8 w-8">
          <SettingsIcon size={15} />
        </IconButton>
      </div>
      <div className="relative px-2.5 pb-2">
        <Search size={13} className="pointer-events-none absolute top-2 left-5 text-faint" />
        <input className="field !pl-7 text-[13px]" placeholder="Search titles and messages" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search conversations" />
      </div>
      <div className="min-h-0 flex-1 space-y-px overflow-y-auto px-1.5 pb-2">
        {conversations.map((c) => (
          <Item key={c.id} c={c} />
        ))}
        {conversations.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-faint">{search ? 'No conversations match.' : 'No conversations yet.'}</div>}
      </div>
    </aside>
  );
}
