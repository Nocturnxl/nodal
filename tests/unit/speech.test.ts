import { describe, expect, it } from 'vitest';
import { MAX_SPEECH_CHARS, speakable, takeSentences } from '../../src/shared/speech';
import { multipart } from '../../src/main/net/http';

describe('text made ready to read aloud', () => {
  it('drops Markdown marks and keeps the words', () => {
    expect(speakable('## Title\n\nSome **bold**, _soft_ and `code` words.')).toBe('Title Some bold, soft and code words.');
    expect(speakable('- one\n- two\n3. three')).toBe('one two three');
    expect(speakable('See [the docs](https://example.com/a?b=c) or https://example.com/x now.')).toBe('See the docs or (link) now.');
    expect(speakable('![chart](https://example.com/c.png) after')).toBe('after');
    expect(speakable('> quoted\n> lines')).toBe('quoted lines');
  });

  it('names a code block instead of reading it', () => {
    expect(speakable('Run this:\n```js\nconst a = 1;\n```\nDone.')).toBe('Run this: (code block) Done.');
  });

  it('reads a table as phrases rather than pipes', () => {
    expect(speakable('| a | b |\n|---|---|\n| 1 | 2 |')).not.toContain('|');
  });
});

describe('splitting a streaming reply into spoken pieces', () => {
  const long = 'This first sentence is comfortably longer than the minimum piece length there is. ';

  it('waits for a whole sentence while the reply is still arriving', () => {
    expect(takeSentences('This sentence is not finished yet and keeps on going for a good while', false)).toEqual({ pieces: [], rest: 'This sentence is not finished yet and keeps on going for a good while' });
    const out = takeSentences(`${long}And then more`, false);
    expect(out.pieces).toEqual([long.trim()]);
    expect(out.rest).toBe('And then more');
  });

  it('does not treat the end of the text so far as the end of a sentence', () => {
    // "3." may turn into "3.14" with the next chunk.
    const text = 'The value of pi to two decimal places is, as everybody knows, 3.';
    expect(takeSentences(text, false).pieces).toEqual([]);
    expect(takeSentences(text, true).pieces).toEqual([text]);
  });

  it('joins short sentences so the voice does not stop and start', () => {
    const out = takeSentences('Yes. No. Maybe. It really depends on what you mean by that, to be honest. Next', false);
    expect(out.pieces).toHaveLength(1);
    expect(out.pieces[0]).toMatch(/^Yes\. No\. Maybe\. It really depends/);
    expect(out.rest).toBe('Next');
  });

  it('takes whatever is left when the reply is complete, and nothing when that is only marks', () => {
    expect(takeSentences('Paris', true)).toEqual({ pieces: ['Paris'], rest: '' });
    expect(takeSentences('***', true)).toEqual({ pieces: [], rest: '' });
    expect(takeSentences('', true)).toEqual({ pieces: [], rest: '' });
  });

  it('holds back an unfinished code block instead of reading half of it', () => {
    const open = `${long}Here it is:\n\`\`\`js\nconst a = 1. toString();\n\nconst b = 2;`;
    const first = takeSentences(open, false);
    expect(first.pieces).toEqual([long.trim()]);
    expect(first.rest.startsWith('Here it is:')).toBe(true);
    const closed = takeSentences(`${first.rest}\n\`\`\`\nThat is all.`, true);
    expect(closed.pieces.join(' ')).toBe('Here it is: (code block) That is all.');
  });

  it('cuts text with no sentence end, and never sends an oversized piece', () => {
    const words = 'word '.repeat(600);
    const out = takeSentences(words, false);
    expect(out.pieces.length).toBeGreaterThan(0);
    for (const p of takeSentences(words, true).pieces) expect(p.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
    for (const p of takeSentences('x'.repeat(5000), true).pieces) expect(p.length).toBeLessThanOrEqual(MAX_SPEECH_CHARS);
  });

  it('loses nothing across a reply fed in small chunks', () => {
    const reply = 'The capital of France is Paris. It has been the capital for a very long time indeed! Would you like to know more about it? Just ask.';
    let pending = '';
    const said: string[] = [];
    for (let i = 0; i < reply.length; i += 7) {
      pending += reply.slice(i, i + 7);
      const out = takeSentences(pending, false);
      pending = out.rest;
      said.push(...out.pieces);
    }
    said.push(...takeSentences(pending, true).pieces);
    expect(said.join(' ')).toBe(reply);
    expect(said.length).toBeGreaterThan(1);
  });
});

describe('multipart upload body', () => {
  it('carries the fields and the file bytes intact, and cannot be broken by a field value', () => {
    const data = new Uint8Array([0, 255, 13, 10, 45, 45]);
    const body = multipart({ model: 'm', note: 'a"b\r\nc' }, { field: 'file', name: 'speech"\r\n.webm', mime: 'audio/webm', data });
    const boundary = body.contentType.replace('multipart/form-data; boundary=', '');
    const text = Buffer.from(body.data).toString('latin1');
    expect(text.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nm\r\n`)).toBe(true);
    expect(text).toContain('name="file"; filename="speech.webm"\r\nContent-Type: audio/webm\r\n\r\n');
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    const start = text.indexOf('audio/webm\r\n\r\n') + 'audio/webm\r\n\r\n'.length;
    expect([...body.data.subarray(start, start + data.length)]).toEqual([...data]);
  });
});
