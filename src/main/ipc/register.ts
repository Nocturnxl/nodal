import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import { IPC_ERROR_TAG } from '@shared/api';
import type { NormalizedError } from '@shared/types';
import type { AttachmentStore } from '../attachments';
import type { StreamManager } from '../chat/streams';
import type { Store } from '../db/store';
import type { Logger } from '../log';
import type { ModelService } from '../models';
import { toNormalized } from '../net/errors';
import type { KeyStore } from '../secrets/keystore';

export interface AppContext {
  store: Store;
  keys: KeyStore;
  attachments: AttachmentStore;
  streams: StreamManager;
  models: ModelService;
  log: Logger;
  paths: { userData: string; logs: string };
  /** Origins allowed to call IPC: the app's own, plus the dev server in development. */
  trustedOrigins: string[];
  window(): Electron.BrowserWindow | null;
  applyNetworkSettings(): void;
}

/** Only the top frame of the app's own page may call a handler. */
export function isTrustedSender(event: IpcMainInvokeEvent, trustedOrigins: string[]): boolean {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(frame.url);
    return trustedOrigins.includes(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}

function encode(err: NormalizedError): Error {
  return new Error(IPC_ERROR_TAG + JSON.stringify(err));
}

/**
 * Registers an invoke handler that (1) rejects foreign senders, (2) validates
 * the payload against a zod schema and (3) converts failures to a
 * NormalizedError that survives the IPC boundary.
 */
export function handle<S extends z.ZodType>(
  ctx: Pick<AppContext, 'trustedOrigins' | 'log'>,
  channel: string,
  schema: S,
  fn: (payload: z.output<S>, event: IpcMainInvokeEvent) => unknown,
): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    if (!isTrustedSender(event, ctx.trustedOrigins)) {
      ctx.log.warn('rejected IPC from untrusted sender', { channel });
      throw encode({ code: 'forbidden', message: 'Untrusted sender.' });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw encode({ code: 'invalid_request', message: `Invalid ${channel} payload: ${issue?.path.join('.') || 'value'} ${issue?.message ?? ''}`.trim() });
    }
    try {
      return await fn(parsed.data, event);
    } catch (e) {
      const err = toNormalized(e);
      if (err.code === 'internal') ctx.log.error('handler failed', { channel, error: err.message });
      throw encode(err);
    }
  });
}
