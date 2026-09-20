import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import {
  analyzeDiff,
  buildDiffAnalysis,
  changeSummaryFrom,
  DiffAnalysisError,
  inlineDiffFrom,
  parseHunks,
  splitPatchSections,
} from '../../src/policy/diff.js';
import { tempDir } from '../helpers/git-fixtures.js';

async function repo(): Promise<string> {
  const dir = join(tempDir(), 'r');
  mkdirSync(dir);
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = true;\n');
  writeFileSync(join(dir, 'old name.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  await commitAll(dir, 'feat(r): base');
  return dir;
}

describe('analyzeDiff', () => {
  it('reports every changed file from the tree with its hunks', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\nconst b = 22;\nconst c = 3;\n');
    writeFileSync(join(dir, 'new.ts'), 'export const added = 1;\n');
    rmSync(join(dir, 'gone.ts'));
    await runGit(dir, ['mv', 'old name.ts', 'new name.ts']);

    const analysis = await analyzeDiff(dir);
    const byPath = new Map(analysis.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual(['gone.ts', 'new name.ts', 'new.ts', 'src-a.ts']);
    expect(byPath.get('new name.ts')?.status).toBe('R');
    expect(byPath.get('new name.ts')?.previousPath).toBe('old name.ts');
    expect(byPath.get('gone.ts')?.status).toBe('D');

    const modified = byPath.get('src-a.ts');
    expect(modified?.added).toBe(1);
    expect(modified?.removed).toBe(1);
    expect(modified?.hunks[0]?.added[0]).toEqual({ text: 'const b = 22;', line: 2 });
    expect(modified?.hunks[0]?.removed[0]).toEqual({ text: 'const b = 2;', line: 2 });
  });

  it('associates sections to files by order, so odd paths land on the right file', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'æøå.ts'), 'export const nordic = 1;\n');
    writeFileSync(join(dir, 'with space.ts'), 'export const spaced = 2;\n');
    const analysis = await analyzeDiff(dir);
    const byPath = new Map(analysis.files.map((file) => [file.path, file]));
    expect(byPath.get('æøå.ts')?.hunks[0]?.added[0]?.text).toBe('export const nordic = 1;');
    expect(byPath.get('with space.ts')?.hunks[0]?.added[0]?.text).toBe('export const spaced = 2;');
  });

  it('counts an empty tree as no change at all', async () => {
    const dir = await repo();
    const analysis = await analyzeDiff(dir);
    expect(analysis.files).toEqual([]);
    expect(analysis.totals).toEqual({ changedFiles: 0, addedLines: 0, removedLines: 0 });
  });

  it('sums totals across files', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'new.ts'), 'one\ntwo\n');
    const analysis = await analyzeDiff(dir);
    expect(analysis.totals.changedFiles).toBe(2);
    expect(analysis.totals.addedLines).toBe(2);
    expect(analysis.totals.removedLines).toBe(2);
  });

  it('marks a lockfile generated and keeps it out of the inline diff', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 9;\nconst b = 2;\nconst c = 3;\n');
    const analysis = await analyzeDiff(dir);
    expect(analysis.files.find((file) => file.path === 'pnpm-lock.yaml')?.generated).toBe(true);
    expect(changeSummaryFrom(analysis)).toContainEqual({ path: 'pnpm-lock.yaml', added: 1, removed: 0, generated: true });
    expect(inlineDiffFrom(analysis)).not.toContain('pnpm-lock.yaml');
    expect(inlineDiffFrom(analysis)).toContain('src-a.ts');
  });
});

describe('splitPatchSections', () => {
  it('returns one section per file, starting at each diff --git line', () => {
    const patch = [
      'diff --git a/one.ts b/one.ts',
      'index 111..222 100644',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/two.ts b/two.ts',
      'new file mode 100644',
    ].join('\n');
    const sections = splitPatchSections(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.startsWith('diff --git a/one.ts')).toBe(true);
    expect(sections[1]).toBe('diff --git a/two.ts b/two.ts\nnew file mode 100644');
  });

  it('returns nothing for an empty patch', () => {
    expect(splitPatchSections('')).toEqual([]);
  });

  it('does not split on an added line whose content looks like a header', () => {
    const patch = ['diff --git a/one.ts b/one.ts', '@@ -0,0 +1 @@', '+diff --git a/fake b/fake'].join('\n');
    expect(splitPatchSections(patch)).toHaveLength(1);
  });
});

describe('parseHunks', () => {
  it('numbers added lines in the new file and removed lines in the old one', () => {
    const section = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,4 +10,4 @@ context header text',
      ' keep',
      '-gone',
      '+fresh',
      ' keep2',
      '@@ -40,2 +40,3 @@',
      ' keep3',
      '+extra',
      '\\ No newline at end of file',
    ].join('\n');
    const hunks = parseHunks(section);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.removed).toEqual([{ text: 'gone', line: 11 }]);
    expect(hunks[0]?.added).toEqual([{ text: 'fresh', line: 11 }]);
    expect(hunks[1]?.added).toEqual([{ text: 'extra', line: 41 }]);
  });

  it('ignores the file header lines that start with --- and +++', () => {
    const section = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '+x'].join('\n');
    expect(parseHunks(section)[0]?.added).toEqual([{ text: 'x', line: 1 }]);
  });

  it('returns nothing for a section with no hunks', () => {
    expect(parseHunks('diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755')).toEqual([]);
  });
});

describe('buildDiffAnalysis', () => {
  it('throws when the file list and the patch sections disagree', () => {
    expect(() =>
      buildDiffAnalysis([{ status: 'M', path: 'a.ts' }], 'diff --git a/a.ts b/a.ts\ndiff --git a/b.ts b/b.ts'),
    ).toThrow(DiffAnalysisError);
  });

  it('marks a binary section without trying to parse hunks', () => {
    const analysis = buildDiffAnalysis(
      [{ status: 'M', path: 'logo.png' }],
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ',
    );
    expect(analysis.files[0]?.binary).toBe(true);
    expect(analysis.files[0]?.added).toBe(0);
  });
});
