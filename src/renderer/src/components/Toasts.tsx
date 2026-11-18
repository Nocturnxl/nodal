import { X } from 'lucide-react';
import { useStore } from '../store';
import { ErrorDetails, IconButton, cx } from './ui';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('pop-in pointer-events-auto rounded-lg border border-line bg-raised p-3 shadow-[var(--shadow)]')}>
          <div className="flex items-start gap-2">
            <div className={cx('min-w-0 flex-1 text-[13px] font-medium break-words', t.kind === 'success' && 'text-ok')}>{t.title}</div>
            <IconButton label="Dismiss" className="-mt-1 -mr-1 h-6 w-6" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </IconButton>
          </div>
          {t.error && (
            <div className="mt-2">
              <ErrorDetails error={t.error} compact />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
