/**
 * Incremental server-sent-events parser. Feed it decoded text in whatever
 * pieces the network delivers; it returns each complete event's data payload.
 * Handles CRLF, events split across reads, multi-line data and comment
 * keep-alive lines (": ping").
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];

  feed(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\n|\r/);
      if (nl === -1) break;
      // A lone trailing \r may be the first half of a \r\n split across reads.
      if (this.buf[nl] === '\r' && nl === this.buf.length - 1) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1));
      this.line(line, out);
    }
    return out;
  }

  /** Call at end of stream: flushes an event that had no trailing blank line. */
  end(): string[] {
    const out: string[] = [];
    if (this.buf.length) {
      this.line(this.buf, out);
      this.buf = '';
    }
    if (this.data.length) {
      out.push(this.data.join('\n'));
      this.data = [];
    }
    return out;
  }

  private line(line: string, out: string[]): void {
    if (line === '') {
      if (this.data.length) {
        out.push(this.data.join('\n'));
        this.data = [];
      }
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
    // `event`, `id` and `retry` fields are not used by chat-completions streams.
  }
}
