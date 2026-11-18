/**
 * Splits inline <think>...</think> blocks out of streamed content, so the UI
 * never parses tags. Tags may be split across chunks; a possible partial tag
 * at the end of a chunk is held back until the next one settles it.
 */
export type Piece = { kind: 'text' | 'reasoning'; text: string };

const OPEN = '<think>';
const CLOSE = '</think>';

export class ThinkTagParser {
  private inThink = false;
  private held = '';
  /** Drop the blank line(s) that usually follow a closing tag. */
  private skipNewlines = false;

  feed(chunk: string): Piece[] {
    const out: Piece[] = [];
    let s = this.held + chunk;
    this.held = '';
    while (s.length) {
      const tag = this.inThink ? CLOSE : OPEN;
      const idx = s.indexOf(tag);
      if (idx !== -1) {
        this.emit(out, s.slice(0, idx));
        s = s.slice(idx + tag.length);
        this.inThink = !this.inThink;
        this.skipNewlines = !this.inThink;
        continue;
      }
      // Hold back a trailing prefix of the tag ("<thi") in case it completes.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
        if (tag.startsWith(s.slice(s.length - n))) {
          keep = n;
          break;
        }
      }
      this.emit(out, s.slice(0, s.length - keep));
      this.held = s.slice(s.length - keep);
      break;
    }
    return out;
  }

  flush(): Piece[] {
    const out: Piece[] = [];
    this.emit(out, this.held);
    this.held = '';
    return out;
  }

  private emit(out: Piece[], text: string): void {
    const kind = this.inThink ? 'reasoning' : 'text';
    if (kind === 'text' && this.skipNewlines) {
      text = text.replace(/^[\r\n]+/, '');
      if (text) this.skipNewlines = false;
    }
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  }
}
