import { Check, Copy } from 'lucide-react';
import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { NormalizedError } from '@shared/types';
import markUrl from '../assets/nodal-mark.png';
import { copyText, errorDetailsText } from '../lib/ipc';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * The NODAL logo: the mark, and optionally the lettering beside it. The
 * lettering is drawn as a mask, so it takes the current text colour and reads
 * on light and dark surfaces alike.
 */
export function Logo({ size = 22, wordmark = true, className }: { size?: number; wordmark?: boolean; className?: string }) {
  return (
    <span role="img" aria-label="NODAL" className={cx('inline-flex shrink-0 items-center', className)} style={{ gap: Math.round(size * 0.4) }}>
      <img src={markUrl} alt="" width={size} height={size} draggable={false} />
      {wordmark && <span aria-hidden className="wordmark" style={{ height: Math.round(size * 0.46) }} />}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({ variant = 'default', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-[12.5px]' : 'h-8 px-3 text-[13px]',
        variant === 'primary' && 'brand shadow-sm hover:brightness-110',
        variant === 'default' && 'border border-line bg-raised hover:bg-hover',
        variant === 'ghost' && 'text-muted hover:bg-hover hover:text-fg',
        variant === 'danger' && 'border border-line bg-raised text-danger hover:bg-danger-soft',
        className,
      )}
      {...rest}
    />
  );
}

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'brand' : 'bg-line')}
    >
      <span className={cx('absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[16px]' : 'left-[2px]')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded px-2.5 py-0.5 text-[12.5px]', value === o.value ? 'bg-raised font-medium text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' | 'ok' | 'danger'; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] leading-4 whitespace-nowrap',
        tone === 'neutral' && 'bg-hover text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'ok' && 'bg-ok-soft text-ok',
        tone === 'danger' && 'bg-danger-soft text-danger',
      )}
    >
      {children}
    </span>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <span className="text-[12.5px] font-medium text-fg">{children}</span>
      {hint && <span className="text-[11.5px] text-faint">{hint}</span>}
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', className }: { text: string | (() => string); label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={done ? 'Copied' : label}
      className={className}
      onClick={async () => {
        if (await copyText(typeof text === 'function' ? text() : text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

const TITLES: Record<string, string> = {
  auth: 'Key rejected',
  quota: 'Out of balance',
  rate_limit: 'Rate limited',
  forbidden: 'Not allowed',
  model_not_found: 'Model or endpoint not found',
  context_length: 'Conversation too long for this model',
  invalid_request: 'The provider rejected the request',
  server: 'The provider had an error',
  network: 'Network problem',
  timeout: 'Timed out',
  blocked: 'Blocked',
  busy: 'Busy',
  internal: 'Something went wrong',
};

export function errorTitle(err: NormalizedError): string {
  return TITLES[err.code] ?? 'Error';
}

/** Every failure shows what happened, the HTTP status and the request ID, with Copy details. */
export function ErrorDetails({ error, children, compact }: { error: NormalizedError; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('rounded-lg border border-danger/30 bg-danger-soft text-[13px]', compact ? 'p-2.5' : 'p-3')} role="alert">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-danger">{errorTitle(error)}</div>
          <div className="mt-0.5 break-words whitespace-pre-wrap text-fg">{error.message}</div>
          {error.hint && error.hint !== 'insecure-lan' && <div className="mt-1 text-muted">{error.hint}</div>}
          {error.code === 'rate_limit' && error.resetAt && <div className="mt-1 text-muted">Limit resets at {new Date(error.resetAt).toLocaleTimeString()}.</div>}
          {error.balance && (
            <div className="mt-1 text-muted">
              Balance: {Object.entries(error.balance).map(([k, v]) => `${v} ${k}`).join(' · ')}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11.5px] text-muted">
            {error.status !== undefined && <span>HTTP {error.status}</span>}
            <span>{error.code}</span>
            {error.requestId && <span className="break-all">request {error.requestId}</span>}
          </div>
        </div>
        <CopyButton text={() => errorDetailsText(error)} label="Copy details" />
      </div>
      {children && <div className="mt-2.5 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}
