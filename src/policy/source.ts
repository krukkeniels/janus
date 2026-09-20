/**
 * Strips `//` line comments and C-style block comments (including multi-line ones), so
 * commented-out code does not appear to the check. Preserves line count by replacing each
 * block comment with the same number of newlines it spanned, so line numbers remain truthful.
 * Block comments are stripped first so a `//` sequence that happens to sit inside one cannot
 * truncate the strip early.
 */
export function stripComments(source: string): string {
  // Replace block comments with the same number of newlines they spanned, preserving line count
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//gu, (match) => {
    const newlineCount = (match.match(/\n/gu) ?? []).length;
    return '\n'.repeat(newlineCount);
  });
  // Remove line comments (they already preserve their newline)
  return withoutBlockComments.replace(/\/\/.*$/gmu, '');
}
