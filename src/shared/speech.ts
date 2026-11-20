// Turning a streamed Markdown reply into pieces worth reading aloud.

/** Longest piece sent to a text-to-speech service in one request. */
export const MAX_SPEECH_CHARS = 1200;
/** Pieces shorter than this wait for the next sentence, so the voice does not stop and start on every "OK." */
const MIN_PIECE = 60;

/** Strips Markdown down to what a person would say. Code blocks are named, not read out. */
export function speakable(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?(```|$)/g, ' (code block) ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, ' (link) ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ')
      .replace(/\|/g, ', ')
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
      // Whatever marks are left over would be read as "asterisk".
      .replace(/[*_~#]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Splits off the text that is ready to be spoken. While a reply is still
 * arriving only whole sentences are taken; `final` takes whatever is left.
 * Returns the pieces and the text still waiting.
 */
export function takeSentences(pending: string, final: boolean): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  let rest = pending;
  // A code block that has not closed yet is held back whole, so it is never read out half-way.
  const fences = (s: string) => (s.match(/```/g) ?? []).length;
  for (;;) {
    let cut = -1;
    const ends = /[.!?…:;]["')\]]?(\s+|$)|\n{2,}/g;
    let m: RegExpExecArray | null;
    while ((m = ends.exec(rest))) {
      const at = m.index + m[0].length;
      // A sentence end at the very end of the text may still grow ("3." then "14").
      if (!final && at >= rest.length && !/\n{2,}$/.test(m[0])) break;
      if (fences(rest.slice(0, at)) % 2 === 1) continue;
      if (at >= MIN_PIECE) {
        cut = at;
        break;
      }
    }
    if (cut === -1 && rest.length > MAX_SPEECH_CHARS && fences(rest) % 2 === 0) {
      // No sentence end in sight: cut at the last space rather than wait for ever.
      const space = rest.lastIndexOf(' ', MAX_SPEECH_CHARS);
      cut = space > MIN_PIECE ? space + 1 : MAX_SPEECH_CHARS;
    }
    if (cut === -1) break;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (final && rest.trim()) {
    pieces.push(rest);
    rest = '';
  }
  const spoken: string[] = [];
  for (const piece of pieces) {
    let text = speakable(piece);
    while (text.length > MAX_SPEECH_CHARS) {
      const space = text.lastIndexOf(' ', MAX_SPEECH_CHARS);
      const at = space > 0 ? space : MAX_SPEECH_CHARS;
      spoken.push(text.slice(0, at).trim());
      text = text.slice(at).trim();
    }
    if (/[\p{L}\p{N}]/u.test(text)) spoken.push(text);
  }
  return { pieces: spoken, rest };
}
