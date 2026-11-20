// A local mock provider: /models, an SSE /chat/completions and a Venice-style
// /api_keys/rate_limits. The model ID selects the behaviour, so unit tests,
// end-to-end tests and manual runs (`npm run mock`) all drive it the same way
// and CI needs no real key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_KEY = 'mock-key-0123456789abcdef';

export const MOCK_MODELS = [
  'mock-echo',
  'mock-markdown',
  'mock-long',
  'mock-slow-start',
  'mock-split',
  'mock-think',
  'mock-reasoning',
  'mock-disconnect',
  'mock-stall',
  'mock-json',
  'mock-strict',
  'mock-401',
  'mock-402',
  'mock-403',
  'mock-404-html',
  'mock-400-context',
  'mock-429-once',
  'mock-429-always',
  'mock-500-once',
  'mock-500-always',
  'mock-deprecated',
];

export interface MockRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface MockServer {
  url: string;
  port: number;
  requests: MockRequest[];
  /** Calls per model, used by the "fail once, then succeed" models. */
  hits: Record<string, number>;
  /** What POST /audio/transcriptions answers. Tests may change it. */
  transcript: string;
  reset(): void;
  close(): Promise<void>;
}

const character = (slug: string, name: string, description: string | null, extra: Record<string, unknown> = {}) => ({
  id: `id-${slug}`,
  slug,
  name,
  description,
  adult: false,
  author: 'anon',
  featured: false,
  tags: [] as string[],
  webEnabled: false,
  modelId: 'mock-echo',
  shareUrl: `https://venice.ai/c/${slug}`,
  photoUrl: null,
  createdAt: '2024-12-20T21:28:08.934Z',
  updatedAt: '2024-12-20T21:28:08.934Z',
  stats: { averageRating: 4.7, imports: 112, ratingCount: 24, ratingSum: 113, userRating: null },
  ...extra,
});

/** Shaped like Venice's GET /characters, per its API reference. */
export const MOCK_CHARACTERS = [
  character('alan-watts', 'Alan Watts', 'A philosopher who   talks about Zen\nand the nature of the self.', { tags: ['philosophy'], featured: true }),
  character('ada-lovelace', 'Ada Lovelace', 'The first programmer, curious about engines of every kind.', { tags: ['history', 'mathematics'] }),
  character('night-owl', 'Night Owl', null, { adult: true, modelId: 'mock-markdown' }),
];

/**
 * A rough stand-in for a voice: a pitch that wanders, with overtones, chopped
 * into syllables. A steady tone will not do, because the noise suppression a
 * microphone stream goes through treats anything constant as background noise
 * and removes it (seen on macOS).
 */
function voiced(t: number): number {
  const syllable = t % 0.25 < 0.18 ? Math.sin((Math.PI * (t % 0.25)) / 0.18) : 0;
  const pitch = 150 + 40 * Math.sin(2 * Math.PI * 1.3 * t) + 25 * Math.sin(2 * Math.PI * 3.1 * t);
  let sum = 0;
  for (let k = 1; k <= 8; k++) sum += Math.sin(2 * Math.PI * pitch * k * t) / k;
  return 0.3 * syllable * sum;
}

/**
 * A 16-bit PCM WAV made of stretches of silence and of voice-like sound, e.g.
 * `[[0.5, false], [1, true]]` for half a second of silence, then a second of sound.
 */
export function wav(parts: [seconds: number, tone: boolean][], rate = 16_000, channels = 1): Buffer {
  const frames = parts.reduce((n, [s]) => n + Math.round(s * rate), 0);
  const out = Buffer.alloc(44 + frames * channels * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + frames * channels * 2, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(frames * channels * 2, 40);
  let at = 44;
  let i = 0;
  for (const [seconds, tone] of parts) {
    for (let n = Math.round(seconds * rate); n > 0; n--, i++) {
      const v = tone ? Math.round(voiced(i / rate) * 32767) : 0;
      for (let c = 0; c < channels; c++, at += 2) out.writeInt16LE(v, at);
    }
  }
  return out;
}

export interface MockOptions {
  port?: number;
  /** Require `Authorization: Bearer MOCK_KEY` (default true). */
  auth?: boolean;
  /** Milliseconds between streamed chunks (default 5). */
  chunkDelayMs?: number;
  /** Serve /models without auth, like Venice does. */
  publicModels?: boolean;
}

const MARKDOWN_SAMPLE = `Here is a **quick tour** of what NODAL renders.

## Lists and inline code

1. Numbered items with \`inline code\`
2. A [link that asks before opening](https://example.com/docs?page=2)
3. A remote image is never fetched: ![chart](https://example.com/chart.png)

- [x] Task lists
- [ ] And unchecked items

## Code

\`\`\`ts
export function greet(name: string): string {
  // Highlighted without any network access
  return \`Hello, \${name}!\`;
}
\`\`\`

## Tables

| Model | Context | Vision |
| --- | ---: | :---: |
| alpha | 128k | yes |
| beta | 32k | no |

> Raw HTML such as <script>alert(1)</script> is shown as text, never executed.
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return sse({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
}

function lastUserText(body: any): string {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as any[]).map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ');
}

export async function startMockServer(opts: MockOptions = {}): Promise<MockServer> {
  const requireAuth = opts.auth ?? true;
  const delay = opts.chunkDelayMs ?? 5;
  const requests: MockRequest[] = [];
  const hits: Record<string, number> = {};
  const state = { transcript: 'What is the capital of France?' };
  let seq = 0;

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body });

    const requestId = `mock-req-${++seq}`;
    res.setHeader('x-request-id', requestId);
    res.setHeader('CF-RAY', `${requestId}-MOCK`);
    const authed = !requireAuth || req.headers.authorization === `Bearer ${MOCK_KEY}`;
    const hasCreds = !!req.headers.authorization;

    if (url.pathname.endsWith('/models') && req.method === 'GET') {
      if (!authed && !opts.publicModels) return json(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      return json(res, 200, { object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock' })) });
    }

    if (url.pathname.endsWith('/key') && req.method === 'GET') {
      // OpenRouter-style key check.
      if (!authed) return json(res, 401, { error: { message: 'User not found.', code: 401 } });
      return json(res, 200, { data: { label: 'mock', limit: null, usage: 0, is_free_tier: false } });
    }

    if (url.pathname.endsWith('/characters') && req.method === 'GET') {
      if (!hasCreds) return json(res, 402, { x402Version: 2, error: 'Authentication required' });
      if (!authed) return json(res, 401, { error: 'Authentication failed' });
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const found = MOCK_CHARACTERS.filter((c) => !q || [c.name, c.description ?? '', ...c.tags].some((t) => t.toLowerCase().includes(q)));
      return json(res, 200, { object: 'list', data: found.slice(0, limit) });
    }

    if (url.pathname.endsWith('/audio/transcriptions') && req.method === 'POST') {
      if (!hasCreds) return json(res, 402, { x402Version: 2, error: 'Authentication required' });
      if (!authed) return json(res, 401, { error: 'Authentication failed' });
      if (!/^multipart\/form-data; boundary=/.test(req.headers['content-type'] ?? '') || !String(body).includes('name="file"')) return json(res, 400, { error: 'file is required' });
      return json(res, 200, { text: state.transcript, duration: 1.2 });
    }

    if (url.pathname.endsWith('/audio/speech') && req.method === 'POST') {
      if (!hasCreds) return json(res, 402, { x402Version: 2, error: 'Authentication required' });
      if (!authed) return json(res, 401, { error: 'Authentication failed' });
      if (typeof body?.input !== 'string' || !body.input) return json(res, 400, { error: 'input is required' });
      // A real clip a browser can decode, whatever format was asked for.
      const clip = wav([[0.15, true]]);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': clip.length });
      return void res.end(clip);
    }

    if (url.pathname.endsWith('/api_keys/rate_limits')) {
      if (!hasCreds) return json(res, 402, { x402Version: 2, error: 'Authentication required' });
      if (!authed) return json(res, 401, { error: 'Authentication failed' });
      return json(res, 200, { data: { accessPermitted: true, apiTier: { id: 'paid', isCharged: true }, balances: { USD: 50.23, DIEM: 100.02 }, rateLimits: [] } });
    }

    if (url.pathname.endsWith('/chat/completions') && req.method === 'POST') {
      if (!authed) return json(res, 401, { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } });
      const model = String(body?.model ?? '');
      hits[model] = (hits[model] ?? 0) + 1;
      const n = hits[model];

      if (model === 'mock-strict') {
        // Behaves like a newer OpenAI model: one complaint per request, by field name.
        const bad = (message: string) => json(res, 400, { error: { message, type: 'invalid_request_error', code: 'unsupported_parameter' } });
        if ('stream_options' in body) return bad('Unrecognized request argument supplied: stream_options');
        if ('max_tokens' in body) return bad("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.");
        if ('temperature' in body) return bad("Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.");
      }
      if (model === 'mock-401') return json(res, 401, { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } });
      if (model === 'mock-402') return json(res, 402, { error: 'Insufficient USD or Diem balance to complete request.' }, { 'x-venice-balance-usd': '0.00', 'x-venice-balance-diem': '0.00' });
      if (model === 'mock-403') return json(res, 403, { error: 'API access is disabled for this key.' });
      if (model === 'mock-404-html') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        return res.end('<!DOCTYPE html><html><body><h1>Not Found</h1></body></html>');
      }
      if (model === 'mock-400-context') {
        return json(res, 400, { error: { message: "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.", type: 'invalid_request_error', code: 'context_length_exceeded' } });
      }
      if (model === 'mock-429-always' || (model === 'mock-429-once' && n === 1)) {
        return json(
          res,
          429,
          { error: 'Rate limit exceeded.' },
          { 'x-ratelimit-limit-requests': '20', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '0.05', 'retry-after': '0.05' },
        );
      }
      if (model === 'mock-500-always' || (model === 'mock-500-once' && n === 1)) return json(res, 500, { error: 'Inference backend crashed.' });

      if (model === 'mock-json') {
        return json(res, 200, {
          choices: [{ index: 0, message: { role: 'assistant', content: 'A complete non-streamed reply.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 5 },
        });
      }

      if (model === 'mock-slow-start') await sleep(Number(url.searchParams.get('delay')) || 400);

      const headers: Record<string, string> = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'x-ratelimit-limit-requests': '20',
        'x-ratelimit-remaining-requests': '19',
        'x-ratelimit-reset-requests': '60',
        'x-ratelimit-remaining-tokens': '99000',
        'x-venice-balance-usd': '12.50',
      };
      if (model === 'mock-deprecated') {
        headers['x-venice-model-deprecation-warning'] = 'This model is deprecated and will be removed.';
        headers['x-venice-model-deprecation-date'] = '2027-01-31';
      }
      res.writeHead(200, headers);
      const write = (s: string | Buffer) => new Promise<void>((r) => (res.write(s) ? r() : res.once('drain', () => r())));
      let closed = false;
      res.on('close', () => (closed = true));

      const say = lastUserText(body);
      let pieces: string[];
      if (model === 'mock-long') pieces = Array.from({ length: 400 }, (_, i) => `word${i} `);
      else if (model === 'mock-think') pieces = ['<th', 'ink>Let me ', 'think.</th', 'ink>\n\n', 'The answer ', 'is 42.'];
      else if (model === 'mock-split') pieces = ['Héllo ', 'wörld ', '— 你好 ', '🌍 done'];
      else if (model === 'mock-markdown') pieces = MARKDOWN_SAMPLE.split(/(?<=\s)/);
      else pieces = `You said: ${say}`.split(/(?<= )/);

      await write(': keep-alive\n\n');
      if (model === 'mock-reasoning') {
        for (const r of ['Weighing ', 'the options.']) {
          await write(chunk({ reasoning_content: r }));
          await sleep(delay);
        }
      }

      if (model === 'mock-split') {
        // Deliver the whole stream in 3-byte slices: events and multi-byte
        // characters are cut at arbitrary points.
        const all = Buffer.from(pieces.map((p) => chunk({ content: p })).join('') + chunk({}, 'stop') + 'data: [DONE]\n\n', 'utf8');
        for (let i = 0; i < all.length && !closed; i += 3) {
          await write(all.subarray(i, i + 3));
          if (i % 30 === 0) await sleep(1);
        }
        return res.end();
      }

      for (let i = 0; i < pieces.length && !closed; i++) {
        await write(chunk(i === 0 ? { role: 'assistant', content: pieces[i] } : { content: pieces[i] }));
        await sleep(model === 'mock-long' ? Math.max(delay, 10) : delay);
        if (model === 'mock-disconnect' && i === 1) return void res.destroy();
        if (model === 'mock-stall' && i === 0) return; // never finishes, never closes
      }
      if (closed) return;
      await write(chunk({}, 'stop'));
      await write(sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: pieces.length } }));
      await write('data: [DONE]\n\n');
      return res.end();
    }

    json(res, 404, { error: 'Not found' });
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    hits,
    get transcript() {
      return state.transcript;
    },
    set transcript(v: string) {
      state.transcript = v;
    },
    reset() {
      requests.length = 0;
      for (const k of Object.keys(hits)) delete hits[k];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
