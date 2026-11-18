import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './net/http';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Rotating metadata-only log: 5 files of 2 MB. Every line passes through
 * `redact`, and callers never pass message bodies or headers.
 */
export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'nodal.log');

  function rotate(): void {
    try {
      if (!existsSync(file) || statSync(file).size < MAX_BYTES) return;
      const oldest = join(dir, `nodal.${MAX_FILES - 1}.log`);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = MAX_FILES - 2; i >= 1; i--) {
        const from = join(dir, `nodal.${i}.log`);
        if (existsSync(from)) renameSync(from, join(dir, `nodal.${i + 1}.log`));
      }
      renameSync(file, join(dir, 'nodal.1.log'));
    } catch {
      /* logging must never crash the app */
    }
  }

  function write(level: string, msg: string, meta?: Record<string, unknown>): void {
    try {
      rotate();
      const line = `${new Date().toISOString()} ${level} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`;
      appendFileSync(file, redact(line) + '\n');
    } catch {
      /* ignore */
    }
  }

  return {
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
