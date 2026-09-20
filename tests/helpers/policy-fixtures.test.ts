import { describe, expect, it } from 'vitest';
import { diffFile } from './policy-fixtures.js';

describe('diffFile', () => {
  it('throws rather than building a binary file that also carries text hunks', () => {
    expect(() => diffFile({ path: 'logo.png', binary: true, added: ['not really binary'] })).toThrow(
      /cannot be both binary and carry added\/removed text lines/,
    );
    expect(() => diffFile({ path: 'logo.png', binary: true, removed: ['not really binary'] })).toThrow(
      /cannot be both binary and carry added\/removed text lines/,
    );
  });

  it('builds a binary file with no hunks and a Binary files section', () => {
    const file = diffFile({ path: 'logo.png', binary: true });
    expect(file.hunks).toEqual([]);
    expect(file.added).toBe(0);
    expect(file.removed).toBe(0);
    expect(file.section).toContain('Binary files a/logo.png and b/logo.png differ');
  });

  it('names the previous path on the a/ side of a rename section, not the new path twice', () => {
    const file = diffFile({ path: 'new name.ts', previousPath: 'old name.ts', status: 'R', added: ['x'] });
    expect(file.section.split('\n')[0]).toBe('diff --git a/old name.ts b/new name.ts');
  });
});
