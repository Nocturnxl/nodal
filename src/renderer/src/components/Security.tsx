import { Lock, ShieldCheck } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import type { ImportResult, VaultStatus } from '@shared/types';
import { nodal, parseIpcError } from '../lib/ipc';
import { useStore } from '../store';
import { Badge, Button, Logo } from './ui';

const MIN = 8;

function Passphrase({ label, value, onChange, autoFocus, autoComplete = 'off' }: { label: string; value: string; onChange(v: string): void; autoFocus?: boolean; autoComplete?: string }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12.5px] font-medium">
        {label}
      </label>
      <input id={id} type="password" className="field" value={value} autoFocus={autoFocus} autoComplete={autoComplete} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** Two fields for choosing a passphrase. Reports the passphrase once both match and it is long enough. */
function NewPassphrase({ onValid, label = 'New passphrase' }: { onValid(v: string | null): void; label?: string }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  useEffect(() => {
    onValid(a.length >= MIN && a === b ? a : null);
  }, [a, b, onValid]);
  const problem = a && a.length < MIN ? `Use at least ${MIN} characters.` : b && a !== b ? 'The two entries do not match.' : null;
  return (
    <>
      <Passphrase label={label} value={a} onChange={setA} autoComplete="new-password" />
      <Passphrase label="Type it again" value={b} onChange={setB} autoComplete="new-password" />
      <p className="min-h-[18px] text-[12.5px] text-muted" aria-live="polite">
        {problem ?? 'A few unrelated words make a passphrase that is strong and easy to remember.'}
      </p>
    </>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p role="alert" className="text-[13px] text-danger">
      {children}
    </p>
  ) : null;
}

/** Shown instead of the app when chats are encrypted and the passphrase has not been given yet. */
export function Unlock({ status, onUnlocked }: { status: VaultStatus; onUnlocked(): void }) {
  const [passphrase, setPassphrase] = useState('');
  const [remaining, setRemaining] = useState<number | null>(status.wipeAfter > 0 ? status.wipeAfter - status.failures : null);
  const [wiped, setWiped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await nodal.vault.unlock(passphrase);
      setPassphrase('');
      if (r.ok) onUnlocked();
      else if (r.wiped) setWiped(true);
      else {
        setRemaining(r.remaining);
        setError('That passphrase is not right.');
      }
    } catch (err) {
      setError(parseIpcError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (wiped) {
    return (
      <main className="brand-wash flex h-full items-center justify-center bg-bg px-6">
        <div className="w-full max-w-[380px] space-y-4">
          <Logo size={44} className="mb-2" />
          <div role="alert">
            <h1 className="text-[22px] font-semibold tracking-tight">The chats on this computer were deleted</h1>
            <p className="mt-1 text-muted">
              The wrong passphrase was entered too many times, and NODAL was set to delete everything when that happens. Chats, attached images and stored API keys are gone. Exports saved elsewhere are not
              affected.
            </p>
          </div>
          <Button variant="primary" className="w-full" autoFocus onClick={onUnlocked}>
            Start again
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="brand-wash flex h-full items-center justify-center bg-bg px-6">
      <form onSubmit={submit} className="w-full max-w-[380px] space-y-4">
        <Logo size={44} className="mb-2" />
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight">
            <Lock size={18} className="text-accent" aria-hidden /> NODAL is locked
          </h1>
          <p className="mt-1 text-muted">Your chats on this computer are encrypted. Enter your passphrase to open them.</p>
        </div>
        <Passphrase label="Passphrase" value={passphrase} onChange={setPassphrase} autoFocus autoComplete="current-password" />
        <Problem>{error}</Problem>
        {remaining !== null && (
          <p className="text-[13px] font-medium text-danger" aria-live="polite">
            {remaining === 1 ? 'One more wrong passphrase deletes all chats on this computer.' : `${remaining} more wrong passphrases delete all chats on this computer.`}
          </p>
        )}
        <Button type="submit" variant="primary" className="w-full" disabled={!passphrase || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <p className="text-[12.5px] text-muted">A forgotten passphrase cannot be reset or recovered. If you kept an export, you can restore it into a fresh data folder.</p>
      </form>
    </main>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="rounded-lg border border-line p-4" aria-labelledby={id}>
      <h3 id={id} className="mb-3 font-semibold">
        {title}
      </h3>
      <div className="max-w-[380px] space-y-3">{children}</div>
    </section>
  );
}

/** Settings → Security: turn encryption on or off, or change the passphrase. */
export function SecuritySettings() {
  const toast = useStore((s) => s.toast);
  const setEncrypted = useStore((s) => s.setEncrypted);
  const lock = useStore((s) => s.lock);
  const autoLockMinutes = useStore((s) => s.settings.autoLockMinutes);
  const setSettings = useStore((s) => s.setSettings);
  const autoLockId = useId();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [current, setCurrent] = useState('');
  const [off, setOff] = useState('');
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    nodal.vault.status().then(setStatus, (e) => setError(parseIpcError(e).message));
  }, []);

  const reset = () => {
    setFresh(null);
    setUnderstood(false);
    setCurrent('');
    setOff('');
    setFormKey((k) => k + 1);
  };
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const failed = await fn();
      if (failed) setError(failed);
      else reset();
      const now = await nodal.vault.status();
      setStatus(now);
      setEncrypted(now.enabled);
    } catch (e) {
      setError(parseIpcError(e).message);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <div className="p-5">{error && <Problem>{error}</Problem>}</div>;

  return (
    <div className="space-y-4 p-5">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <ShieldCheck size={16} className="text-accent" aria-hidden /> Encrypt chats on this computer {status.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Encrypts your conversations, the search index, attached images and settings with a passphrase you choose. NODAL asks for it each time it starts and after it locks. Your API keys are already encrypted by the operating
          system, with or without this.
        </p>
      </div>

      {!status.enabled ? (
        <Card title="Turn on encryption">
          <NewPassphrase key={formKey} label="Passphrase" onValid={setFresh} />
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand that if I forget this passphrase my chats are gone. Nobody can reset or recover it.</span>
          </label>
          <Button
            variant="primary"
            disabled={!fresh || !understood || busy}
            onClick={() =>
              run(async () => {
                await nodal.vault.enable(fresh!);
                toast({ kind: 'success', title: 'Encryption is on. NODAL will ask for your passphrase when it starts.' });
                return null;
              })
            }
          >
            {busy ? 'Encrypting…' : 'Turn on encryption'}
          </Button>
          <p className="text-[12.5px] text-muted">
            Older unencrypted database backups in the data folder are deleted when you turn this on. Exports you already saved elsewhere are not touched. For a safety copy, make an encrypted export under Data
            and keep it somewhere else.
          </p>
        </Card>
      ) : (
        <>
          <Card title="Lock">
            <div>
              <label htmlFor={autoLockId} className="mb-1 block text-[12.5px] font-medium">
                Lock automatically
              </label>
              <select id={autoLockId} className="field" value={autoLockMinutes} onChange={(e) => void setSettings({ autoLockMinutes: Number(e.target.value) })}>
                {[...new Set([0, 1, 5, 15, 30, 60, autoLockMinutes])]
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? 'Never' : m === 1 ? 'After 1 minute without input' : m === 60 ? 'After 1 hour without input' : `After ${m} minutes without input`}
                    </option>
                  ))}
              </select>
            </div>
            <p className="text-[12.5px] text-muted">
              Unless this is set to Never, NODAL also locks when the computer is locked or goes to sleep. A reply that is still arriving is never cut off: NODAL locks when it has finished.
            </p>
            <Button onClick={lock}>
              <Lock size={13} /> Lock now
            </Button>
            <p className="text-[12.5px] text-muted">Lock now stops any reply that is still arriving. Shortcut: Ctrl+Shift+L.</p>
          </Card>
          <Card title="Wrong passphrases">
            <label className="flex items-start gap-2 text-[13px]">
              <input
                type="checkbox"
                className="mt-1"
                checked={status.wipeAfter > 0}
                disabled={busy}
                onChange={(e) => {
                  const on = e.target.checked;
                  void run(async () => {
                    await nodal.vault.setWipe(on);
                    return null;
                  });
                }}
              />
              <span>Delete all chats after 5 wrong passphrases in a row</span>
            </label>
            <p className="text-[12.5px] text-muted">
              Off unless you turn it on. The count survives restarts and starts again after a right passphrase. On the fifth wrong one NODAL permanently deletes the chats, attached images and stored API keys
              on this computer; nothing can bring them back, so keep an encrypted export somewhere else. This stops someone guessing at your keyboard. It does not stop someone who copies the data folder and
              guesses elsewhere: only a strong passphrase does.
            </p>
          </Card>
          <Card title="Change passphrase">
            <Passphrase label="Current passphrase" value={current} onChange={setCurrent} autoComplete="current-password" />
            <NewPassphrase key={formKey} onValid={setFresh} />
            <Button
              disabled={!current || !fresh || busy}
              onClick={() =>
                run(async () => {
                  if (!(await nodal.vault.changePassphrase(current, fresh!))) return 'The current passphrase is not right.';
                  toast({ kind: 'success', title: 'Passphrase changed' });
                  return null;
                })
              }
            >
              Change passphrase
            </Button>
          </Card>
          <Card title="Turn off encryption">
            <p className="text-[13px] text-muted">Your chats and images are written back to disk unencrypted, and NODAL stops asking for a passphrase.</p>
            <Passphrase label="Passphrase" value={off} onChange={setOff} autoComplete="current-password" />
            <Button
              variant="danger"
              disabled={!off || busy}
              onClick={() =>
                run(async () => {
                  if (!(await nodal.vault.disable(off))) return 'That passphrase is not right.';
                  toast({ kind: 'success', title: 'Encryption is off' });
                  return null;
                })
              }
            >
              Turn off encryption
            </Button>
          </Card>
        </>
      )}
      <Problem>{error}</Problem>
    </div>
  );
}

/** Settings → Data: write the full export encrypted with its own passphrase. */
export function EncryptedExport() {
  const toast = useStore((s) => s.toast);
  const toastError = useStore((s) => s.toastError);
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPassphrase(null);
      }}
    >
      <Dialog.Trigger asChild>
        <Button>
          <Lock size={13} /> Encrypted export
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <Dialog.Content className="pop-in fixed top-1/2 left-1/2 z-[70] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 space-y-3 rounded-xl border border-line bg-bg p-5 shadow-[var(--shadow)] outline-none">
          <Dialog.Title className="text-[15px] font-semibold">Encrypted export</Dialog.Title>
          <Dialog.Description className="text-[13px] text-muted">
            Everything in one file that only this passphrase opens. It can be different from the one that unlocks NODAL, and you will need it to import the file.
          </Dialog.Description>
          <NewPassphrase label="Passphrase for this file" onValid={setPassphrase} />
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              disabled={!passphrase || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const path = await nodal.data.exportAll(passphrase!);
                  if (path) {
                    toast({ kind: 'success', title: `Exported to ${path}` });
                    setOpen(false);
                    setPassphrase(null);
                  }
                } catch (e) {
                  toastError('Export failed', e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Exporting…' : 'Export'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Picks a file to import, asking for a passphrase when the file is an encrypted export. */
export function ImportButton({ label, variant = 'default', onImported }: { label: string; variant?: 'default' | 'ghost'; onImported(r: ImportResult): void | Promise<void> }) {
  const toastError = useStore((s) => s.toastError);
  const [token, setToken] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setToken(null);
    setPassphrase('');
    setError(null);
  };
  const pick = async () => {
    try {
      const r = await nodal.data.importFile();
      if (!r) return;
      if ('locked' in r) setToken(r.token);
      else await onImported(r);
    } catch (e) {
      toastError('Import failed', e);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await nodal.data.importFile({ token, passphrase });
      close();
      if (r && !('locked' in r)) await onImported(r);
    } catch (err) {
      setError(parseIpcError(err).message);
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant={variant} onClick={() => void pick()}>
        {label}
      </Button>
      <Dialog.Root open={token !== null} onOpenChange={(o) => !o && close()}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
          <Dialog.Content className="pop-in fixed top-1/2 left-1/2 z-[70] w-[min(420px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-bg p-5 shadow-[var(--shadow)] outline-none">
            <form onSubmit={submit} className="space-y-3">
              <Dialog.Title className="text-[15px] font-semibold">This export is encrypted</Dialog.Title>
              <Dialog.Description className="text-[13px] text-muted">Enter the passphrase that was chosen when the file was exported.</Dialog.Description>
              <Passphrase label="Passphrase for this file" value={passphrase} onChange={setPassphrase} autoFocus />
              <Problem>{error}</Problem>
              <div className="flex justify-end gap-2">
                <Button onClick={close}>Cancel</Button>
                <Button type="submit" variant="primary" disabled={!passphrase || busy}>
                  {busy ? 'Importing…' : 'Import'}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
