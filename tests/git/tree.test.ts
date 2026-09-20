import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutBranch, commitAll, initRepo, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { listRefShas, listRefs, merge, parseNameStatusZ, reflog, reflogExists, resetHard, workingTreeDiff } from '../../src/git/tree.js';
import { tempDir } from '../helpers/git-fixtures.js';

async function repoWithFile(): Promise<string> {
  const dir = join(tempDir(), 'r');
  mkdirSync(dir);
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'shared.txt'), 'line one\n');
  writeFileSync(join(dir, 'keep.txt'), 'keep\n');
  await commitAll(dir, 'feat(r): base');
  return dir;
}

describe('merge', () => {
  it('merges a branch that touches other files', async () => {
    const dir = await repoWithFile();
    await checkoutBranch(dir, 'feature', 'HEAD');
    writeFileSync(join(dir, 'feature.txt'), 'f\n');
    await commitAll(dir, 'feat(r): feature');
    await checkoutBranch(dir, 'main');
    writeFileSync(join(dir, 'main.txt'), 'm\n');
    await commitAll(dir, 'feat(r): main');
    const result = await merge(dir, 'feature', 'chore(r): merge feature');
    expect(result).toEqual({ status: 'merged', conflictedFiles: [] });
    expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('chore(r): merge feature');
  });

  it('reports up to date when nothing is new', async () => {
    const dir = await repoWithFile();
    await checkoutBranch(dir, 'feature', 'HEAD');
    await checkoutBranch(dir, 'main');
    expect(await merge(dir, 'feature', 'chore(r): merge')).toEqual({ status: 'up_to_date', conflictedFiles: [] });
  });

  it('reports conflicts with the files involved and leaves the tree resettable', async () => {
    const dir = await repoWithFile();
    await checkoutBranch(dir, 'feature', 'HEAD');
    writeFileSync(join(dir, 'shared.txt'), 'feature version\n');
    await commitAll(dir, 'feat(r): feature edit');
    await checkoutBranch(dir, 'main');
    writeFileSync(join(dir, 'shared.txt'), 'main version\n');
    const mainHead = await commitAll(dir, 'feat(r): main edit');
    const result = await merge(dir, 'feature', 'chore(r): merge');
    expect(result.status).toBe('conflict');
    expect(result.conflictedFiles).toEqual(['shared.txt']);
    await resetHard(dir);
    expect(await revParse(dir, 'HEAD')).toBe(mainHead);
    expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
  });
});

describe('workingTreeDiff and resetHard', () => {
  it('includes modified, added, and deleted files with a patch', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'shared.txt'), 'line one\nline two\n');
    writeFileSync(join(dir, 'new.txt'), 'new\n');
    rmSync(join(dir, 'keep.txt'));
    const diff = await workingTreeDiff(dir);
    const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file.status]));
    expect(byPath).toEqual({ 'shared.txt': 'M', 'new.txt': 'A', 'keep.txt': 'D' });
    expect(diff.patch).toContain('+line two');
    expect(diff.patch).toContain('+++ b/new.txt');
    expect(diff.patch).toContain('--- a/keep.txt');
  });

  it('returns no files for a clean tree', async () => {
    const dir = await repoWithFile();
    expect(await workingTreeDiff(dir)).toEqual({ files: [], patch: '' });
  });

  it('parses paths with spaces and non-ASCII characters without quoting', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'with space.txt'), 'spaced\n');
    writeFileSync(join(dir, 'æøå.txt'), 'nordic\n');
    const diff = await workingTreeDiff(dir);
    const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file.status]));
    expect(byPath['with space.txt']).toBe('A');
    expect(byPath['æøå.txt']).toBe('A');
    expect(Object.keys(byPath)).not.toContain('"\\303\\246\\303\\270\\303\\245.txt"');
  });

  it('parses the three-record rename grammar correctly', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'old name.txt'), 'a\nb\nc\nd\ne\n');
    await commitAll(dir, 'feat(r): add a spaced path');
    await runGit(dir, ['mv', 'old name.txt', 'new name.txt']);
    const diff = await workingTreeDiff(dir);
    expect(diff.files).toEqual([{ status: 'R', path: 'new name.txt', previousPath: 'old name.txt' }]);
  });

  it('resetHard discards tracked changes and untracked files', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'shared.txt'), 'changed\n');
    writeFileSync(join(dir, 'junk.txt'), 'junk\n');
    mkdirSync(join(dir, 'junkdir'));
    writeFileSync(join(dir, 'junkdir', 'x.txt'), 'x\n');
    await resetHard(dir);
    expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
  });
});

describe('parseNameStatusZ', () => {
  it('reads two records for an ordinary change and three for a rename', () => {
    expect(parseNameStatusZ('D\0keep.txt\0R100\0old name.txt\0new name.txt\0A\0un tracked.txt\0')).toEqual([
      { status: 'D', path: 'keep.txt' },
      { status: 'R', path: 'new name.txt', previousPath: 'old name.txt' },
      { status: 'A', path: 'un tracked.txt' },
    ]);
  });

  it('returns nothing for an empty stream', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });

  it('treats a copy as a rename, because both carry an old and a new path', () => {
    expect(parseNameStatusZ('C90\0src/a.ts\0src/b.ts\0')).toEqual([
      { status: 'R', path: 'src/b.ts', previousPath: 'src/a.ts' },
    ]);
  });

  it('parses two renames in a row without off-by-one errors', () => {
    expect(parseNameStatusZ('R100\0a-old\0a-new\0R100\0b-old\0b-new\0')).toEqual([
      { status: 'R', path: 'a-new', previousPath: 'a-old' },
      { status: 'R', path: 'b-new', previousPath: 'b-old' },
    ]);
  });

  it('throws when a rename record is missing its second path', () => {
    expect(() => parseNameStatusZ('R100\0only-one.txt\0')).toThrow('incomplete rename record');
  });

  it('throws when a status record has no path at all', () => {
    expect(() => parseNameStatusZ('M\0')).toThrow('status "M" with no path');
  });

  it('throws on an unmerged path, which no caller may policy-check', () => {
    expect(() => parseNameStatusZ('U\0src/conflict.ts\0')).toThrow('unmerged path src/conflict.ts');
  });
});

describe('reflog', () => {
  it('lists HEAD movements newest first', async () => {
    const dir = await repoWithFile();
    const second = await commitAll(dir, 'chore(r): second', { allowEmpty: true });
    const entries = await reflog(dir);
    expect(entries[0]?.sha).toBe(second);
    expect(entries[0]?.subject).toContain('second');
    expect(entries.map((entry) => entry.selector)).toContain('HEAD@{0}');
  });

  it('reads the reflog of a named ref', async () => {
    const dir = await repoWithFile();
    await commitAll(dir, 'chore(r): second', { allowEmpty: true });
    const entries = await reflog(dir, 'refs/heads/main');
    expect(entries[0]?.selector).toBe('main@{0}');
    expect(entries[0]?.subject).toContain('second');
  });
});

describe('listRefs', () => {
  it('lists every ref in the repository', async () => {
    const dir = await repoWithFile();
    await runGit(dir, ['branch', 'side']);
    await runGit(dir, ['tag', 'v1']);
    expect(await listRefs(dir)).toEqual(['refs/heads/main', 'refs/heads/side', 'refs/tags/v1']);
  });
});

describe('listRefShas', () => {
  it('pairs every ref with the object it points at, including tags git keeps no reflog for', async () => {
    const dir = await repoWithFile();
    const head = await runGit(dir, ['rev-parse', 'HEAD']);
    await runGit(dir, ['tag', 'v1']);
    expect(await listRefShas(dir)).toEqual([
      { ref: 'refs/heads/main', sha: head },
      { ref: 'refs/tags/v1', sha: head },
    ]);
  });
});

describe('reflogExists', () => {
  it('is true for a ref git logs and false for one it does not', async () => {
    const dir = await repoWithFile();
    expect(await reflogExists(dir, 'HEAD')).toBe(true);
    expect(await reflogExists(dir, 'refs/heads/main')).toBe(true);
    // A tag never gets a reflog, and `git reflog show` would silently fall back to a plain log for it.
    await runGit(dir, ['tag', 'v1']);
    expect(await reflogExists(dir, 'refs/tags/v1')).toBe(false);
    expect(await reflogExists(dir, 'refs/heads/does-not-exist')).toBe(false);
  });
});
