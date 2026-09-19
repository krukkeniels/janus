import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { GitError, runGit } from './run.js';

/** A push git rejected because the remote branch is not an ancestor of what was pushed. */
export class PushRejectedError extends GitError {
  constructor(cause: GitError) {
    super(cause.args, cause.cwd, cause.exitCode, cause.stderr);
    this.name = 'PushRejectedError';
  }
}

export async function initRepo(dir: string, initialBranch: string): Promise<void> {
  await runGit(dir, ['init', '-q', '-b', initialBranch]);
}

export async function initBare(dir: string, initialBranch: string): Promise<void> {
  await runGit(dir, ['init', '-q', '--bare', '-b', initialBranch]);
}

export async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await runGit(cwd, ['remote', 'add', name, url]);
}

export interface CloneOptions {
  branch?: string;
  singleBranch?: boolean;
}

/** Clones `url` into `dir` (whose parent must exist). */
export async function clone(url: string, dir: string, options: CloneOptions = {}): Promise<void> {
  const args = ['clone', '-q'];
  if (options.branch !== undefined) args.push('--branch', options.branch);
  if (options.singleBranch) args.push('--single-branch');
  args.push(url, dir);
  await runGit(dirname(dir), args);
}

export interface FetchOptions {
  /** Fetch a single ref into `FETCH_HEAD` instead of updating remote-tracking branches. */
  refspec?: string;
  /** Remove local remote-tracking refs for branches the remote no longer has; needed to notice a deleted branch. */
  prune?: boolean;
}

export async function fetch(cwd: string, remote = 'origin', options: FetchOptions = {}): Promise<void> {
  const args = ['fetch', '-q', remote];
  if (options.prune) args.push('--prune');
  if (options.refspec !== undefined) args.push(options.refspec);
  await runGit(cwd, args);
}

/** Resolves `ref` to a full commit sha. */
export async function revParse(cwd: string, ref: string): Promise<string> {
  return runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
}

/** The checked-out branch name, or null when HEAD is detached. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const name = await runGit(cwd, ['symbolic-ref', '-q', '--short', 'HEAD']);
    return name === '' ? null : name;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return null;
    throw error;
  }
}

/** Checks out `name`; with `startPoint` the branch is created from it and must not already exist. */
export async function checkoutBranch(cwd: string, name: string, startPoint?: string): Promise<void> {
  const args = startPoint === undefined ? ['checkout', '-q', name] : ['checkout', '-q', '-b', name, startPoint];
  await runGit(cwd, args);
}

export interface CommitOptions {
  allowEmpty?: boolean;
}

/** Stages every change (added, modified, deleted) and commits. Returns the new commit sha. */
export async function commitAll(cwd: string, message: string, options: CommitOptions = {}): Promise<string> {
  await runGit(cwd, ['add', '-A']);
  const args = ['commit', '-q', '-m', message];
  if (options.allowEmpty) args.push('--allow-empty');
  await runGit(cwd, args);
  return revParse(cwd, 'HEAD');
}

export interface PushOptions {
  setUpstream?: boolean;
}

/** Pushes `branch` without `--force`, so git itself refuses non-fast-forward updates. */
export async function push(cwd: string, remote: string, branch: string, options: PushOptions = {}): Promise<void> {
  const args = ['push', '-q'];
  if (options.setUpstream) args.push('-u');
  args.push(remote, `${branch}:${branch}`);
  try {
    await runGit(cwd, args);
  } catch (error) {
    if (error instanceof GitError && /non-fast-forward|fetch first/.test(error.stderr)) {
      throw new PushRejectedError(error);
    }
    throw error;
  }
}

/** Sha of `branch` on `remote`, or null when the branch does not exist there. */
export async function remoteHead(cwd: string, remote: string, branch: string): Promise<string | null> {
  const output = await runGit(cwd, ['ls-remote', remote, `refs/heads/${branch}`]);
  if (output === '') return null;
  const [sha] = output.split(/\s+/);
  return sha === undefined || sha === '' ? null : sha;
}

/** Sha of `branch` at `url`, or null when the branch does not exist there. Runs outside any local repo. */
export async function lsRemoteHead(url: string, branch: string): Promise<string | null> {
  const output = await runGit(tmpdir(), ['ls-remote', url, `refs/heads/${branch}`]);
  if (output === '') return null;
  const [sha] = output.split(/\s+/);
  return sha === undefined || sha === '' ? null : sha;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

/** Like `revParse`, but null when `ref` does not resolve to a commit. */
export async function tryRevParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return await revParse(cwd, ref);
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 128) return null;
    throw error;
  }
}

/** Moves the current branch forward to `ref`; fails with GitError when that is not a fast-forward. */
export async function fastForward(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ['merge', '-q', '--ff-only', ref]);
}
