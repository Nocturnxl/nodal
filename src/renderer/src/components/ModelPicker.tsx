import { Brain, Eye, Globe, Plus, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITY_KEYS, type CapabilityKey, type ModelInfo } from '@shared/types';
import { relay } from '../lib/ipc';
import { formatTokens } from '../lib/tree';
import { useStore } from '../store';
import { Badge, Button, IconButton, cx } from './ui';

const CAP_LABEL: Record<CapabilityKey, string> = {
  vision: 'Vision',
  reasoning: 'Reasoning',
  tools: 'Tools',
  structuredOutput: 'Structured output',
  webSearch: 'Web search',
};

function CapBadges({ m }: { m: ModelInfo }) {
  const c = m.capabilities;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted">
      {c.vision && <Eye size={13} aria-label="Vision" />}
      {c.reasoning && <Brain size={13} aria-label="Reasoning" />}
      {c.tools && <Wrench size={13} aria-label="Tools" />}
      {c.webSearch && <Globe size={13} aria-label="Web search" />}
    </span>
  );
}

function price(n: number | undefined): string {
  return n === undefined ? '?' : n === 0 ? 'free' : `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

function Detail({ m, providerName, current }: { m: ModelInfo; providerName: string; current: boolean }) {
  const loadModels = useStore((s) => s.loadModels);
  const toastError = useStore((s) => s.toastError);
  const setOverride = async (key: CapabilityKey, value: 'auto' | 'yes' | 'no') => {
    const reported = m.reportedCapabilities ?? {};
    const overrides: Record<string, boolean> = {};
    for (const k of CAPABILITY_KEYS) {
      const v = k === key ? (value === 'auto' ? undefined : value === 'yes') : m.capabilities[k] !== reported[k] ? m.capabilities[k] : undefined;
      if (v !== undefined) overrides[k] = v;
    }
    try {
      await relay.models.setOverride(m.providerId, m.id, Object.keys(overrides).length ? overrides : null);
      await loadModels(m.providerId);
    } catch (e) {
      toastError('Could not save the override', e);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 text-[13px]">
      <div>
        <div className="text-[15px] font-semibold">{m.displayName}</div>
        <div className="font-mono text-[11.5px] break-all text-muted">{m.id}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge>{providerName}</Badge>
          {current && <Badge tone="accent">Current</Badge>}
          {m.manual && <Badge tone="warn">Entered by hand</Badge>}
          {m.details?.offline && <Badge tone="danger">Offline</Badge>}
          {m.details?.beta && <Badge tone="warn">Beta</Badge>}
          {m.details?.traits?.map((t) => <Badge key={t}>{t}</Badge>)}
        </div>
      </div>
      {m.details?.description && <p className="text-muted">{m.details.description}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">Context</dt>
        <dd>{m.contextTokens ? `${formatTokens(m.contextTokens)} tokens` : 'Not reported'}</dd>
        <dt className="text-muted">Pricing</dt>
        <dd>{m.pricing ? `${price(m.pricing.inputPerM)} in · ${price(m.pricing.outputPerM)} out per 1M tokens` : 'Not reported'}</dd>
        {m.details?.privacy && (
          <>
            <dt className="text-muted">Privacy</dt>
            <dd>
              {m.details.privacy} <span className="text-faint">(the provider's claim; not verified by Relay)</span>
            </dd>
          </>
        )}
      </dl>
      <div>
        <div className="mb-1 text-[12px] font-medium text-muted">Capabilities</div>
        <div className="grid gap-1">
          {CAPABILITY_KEYS.map((k) => {
            const reported = m.reportedCapabilities?.[k];
            const effective = m.capabilities[k];
            const overridden = effective !== reported;
            return (
              <label key={k} className="flex items-center justify-between gap-2">
                <span>
                  {CAP_LABEL[k]}{' '}
                  <span className="text-faint">{reported === undefined ? '(unverified)' : reported ? '(reported)' : '(not supported)'}</span>
                </span>
                <select
                  className="field !w-24 !py-0.5 text-[12.5px]"
                  aria-label={`${CAP_LABEL[k]} override`}
                  value={overridden ? (effective ? 'yes' : 'no') : 'auto'}
                  onChange={(e) => void setOverride(k, e.target.value as 'auto' | 'yes' | 'no')}
                >
                  <option value="auto">Auto</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </label>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11.5px] text-faint">Override when the provider reports nothing or gets it wrong. Unverified capabilities stay enabled.</p>
      </div>
    </div>
  );
}

export function ModelPicker() {
  const open = useStore((s) => s.pickerOpen);
  const setPicker = useStore((s) => s.setPicker);
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const conv = useStore((s) => s.detail?.conversation);
  const chooseModel = useStore((s) => s.chooseModel);
  const loadModels = useStore((s) => s.loadModels);
  const openSettings = useStore((s) => s.openSettings);
  const toastError = useStore((s) => s.toastError);
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setFocus(conv ? `${conv.providerId}\n${conv.modelId}` : null);
    }
  }, [open, conv]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return providers.map((p) => {
      const all = models[p.id]?.models ?? [];
      const list = needle ? all.filter((m) => m.id.toLowerCase().includes(needle) || m.displayName.toLowerCase().includes(needle)) : all;
      return { provider: p, list, result: models[p.id], exact: all.some((m) => m.id === q.trim()) };
    });
  }, [providers, models, q]);

  const flat = useMemo(() => groups.flatMap((g) => g.list.map((m) => ({ key: `${g.provider.id}\n${m.id}`, m, provider: g.provider }))), [groups]);
  const focused = flat.find((f) => f.key === focus) ?? flat[0];
  const missing = conv && !models[conv.providerId]?.models.some((m) => m.id === conv.modelId);

  const move = (delta: number) => {
    if (!flat.length) return;
    const i = Math.max(0, flat.findIndex((f) => f.key === focused?.key));
    const next = flat[(i + delta + flat.length) % flat.length];
    setFocus(next.key);
    listRef.current?.querySelector(`[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const addManual = async (providerId: string) => {
    const id = q.trim();
    if (!id) return;
    try {
      await relay.models.addManual(providerId, id);
      await loadModels(providerId);
      await chooseModel(providerId, id);
    } catch (e) {
      toastError('Could not add the model', e);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await Promise.all(providers.map((p) => loadModels(p.id, true)));
    setRefreshing(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setPicker}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pop-in fixed top-[9vh] left-1/2 z-50 flex h-[min(620px,80vh)] w-[min(860px,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-line bg-bg shadow-[var(--shadow)] outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter' && focused && (e.target as HTMLElement).tagName === 'INPUT') {
              e.preventDefault();
              void chooseModel(focused.provider.id, focused.m.id);
            }
          }}
        >
          <Dialog.Title className="sr-only">Choose a model</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={15} className="text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search models, or type a model ID to add it"
              aria-label="Search models"
              className="h-7 min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            />
            <IconButton label="Refresh model lists" onClick={() => void refreshAll()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
            </IconButton>
          </div>
          <div className="flex min-h-0 flex-1">
            <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Models">
              {providers.length === 0 && (
                <div className="p-6 text-center text-muted">
                  No providers yet.{' '}
                  <button type="button" className="text-accent underline" onClick={() => (setPicker(false), openSettings('providers'))}>
                    Add one
                  </button>
                </div>
              )}
              {missing && conv && (
                <div className="mx-1.5 mb-1.5 rounded-md bg-warn-soft px-2.5 py-1.5 text-[12.5px] text-warn">
                  <span className="font-mono">{conv.modelId}</span> is not in the current list. The chat keeps using it; any error from the API will be shown.
                </div>
              )}
              {groups.map((g) => (
                <div key={g.provider.id} className="mb-1.5">
                  <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1 text-[11.5px] font-semibold tracking-wide text-muted uppercase">
                    <span>{g.provider.displayName}</span>
                    <span className="font-normal normal-case">{g.result ? `${g.result.models.length} models` : 'loading…'}</span>
                  </div>
                  {g.result?.error && (
                    <div className="mx-1.5 mb-1 rounded-md bg-danger-soft px-2.5 py-1.5 text-[12.5px]">
                      <span className="text-danger">Could not refresh the model list.</span> {g.result.error.message}
                      {g.result.error.status ? ` (HTTP ${g.result.error.status})` : ''} Type a model ID above to use it anyway.
                    </div>
                  )}
                  {g.list.map((m) => {
                    const key = `${g.provider.id}\n${m.id}`;
                    const isCurrent = conv?.providerId === g.provider.id && conv.modelId === m.id;
                    return (
                      <div
                        key={key}
                        data-key={key}
                        role="option"
                        aria-selected={focused?.key === key}
                        tabIndex={-1}
                        onMouseEnter={() => setFocus(key)}
                        onClick={() => void chooseModel(g.provider.id, m.id)}
                        className={cx(
                          'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5',
                          focused?.key === key && 'bg-hover',
                          m.details?.offline && 'opacity-50',
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {m.displayName}
                          {isCurrent && <span className="ml-1.5 text-[11.5px] text-accent">current</span>}
                          {m.details?.offline && <span className="ml-1.5 text-[11.5px] text-danger">offline</span>}
                        </span>
                        <CapBadges m={m} />
                        <span className="w-12 shrink-0 text-right text-[11.5px] text-faint tabular-nums">{m.contextTokens ? formatTokens(m.contextTokens) : ''}</span>
                        {m.manual && (
                          <IconButton
                            label="Remove hand-entered model"
                            className="h-6 w-6"
                            onClick={(e) => {
                              e.stopPropagation();
                              void relay.models.removeManual(g.provider.id, m.id).then(() => loadModels(g.provider.id));
                            }}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        )}
                      </div>
                    );
                  })}
                  {q.trim() && !g.exact && (
                    <button
                      type="button"
                      onClick={() => void addManual(g.provider.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-hover hover:text-fg"
                    >
                      <Plus size={13} /> Use “<span className="font-mono text-[12.5px]">{q.trim()}</span>” as a model ID
                    </button>
                  )}
                  {!q.trim() && g.result && g.list.length === 0 && !g.result.error && (
                    <div className="px-2.5 py-1.5 text-[12.5px] text-faint">No models listed. Type a model ID above to add one by hand.</div>
                  )}
                </div>
              ))}
            </div>
            <div className="hidden w-[310px] shrink-0 border-l border-line bg-panel/50 sm:block">
              {focused ? (
                <Detail m={focused.m} providerName={focused.provider.displayName} current={conv?.providerId === focused.provider.id && conv.modelId === focused.m.id} />
              ) : (
                <div className="p-4 text-muted">Pick a model to see its details.</div>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11.5px] text-faint">
            <span>↑↓ to move · Enter to select · Esc to close</span>
            <Button size="sm" variant="ghost" onClick={() => (setPicker(false), openSettings('providers'))}>
              Manage providers
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
