import type { ProviderConfig } from '@shared/types';
import { NodalError, nodalError, toNormalized } from './errors';
import { SseParser } from './sse';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface Timeouts {
  /** Until response headers arrive. Chromium owns the socket, so the connect
   *  phase cannot be timed on its own; it is bounded by this timer. */
  connectMs: number;
  /** Until the first byte of the response body. */
  firstByteMs: number;
  /** Maximum silence between body chunks. */
  idleMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = { connectMs: 15_000, firstByteMs: 60_000, idleMs: 90_000 };

// ---------- redaction ----------

const SECRET_PATTERNS: RegExp[] = [
  /(authorization|x-api-key|api-key|proxy-authorization)(["']?\s*[:=]\s*["']?)((?:Bearer\s+|Basic\s+)?[^\s"',}]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/g,
  /\b(sk|pk|rk|key|vn)[-_][A-Za-z0-9_-]{16,}\b/g,
];

/** Strip anything that looks like a credential before text reaches a log. */
export function redact(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0], '$1$2[redacted]');
  out = out.replace(SECRET_PATTERNS[1], 'Bearer [redacted]');
  out = out.replace(SECRET_PATTERNS[2], '[redacted-key]');
  return out;
}

// ---------- URL policy ----------

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^10(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^192\.168(\.\d{1,3}){2}$/.test(h)) return true;
  if (/^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  const m = /^172\.(\d{1,3})(\.\d{1,3}){2}$/.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  // Single-label names and .local/.lan/.home.arpa resolve on the local network.
  if (!h.includes('.') && !h.includes(':')) return true;
  return /\.(local|lan|home\.arpa|internal)$/.test(h);
}

export interface UrlVerdict {
  ok: boolean;
  url?: URL;
  /** Plaintext HTTP to a LAN host: allowed only after explicit confirmation. */
  needsInsecureConfirm?: boolean;
  reason?: string;
}

/** HTTPS required; HTTP only for loopback, or LAN hosts once confirmed. */
export function checkBaseUrl(baseUrl: string, allowInsecureHttp: boolean): UrlVerdict {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'The base URL is not a valid URL.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'Do not put credentials in the base URL.' };
  if (url.protocol === 'https:') return { ok: true, url };
  if (url.protocol !== 'http:') return { ok: false, reason: 'Only http and https URLs are supported.' };
  if (isLoopbackHost(url.hostname)) return { ok: true, url };
  if (isLanHost(url.hostname)) {
    return allowInsecureHttp
      ? { ok: true, url }
      : { ok: false, needsInsecureConfirm: true, reason: 'Plaintext HTTP to a LAN address must be explicitly allowed for this provider.' };
  }
  return { ok: false, reason: 'Plaintext HTTP to a remote host would expose the API key. Use https.' };
}

export function joinUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  const u = new URL(base + p);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

export function buildAuthHeaders(config: ProviderConfig, apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { ...(config.extraHeaders ?? {}) };
  if (apiKey && config.auth.scheme === 'bearer') headers['Authorization'] = `Bearer ${apiKey}`;
  if (apiKey && config.auth.scheme === 'header') headers[config.auth.headerName || 'x-api-key'] = apiKey;
  return headers;
}

// ---------- requests ----------

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  text(maxBytes?: number): Promise<string>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  json?: unknown;
  /** A ready-made body, such as a multipart upload. Not combined with `json`. */
  body?: { contentType: string; data: Uint8Array };
  signal?: AbortSignal;
  /** Budget until response headers. */
  timeoutMs: number;
}

export class Http {
  constructor(
    private readonly fetchImpl: FetchLike,
    readonly userAgent: string,
  ) {}

  /**
   * Sends a request and resolves once headers arrive. The returned body is
   * unread; use `readSse` or `text`. Aborting `signal` cancels at any point.
   */
  async request(url: string, opts: RequestOptions): Promise<HttpResponse & { abort(reason: unknown): void }> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(opts.signal?.reason);
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, opts.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method ?? (opts.json !== undefined || opts.body ? 'POST' : 'GET'),
        headers: {
          'User-Agent': this.userAgent,
          ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : opts.body ? { 'Content-Type': opts.body.contentType } : {}),
          ...opts.headers,
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body ? (opts.body.data as unknown as BodyInit) : undefined,
        signal: ctl.signal,
        credentials: 'omit',
        redirect: 'error',
      });
    } catch (e) {
      opts.signal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        throw nodalError('timeout', `No response from the server within ${Math.round(opts.timeoutMs / 1000)} s (connect / first-byte timer).`);
      }
      if (opts.signal?.aborted) throw nodalError('cancelled', 'Cancelled');
      throw new NodalError(toNormalized(e));
    } finally {
      clearTimeout(timer);
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      body: res.body,
      abort: (reason) => ctl.abort(reason),
      text: async (maxBytes = 256 * 1024) => {
        try {
          return await readText(res.body, maxBytes);
        } finally {
          opts.signal?.removeEventListener('abort', onAbort);
        }
      },
    };
  }
}

async function readText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += dec.decode(value, { stream: true });
      if (total >= maxBytes) break;
    }
    out += dec.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
  return out;
}

/** Reads a whole (bounded) body with an overall timeout. */
export async function readBody(res: HttpResponse, timeoutMs: number, maxBytes = 32 * 1024 * 1024): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(nodalError('timeout', 'The server stopped sending the response body.')), timeoutMs);
  });
  try {
    return await Promise.race([res.text(maxBytes), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Yields SSE data payloads from a response body. Decodes with a streaming
 * TextDecoder so multi-byte characters split across reads survive, and
 * enforces the first-byte and idle timers.
 */
export async function* readSse(
  res: HttpResponse & { abort(reason: unknown): void },
  timeouts: Pick<Timeouts, 'firstByteMs' | 'idleMs'>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  const parser = new SseParser();
  let first = true;
  try {
    for (;;) {
      const ms = first ? timeouts.firstByteMs : timeouts.idleMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              nodalError(
                'timeout',
                first
                  ? `The model sent nothing within ${Math.round(ms / 1000)} s (first-byte timer).`
                  : `The stream stalled: no data for ${Math.round(ms / 1000)} s (idle timer).`,
              ),
            ),
          ms,
        );
      });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([reader.read(), timeout]);
      } catch (e) {
        if (e instanceof NodalError) {
          res.abort(e);
          throw e;
        }
        if (signal?.aborted) throw nodalError('cancelled', 'Cancelled');
        throw new NodalError(toNormalized(e));
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      first = false;
      for (const data of parser.feed(dec.decode(chunk.value, { stream: true }))) yield data;
    }
    for (const data of parser.feed(dec.decode())) yield data;
    for (const data of parser.end()) yield data;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Reads a whole binary body, bounded in size and time. */
export async function readBytes(res: HttpResponse, timeoutMs: number, maxBytes = 32 * 1024 * 1024): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(nodalError('timeout', 'The server stopped sending the response body.')), timeoutMs);
  });
  const read = async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw nodalError('invalid_request', 'The response was larger than expected.');
      chunks.push(value);
    }
  };
  try {
    await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Builds a multipart/form-data body from text fields and one file. */
export function multipart(fields: Record<string, string>, file: { field: string; name: string; mime: string; data: Uint8Array }): { contentType: string; data: Uint8Array } {
  const boundary = `----nodal${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const clean = (v: string) => v.replace(/[\r\n"]/g, '');
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${clean(k)}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${clean(file.field)}"; filename="${clean(file.name)}"\r\nContent-Type: ${clean(file.mime)}\r\n\r\n`));
  parts.push(file.data);
  parts.push(enc.encode(`\r\n--${boundary}--\r\n`));
  const data = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.byteLength;
  }
  return { contentType: `multipart/form-data; boundary=${boundary}`, data };
}
