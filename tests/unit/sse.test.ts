import { describe, expect, it } from 'vitest';
import { SseParser } from '../../src/main/net/sse';
import { ThinkTagParser } from '../../src/main/providers/thinkParser';

describe('SseParser', () => {
  it('parses events split at every possible boundary', () => {
    const stream = ': keep-alive\n\ndata: {"a":1}\n\ndata: line1\ndata: line2\r\n\r\ndata: [DONE]\n\n';
    for (let size = 1; size <= stream.length; size++) {
      const p = new SseParser();
      const out: string[] = [];
      for (let i = 0; i < stream.length; i += size) out.push(...p.feed(stream.slice(i, i + size)));
      out.push(...p.end());
      expect(out, `chunk size ${size}`).toEqual(['{"a":1}', 'line1\nline2', '[DONE]']);
    }
  });

  it('ignores comments and unknown fields, and flushes a final event with no blank line', () => {
    const p = new SseParser();
    expect(p.feed(': ping\nevent: message\nid: 7\ndata:no-space\n\n')).toEqual(['no-space']);
    expect(p.feed('data: tail')).toEqual([]);
    expect(p.end()).toEqual(['tail']);
  });
});

describe('ThinkTagParser', () => {
  const run = (chunks: string[]) => {
    const p = new ThinkTagParser();
    const pieces = [...chunks.flatMap((c) => p.feed(c)), ...p.flush()];
    return {
      text: pieces.filter((x) => x.kind === 'text').map((x) => x.text).join(''),
      reasoning: pieces.filter((x) => x.kind === 'reasoning').map((x) => x.text).join(''),
    };
  };

  it('separates inline think blocks whatever the chunking', () => {
    const full = 'Before <think>step one\nstep two</think>\n\nThe answer is 42.';
    for (let size = 1; size <= full.length; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
      expect(run(chunks), `chunk size ${size}`).toEqual({ text: 'Before The answer is 42.', reasoning: 'step one\nstep two' });
    }
  });

  it('leaves lookalike text alone and keeps an unterminated block as reasoning', () => {
    expect(run(['a < b and <thin', 'g> stays'])).toEqual({ text: 'a < b and <thing> stays', reasoning: '' });
    expect(run(['<think>never closed'])).toEqual({ text: '', reasoning: 'never closed' });
  });
});
