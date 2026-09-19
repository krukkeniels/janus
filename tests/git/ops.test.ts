import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addRemote,
  checkoutBranch,
  clone,
  commitAll,
  currentBranch,
  fetch,
  initBare,
  initRepo,
  isAncestor,
  lsRemoteHead,
  push,
  PushRejectedError,
  remoteHead,
  revParse,
} from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { createRemoteWithCommit, tempDir } from '../helpers/git-fixtures.js';

async function touchAndCommit(cwd: string, name: string, message: string): Promise<string> {
  writeFileSync(join(cwd, name), `${name}\n`);
  return commitAll(cwd, message);
}

describe('git ops', () => {
  it('clones a branch and reports head and current branch', async () => {
    const remote = await createRemoteWithCommit('app');
    const dir = join(tempDir(), 'app');
    await clone(remote.bare, dir, { branch: 'main' });
    expect(await revParse(dir, 'HEAD')).toBe(remote.head);
    expect(await currentBranch(dir)).toBe('main');
  });

  it('reports null for a detached HEAD', async () => {
    const remote = await createRemoteWithCommit('app');
    const dir = join(tempDir(), 'app');
    await clone(remote.bare, dir);
    await runGit(dir, ['checkout', '-q', '--detach']);
    expect(await currentBranch(dir)).toBeNull();
  });

  it('creates a branch, commits everything, and pushes it', async () => {
    const remote = await createRemoteWithCommit('app');
    const dir = join(tempDir(), 'app');
    await clone(remote.bare, dir);
    await checkoutBranch(dir, 'ai/goal', 'HEAD');
    const sha = await touchAndCommit(dir, 'new.txt', 'feat(app): add file');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sha).not.toBe(remote.head);
    await push(dir, 'origin', 'ai/goal', { setUpstream: true });
    expect(await remoteHead(dir, 'origin', 'ai/goal')).toBe(sha);
    expect(await remoteHead(dir, 'origin', 'does-not-exist')).toBeNull();
  });

  it('rejects a non-fast-forward push with PushRejectedError', async () => {
    const remote = await createRemoteWithCommit('app');
    const first = join(tempDir(), 'first');
    const second = join(tempDir(), 'second');
    await clone(remote.bare, first);
    await clone(remote.bare, second);
    await touchAndCommit(first, 'one.txt', 'feat(app): one');
    await push(first, 'origin', 'main');
    await touchAndCommit(second, 'two.txt', 'feat(app): two');
    await expect(push(second, 'origin', 'main')).rejects.toBeInstanceOf(PushRejectedError);
  });

  it('fetches and answers ancestry questions', async () => {
    const remote = await createRemoteWithCommit('app');
    const dir = join(tempDir(), 'app');
    await clone(remote.bare, dir);
    const sha = await touchAndCommit(dir, 'a.txt', 'feat(app): a');
    await push(dir, 'origin', 'main');
    await fetch(dir, 'origin');
    expect(await revParse(dir, 'origin/main')).toBe(sha);
    expect(await isAncestor(dir, remote.head, sha)).toBe(true);
    expect(await isAncestor(dir, sha, remote.head)).toBe(false);
  });

  it('initializes repos and remotes for a fresh state branch', async () => {
    const bareDir = join(tempDir(), 'state.git');
    mkdirSync(bareDir);
    await initBare(bareDir, 'janus/goal');
    const dir = join(tempDir(), 'janus');
    mkdirSync(dir);
    await initRepo(dir, 'janus/goal');
    await addRemote(dir, 'origin', bareDir);
    const sha = await touchAndCommit(dir, 'state.yaml', 'chore(janus): first');
    await push(dir, 'origin', 'janus/goal', { setUpstream: true });
    expect(await remoteHead(dir, 'origin', 'janus/goal')).toBe(sha);
    expect(await currentBranch(dir)).toBe('janus/goal');
  });

  it('resolves a remote branch head by url without requiring a local repo', async () => {
    const remote = await createRemoteWithCommit('app');
    expect(await lsRemoteHead(remote.bare, 'main')).toBe(remote.head);
    expect(await lsRemoteHead(remote.bare, 'does-not-exist')).toBeNull();
  });

  it('allows an empty commit only when asked', async () => {
    const dir = join(tempDir(), 'r');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    await touchAndCommit(dir, 'a.txt', 'feat(r): a');
    await expect(commitAll(dir, 'chore(r): nothing')).rejects.toThrow();
    const sha = await commitAll(dir, 'chore(r): checkpoint', { allowEmpty: true });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
