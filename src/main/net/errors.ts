import type { ErrorCode, NormalizedError, RateLimitInfo } from '@shared/types';

/** Any failure that should reach the user carries a NormalizedError. */
export class NodalError extends Error {
  readonly normalized: NormalizedError;
  constructor(normalized: NormalizedError) {
    super(normalized.message);
    this.name = 'NodalError';
    this.normalized = normalized;
  }
}

export function nodalError(code: ErrorCode, message: string, extra: Partial<NormalizedError> = {}): NodalError {
  return new NodalError({ code, message, ...extra });
}

export function toNormalized(e: unknown): NormalizedError {
  if (e instanceof NodalError) return e.normalized;
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  if (err?.name === 'AbortError') return { code: 'cancelled', message: 'Cancelled' };
  const raw = [err?.message, err?.cause?.code, err?.cause?.message].filter(Boolean).join(' ');
  if (/fetch failed|net::|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|socket|network|terminated|TLS|CERT|SSL/i.test(raw)) {
    return { code: 'network', message: describeNetworkFailure(raw) };
  }
  return { code: 'internal', message: err?.message || String(e) };
}

/** Plain-language cause for a transport failure. */
export function describeNetworkFailure(raw: string): string {
  const r = raw.toUpperCase();
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(r)) return 'Could not find the server. Check the base URL and your internet connection.';
  if (/CONNECTION_REFUSED|ECONNREFUSED/.test(r)) return 'The server refused the connection. Is it running, and is the port right?';
  if (/CERT|SSL|TLS/.test(r)) return 'Could not establish a secure connection (TLS or certificate problem).';
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED/.test(r)) return 'No internet connection.';
  if (/TIMED_OUT|ETIMEDOUT/.test(r)) return 'The connection timed out before the server answered.';
  if (/PROXY/.test(r)) return 'Could not connect through the proxy. Check the proxy setting.';
  if (/CONNECTION_RESET|ECONNRESET|EPIPE|TERMINATED|CONNECTION_CLOSED|EMPTY_RESPONSE|SOCKET/.test(r)) return 'The connection was dropped by the server or the network.';
  return `Network error: ${raw.trim()}`;
}

const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray'];

export function requestIdFrom(headers: Headers, preferred: string[] = []): string | undefined {
  for (const h of [...preferred, ...REQUEST_ID_HEADERS]) {
    const v = headers.get(h);
    if (v) return v;
  }
  return undefined;
}

/**
 * Rate-limit reset values come in three shapes across providers: an epoch
 * timestamp (seconds or ms), a number of seconds from now, or a Go-style
 * duration ("6m0s", "250ms"). Returns epoch ms.
 */
export function parseReset(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return n; // epoch ms
    if (n > 1e9) return n * 1000; // epoch seconds
    return now + n * 1000; // seconds from now
  }
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  for (let m = re.exec(v); m; m = re.exec(v)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  if (matched) return now + total;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : date;
}

function num(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseRateLimit(headers: Headers, now: number): RateLimitInfo | undefined {
  const info: RateLimitInfo = {
    limitRequests: num(headers.get('x-ratelimit-limit-requests')),
    remainingRequests: num(headers.get('x-ratelimit-remaining-requests')),
    resetRequestsAt: parseReset(headers.get('x-ratelimit-reset-requests'), now),
    limitTokens: num(headers.get('x-ratelimit-limit-tokens')),
    remainingTokens: num(headers.get('x-ratelimit-remaining-tokens')),
    resetTokensAt: parseReset(headers.get('x-ratelimit-reset-tokens'), now),
  };
  return Object.values(info).some((v) => v !== undefined) ? info : undefined;
}

function retryAfterMs(headers: Headers, now: number): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Pull the provider's own message out of whatever error body shape it sent. */
export function extractErrorMessage(body: string): { message?: string; code?: string; html: boolean } {
  const trimmed = body.trim();
  if (/^<(!doctype|html)/i.test(trimmed)) return { html: true };
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const e = j.error;
    if (typeof e === 'string') {
      const details = j.details ? ` (${typeof j.details === 'string' ? j.details : JSON.stringify(j.details)})` : '';
      return { message: e + details, code: typeof j.code === 'string' ? j.code : undefined, html: false };
    }
    if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      const message = typeof o.message === 'string' ? o.message : JSON.stringify(o);
      const code = typeof o.code === 'string' ? o.code : typeof o.type === 'string' ? o.type : undefined;
      return { message, code, html: false };
    }
    if (typeof j.message === 'string') return { message: j.message, html: false };
    if (typeof j.detail === 'string') return { message: j.detail, html: false };
  } catch {
    /* not JSON */
  }
  return { message: trimmed ? trimmed.slice(0, 2000) : undefined, html: false };
}

const CONTEXT_RE = /context[ _-]?(length|window|size)|maximum context|too many tokens|token limit|reduce the length|exceeds? the (model'?s? )?(max|limit)|prompt is too long/i;

export interface HttpErrorOptions {
  requestIdHeaders?: string[];
  now?: number;
}

/** Spec section 8: map an HTTP failure to a NormalizedError. */
export function normalizeHttpError(status: number, body: string, headers: Headers, opts: HttpErrorOptions = {}): NormalizedError {
  const now = opts.now ?? Date.now();
  const { message, code: providerCode, html } = extractErrorMessage(body);
  const requestId = requestIdFrom(headers, opts.requestIdHeaders);
  const base = { status, requestId };
  const text = message ?? `HTTP ${status}`;

  if (status === 400 || status === 413 || status === 422) {
    const isContext = CONTEXT_RE.test(text) || /context_length/i.test(providerCode ?? '');
    return { ...base, code: isContext ? 'context_length' : 'invalid_request', message: text };
  }
  if (status === 401) return { ...base, code: 'auth', message: message ?? 'The provider rejected the API key.' };
  if (status === 402) return { ...base, code: 'quota', message: message ?? 'Payment required: balance or spend limit reached.' };
  if (status === 403) return { ...base, code: 'forbidden', message: text };
  if (status === 404 || status === 405) {
    return {
      ...base,
      code: 'model_not_found',
      message: html ? `HTTP ${status}: the server returned a web page, not an API response.` : text,
      hint: html
        ? 'The base URL is probably wrong: it points at a website, not an API endpoint.'
        : 'The model may have been removed, or the base URL may be wrong.',
    };
  }
  if (status === 429) {
    const rl = parseRateLimit(headers, now);
    const ra = retryAfterMs(headers, now);
    const candidates = [rl?.remainingRequests === 0 ? rl.resetRequestsAt : undefined, rl?.remainingTokens === 0 ? rl.resetTokensAt : undefined]
      .filter((x): x is number => x !== undefined);
    const fallback = [rl?.resetRequestsAt, rl?.resetTokensAt].filter((x): x is number => x !== undefined);
    const resetAt = ra !== undefined ? now + ra : candidates.length ? Math.max(...candidates) : fallback.length ? Math.min(...fallback) : undefined;
    return {
      ...base,
      code: 'rate_limit',
      message: message ?? 'Rate limit exceeded.',
      resetAt,
      retryAfterMs: resetAt !== undefined ? Math.max(0, resetAt - now) : undefined,
    };
  }
  if (status >= 500) {
    return { ...base, code: 'server', message: html ? `The server failed with HTTP ${status}.` : text };
  }
  return { ...base, code: 'invalid_request', message: html ? `Unexpected HTTP ${status}.` : text };
}
