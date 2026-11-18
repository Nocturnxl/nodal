import { describe, expect, it } from 'vitest';
import { normalizeHttpError, parseRateLimit, parseReset, toNormalized } from '../../src/main/net/errors';
import { checkBaseUrl, joinUrl, redact } from '../../src/main/net/http';

const h = (o: Record<string, string> = {}) => new Headers(o);
const NOW = 1_800_000_000_000;

describe('normalizeHttpError (spec section 8 table)', () => {
  it('400 is invalid_request, or context_length when the message says so', () => {
    expect(normalizeHttpError(400, '{"error":"Invalid request parameters"}', h()).code).toBe('invalid_request');
    const ctx = normalizeHttpError(400, '{"error":{"message":"maximum context length is 8192 tokens","code":"context_length_exceeded"}}', h());
    expect(ctx.code).toBe('context_length');
    expect(ctx.message).toContain('8192');
  });

  it('401 auth, 402 quota, 403 forbidden keep the provider message and request id', () => {
    const e = normalizeHttpError(401, '{"error":"Authentication failed"}', h({ 'cf-ray': 'abc-ATL' }), { requestIdHeaders: ['cf-ray'] });
    expect(e).toMatchObject({ code: 'auth', status: 401, message: 'Authentication failed', requestId: 'abc-ATL' });
    expect(normalizeHttpError(402, '{"error":"Insufficient USD or Diem balance"}', h()).code).toBe('quota');
    expect(normalizeHttpError(403, '{"error":{"message":"nope"}}', h())).toMatchObject({ code: 'forbidden', message: 'nope' });
  });

  it('404 with an HTML body hints that the base URL is wrong', () => {
    const e = normalizeHttpError(404, '<!DOCTYPE html><html></html>', h());
    expect(e.code).toBe('model_not_found');
    expect(e.hint).toMatch(/base URL is probably wrong/);
    expect(e.message).not.toContain('<html');
  });

  it('429 carries the reset time from the rate-limit headers', () => {
    const e = normalizeHttpError(429, '{"error":"Rate limit exceeded."}', h({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30' }), { now: NOW });
    expect(e).toMatchObject({ code: 'rate_limit', resetAt: NOW + 30_000, retryAfterMs: 30_000 });
    expect(normalizeHttpError(429, '', h({ 'retry-after': '2' }), { now: NOW }).retryAfterMs).toBe(2000);
  });

  it('5xx is server', () => {
    expect(normalizeHttpError(503, '{"error":"MODEL_AT_CAPACITY"}', h())).toMatchObject({ code: 'server', status: 503, message: 'MODEL_AT_CAPACITY' });
  });

  it('transport failures become plain-language network errors', () => {
    const e = toNormalized(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(e.code).toBe('network');
    expect(e.message).toMatch(/refused/);
    expect(toNormalized(new Error('net::ERR_NAME_NOT_RESOLVED')).message).toMatch(/Could not find the server/);
  });
});

describe('rate-limit headers', () => {
  it('parses epoch seconds, epoch ms, relative seconds and Go durations', () => {
    expect(parseReset('1800000060', NOW)).toBe(1_800_000_060_000);
    expect(parseReset('1800000060000', NOW)).toBe(1_800_000_060_000);
    expect(parseReset('12', NOW)).toBe(NOW + 12_000);
    expect(parseReset('6m0s', NOW)).toBe(NOW + 360_000);
    expect(parseReset('250ms', NOW)).toBe(NOW + 250);
    expect(parseReset(null, NOW)).toBeUndefined();
  });

  it('returns undefined when no rate-limit headers are present', () => {
    expect(parseRateLimit(h(), NOW)).toBeUndefined();
    expect(parseRateLimit(h({ 'x-ratelimit-remaining-requests': '19', 'x-ratelimit-limit-requests': '20' }), NOW)).toMatchObject({ remainingRequests: 19, limitRequests: 20 });
  });
});

describe('redaction and URL policy', () => {
  it('removes credentials from log text', () => {
    const out = redact('Authorization: Bearer abc123def456ghi789 and x-api-key=sk-live-AAAABBBBCCCCDDDDEEEE ok');
    expect(out).not.toContain('abc123def456ghi789');
    expect(out).not.toContain('AAAABBBBCCCCDDDDEEEE');
    expect(out).toContain('ok');
  });

  it('requires https except for loopback, and LAN only when confirmed', () => {
    expect(checkBaseUrl('https://api.venice.ai/api/v1', false).ok).toBe(true);
    expect(checkBaseUrl('http://localhost:1234/v1', false).ok).toBe(true);
    expect(checkBaseUrl('http://127.0.0.1:11434/v1', false).ok).toBe(true);
    expect(checkBaseUrl('http://192.168.1.20:1234/v1', false)).toMatchObject({ ok: false, needsInsecureConfirm: true });
    expect(checkBaseUrl('http://192.168.1.20:1234/v1', true).ok).toBe(true);
    expect(checkBaseUrl('http://api.example.com/v1', true).ok).toBe(false);
    expect(checkBaseUrl('ftp://example.com', false).ok).toBe(false);
    expect(checkBaseUrl('https://user:pw@example.com/v1', false).ok).toBe(false);
    expect(checkBaseUrl('not a url', false).ok).toBe(false);
  });

  it('joins base URL, path and query', () => {
    expect(joinUrl('https://api.venice.ai/api/v1/', '/models', { type: 'text' })).toBe('https://api.venice.ai/api/v1/models?type=text');
    expect(joinUrl('http://localhost:1234/v1', 'chat/completions')).toBe('http://localhost:1234/v1/chat/completions');
  });
});
