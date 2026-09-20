/**
 * Strips `//` line comments and C-style block comments (including multi-line ones), so
 * commented-out code does not appear to the check. Preserves line count: a block comment is
 * replaced by the same number of newlines it spanned, so line numbers remain truthful.
 *
 * A single-pass character scanner, not a regex: a block-comment regex has no notion of being
 * inside a string literal, so a glob like `'x/**'` (a string containing a slash-star sequence)
 * opens a "comment" that a later star-slash anywhere in the file — even inside an unrelated
 * string — closes, deleting everything between. This scanner tracks whether it is inside a `'`,
 * `"` or backtick string (honouring backslash escapes) and only treats a slash-slash or
 * slash-star as a comment opener outside of one, so a string's contents are copied verbatim and
 * can never be mistaken for a comment.
 */
export function stripComments(source: string): string {
  let result = '';
  let i = 0;
  const n = source.length;
  type State = 'code' | 'string' | 'lineComment' | 'blockComment';
  let state: State = 'code';
  let stringQuote = '';
  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1] : undefined;
    if (c === undefined) break;
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'lineComment';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'blockComment';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = 'string';
        stringQuote = c;
        result += c;
        i += 1;
        continue;
      }
      result += c;
      i += 1;
      continue;
    }
    if (state === 'string') {
      if (c === '\\') {
        // An escape: copy the backslash and whatever it escapes verbatim, without interpreting it.
        result += c;
        if (next !== undefined) {
          result += next;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (c === stringQuote) {
        state = 'code';
      }
      result += c;
      i += 1;
      continue;
    }
    if (state === 'lineComment') {
      if (c === '\n') {
        state = 'code';
        result += c;
      }
      i += 1;
      continue;
    }
    // state === 'blockComment'
    if (c === '*' && next === '/') {
      state = 'code';
      i += 2;
      continue;
    }
    if (c === '\n') result += '\n';
    i += 1;
  }
  return result;
}
