/**
 * Strips `//` line comments and C-style block comments (including multi-line ones), so
 * commented-out code does not appear to the check. Block comments are stripped first so a `//`
 * sequence that happens to sit inside one cannot truncate the strip early.
 */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
}
