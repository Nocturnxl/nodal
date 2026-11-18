import { ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AttachmentRef, Conversation, ModelInfo } from '@shared/types';
import { relay } from '../lib/ipc';
import { formatTokens } from '../lib/tree';
import { useStore } from '../store';
import { IconButton, cx } from './ui';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

interface Pending extends AttachmentRef {
  preview: string;
}

export function Composer({ conversation, model, providerName }: { conversation: Conversation; model: ModelInfo | undefined; providerName: string }) {
  const id = conversation.id;
  const draft = useStore((s) => s.drafts[id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const streaming = useStore((s) => !!s.streams[id]);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const focusTick = useStore((s) => s.focusTick);
  const setPicker = useStore((s) => s.setPicker);
  const toastError = useStore((s) => s.toastError);
  const status = useStore((s) => s.status[conversation.providerId]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Vision gates the attach button: hidden when the model lacks it, marked "unverified" when unknown.
  const vision = model?.capabilities.vision;
  const canAttach = vision !== false;

  useEffect(() => {
    ref.current?.focus();
  }, [focusTick, id]);

  const idRef = useRef(id);
  idRef.current = id;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [draft]);

  // Storing an attachment is asynchronous. `adding` tracks work in flight and
  // `pendingRef` mirrors the list, so pressing Enter straight after attaching
  // waits for the image instead of sending the message without it.
  const adding = useRef<Promise<void>>(Promise.resolve());
  const pendingRef = useRef<Pending[]>([]);
  const updatePending = (fn: (list: Pending[]) => Pending[]) => {
    pendingRef.current = fn(pendingRef.current);
    setPending(pendingRef.current);
  };
  useEffect(() => {
    pendingRef.current = [];
    setPending([]);
  }, [id]);

  const addFiles = (files: Iterable<File>): Promise<void> => {
    const list = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
    const forConversation = id;
    adding.current = adding.current.then(async () => {
      for (const f of list) {
        try {
          const data = new Uint8Array(await f.arrayBuffer());
          const added = await relay.attachments.add(f.type, data);
          if (forConversation !== idRef.current) return; // the user moved to another chat meanwhile
          const preview = URL.createObjectURL(new Blob([data], { type: f.type }));
          updatePending((p) => (p.some((x) => x.sha256 === added.sha256) ? p : [...p, { ...added, preview }]));
        } catch (e) {
          toastError('Could not attach the image', e);
        }
      }
    });
    return adding.current;
  };

  const submitting = useRef(false);
  const submit = async () => {
    if (streaming || submitting.current) return;
    submitting.current = true;
    try {
      await adding.current;
      const text = useStore.getState().drafts[id] ?? '';
      const atts = pendingRef.current;
      if (!text.trim() && atts.length === 0) return;
      setDraft(id, '');
      updatePending(() => []);
      const ok = await send(text, atts);
      if (!ok) {
        setDraft(id, text);
        updatePending(() => atts);
      }
    } finally {
      submitting.current = false;
    }
  };

  const rl = status?.rateLimit;
  return (
    <div className="mx-auto w-full max-w-[820px] px-6 pb-3">
      <div
        className={cx('rounded-2xl border bg-raised shadow-sm transition-colors', dragging ? 'border-accent' : 'border-line focus-within:border-accent')}
        onDragOver={(e) => {
          if (canAttach && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (!canAttach || !e.dataTransfer.files.length) return;
          e.preventDefault();
          void addFiles(e.dataTransfer.files);
        }}
      >
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {pending.map((p) => (
              <div key={p.sha256} className="relative">
                <img src={p.preview} alt="Attachment preview" className="h-16 w-16 rounded-md border border-line object-cover" />
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => updatePending((list) => list.filter((x) => x.sha256 !== p.sha256))}
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-raised text-muted hover:text-fg"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={draft}
          placeholder="Message…"
          aria-label="Message"
          className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14.5px] leading-relaxed outline-none placeholder:text-faint"
          onChange={(e) => setDraft(id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => IMAGE_TYPES.includes(f.type));
            if (files.length && canAttach) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          {canAttach && (
            <>
              <IconButton label={vision === undefined ? 'Attach image (vision support unverified for this model)' : 'Attach image'} onClick={() => fileRef.current?.click()}>
                <ImagePlus size={16} />
              </IconButton>
              <input
                ref={fileRef}
                type="file"
                accept={IMAGE_TYPES.join(',')}
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) void addFiles([...e.target.files]);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <button
            type="button"
            onClick={() => setPicker(true)}
            title="Switch model (Ctrl+K)"
            className="min-w-0 truncate rounded-md px-2 py-1 text-[12.5px] text-muted hover:bg-hover hover:text-fg"
          >
            <span className="font-medium text-fg">{model?.displayName ?? conversation.modelId}</span> · {providerName}
          </button>
          <span className="ml-auto" />
          {streaming ? (
            <button
              type="button"
              aria-label="Stop"
              title="Stop (Esc)"
              onClick={() => stop(id)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-fg text-bg hover:opacity-85"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              aria-label="Send"
              title="Send (Enter)"
              disabled={!draft.trim() && pending.length === 0}
              onClick={() => void submit()}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg hover:opacity-90 disabled:bg-hover disabled:text-faint"
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex h-4 items-center justify-between gap-3 px-1 text-[11.5px] text-faint">
        <span className="truncate">
          {status?.lastUsage && `Last reply: ${formatTokens(status.lastUsage.promptTokens)} in / ${formatTokens(status.lastUsage.completionTokens)} out`}
          {model?.contextTokens ? `${status?.lastUsage ? ' · ' : ''}${formatTokens(model.contextTokens)} context` : ''}
        </span>
        <span className="flex shrink-0 gap-3">
          {status?.balance && (
            <span title="Balance reported by the provider before the last request ran">
              Balance {Object.entries(status.balance).map(([k, v]) => `${Number(v).toFixed(2)} ${k}`).join(' · ')}
            </span>
          )}
          {rl?.remainingRequests !== undefined && (
            <span title={rl.resetRequestsAt ? `Resets ${new Date(rl.resetRequestsAt).toLocaleTimeString()}` : undefined}>
              {rl.remainingRequests}
              {rl.limitRequests !== undefined ? `/${rl.limitRequests}` : ''} requests left
            </span>
          )}
          {rl?.remainingTokens !== undefined && <span>{formatTokens(rl.remainingTokens)} tokens left</span>}
        </span>
      </div>
    </div>
  );
}
