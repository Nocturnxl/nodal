import { ChevronLeft, ChevronRight, CornerDownRight, Pencil, RefreshCw } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import type { Message, NormalizedError } from '@shared/types';
import { relay } from '../lib/ipc';
import { formatTokens, textOf } from '../lib/tree';
import { currentPath, useStore } from '../store';
import { Markdown } from './Markdown';
import { Badge, Button, CopyButton, ErrorDetails, IconButton } from './ui';

const blobCache = new Map<string, string>();

export function AttachmentImage({ sha256, className }: { sha256: string; className?: string }) {
  const [url, setUrl] = useState<string | undefined>(blobCache.get(sha256));
  useEffect(() => {
    if (blobCache.has(sha256)) return setUrl(blobCache.get(sha256));
    let alive = true;
    void relay.attachments.get(sha256).then((res) => {
      if (!res) return;
      const u = URL.createObjectURL(new Blob([res.data as BlobPart], { type: res.mime }));
      blobCache.set(sha256, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [sha256]);
  if (!url) return <div className={className ?? 'h-24 w-24 rounded-md bg-hover'} />;
  return <img src={url} alt="Attached image" className={className ?? 'max-h-64 max-w-full rounded-md border border-line'} />;
}

function BranchSwitcher({ message, siblings }: { message: Message; siblings: string[] }) {
  const switchBranch = useStore((s) => s.switchBranch);
  const busy = useStore((s) => !!s.streams[message.conversationId]);
  const i = siblings.indexOf(message.id);
  if (siblings.length < 2) return null;
  return (
    <span className="inline-flex items-center text-[12px] text-muted" aria-label="Branches of this message">
      <IconButton label="Previous version" disabled={i <= 0 || busy} onClick={() => void switchBranch(siblings[i - 1])} className="h-6 w-6">
        <ChevronLeft size={14} />
      </IconButton>
      <span className="tabular-nums">
        {i + 1}/{siblings.length}
      </span>
      <IconButton label="Next version" disabled={i >= siblings.length - 1 || busy} onClick={() => void switchBranch(siblings[i + 1])} className="h-6 w-6">
        <ChevronRight size={14} />
      </IconButton>
    </span>
  );
}

function RetryNote({ until, attempt, error }: { until: number; attempt: number; error: NormalizedError }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const why = error.code === 'rate_limit' ? 'Rate limited' : error.code === 'server' ? `Provider error${error.status ? ` (HTTP ${error.status})` : ''}` : 'Network problem';
  return (
    <div className="text-[12.5px] text-warn">
      {why}. Retrying{secs > 0 ? ` in ${secs} s` : ' now'} (attempt {attempt})…
    </div>
  );
}

const FINISH_LABEL: Record<string, string> = {
  cancelled: 'Stopped',
  incomplete: 'Incomplete',
  interrupted: 'Interrupted',
  length: 'Hit max tokens',
  content_filter: 'Filtered',
};

function ErrorActions({ message, error }: { message: Message; error: NormalizedError }) {
  const openSettings = useStore((s) => s.openSettings);
  const setPicker = useStore((s) => s.setPicker);
  const regenerate = useStore((s) => s.regenerate);
  const patch = useStore((s) => s.patchConversation);
  const detail = useStore((s) => s.detail);

  const trimAndRetry = async () => {
    if (!detail) return;
    const chars = currentPath(detail).reduce((n, m) => n + textOf(m.content).length, 0) + (detail.conversation.systemPrompt?.length ?? 0);
    const limit = Math.max(512, Math.floor((chars / 4) * 0.6));
    await patch({ params: { ...detail.conversation.params, contextLimit: limit } });
    await regenerate(message.id);
  };

  return (
    <>
      {error.code === 'auth' && message.providerId && (
        <Button size="sm" variant="primary" onClick={() => openSettings('providers', message.providerId)}>
          Re-enter key
        </Button>
      )}
      {error.code === 'model_not_found' && (
        <Button size="sm" onClick={() => setPicker(true)}>
          Choose another model
        </Button>
      )}
      {error.code === 'context_length' && (
        <Button size="sm" variant="primary" onClick={() => void trimAndRetry()}>
          Drop oldest turns and retry
        </Button>
      )}
    </>
  );
}

interface Props {
  message: Message;
  siblings: string[];
}

export const MessageItem = memo(function MessageItem({ message, siblings }: Props) {
  const streaming = useStore((s) => s.streams[message.conversationId]?.messageId === message.id);
  const busy = useStore((s) => !!s.streams[message.conversationId]);
  const live = useStore((s) => s.live[message.id]);
  const regenerate = useStore((s) => s.regenerate);
  const continueReply = useStore((s) => s.continueReply);
  const editAndResend = useStore((s) => s.editAndResend);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);

  const text = streaming && live ? live.text : textOf(message.content);
  const reasoning = streaming && live ? live.reasoning : (message.reasoningText ?? '');
  const usage = (streaming && live?.usage) || message.usage;
  const error = streaming ? null : message.error;
  const finish = streaming ? null : message.finishReason;
  const canContinue = !streaming && !busy && (finish === 'incomplete' || finish === 'interrupted' || finish === 'cancelled' || finish === 'length');

  useEffect(() => {
    if (editing) {
      const el = editRef.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  if (message.role === 'user') {
    const images = message.content.filter((p) => p.type === 'image');
    return (
      <div className="group flex flex-col items-end py-2.5" data-role="user" data-message-id={message.id}>
        {editing ? (
          <div className="w-full rounded-xl border border-accent bg-raised p-2">
            <textarea
              ref={editRef}
              className="block max-h-80 min-h-20 w-full resize-y bg-transparent p-1.5 outline-none"
              value={draft}
              aria-label="Edit message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(false);
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.trim()) {
                  setEditing(false);
                  void editAndResend(message.id, draft);
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-end gap-2">
              <span className="mr-auto pl-1.5 text-[12px] text-faint">Sending creates a new branch; the original stays.</span>
              <Button size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() => {
                  setEditing(false);
                  void editAndResend(message.id, draft);
                }}
              >
                Send
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel px-3.5 py-2.5">
              {images.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {images.map((p, i) => p.type === 'image' && <AttachmentImage key={i} sha256={p.sha256} />)}
                </div>
              )}
              <div className="text-[14.5px] leading-relaxed break-words whitespace-pre-wrap">{text}</div>
            </div>
            <div className="mt-0.5 flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-label^=Branches]]:opacity-100">
              <BranchSwitcher message={message} siblings={siblings} />
              <CopyButton text={text} label="Copy message" />
              <IconButton
                label="Edit and resend"
                disabled={busy}
                onClick={() => {
                  setDraft(text);
                  setEditing(true);
                }}
              >
                <Pencil size={14} />
              </IconButton>
            </div>
          </>
        )}
      </div>
    );
  }

  const waiting = streaming && !text && !reasoning;
  return (
    <div className="group py-2.5" data-role="assistant" data-message-id={message.id} data-finish={finish ?? 'streaming'}>
      {reasoning && (
        <details className="mb-2 rounded-lg border border-line bg-panel/60 text-[13px]" open={streaming && !text}>
          <summary className="cursor-pointer px-3 py-1.5 text-muted select-none">{streaming && !text ? 'Thinking…' : 'Reasoning'}</summary>
          <div className="max-h-80 overflow-y-auto border-t border-line px-3 py-2 whitespace-pre-wrap text-muted">{reasoning}</div>
        </details>
      )}
      {text && <Markdown text={text} streaming={streaming} />}
      {waiting && !live?.retry && (
        <div className="py-1.5" aria-label="Waiting for the model">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      )}
      {streaming && live?.retry && <RetryNote {...live.retry} />}
      {error && (
        <div className="mt-2">
          <ErrorDetails error={error}>
            <ErrorActions message={message} error={error} />
            {canContinue && text && (
              <Button size="sm" onClick={() => void continueReply(message.id)}>
                <CornerDownRight size={13} /> Continue
              </Button>
            )}
            <Button size="sm" disabled={busy} onClick={() => void regenerate(message.id)}>
              <RefreshCw size={13} /> {text ? 'Regenerate' : 'Retry'}
            </Button>
          </ErrorDetails>
        </div>
      )}
      {!streaming && (
        <div className="mt-1 flex min-h-7 flex-wrap items-center gap-x-1 gap-y-0.5 text-[12px] text-faint">
          <BranchSwitcher message={message} siblings={siblings} />
          {finish && FINISH_LABEL[finish] && <Badge tone={finish === 'length' ? 'neutral' : 'warn'}>{FINISH_LABEL[finish]}</Badge>}
          {!error && canContinue && (
            <Button size="sm" variant="ghost" onClick={() => void continueReply(message.id)}>
              <CornerDownRight size={13} /> Continue
            </Button>
          )}
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
            {text && <CopyButton text={text} label="Copy reply" />}
            {!error && (
              <IconButton label="Regenerate" disabled={busy} onClick={() => void regenerate(message.id)}>
                <RefreshCw size={14} />
              </IconButton>
            )}
          </span>
          <span className="ml-1 truncate" title={message.requestId ? `Request ${message.requestId}` : undefined}>
            {message.modelId}
            {usage && ` · ${formatTokens(usage.promptTokens)} in / ${formatTokens(usage.completionTokens)} out`}
          </span>
        </div>
      )}
    </div>
  );
});
