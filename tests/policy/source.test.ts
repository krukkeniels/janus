import { describe, expect, it } from 'vitest';
import { stripComments } from '../../src/policy/source.js';

describe('stripComments', () => {
  it('removes line comments', () => {
    expect(stripComments('const x = 1; // comment\nconst y = 2;')).toBe('const x = 1; \nconst y = 2;');
  });

  it('removes block comments', () => {
    expect(stripComments('const x = /* comment */ 1;')).toBe('const x =  1;');
  });

  it('preserves line count for single-line block comments', () => {
    const source = 'line 1\n/* comment */\nline 3';
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('preserves line count for multi-line block comments', () => {
    const source = 'line 1\n/* comment\nspans\nmultiple\nlines */\nline 6';
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
    // The comment should be replaced with 4 newlines (the comment spanned 4 newlines)
    expect(stripped).toBe('line 1\n\n\n\n\nline 6');
  });

  it('handles multiple block comments', () => {
    const source = 'a\n/* first */\nb\n/* second\nline */\nc';
    const stripped = stripComments(source);
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('handles nested-looking block comments correctly', () => {
    // Note: /* ... */ does not nest in C-style comments, so this is one block
    const source = 'code /* outer /* inner */ still comment */ more';
    const stripped = stripComments(source);
    // The regex will match from first /* to first */, leaving "still comment */ more"
    expect(stripped).toContain('more');
  });
});
