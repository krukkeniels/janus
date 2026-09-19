import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutBranch, commitAll, initRepo, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { merge, reflog, resetHard, workingTreeDiff } from '../../src/git/tree.js';
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

describe('reflog', () => {
  it('lists HEAD movements newest first', async () => {
    const dir = await repoWithFile();
    const second = await commitAll(dir, 'chore(r): second', { allowEmpty: true });
    const entries = await reflog(dir);
    expect(entries[0]?.sha).toBe(second);
    expect(entries[0]?.subject).toContain('second');
    expect(entries.map((entry) => entry.selector)).toContain('HEAD@{0}');
  });
});
