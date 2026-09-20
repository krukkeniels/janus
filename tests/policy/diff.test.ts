import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import {
  addedLines,
  analyzeDiff,
  buildDiffAnalysis,
  changeSummaryFrom,
  DiffAnalysisError,
  inlineDiffFrom,
  parseHunks,
  removedLines,
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

  it('merges a typechange into one file whose section carries both halves and both sets of lines', async () => {
    const dir = join(tempDir(), 'r');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    writeFileSync(join(dir, 'target.txt'), 'target\n');
    symlinkSync('target.txt', join(dir, 'link.txt'));
    await commitAll(dir, 'feat(r): base with a symlink');

    // git 2.43.0, reproduced: a symlink -> regular-file transition is one `T` name-status record but two
    // `diff --git` patch sections (a delete of the symlink, then an add of the regular file). This is exactly
    // the case `buildDiffAnalysis` must not mis-count or mis-attribute.
    rmSync(join(dir, 'link.txt'));
    writeFileSync(join(dir, 'link.txt'), 'now a real file\n');

    const analysis = await analyzeDiff(dir);
    expect(analysis.files).toHaveLength(1);
    const file = analysis.files[0];
    expect(file?.path).toBe('link.txt');
    expect(file?.status).toBe('T');
    expect(file?.section).toContain('deleted file mode 120000');
    expect(file?.section).toContain('new file mode 100644');
    expect(file !== undefined && removedLines(file).some((line) => line.text === 'target.txt')).toBe(true);
    expect(file !== undefined && addedLines(file).some((line) => line.text === 'now a real file')).toBe(true);
  });

  it('drops a file renamed out of a generated directory from the inline diff, even though its new path is not generated', async () => {
    const dir = await repo();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'console.log(1);\n');
    await commitAll(dir, 'chore(r): add build output');

    await runGit(dir, ['mv', 'dist/bundle.js', 'bundle.js']);

    const analysis = await analyzeDiff(dir);
    const file = analysis.files.find((entry) => entry.path === 'bundle.js');
    expect(file?.status).toBe('R');
    expect(file?.previousPath).toBe('dist/bundle.js');
    // The new path alone is not under a generated directory, so `generated` (derived from `file.path`) is false —
    // it is `inlineDiffFrom` that must still exclude the section because its header still names `a/dist/bundle.js`.
    expect(file?.generated).toBe(false);
    expect(inlineDiffFrom(analysis)).not.toContain('bundle.js');
    expect(changeSummaryFrom(analysis)).toContainEqual({ path: 'bundle.js', added: 0, removed: 0, generated: false });
  });

  it('attributes every non-trivial diff shape to the right path in one diff', async () => {
    const dir = join(tempDir(), 'r');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    writeFileSync(join(dir, 'mode.sh'), '#!/bin/sh\necho hi\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    writeFileSync(join(dir, 'target.txt'), 'target\n');
    symlinkSync('target.txt', join(dir, 'link.txt'));
    writeFileSync(join(dir, 'first name.ts'), 'export const first = 1;\n');
    await commitAll(dir, 'feat(r): base for attribution');

    // Empty new file: no hunk, just an "added" record with no content.
    writeFileSync(join(dir, 'empty.txt'), '');
    // Mode-only change: no content difference, just the executable bit.
    chmodSync(join(dir, 'mode.sh'), 0o755);
    // Binary file: git detects the NUL byte and refuses to produce a text hunk.
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
    // Typechange: symlink -> regular file, same as the dedicated typechange test above.
    rmSync(join(dir, 'link.txt'));
    writeFileSync(join(dir, 'link.txt'), 'now a real file\n');
    // Rename between two space-containing paths, pure rename (no content change).
    await runGit(dir, ['mv', 'first name.ts', 'second name.ts']);

    const analysis = await analyzeDiff(dir);
    const byPath = new Map(analysis.files.map((file) => [file.path, file]));

    const empty = byPath.get('empty.txt');
    expect(empty?.status).toBe('A');
    expect(empty?.hunks).toEqual([]);
    expect(empty?.added).toBe(0);

    const mode = byPath.get('mode.sh');
    expect(mode?.hunks).toEqual([]);
    expect(mode?.added).toBe(0);
    expect(mode?.removed).toBe(0);

    const logo = byPath.get('logo.png');
    expect(logo?.binary).toBe(true);
    expect(logo?.hunks).toEqual([]);

    const link = byPath.get('link.txt');
    expect(link?.status).toBe('T');
    expect(link !== undefined && removedLines(link).some((line) => line.text === 'target.txt')).toBe(true);
    expect(link !== undefined && addedLines(link).some((line) => line.text === 'now a real file')).toBe(true);

    const renamed = byPath.get('second name.ts');
    expect(renamed?.status).toBe('R');
    expect(renamed?.previousPath).toBe('first name.ts');
    expect(byPath.has('first name.ts')).toBe(false);
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
    expect(analysis.files[0]?.hunks).toEqual([]);
  });
});
