import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { PRESETS, type Preset } from '@shared/presets';
import type { KeyCheck, ProviderConfig } from '@shared/types';
import { nodal } from '../lib/ipc';
import { formatTokens } from '../lib/tree';
import { useStore } from '../store';
import { ProviderForm } from './ProviderForm';
import { Button, Logo } from './ui';

export function PresetList({ onPick }: { onPick(p: Preset): void }) {
  return (
    <div className="grid gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p)}
          className="flex items-center gap-3 rounded-lg border border-line bg-raised px-3.5 py-2.5 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
        >
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{p.label}</span>
            <span className="block truncate text-[12.5px] text-muted">{p.blurb}</span>
          </span>
          <span className="hidden font-mono text-[11.5px] text-faint sm:block">{p.config.baseUrl.replace(/^https?:\/\//, '') || 'your endpoint'}</span>
          <ChevronRight size={15} className="text-faint" />
        </button>
      ))}
    </div>
  );
}

/** First run: pick a preset, paste a key, connect, choose a model. */
export function Welcome() {
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const setWelcome = useStore((s) => s.setWelcome);
  const chooseModel = useStore((s) => s.chooseModel);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [connected, setConnected] = useState<{ provider: ProviderConfig; check: KeyCheck } | null>(null);

  const list = connected ? (models[connected.provider.id]?.models ?? []) : [];

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-bg px-6 py-[7vh]">
      <div className="w-full max-w-[560px]">
        {!preset && (
          <>
            <Logo size={52} className="mb-7" />
            <h1 className="text-[26px] font-semibold tracking-tight">Welcome to NODAL</h1>
            <p className="mt-1.5 mb-6 text-muted">
              A chat client that runs entirely on this computer. Connect a provider to begin. Your key is encrypted by the operating system, and nothing leaves this machine except the requests you send to
              the provider you choose.
            </p>
            <PresetList onPick={setPreset} />
            <div className="mt-4 flex gap-2">
              <Button
                variant="ghost"
                onClick={async () => {
                  const s = useStore.getState();
                  try {
                    const r = await nodal.data.importFile();
                    if (!r) return;
                    await s.refreshProviders();
                    await s.refreshConversations();
                    s.toast({ kind: 'success', title: `Imported ${r.conversations} conversation${r.conversations === 1 ? '' : 's'}. Keys are never exported, so re-enter them in Settings.` });
                    if (useStore.getState().providers.length) {
                      setWelcome(false);
                      const first = useStore.getState().conversations[0];
                      if (first) await s.select(first.id);
                    }
                  } catch (e) {
                    s.toastError('Import failed', e);
                  }
                }}
              >
                Restore from an export
              </Button>
              {providers.length > 0 && (
                <Button variant="ghost" onClick={() => setWelcome(false)}>
                  Skip
                </Button>
              )}
            </div>
          </>
        )}

        {preset && !connected && (
          <>
            <button type="button" className="mb-3 flex items-center gap-1 text-[13px] text-muted hover:text-fg" onClick={() => setPreset(null)}>
              <ArrowLeft size={14} /> All providers
            </button>
            <h1 className="mb-4 text-[22px] font-semibold tracking-tight">Connect {preset.label}</h1>
            <ProviderForm initial={preset.config} onConnected={(provider, check) => setConnected({ provider, check })} />
          </>
        )}

        {connected && (
          <>
            <h1 className="text-[22px] font-semibold tracking-tight">{connected.provider.displayName} is connected</h1>
            <p className="mt-1 mb-4 text-muted">
              {list.length ? `${list.length} model${list.length === 1 ? '' : 's'} available. Choose one to start chatting.` : 'No model list was returned. You can type a model ID in the model picker.'}
            </p>
            <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-line bg-raised p-1" role="listbox" aria-label="Models">
              {list.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={m.details?.offline}
                  onClick={async () => {
                    await chooseModel(connected.provider.id, m.id);
                    setWelcome(false);
                  }}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left hover:bg-hover disabled:opacity-50"
                >
                  <span className="min-w-0 flex-1 truncate">{m.displayName}</span>
                  <span className="text-[11.5px] text-faint">{m.contextTokens ? `${formatTokens(m.contextTokens)} context` : ''}</span>
                </button>
              ))}
              {list.length === 0 && <div className="px-3 py-2 text-muted">Nothing to show.</div>}
            </div>
            <Button
              className="mt-4"
              onClick={() => {
                setWelcome(false);
                if (!list.length) useStore.getState().setPicker(true);
              }}
            >
              {list.length ? 'Choose later' : 'Open the model picker'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
