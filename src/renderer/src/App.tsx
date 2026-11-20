import { useCallback, useEffect, useState } from 'react';
import type { VaultStatus } from '@shared/types';
import { ChatView } from './components/ChatView';
import { ModelPicker } from './components/ModelPicker';
import { Unlock } from './components/Security';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/Toasts';
import { Welcome } from './components/Welcome';
import { nodal } from './lib/ipc';
import { useStore } from './store';

function useTheme() {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (!s.ready) return; // still locked or starting
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && e.shiftKey && !e.altKey && key === 'l') {
        e.preventDefault();
        s.lock();
        return;
      }
      if (mod && !e.shiftKey && !e.altKey) {
        if (key === 'n') {
          e.preventDefault();
          void s.newChat();
        } else if (key === 'k') {
          e.preventDefault();
          s.setPicker(!s.pickerOpen);
        } else if (key === 'l') {
          e.preventDefault();
          s.focusComposer();
        } else if (key === ',') {
          e.preventDefault();
          if (s.settingsOpen) s.closeSettings();
          else s.openSettings('providers');
        } else if (key === 'i') {
          e.preventDefault();
          void s.setSettings({ inspectorOpen: !s.settings.inspectorOpen });
        }
      } else if (e.key === 'Escape' && !s.pickerOpen && !s.settingsOpen && s.currentId && s.streams[s.currentId]) {
        // Leave Escape alone while editing a message; otherwise it stops the reply.
        if ((e.target as HTMLElement | null)?.getAttribute('aria-label') === 'Edit message') return;
        e.preventDefault();
        s.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const ready = useStore((s) => s.ready);
  const welcome = useStore((s) => s.welcome);
  const init = useStore((s) => s.init);
  useTheme();
  useShortcuts();

  // Encrypted chats stay closed until the passphrase is given, so nothing else is asked of main before then.
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const refresh = useCallback(
    () =>
      nodal.vault.status().then((v) => {
        setVault(v);
        useStore.getState().setEncrypted(v.enabled);
      }),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const unlocked = vault?.unlocked ?? false;
  useEffect(() => {
    if (unlocked) void init().catch((e) => useStore.getState().toastError('NODAL could not start', e));
  }, [init, unlocked]);

  if (vault && !vault.unlocked) return <Unlock status={vault} onUnlocked={() => void refresh()} />;
  if (!ready) return <div className="h-full bg-bg" />;
  return (
    <>
      {welcome ? (
        <Welcome />
      ) : (
        <div className="flex h-full">
          <Sidebar />
          <ChatView />
        </div>
      )}
      <ModelPicker />
      <SettingsDialog />
      <Toasts />
    </>
  );
}
