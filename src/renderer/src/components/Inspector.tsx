import { useEffect, useState } from 'react';
import type { Conversation, ExtensionField, ExtensionValue, ModelInfo, SamplingParams } from '@shared/types';
import { relay } from '../lib/ipc';
import { useStore } from '../store';
import { Badge, Button, Label, Segmented, Switch } from './ui';

function NumberField({
  label,
  value,
  placeholder,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number | undefined;
  placeholder?: string;
  min: number;
  max: number;
  step: number;
  onCommit(v: number | undefined): void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => setText(value === undefined ? '' : String(value)), [value]);
  const commit = () => {
    if (text.trim() === '') return onCommit(undefined);
    const n = Number(text);
    if (!Number.isFinite(n)) return setText(value === undefined ? '' : String(value));
    const clamped = Math.min(max, Math.max(min, step >= 1 ? Math.round(n) : n));
    setText(String(clamped));
    onCommit(clamped);
  };
  return (
    <label className="block">
      <Label>{label}</Label>
      <input
        className="field"
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

function ExtensionControl({ field, value, onChange }: { field: ExtensionField; value: ExtensionValue; onChange(v: ExtensionValue): void }) {
  const [text, setText] = useState(typeof value === 'string' ? value : String(value));
  useEffect(() => setText(typeof value === 'string' ? value : String(value)), [value]);
  const notes = (
    <>
      {field.unverified && <Badge title="The provider did not confirm this model supports it">unverified</Badge>}
      {field.costNote && (
        <Badge tone="warn" title={field.costNote}>
          extra cost
        </Badge>
      )}
    </>
  );
  if (field.type === 'toggle') {
    return (
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px]">
            {field.label} {notes}
          </span>
          <Switch checked={value === true} onChange={onChange} label={field.label} />
        </div>
        {field.description && <p className="mt-0.5 text-[11.5px] text-faint">{field.description}</p>}
      </div>
    );
  }
  if (field.type === 'enum') {
    return (
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]">
          {field.label} {notes}
        </div>
        <Segmented label={field.label} value={String(value)} options={field.options ?? []} onChange={onChange} />
        {field.description && <p className="mt-0.5 text-[11.5px] text-faint">{field.description}</p>}
      </div>
    );
  }
  return (
    <label className="block">
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[13px]">
        {field.label} {notes}
      </div>
      <input
        className="field"
        value={text}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(field.type === 'number' ? Number(text) || 0 : text)}
      />
      {field.description && <p className="mt-0.5 text-[11.5px] text-faint">{field.description}</p>}
    </label>
  );
}

export function Inspector({ conversation, model }: { conversation: Conversation; model: ModelInfo | undefined }) {
  const patch = useStore((s) => s.patchConversation);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const toast = useStore((s) => s.toast);
  const modelsStamp = useStore((s) => s.models[conversation.providerId]);
  const [prompt, setPrompt] = useState(conversation.systemPrompt ?? '');
  const [fields, setFields] = useState<ExtensionField[]>([]);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => setPrompt(conversation.systemPrompt ?? ''), [conversation.id, conversation.systemPrompt]);

  // Provider-specific controls come from the adapter's extensions(); this panel knows nothing about any provider.
  useEffect(() => {
    let alive = true;
    relay.models
      .extensions(conversation.providerId, conversation.modelId)
      .then((f) => alive && setFields(f))
      .catch(() => alive && setFields([]));
    return () => {
      alive = false;
    };
  }, [conversation.providerId, conversation.modelId, modelsStamp]);

  const params = conversation.params;
  const setParam = (p: Partial<SamplingParams>) => {
    const next = { ...params, ...p };
    for (const k of Object.keys(next) as (keyof SamplingParams)[]) if (next[k] === undefined) delete next[k];
    void patch({ params: next });
  };
  const ext = conversation.extensions;
  const valueOf = (f: ExtensionField): ExtensionValue => ext[f.key] ?? f.default;
  const visible = fields.filter((f) => {
    if (f.showWhen) {
      const dep = fields.find((x) => x.key === f.showWhen!.key);
      if ((ext[f.showWhen.key] ?? dep?.default) === f.showWhen.notEquals) return false;
    }
    return true;
  });
  const basic = visible.filter((f) => !f.advanced);
  const adv = visible.filter((f) => f.advanced);

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-panel/40" aria-label="Inspector">
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <Label hint="This conversation">System prompt</Label>
          <textarea
            className="field min-h-24 resize-y text-[13px]"
            value={prompt}
            placeholder="How the model should behave…"
            aria-label="System prompt"
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => prompt !== (conversation.systemPrompt ?? '') && void patch({ systemPrompt: prompt || null })}
          />
        </section>

        <section className="space-y-3">
          <div className="text-[12px] font-semibold tracking-wide text-muted uppercase">Sampling</div>
          <NumberField
            label="Temperature"
            value={params.temperature}
            placeholder={model?.defaults?.temperature !== undefined ? `Model default (${model.defaults.temperature})` : 'Provider default'}
            min={0}
            max={2}
            step={0.1}
            onCommit={(v) => setParam({ temperature: v })}
          />
          <NumberField
            label="Top-p"
            value={params.topP}
            placeholder={model?.defaults?.topP !== undefined ? `Model default (${model.defaults.topP})` : 'Provider default'}
            min={0}
            max={1}
            step={0.05}
            onCommit={(v) => setParam({ topP: v })}
          />
          <NumberField
            label="Max output tokens"
            value={params.maxTokens}
            placeholder={model?.maxOutputTokens ? `Up to ${model.maxOutputTokens}` : 'Provider default'}
            min={1}
            max={model?.maxOutputTokens ?? 10_000_000}
            step={1}
            onCommit={(v) => setParam({ maxTokens: v })}
          />
          <NumberField
            label="Context limit (tokens, estimated)"
            value={params.contextLimit}
            placeholder={model?.contextTokens ? `Model limit (${model.contextTokens})` : 'No limit known'}
            min={256}
            max={100_000_000}
            step={1}
            onCommit={(v) => setParam({ contextLimit: v })}
          />
          <p className="text-[11.5px] text-faint">Oldest messages are left out of the request once the thread passes the limit.</p>
        </section>

        {visible.length > 0 && (
          <section className="space-y-3">
            <div className="text-[12px] font-semibold tracking-wide text-muted uppercase">Model options</div>
            {basic.map((f) => (
              <ExtensionControl key={f.key} field={f} value={valueOf(f)} onChange={(v) => void patch({ extensions: { ...ext, [f.key]: v } })} />
            ))}
            {adv.length > 0 && (
              <>
                <button type="button" className="text-[12.5px] text-accent" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
                  {advanced ? 'Hide advanced' : 'Advanced'}
                </button>
                {advanced && adv.map((f) => <ExtensionControl key={f.key} field={f} value={valueOf(f)} onChange={(v) => void patch({ extensions: { ...ext, [f.key]: v } })} />)}
              </>
            )}
          </section>
        )}
      </div>
      <div className="border-t border-line p-3">
        <Button
          className="w-full"
          onClick={async () => {
            const { contextLimit: _c, ...defaults } = params;
            await setSettings({
              defaultSystemPrompt: prompt,
              defaultParams: defaults,
              defaultExtensions: { ...settings.defaultExtensions, [conversation.providerId]: ext },
            });
            toast({ kind: 'success', title: 'Saved as the default for new chats' });
          }}
        >
          Save as default
        </Button>
      </div>
    </aside>
  );
}
