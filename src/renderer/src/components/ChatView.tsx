import { ChevronDown, Download, PanelRight, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { nodal } from '../lib/ipc';
import { currentPath, findModel, useStore } from '../store';
import { Composer } from './Composer';
import { Inspector } from './Inspector';
import { MessageList } from './MessageList';
import { Button, IconButton, Logo } from './ui';

function EmptyState() {
  const providers = useStore((s) => s.providers);
  const setPicker = useStore((s) => s.setPicker);
  const setWelcome = useStore((s) => s.setWelcome);
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="brand-glow flex max-w-sm flex-col items-center px-16 py-14 text-center">
        <Logo size={64} wordmark={false} className="mb-5" />
        <div className="text-[18px] font-semibold">No conversation open</div>
        <p className="mt-1 text-muted">{providers.length ? 'Pick a model to start a new chat.' : 'Connect a provider to start chatting.'}</p>
        <Button variant="primary" className="mt-4" onClick={() => (providers.length ? setPicker(true) : setWelcome(true))}>
          {providers.length ? 'Choose a model' : 'Connect a provider'}
        </Button>
      </div>
    </div>
  );
}

export function ChatView() {
  const detail = useStore((s) => s.detail);
  const models = useStore((s) => s.models);
  const providers = useStore((s) => s.providers);
  const inspectorOpen = useStore((s) => s.settings.inspectorOpen);
  const setSettings = useStore((s) => s.setSettings);
  const setPicker = useStore((s) => s.setPicker);
  const toast = useStore((s) => s.toast);
  const toastError = useStore((s) => s.toastError);
  const notice = useStore((s) => (detail ? s.status[detail.conversation.providerId]?.notice : undefined));
  const path = useMemo(() => currentPath(detail), [detail]);

  if (!detail) return <EmptyState />;
  const conv = detail.conversation;
  const model = findModel(models, conv.providerId, conv.modelId);
  const provider = providers.find((p) => p.id === conv.providerId);
  const listed = models[conv.providerId];
  const missing = listed && !listed.error && listed.models.length > 0 && !model;

  const exportAs = async (format: 'markdown' | 'json') => {
    try {
      const file = await nodal.data.exportConversation(conv.id, format);
      if (file) toast({ kind: 'success', title: `Exported to ${file}` });
    } catch (e) {
      toastError('Export failed', e);
    }
  };

  return (
    <div className="flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{conv.title}</h1>
          <button
            type="button"
            onClick={() => setPicker(true)}
            title="Switch model (Ctrl+K)"
            className="flex max-w-[45%] items-center gap-1 rounded-md border border-line px-2 py-1 text-[12.5px] hover:bg-hover"
          >
            <span className="truncate">{model?.displayName ?? conv.modelId}</span>
            {missing && <TriangleAlert size={12} className="shrink-0 text-warn" aria-label="Not in the current model list" />}
            <ChevronDown size={13} className="shrink-0 text-muted" />
          </button>
          <IconButton label="Export as Markdown" onClick={() => void exportAs('markdown')}>
            <Download size={15} />
          </IconButton>
          <IconButton label={inspectorOpen ? 'Hide inspector (Ctrl+I)' : 'Show inspector (Ctrl+I)'} onClick={() => void setSettings({ inspectorOpen: !inspectorOpen })} aria-pressed={inspectorOpen}>
            <PanelRight size={15} />
          </IconButton>
        </header>

        {notice && notice.modelId === conv.modelId && (
          <div className="flex items-center gap-3 border-b border-line bg-warn-soft px-4 py-2 text-[13px] text-warn" role="status">
            <TriangleAlert size={14} className="shrink-0" />
            <span className="min-w-0 flex-1">
              {notice.message}
              {notice.date ? ` Retirement date: ${notice.date}.` : ''}
            </span>
            <Button size="sm" onClick={() => setPicker(true)}>
              Choose another model
            </Button>
          </div>
        )}

        {path.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="brand-glow flex flex-col items-center px-20 py-16 text-center">
              <Logo size={72} wordmark={false} className="mb-5" />
              <div className="text-[20px] font-semibold tracking-tight">{model?.displayName ?? conv.modelId}</div>
              <p className="mt-1 text-muted">
                {provider?.displayName ?? 'Unknown provider'}
                {missing ? ' · not in the current model list' : ''}
              </p>
            </div>
          </div>
        ) : (
          <MessageList conversationId={conv.id} path={path} all={detail.messages} />
        )}

        <Composer conversation={conv} model={model} providerName={provider?.displayName ?? 'Unknown provider'} />
      </main>
      {inspectorOpen && <Inspector conversation={conv} model={model} />}
    </div>
  );
}
