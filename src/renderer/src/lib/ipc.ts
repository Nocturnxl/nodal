import { IPC_ERROR_TAG, type RelayApi } from '@shared/api';
import type { NormalizedError } from '@shared/types';

declare global {
  interface Window {
    relay: RelayApi;
  }
}

export const relay: RelayApi = window.relay;

/** Handler failures cross IPC as a tagged JSON string inside the error message. */
export function parseIpcError(e: unknown): NormalizedError {
  const message = e instanceof Error ? e.message : String(e);
  const at = message.indexOf(IPC_ERROR_TAG);
  if (at !== -1) {
    try {
      return JSON.parse(message.slice(at + IPC_ERROR_TAG.length)) as NormalizedError;
    } catch {
      /* fall through */
    }
  }
  return { code: 'internal', message };
}

export function errorDetailsText(err: NormalizedError): string {
  const lines = [err.message, `Code: ${err.code}`];
  if (err.status) lines.push(`HTTP status: ${err.status}`);
  if (err.requestId) lines.push(`Request ID: ${err.requestId}`);
  if (err.hint && err.hint !== 'insecure-lan') lines.push(`Hint: ${err.hint}`);
  if (err.resetAt) lines.push(`Resets: ${new Date(err.resetAt).toLocaleString()}`);
  return lines.join('\n');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
