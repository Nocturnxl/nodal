import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PRESETS } from '@shared/presets';
import type { AuthScheme, KeyCheck, KeyStoreStatus, NormalizedError, ProviderConfig } from '@shared/types';
import { parseIpcError, relay } from '../lib/ipc';
import { useStore } from '../store';
import { Button, ErrorDetails, Label } from './ui';

type Draft = Omit<ProviderConfig, 'id'> & { id?: string };

function headersToText(h: Record<string, string> | undefined): string {
  return Object.entries(h ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function textToHeaders(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function isPlainHttpNonLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Add or edit a provider and connect it: save the config, store the key
 * (main validates it with an authenticated call first) and fetch the models.
 */
export function ProviderForm({
  initial,
  onConnected,
  onCancel,
  submitLabel = 'Connect',
}: {
  initial: Draft;
  onConnected(provider: ProviderConfig, check: KeyCheck): void;
  onCancel?(): void;
  submitLabel?: string;
}) {
  const refreshProviders = useStore((s) => s.refreshProviders);
  const keyStatus = useStore((s) => (initial.id ? s.keyStatus[initial.id] : undefined));
  const [form, setForm] = useState<Draft>(initial);
  const [headersText, setHeadersText] = useState(headersToText(initial.extraHeaders));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NormalizedError | null>(null);
  const [failed, setFailed] = useState<{ provider: ProviderConfig; check: KeyCheck } | null>(null);
  const [ok, setOk] = useState<KeyCheck | null>(null);
  const [needsLanConfirm, setNeedsLanConfirm] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(!initial.preset);
  const [store, setStore] = useState<KeyStoreStatus | null>(null);
  // A provider this form created but never connected is removed when the form
  // closes, so a failed first attempt leaves nothing behind.
  const createdId = useRef<string | null>(null);
  const kept = useRef(false);
  useEffect(
    () => () => {
      const id = createdId.current;
      if (id && !kept.current) {
        void relay.providers
          .delete(id)
          .then(() => useStore.getState().refreshProviders())
          .catch(() => {});
      }
    },
    [],
  );
  const finish = (provider: ProviderConfig, check: KeyCheck) => {
    kept.current = true;
    onConnected(provider, check);
  };

  useEffect(() => {
    void relay.keys.storeStatus().then(setStore);
  }, []);
  useEffect(() => {
    setForm(initial);
    setHeadersText(headersToText(initial.extraHeaders));
    setKey('');
    setError(null);
    setFailed(null);
    setOk(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id, initial.preset, initial.baseUrl]);

  const preset = PRESETS.find((p) => p.id === (form.preset ?? 'custom'));
  const needsKey = form.auth.scheme !== 'none';
  const hasStoredKey = !!keyStatus?.present;
  const set = (p: Partial<Draft>) => setForm((f) => ({ ...f, ...p }));

  const connect = async (saveAnyway = false) => {
    setBusy(true);
    setError(null);
    setFailed(null);
    setOk(null);
    try {
      const { saved } = await relay.providers.save({ ...form, extraHeaders: textToHeaders(headersText) });
      if (!form.id) createdId.current = saved.id;
      setForm((f) => ({ ...f, id: saved.id }));
      const check: KeyCheck = needsKey && key.trim() ? await relay.keys.set(saved.id, key.trim(), saveAnyway) : await relay.providers.test(saved.id);
      await refreshProviders();
      if (check.ok || (saveAnyway && check.saved)) {
        setKey('');
        setOk(check);
        finish(saved, check);
      } else {
        setFailed({ provider: saved, check });
      }
    } catch (e) {
      const err = parseIpcError(e);
      if (err.hint === 'insecure-lan') setNeedsLanConfirm(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void connect();
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <Label>Name</Label>
          <input className="field" value={form.displayName} onChange={(e) => set({ displayName: e.target.value })} required />
        </label>
        <label className="block">
          <Label>Base URL</Label>
          <input
            className="field font-mono text-[12.5px]"
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(e) => set({ baseUrl: e.target.value })}
            required
            spellCheck={false}
          />
        </label>
      </div>

      {(needsLanConfirm || (isPlainHttpNonLocal(form.baseUrl) && form.allowInsecureHttp)) && (
        <label className="flex items-start gap-2 rounded-md bg-warn-soft p-2.5 text-[12.5px] text-warn">
          <input type="checkbox" className="mt-0.5" checked={form.allowInsecureHttp} onChange={(e) => set({ allowInsecureHttp: e.target.checked })} />
          <span>Allow plaintext HTTP to this LAN address. Anything sent, including the API key, is readable by others on the network.</span>
        </label>
      )}

      {needsKey && (
        <label className="block">
          <Label hint={hasStoredKey ? `Stored: •••• ${keyStatus?.last4 ?? ''}` : undefined}>API key</Label>
          <input
            className="field font-mono text-[12.5px]"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={hasStoredKey ? 'Leave blank to keep the stored key' : 'Paste your key'}
            onChange={(e) => setKey(e.target.value)}
            aria-label="API key"
          />
          <p className="mt-1 text-[11.5px] text-faint">
            {preset?.keyHelp ?? 'Encrypted by your operating system and stored only on this computer.'}
            {preset?.keyHelp && ' The key is encrypted by your operating system and stored only on this computer.'}
          </p>
        </label>
      )}
      {store && !store.available && needsKey && <div className="rounded-md bg-danger-soft p-2.5 text-[12.5px] text-danger">{store.reason}</div>}

      <button type="button" className="text-[12.5px] text-accent" onClick={() => setShowAdvanced((v) => !v)} aria-expanded={showAdvanced}>
        {showAdvanced ? 'Hide connection details' : 'Connection details'}
      </button>
      {showAdvanced && (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <Label>Authentication</Label>
              <select className="field" value={form.auth.scheme} onChange={(e) => set({ auth: { ...form.auth, scheme: e.target.value as AuthScheme } })}>
                <option value="bearer">Bearer token (Authorization header)</option>
                <option value="header">Key in a custom header</option>
                <option value="none">None</option>
              </select>
            </label>
            {form.auth.scheme === 'header' ? (
              <label className="block">
                <Label>Header name</Label>
                <input className="field font-mono text-[12.5px]" value={form.auth.headerName ?? ''} placeholder="x-api-key" onChange={(e) => set({ auth: { ...form.auth, headerName: e.target.value } })} />
              </label>
            ) : (
              <label className="block">
                <Label>Model list path</Label>
                <input className="field font-mono text-[12.5px]" value={form.modelListPath} placeholder="/models" onChange={(e) => set({ modelListPath: e.target.value })} />
              </label>
            )}
          </div>
          {form.auth.scheme === 'header' && (
            <label className="block">
              <Label>Model list path</Label>
              <input className="field font-mono text-[12.5px]" value={form.modelListPath} placeholder="/models" onChange={(e) => set({ modelListPath: e.target.value })} />
            </label>
          )}
          <label className="block">
            <Label hint="One per line, Name: value">Extra headers</Label>
            <textarea className="field min-h-14 resize-y font-mono text-[12.5px]" value={headersText} onChange={(e) => setHeadersText(e.target.value)} spellCheck={false} />
          </label>
          {form.id && <p className="text-[11.5px] text-faint">Changing the host removes the stored key, so it is never sent to a different server.</p>}
        </div>
      )}

      {error && <ErrorDetails error={error} compact />}
      {failed?.check.error && (
        <ErrorDetails error={failed.check.error} compact>
          {needsKey && key.trim() && (
            <Button size="sm" onClick={() => void connect(true)} disabled={busy} title="For providers with no endpoint that can validate a key">
              Save anyway
            </Button>
          )}
          {!needsKey && (
            <Button size="sm" onClick={() => finish(failed.provider, failed.check)}>
              Keep provider anyway
            </Button>
          )}
        </ErrorDetails>
      )}
      {ok && (
        <div className="flex items-center gap-2 rounded-md bg-ok-soft p-2.5 text-[13px] text-ok" role="status">
          <CheckCircle2 size={15} />
          {ok.ok ? 'Connected.' : 'Saved without validation.'}
          {ok.modelCount !== undefined && ` ${ok.modelCount} model${ok.modelCount === 1 ? '' : 's'} available.`}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" variant="primary" disabled={busy || !form.baseUrl.trim() || !form.displayName.trim() || (needsKey && !key.trim() && !hasStoredKey)}>
          {busy && <Loader2 size={14} className="animate-spin" />}
          {busy ? 'Connecting…' : submitLabel}
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
