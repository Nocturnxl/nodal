import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useState } from 'react';
import type { Preset } from '@shared/presets';
import type { AppInfo, KeyCheck, ProviderConfig } from '@shared/types';
import { parseIpcError, nodal } from '../lib/ipc';
import { relativeTime } from '../lib/tree';
import { useStore, type SettingsSection } from '../store';
import { ProviderForm } from './ProviderForm';
import { EncryptedExport, ImportButton, SecuritySettings } from './Security';
import { Badge, Button, ErrorDetails, IconButton, Label, Logo, Segmented, Switch, cx } from './ui';
import { PresetList } from './Welcome';

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'providers', label: 'Providers' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
  { id: 'security', label: 'Security' },
  { id: 'network', label: 'Network' },
  { id: 'about', label: 'About' },
];

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {hint && <div className="text-[12.5px] text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ProviderEditor({ provider, onDeleted }: { provider: ProviderConfig; onDeleted(): void }) {
  const refreshProviders = useStore((s) => s.refreshProviders);
  const loadModels = useStore((s) => s.loadModels);
  const refreshConversations = useStore((s) => s.refreshConversations);
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const keyStatus = useStore((s) => s.keyStatus[provider.id]);
  const toast = useStore((s) => s.toast);
  const toastError = useStore((s) => s.toastError);
  const [test, setTest] = useState<KeyCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [usage, setUsage] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [target, setTarget] = useState('');

  const result = models[provider.id];
  useEffect(() => {
    setTest(null);
    setConfirmDelete(false);
    void nodal.providers.usage(provider.id).then((u) => setUsage(u.conversations));
    // Opening a provider refreshes its model list.
    void loadModels(provider.id, true);
  }, [provider.id, loadModels]);

  const others = providers.filter((p) => p.id !== provider.id);
  const targets = others.flatMap((p) => (models[p.id]?.models ?? []).map((m) => ({ value: `${p.id}\n${m.id}`, label: `${p.displayName} · ${m.displayName}` })));

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toastError('That did not work', e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <ProviderForm initial={provider} submitLabel="Save and connect" onConnected={() => toast({ kind: 'success', title: `${provider.displayName} saved` })} />

      <div className="rounded-lg border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!!busy} onClick={() => run('test', async () => setTest(await nodal.providers.test(provider.id)))}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </Button>
          <Button size="sm" disabled={!!busy} onClick={() => run('refresh', async () => void (await loadModels(provider.id, true)))}>
            <RefreshCw size={13} className={busy === 'refresh' ? 'animate-spin' : undefined} /> Refresh models
          </Button>
          {keyStatus?.present && (
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() =>
                run('clear', async () => {
                  await nodal.keys.clear(provider.id);
                  await refreshProviders();
                })
              }
            >
              Remove key
            </Button>
          )}
          <span className="ml-auto text-[12px] text-faint">
            {result ? `${result.models.length} models${result.fetchedAt ? ` · updated ${relativeTime(result.fetchedAt)}` : ''}` : ''}
          </span>
        </div>
        {test && (
          <div className="mt-2.5">
            {test.ok ? (
              <div className="rounded-md bg-ok-soft p-2 text-[13px] text-ok" role="status">
                Connection works{test.modelCount !== undefined ? `: ${test.modelCount} models` : ''}.
              </div>
            ) : (
              test.error && <ErrorDetails error={test.error} compact />
            )}
          </div>
        )}
        {result?.error && !test && (
          <div className="mt-2.5">
            <ErrorDetails error={result.error} compact />
          </div>
        )}
      </div>

      <div className="rounded-lg border border-line p-3">
        {!confirmDelete ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-muted">
              {usage > 0 ? `${usage} conversation${usage === 1 ? ' uses' : 's use'} this provider.` : 'No conversations use this provider.'}
            </span>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={13} /> Remove provider
            </Button>
          </div>
        ) : usage > 0 ? (
          <div className="space-y-2.5 text-[13px]">
            <p>
              {usage} conversation{usage === 1 ? ' still uses' : 's still use'} <b>{provider.displayName}</b>. Move them to another model first, or delete them from the sidebar.
            </p>
            {targets.length > 0 ? (
              <div className="flex gap-2">
                <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Move conversations to">
                  <option value="">Move them to…</option>
                  {targets.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <Button
                  variant="primary"
                  disabled={!target || !!busy}
                  onClick={() =>
                    run('reassign', async () => {
                      const [pid, mid] = target.split('\n');
                      await nodal.providers.reassign(provider.id, pid, mid);
                      setUsage(0);
                      await refreshConversations();
                      const cur = useStore.getState().currentId;
                      if (cur) await useStore.getState().select(cur);
                    })
                  }
                >
                  Move
                </Button>
              </div>
            ) : (
              <p className="text-muted">Add another provider to move them to.</p>
            )}
            <Button size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span>
              Remove <b>{provider.displayName}</b> and delete its stored key?
            </span>
            <span className="flex gap-2">
              <Button size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!!busy}
                onClick={() =>
                  run('delete', async () => {
                    await nodal.providers.delete(provider.id);
                    await refreshProviders();
                    onDeleted();
                  })
                }
              >
                Remove
              </Button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Providers() {
  const providers = useStore((s) => s.providers);
  const keyStatus = useStore((s) => s.keyStatus);
  const initialId = useStore((s) => s.settingsProviderId);
  const [selected, setSelected] = useState<string | null>(initialId ?? providers[0]?.id ?? null);
  const [adding, setAdding] = useState<Preset | 'choose' | null>(providers.length ? null : 'choose');
  const current = providers.find((p) => p.id === selected);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-52 shrink-0 flex-col border-r border-line p-2">
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => (setSelected(p.id), setAdding(null))}
              className={cx('block w-full rounded-md px-2.5 py-1.5 text-left', !adding && selected === p.id ? 'bg-hover' : 'hover:bg-hover/60')}
            >
              <span className="block truncate font-medium">{p.displayName}</span>
              <span className="block text-[11.5px] text-muted">
                {p.auth.scheme === 'none' ? 'No key needed' : keyStatus[p.id]?.present ? `Key •••• ${keyStatus[p.id]?.last4 ?? ''}` : 'No key'}
              </span>
            </button>
          ))}
        </div>
        <Button className="mt-2" onClick={() => setAdding('choose')}>
          <Plus size={14} /> Add provider
        </Button>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {adding === 'choose' && (
          <>
            <h3 className="mb-3 text-[15px] font-semibold">Add a provider</h3>
            <PresetList onPick={setAdding} />
          </>
        )}
        {adding && adding !== 'choose' && (
          <>
            <h3 className="mb-3 text-[15px] font-semibold">Connect {adding.label}</h3>
            <ProviderForm
              initial={adding.config}
              onCancel={() => setAdding(providers.length ? null : 'choose')}
              onConnected={(p) => {
                setSelected(p.id);
                setAdding(null);
              }}
            />
          </>
        )}
        {!adding && current && <ProviderEditor key={current.id} provider={current} onDeleted={() => setSelected(providers.find((p) => p.id !== current.id)?.id ?? null)} />}
        {!adding && !current && <p className="text-muted">Add a provider to get started.</p>}
      </div>
    </div>
  );
}

function Appearance() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <div className="p-5">
      <Row title="Theme" hint="System follows your operating system setting.">
        <Segmented
          label="Theme"
          value={settings.theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(theme) => void setSettings({ theme })}
        />
      </Row>
      <Row title="Render math" hint="Typeset $…$ and $$…$$ with KaTeX. Off by default.">
        <Switch label="Render math" checked={settings.mathEnabled} onChange={(mathEnabled) => void setSettings({ mathEnabled })} />
      </Row>
      <Row title="Show archived conversations" hint="Archived chats appear dimmed in the sidebar.">
        <Switch label="Show archived conversations" checked={settings.showArchived} onChange={(showArchived) => void setSettings({ showArchived })} />
      </Row>
      <div className="pt-4">
        <Label hint="Used for new chats">Default system prompt</Label>
        <textarea
          className="field min-h-24 resize-y"
          defaultValue={settings.defaultSystemPrompt}
          aria-label="Default system prompt"
          onBlur={(e) => e.target.value !== settings.defaultSystemPrompt && void setSettings({ defaultSystemPrompt: e.target.value })}
        />
      </div>
      <div className="pt-5 text-[12.5px] text-muted">
        <div className="mb-1 font-medium text-fg">Keyboard shortcuts</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          <kbd>Ctrl+N</kbd> <span>New chat</span>
          <kbd>Ctrl+K</kbd> <span>Switch model</span>
          <kbd>Ctrl+L</kbd> <span>Focus the message box</span>
          <kbd>Esc</kbd> <span>Stop the reply</span>
          <kbd>Ctrl+I</kbd> <span>Show or hide the inspector</span>
          <kbd>Ctrl+,</kbd> <span>Settings</span>
          <kbd>Ctrl+Shift+L</kbd> <span>Lock (when encryption is on)</span>
        </div>
      </div>
    </div>
  );
}

function Data() {
  const toast = useStore((s) => s.toast);
  const toastError = useStore((s) => s.toastError);
  const currentId = useStore((s) => s.currentId);
  const refresh = async () => {
    const s = useStore.getState();
    await s.refreshProviders();
    await s.refreshConversations();
    s.setSettings({});
  };
  const guard = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      toastError('That did not work', e);
    }
  };
  return (
    <div className="p-5">
      <Row title="Export this conversation" hint="Markdown holds the visible thread. JSON holds every branch.">
        <span className="flex gap-2">
          {(['markdown', 'json'] as const).map((f) => (
            <Button
              key={f}
              disabled={!currentId}
              onClick={() =>
                guard(async () => {
                  const path = await nodal.data.exportConversation(currentId!, f);
                  if (path) toast({ kind: 'success', title: `Exported to ${path}` });
                })
              }
            >
              {f === 'markdown' ? 'Markdown' : 'JSON'}
            </Button>
          ))}
        </span>
      </Row>
      <Row
        title="Export everything"
        hint="All conversations, provider settings and images. Keys are never exported. A ZIP is not encrypted, even when encryption is on; an encrypted export is protected by a passphrase of its own."
      >
        <span className="flex gap-2">
          <Button
            onClick={() =>
              guard(async () => {
                const path = await nodal.data.exportAll();
                if (path) toast({ kind: 'success', title: `Exported to ${path}` });
              })
            }
          >
            Export ZIP
          </Button>
          <EncryptedExport />
        </span>
      </Row>
      <Row title="Import" hint="Merges a NODAL export: ZIP, JSON or encrypted. Items that already exist are skipped.">
        <ImportButton
          label="Import file"
          onImported={async (r) => {
            await refresh();
            toast({
              kind: 'success',
              title: `Imported ${r.conversations} conversation${r.conversations === 1 ? '' : 's'} and ${r.messages} messages${r.skipped ? `; ${r.skipped} skipped` : ''}`,
            });
          }}
        />
      </Row>
      <Row title="Data folder" hint="The database, the vault and key files, attachments, backups and logs.">
        <Button onClick={() => void nodal.app.openDataFolder()}>Open folder</Button>
      </Row>
    </div>
  );
}

function Network() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [proxy, setProxy] = useState(settings.proxy);
  const [ttfb, setTtfb] = useState(String(settings.firstByteTimeoutSec));
  return (
    <div className="p-5">
      <Row title="Check for updates" hint="The only automatic network call besides your provider requests. Off by default.">
        <Switch label="Check for updates" checked={settings.updateCheck} onChange={(updateCheck) => void setSettings({ updateCheck })} />
      </Row>
      <Row title="Proxy" hint="Leave empty to use the system proxy. Example: http://127.0.0.1:8080 or socks5://127.0.0.1:1080">
        <input className="field !w-64 font-mono text-[12.5px]" value={proxy} placeholder="System proxy" onChange={(e) => setProxy(e.target.value)} onBlur={() => proxy !== settings.proxy && void setSettings({ proxy: proxy.trim() })} aria-label="Proxy" />
      </Row>
      <Row title="Wait for first token" hint="Seconds to wait before giving up on a reply that has not started. Reasoning models can think for a long time. 5 to 300.">
        <input
          className="field !w-20 text-right"
          inputMode="numeric"
          value={ttfb}
          aria-label="First token timeout in seconds"
          onChange={(e) => setTtfb(e.target.value)}
          onBlur={() => {
            const n = Math.min(300, Math.max(5, Math.round(Number(ttfb)) || 60));
            setTtfb(String(n));
            if (n !== settings.firstByteTimeoutSec) void setSettings({ firstByteTimeoutSec: n });
          }}
        />
      </Row>
      <p className="pt-4 text-[12.5px] text-muted">
        NODAL only connects to the providers you configure. Plaintext HTTP is allowed for this computer, and for LAN addresses only after you confirm it per provider. There is no telemetry, analytics or crash
        upload.
      </p>
    </div>
  );
}

function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    nodal.app.info().then(setInfo, (e) => setErr(parseIpcError(e).message));
  }, []);
  if (err) return <div className="p-5 text-danger">{err}</div>;
  if (!info) return null;
  return (
    <div className="p-5">
      <Logo size={40} className="mb-4" />
      <div className="text-[20px] font-semibold">
        NODAL <span className="text-[13px] font-normal text-muted">{info.version}</span> {!info.packaged && <Badge tone="warn">development build</Badge>}
      </div>
      <p className="mt-1 text-muted">A local, provider-agnostic chat client. No accounts, sync or telemetry.</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[13px]">
        <dt className="text-muted">Electron</dt>
        <dd>{info.electron}</dd>
        <dt className="text-muted">Chromium</dt>
        <dd>{info.chrome}</dd>
        <dt className="text-muted">Node</dt>
        <dd>{info.node}</dd>
        <dt className="text-muted">Platform</dt>
        <dd>{info.platform}</dd>
        <dt className="text-muted">Data folder</dt>
        <dd className="font-mono text-[12px] break-all">{info.userDataPath}</dd>
        <dt className="text-muted">Log folder</dt>
        <dd className="font-mono text-[12px] break-all">{info.logPath}</dd>
      </dl>
      <div className="mt-4 flex gap-2">
        <Button onClick={() => void nodal.app.openLogFolder()}>Open log folder</Button>
        <Button onClick={() => void nodal.app.openDataFolder()}>Open data folder</Button>
      </div>
      <p className="mt-4 text-[12.5px] text-muted">Logs hold metadata only: time, provider, model, status, request ID and token counts. Message text is never logged.</p>
    </div>
  );
}

export function SettingsDialog() {
  const section = useStore((s) => s.settingsOpen);
  const open = useStore((s) => s.openSettings);
  const close = useStore((s) => s.closeSettings);
  const providerId = useStore((s) => s.settingsProviderId);
  return (
    <Dialog.Root open={section !== null} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="pop-in fixed top-1/2 left-1/2 z-50 flex h-[min(680px,88vh)] w-[min(920px,94vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl border border-line bg-bg shadow-[var(--shadow)] outline-none"
        >
          <nav className="flex w-40 shrink-0 flex-col gap-0.5 border-r border-line bg-panel p-2" aria-label="Settings sections">
            <Dialog.Title className="px-2.5 pt-1.5 pb-2 text-[15px] font-semibold">Settings</Dialog.Title>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => open(s.id, providerId)}
                aria-current={section === s.id}
                className={cx('rounded-md px-2.5 py-1.5 text-left', section === s.id ? 'bg-hover font-medium' : 'text-muted hover:bg-hover/60 hover:text-fg')}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="relative min-w-0 flex-1 overflow-y-auto">
            <Dialog.Close asChild>
              <IconButton label="Close settings" className="absolute top-2 right-2 z-10">
                <X size={15} />
              </IconButton>
            </Dialog.Close>
            {section === 'providers' && <Providers key={providerId ?? 'none'} />}
            {section === 'appearance' && <Appearance />}
            {section === 'data' && <Data />}
            {section === 'security' && <SecuritySettings />}
            {section === 'network' && <Network />}
            {section === 'about' && <About />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
