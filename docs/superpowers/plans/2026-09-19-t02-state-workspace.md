# T02 State Model, Workspace, State Branch, Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Janus its durable memory: a validated `state.yaml`, a goal workspace of repo clones plus a `.janus/` state-branch checkout, a git module the engine can trust, atomic checkpoints that commit and fast-forward-push state, and `janus init` in both modes (`--goal` creates a workspace; `--resume` rebuilds one from the state branch alone).

**Architecture:** `src/git/` wraps the `git` CLI (never a library) in small typed functions; pushes are never forced, merges never rebase. `src/state/` owns the schema, the atomic store, decisions, and the checkpoint routine. `src/workspace/` owns paths, the PID lock, clone-URL resolution, and the two workspace builders. `src/telemetry/` appends JSONL events. `src/cli/commands/init.ts` wires it together. Every git-touching test uses real temporary repositories with a hermetic identity set in `vitest.config.ts`.

**Tech Stack:** Node 20+, TypeScript strict ESM (NodeNext), commander 14, zod 3, yaml 2, vitest, the system `git` binary (2.28+ for `init -b`).

**Spec:** `angular-ai-development-workflow-v2.md` §5 (workspace and Git layout), §6 (state schema), §7 (checkpoint rule and resume semantics), §8 (CLI). Task definition: `tasks.md` T02. Builds on T01 (`docs/superpowers/plans/2026-09-19-t01-bootstrap-cli.md`), which delivered `src/cli/*`, `src/config/*`, and the test helpers `tests/helpers/run-cli.ts` and `tests/fixtures/valid-goal.ts`.

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`); relative imports use `.js` extensions; `import type` for type-only imports; TypeScript `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (no `!` non-null assertions on indexed access; narrow with `if`).
- Package manager is `pnpm`; every commit message is `type(scope): subject` and ends, after a blank line, with the two trailer lines the controller gives the implementer.
- Exit codes come only from `src/cli/exit-codes.ts` (`Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`).
- Workspace layout (§5): `<workspace>/.janus/` is a plain single-branch clone of the state branch `janus/<goal-id>` (never a worktree of a product clone); `repos/<name>/` one clone per repo; `fake/`; `.pnpm-store/`; `janus.lock` holds PID and timestamp. The state branch lives in the dedicated state repo when configured, otherwise in the first repo of `goal.yaml`.
- `.janus/` contents (§5): `config.yaml`, `goal.yaml`, `state.yaml`, `decisions.md` (append-only), `handover.md` (regenerated at every checkpoint), `telemetry/events.jsonl` (append-only). Secrets never enter `.janus/`.
- `state.yaml` is version 2 and authoritative (§6); fields may be added, never removed or repurposed; all objects strict.
- Checkpoints (§7): every checkpoint writes `state.yaml` and `handover.md`, appends any decision, commits on the state branch; state pushes are fast-forward only and a moved remote stops the run with an instruction to reconcile; a lock whose PID is dead is reclaimed with a warning.
- Git: pushes never use `--force`; base-branch integration is `merge`, never `rebase`; agents never run git write commands (the orchestrator does, through this module).
- Store directory ruling (differs from spec wording; spec is updated in Task 8): the pnpm store is `<workspace>/.pnpm-store` and is handed to agents through the `npm_config_store_dir` environment variable in T05; no `.npmrc` file is written into the workspace, because pnpm reads `.npmrc` only from the project root, not from parent directories.
- Clone URL ruling (spec extension; spec is updated in Task 8): `goal.yaml` repos may carry `clone_url`; otherwise the URL is `bitbucket.clone_url_template` (default `{url}/scm/{project}/{slug}.git`) rendered with `bitbucket.url`, the lowercase project key, and the slug. `config.yaml` `state.clone_url` names a dedicated state remote.

---

## File Structure

```text
vitest.config.ts                       add hermetic git identity env (Task 1)
src/git/run.ts                         runGit(cwd, args) -> stdout; GitError
src/git/ops.ts                         initRepo, initBare, addRemote, clone, fetch, revParse, currentBranch,
                                       checkoutBranch, commitAll, push (+PushRejectedError), remoteHead, isAncestor
src/git/tree.ts                        merge, workingTreeDiff, resetHard, reflog
src/workspace/layout.ts                workspacePaths(root), createWorkspaceDirs, ensureEmptyOrMissing
src/workspace/lock.ts                  acquireLock / releaseLock / WorkspaceLockedError (PID reclaim)
src/workspace/remotes.ts               repoCloneUrl, stateRemote, stateBranchName
src/workspace/state-branch.ts          initStateRepo (new orphan repo + origin), openStateRepo (single-branch clone)
src/workspace/create-workspace.ts      createWorkspace(): clones repos, creates state repo, first checkpoint
src/workspace/resume-workspace.ts      resumeWorkspace(): clones state branch, re-clones repos at recorded heads
src/state/files.ts                     file-name constants under .janus/
src/state/state-schema.ts              stateSchema (zod, §6), JanusState, createInitialState
src/state/state-store.ts               readState / writeState (atomic)
src/state/decisions.ts                 appendDecision, DECISIONS_HEADER
src/state/checkpoint.ts                checkpoint(), StateBranchDivergedError
src/telemetry/events.ts                appendEvent / readEvents (JSONL)
src/render/handover.ts                 renderHandover(state, goal, now) minimal version
src/config/goal-schema.ts              modify: repos[].clone_url
src/config/config-schema.ts            modify: state.clone_url, bitbucket.clone_url_template
src/cli/main.ts                        modify: WorkspaceLockedError -> Locked
src/cli/commands/init.ts               replace: real --goal and --resume
angular-ai-development-workflow-v2.md  modify: §4, §5, §18.4, §28 wording (Task 8)
tasks.md                               modify: T02 store-dir wording (Task 8)
README.md                              modify: status and workspace section (Task 12)
tests/helpers/git-fixtures.ts          tempDir, createRemoteWithCommit, createBareRepo
tests/git/run.test.ts, ops.test.ts, tree.test.ts
tests/workspace/layout.test.ts, lock.test.ts, remotes.test.ts, state-branch.test.ts
tests/state/state-schema.test.ts, state-store.test.ts, decisions.test.ts, checkpoint.test.ts
tests/telemetry/events.test.ts
tests/render/handover.test.ts
tests/cli/init.test.ts                 modify: first case now fails on missing config
tests/cli/init-create.test.ts          integration: init --goal against temp bare remotes
tests/cli/init-resume.test.ts          integration: round trip through the state branch
tests/cli/commands.test.ts             modify: drop the init --resume stub case
tests/cli/main.test.ts                 modify: Locked mapping test
```

---

### Task 1: Git runner, hermetic test identity, git fixtures

**Files:**
- Create: `src/git/run.ts`, `tests/helpers/git-fixtures.ts`, `tests/git/run.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `runGit(cwd: string, args: string[], options?: { env?: Record<string, string | undefined> }): Promise<string>` returning stdout without the trailing newline; `class GitError extends Error { args: string[]; cwd: string; exitCode: number | null; stderr: string }`; test helpers `tempDir(prefix?)`, `createRemoteWithCommit(name, branch?) -> { bare, work, head }`, `createBareRepo(name, branch?) -> string`.

- [ ] **Step 1: Give tests a hermetic git identity**

Replace `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    env: {
      GIT_AUTHOR_NAME: 'Janus Test',
      GIT_AUTHOR_EMAIL: 'janus@test.invalid',
      GIT_COMMITTER_NAME: 'Janus Test',
      GIT_COMMITTER_EMAIL: 'janus@test.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
```

- [ ] **Step 2: Write the fixtures helper and the failing tests**

`tests/helpers/git-fixtures.ts`:
```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../../src/git/run.js';

export function tempDir(prefix = 'janus-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface RemoteFixture {
  /** Bare repository usable as a clone URL. */
  bare: string;
  /** Working clone the bare repo was created from. */
  work: string;
  /** Sha of the single commit on the branch. */
  head: string;
}

/** A working repo with one commit on `branch`, plus a bare clone of it to serve as the remote. */
export async function createRemoteWithCommit(name: string, branch = 'main'): Promise<RemoteFixture> {
  const root = tempDir(`janus-remote-${name}-`);
  const work = join(root, 'work');
  const bare = join(root, `${name}.git`);
  mkdirSync(work);
  await runGit(work, ['init', '-q', '-b', branch]);
  writeFileSync(join(work, 'README.md'), `# ${name}\n`);
  await runGit(work, ['add', '-A']);
  await runGit(work, ['commit', '-q', '-m', 'chore(init): initial commit']);
  const head = await runGit(work, ['rev-parse', 'HEAD']);
  await runGit(root, ['clone', '-q', '--bare', work, bare]);
  return { bare, work, head };
}

/** An empty bare repository whose HEAD points at `branch`. */
export async function createBareRepo(name: string, branch = 'main'): Promise<string> {
  const root = tempDir(`janus-bare-${name}-`);
  const bare = join(root, `${name}.git`);
  await runGit(root, ['init', '-q', '--bare', '-b', branch, bare]);
  return bare;
}
```

`tests/git/run.test.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError, runGit } from '../../src/git/run.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('runGit', () => {
  it('returns stdout without the trailing newline', async () => {
    const dir = tempDir();
    await runGit(dir, ['init', '-q', '-b', 'main']);
    expect(await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('throws GitError carrying args, cwd, exit code, and stderr', async () => {
    const dir = tempDir();
    try {
      await runGit(dir, ['rev-parse', 'HEAD']);
      expect.unreachable('expected GitError');
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      const gitError = error as GitError;
      expect(gitError.name).toBe('GitError');
      expect(gitError.args).toEqual(['rev-parse', 'HEAD']);
      expect(gitError.cwd).toBe(dir);
      expect(gitError.exitCode).toBe(128);
      expect(gitError.stderr).toContain('not a git repository');
      expect(gitError.message).toContain('git rev-parse HEAD failed');
    }
  });

  it('commits with the hermetic identity from the test environment', async () => {
    const dir = tempDir();
    await runGit(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-q', '-m', 'test(git): first']);
    expect(await runGit(dir, ['log', '-1', '--format=%an <%ae>'])).toBe('Janus Test <janus@test.invalid>');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test tests/git/run.test.ts`
Expected: FAIL, cannot resolve `src/git/run.js`.

- [ ] **Step 4: Write the runner**

`src/git/run.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], cwd: string, exitCode: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed in ${cwd} (exit ${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  env?: Record<string, string | undefined>;
}

/** Runs `git <args>` in `cwd` and returns stdout without its trailing newline. Non-zero exit throws GitError. */
export async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.replace(/\n$/, '');
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; message: string };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    throw new GitError(args, cwd, exitCode, failure.stderr ?? failure.message);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test tests/git/run.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add vitest.config.ts src/git/run.ts tests/helpers/git-fixtures.ts tests/git/run.test.ts
git commit -m "feat(git): add git runner with typed errors and hermetic test identity"
```

---

### Task 2: Git branch and remote operations

**Files:**
- Create: `src/git/ops.ts`, `tests/git/ops.test.ts`

**Interfaces:**
- Consumes: `runGit`, `GitError` (Task 1); fixtures (Task 1).
- Produces: `initRepo(dir, initialBranch)`, `initBare(dir, initialBranch)`, `addRemote(cwd, name, url)`, `clone(url, dir, { branch?, singleBranch? })`, `fetch(cwd, remote?, refspec?)`, `revParse(cwd, ref): Promise<string>`, `currentBranch(cwd): Promise<string | null>`, `checkoutBranch(cwd, name, startPoint?)`, `commitAll(cwd, message, { allowEmpty? }): Promise<string>`, `push(cwd, remote, branch, { setUpstream? })` throwing `PushRejectedError` on non-fast-forward, `remoteHead(cwd, remote, branch): Promise<string | null>`, `isAncestor(cwd, ancestor, descendant): Promise<boolean>`.

- [ ] **Step 1: Write the failing tests**

`tests/git/ops.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/git/ops.test.ts`
Expected: FAIL, cannot resolve `src/git/ops.js`.

- [ ] **Step 3: Write the operations**

`src/git/ops.ts`:
```ts
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

export async function fetch(cwd: string, remote = 'origin', refspec?: string): Promise<void> {
  const args = ['fetch', '-q', remote];
  if (refspec !== undefined) args.push(refspec);
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
    if (error instanceof GitError && /rejected|non-fast-forward|fetch first/.test(error.stderr)) {
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

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/git/ops.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/git/ops.ts tests/git/ops.test.ts
git commit -m "feat(git): add clone, branch, commit, fast-forward push, and remote queries"
```

---

### Task 3: Working-tree operations: merge, diff, reset, reflog

**Files:**
- Create: `src/git/tree.ts`, `tests/git/tree.test.ts`

**Interfaces:**
- Consumes: `runGit`, `GitError` (Task 1); `checkoutBranch`, `commitAll`, `initRepo`, `revParse` (Task 2).
- Produces: `merge(cwd, ref, message): Promise<{ status: 'merged' | 'up_to_date' | 'conflict'; conflictedFiles: string[] }>`, `workingTreeDiff(cwd): Promise<{ files: ChangedFile[]; patch: string }>` with `ChangedFile { status: 'A' | 'M' | 'D' | 'R' | 'T'; path: string; previousPath?: string }`, `resetHard(cwd)`, `reflog(cwd): Promise<{ sha: string; selector: string; subject: string }[]>`.

- [ ] **Step 1: Write the failing tests**

`tests/git/tree.test.ts`:
```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/git/tree.test.ts`
Expected: FAIL, cannot resolve `src/git/tree.js`.

- [ ] **Step 3: Write the operations**

`src/git/tree.ts` (the reflog format uses the unit-separator character, written as the escape `\x1f` in the git format string and `` in the split, never as a literal control character):
```ts
import { GitError, runGit } from './run.js';

export type MergeStatus = 'merged' | 'up_to_date' | 'conflict';

export interface MergeResult {
  status: MergeStatus;
  conflictedFiles: string[];
}

/** Merges `ref` into the current branch (never rebases). A conflict leaves the merge in progress for inspection; call resetHard to abandon it. */
export async function merge(cwd: string, ref: string, message: string): Promise<MergeResult> {
  try {
    const output = await runGit(cwd, ['merge', '--no-edit', '-m', message, ref]);
    return { status: /Already up[- ]to[- ]date/.test(output) ? 'up_to_date' : 'merged', conflictedFiles: [] };
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      const files = await runGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
      if (files !== '') return { status: 'conflict', conflictedFiles: files.split('\n') };
    }
    throw error;
  }
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'T';

export interface ChangedFile {
  status: ChangeStatus;
  path: string;
  previousPath?: string;
}

export interface WorkingTreeDiff {
  files: ChangedFile[];
  patch: string;
}

/** Diff of the working tree against HEAD, including untracked files (registered as intent-to-add). Ignored files are excluded. */
export async function workingTreeDiff(cwd: string): Promise<WorkingTreeDiff> {
  await runGit(cwd, ['add', '--intent-to-add', '.']);
  const nameStatus = await runGit(cwd, ['diff', 'HEAD', '--name-status', '-M']);
  const patch = await runGit(cwd, ['diff', 'HEAD', '-M']);
  const files = nameStatus === '' ? [] : nameStatus.split('\n').map(parseNameStatus);
  return { files, patch };
}

function parseNameStatus(line: string): ChangedFile {
  const [rawStatus, first, second] = line.split('\t');
  const status = (rawStatus ?? 'M').charAt(0) as ChangeStatus;
  if (status === 'R' && first !== undefined && second !== undefined) {
    return { status, path: second, previousPath: first };
  }
  return { status, path: first ?? '' };
}

/** Discards every change: tracked files back to HEAD, untracked files and directories removed, ignored files kept. Also abandons an in-progress merge. */
export async function resetHard(cwd: string): Promise<void> {
  await runGit(cwd, ['reset', '-q', '--hard', 'HEAD']);
  await runGit(cwd, ['clean', '-q', '-fd']);
}

export interface ReflogEntry {
  sha: string;
  selector: string;
  subject: string;
}

const FIELD_SEPARATOR = '';

/** HEAD reflog, newest first. Used later to audit that no agent process ever moved HEAD. */
export async function reflog(cwd: string): Promise<ReflogEntry[]> {
  const output = await runGit(cwd, ['reflog', 'show', '--format=%H%x1f%gd%x1f%gs', 'HEAD']);
  if (output === '') return [];
  return output.split('\n').map((line) => {
    const [sha = '', selector = '', subject = ''] = line.split(FIELD_SEPARATOR);
    return { sha, selector, subject };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/git/tree.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/git/tree.ts tests/git/tree.test.ts
git commit -m "feat(git): add merge, working-tree diff, reset, and reflog operations"
```

---

### Task 4: Workspace layout and PID lock

**Files:**
- Create: `src/workspace/layout.ts`, `src/workspace/lock.ts`, `tests/workspace/layout.test.ts`, `tests/workspace/lock.test.ts`

**Interfaces:**
- Consumes: `ConfigError` (T01).
- Produces: `interface WorkspacePaths { root; janusDir; reposDir; fakeDir; pnpmStoreDir; lockFile; repoDir(name): string }`, `workspacePaths(root: string): WorkspacePaths` (absolute), `createWorkspaceDirs(paths)`, `ensureEmptyOrMissing(root)` throwing `ConfigError(root, ['workspace directory exists and is not empty'])`; `acquireLock(lockFile, now?, pid?): { reclaimed: LockInfo | null }`, `releaseLock(lockFile)`, `class WorkspaceLockedError extends Error { lockFile; holder: LockInfo }`, `interface LockInfo { pid: number; acquired_at: string }`, `isProcessAlive(pid)`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace/layout.test.ts`:
```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { createWorkspaceDirs, ensureEmptyOrMissing, workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('workspacePaths', () => {
  it('derives every path from an absolute root', () => {
    const root = join(tempDir(), 'ws');
    const paths = workspacePaths(root);
    expect(paths.root).toBe(root);
    expect(paths.janusDir).toBe(join(root, '.janus'));
    expect(paths.reposDir).toBe(join(root, 'repos'));
    expect(paths.repoDir('shell')).toBe(join(root, 'repos', 'shell'));
    expect(paths.fakeDir).toBe(join(root, 'fake'));
    expect(paths.pnpmStoreDir).toBe(join(root, '.pnpm-store'));
    expect(paths.lockFile).toBe(join(root, 'janus.lock'));
  });

  it('resolves a relative root against the process cwd', () => {
    expect(workspacePaths('rel').root).toBe(join(process.cwd(), 'rel'));
  });
});

describe('createWorkspaceDirs', () => {
  it('creates repos, fake, and pnpm store directories but not .janus', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    createWorkspaceDirs(paths);
    expect(existsSync(paths.reposDir)).toBe(true);
    expect(existsSync(paths.fakeDir)).toBe(true);
    expect(existsSync(paths.pnpmStoreDir)).toBe(true);
    expect(existsSync(paths.janusDir)).toBe(false);
  });
});

describe('ensureEmptyOrMissing', () => {
  it('accepts a missing or empty directory', () => {
    const missing = join(tempDir(), 'missing');
    expect(() => ensureEmptyOrMissing(missing)).not.toThrow();
    const empty = join(tempDir(), 'empty');
    mkdirSync(empty);
    expect(() => ensureEmptyOrMissing(empty)).not.toThrow();
  });

  it('rejects a non-empty directory with a ConfigError naming it', () => {
    const full = join(tempDir(), 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'x'), 'x');
    expect(() => ensureEmptyOrMissing(full)).toThrowError(ConfigError);
    expect(() => ensureEmptyOrMissing(full)).toThrowError(/exists and is not empty/);
  });
});
```

`tests/workspace/lock.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, isProcessAlive, releaseLock, WorkspaceLockedError } from '../../src/workspace/lock.js';
import { tempDir } from '../helpers/git-fixtures.js';

function deadPid(): number {
  const child = spawnSync('true');
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

describe('acquireLock', () => {
  it('writes pid and timestamp and releases cleanly', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    const now = new Date('2026-09-19T10:00:00.000Z');
    const result = acquireLock(lockFile, now, 4242);
    expect(result.reclaimed).toBeNull();
    expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toEqual({ pid: 4242, acquired_at: '2026-09-19T10:00:00.000Z' });
    releaseLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
    expect(() => releaseLock(lockFile)).not.toThrow();
  });

  it('refuses when the holder is alive', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    acquireLock(lockFile, new Date(), process.pid);
    try {
      acquireLock(lockFile, new Date(), 1);
      expect.unreachable('expected WorkspaceLockedError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceLockedError);
      const locked = error as WorkspaceLockedError;
      expect(locked.holder.pid).toBe(process.pid);
      expect(locked.message).toContain(`locked by pid ${process.pid}`);
    }
  });

  it('reclaims a lock whose holder is dead and reports it', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    const stale = deadPid();
    expect(isProcessAlive(stale)).toBe(false);
    writeFileSync(lockFile, JSON.stringify({ pid: stale, acquired_at: '2026-01-01T00:00:00.000Z' }));
    const result = acquireLock(lockFile, new Date(), process.pid);
    expect(result.reclaimed).toEqual({ pid: stale, acquired_at: '2026-01-01T00:00:00.000Z' });
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });

  it('reclaims a corrupt lock file', () => {
    const lockFile = join(tempDir(), 'janus.lock');
    writeFileSync(lockFile, 'not json');
    const result = acquireLock(lockFile, new Date(), process.pid);
    expect(result.reclaimed).toBeNull();
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/workspace`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write layout and lock**

`src/workspace/layout.ts`:
```ts
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigError } from '../config/errors.js';

export interface WorkspacePaths {
  root: string;
  janusDir: string;
  reposDir: string;
  fakeDir: string;
  pnpmStoreDir: string;
  lockFile: string;
  repoDir(name: string): string;
}

/** Absolute paths of everything in a goal workspace (spec §5). */
export function workspacePaths(root: string): WorkspacePaths {
  const absolute = resolve(root);
  const reposDir = join(absolute, 'repos');
  return {
    root: absolute,
    janusDir: join(absolute, '.janus'),
    reposDir,
    fakeDir: join(absolute, 'fake'),
    pnpmStoreDir: join(absolute, '.pnpm-store'),
    lockFile: join(absolute, 'janus.lock'),
    repoDir: (name) => join(reposDir, name),
  };
}

/** Creates the plain directories of a workspace. `.janus/` is created by the state-branch module because it is a git checkout. */
export function createWorkspaceDirs(paths: WorkspacePaths): void {
  for (const dir of [paths.root, paths.reposDir, paths.fakeDir, paths.pnpmStoreDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureEmptyOrMissing(root: string): void {
  if (!existsSync(root)) return;
  if (readdirSync(root).length > 0) {
    throw new ConfigError(root, ['workspace directory exists and is not empty']);
  }
}
```

`src/workspace/lock.ts`:
```ts
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockInfo {
  pid: number;
  acquired_at: string;
}

export class WorkspaceLockedError extends Error {
  readonly lockFile: string;
  readonly holder: LockInfo;

  constructor(lockFile: string, holder: LockInfo) {
    super(`workspace is locked by pid ${holder.pid} since ${holder.acquired_at} (${lockFile})`);
    this.name = 'WorkspaceLockedError';
    this.lockFile = lockFile;
    this.holder = holder;
  }
}

export interface AcquireResult {
  /** The stale lock that was reclaimed, if any. The caller should warn about it. */
  reclaimed: LockInfo | null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Creates the lock file atomically. A lock held by a live process throws; a dead or corrupt one is reclaimed. */
export function acquireLock(lockFile: string, now: Date = new Date(), pid: number = process.pid): AcquireResult {
  const info: LockInfo = { pid, acquired_at: now.toISOString() };
  let reclaimed: LockInfo | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockFile, JSON.stringify(info), { flag: 'wx' });
      return { reclaimed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLock(lockFile);
      if (holder !== null && isProcessAlive(holder.pid)) {
        throw new WorkspaceLockedError(lockFile, holder);
      }
      reclaimed = holder;
      unlinkSync(lockFile);
    }
  }
  throw new Error(`could not acquire lock ${lockFile}`);
}

export function releaseLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function readLock(lockFile: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.acquired_at === 'string') {
      return { pid: parsed.pid, acquired_at: parsed.acquired_at };
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/workspace`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/workspace/layout.ts src/workspace/lock.ts tests/workspace/layout.test.ts tests/workspace/lock.test.ts
git commit -m "feat(workspace): add workspace paths and a pid-aware lock"
```

---

### Task 5: State schema and initial state

**Files:**
- Create: `src/state/state-schema.ts`, `tests/state/state-schema.test.ts`

**Interfaces:**
- Consumes: `Goal` (T01 `src/config/goal-schema.ts`).
- Produces: `stateSchema` (zod, strict, version literal 2), `type JanusState = z.infer<typeof stateSchema>`, `type RepoState`, `GOAL_STATUSES`, `type GoalStatus`, `createInitialState({ goal, stateBranch: { name, remote }, now }): JanusState`.

- [ ] **Step 1: Write the failing tests**

`tests/state/state-schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatZodIssues } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { createInitialState, GOAL_STATUSES, stateSchema } from '../../src/state/state-schema.js';
import { validGoal } from '../fixtures/valid-goal.js';

const now = new Date('2026-09-19T12:00:00.000Z');

function initial() {
  return createInitialState({
    goal: goalSchema.parse(validGoal),
    stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' },
    now,
  });
}

function issuesOf(input: unknown): string[] {
  const result = stateSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('createInitialState', () => {
  it('builds a version 2 state with one entry per repo and every default filled', () => {
    const state = initial();
    expect(state.version).toBe(2);
    expect(state.goal).toEqual({ id: 'angular-15-to-16', status: 'created' });
    expect(state.state_branch).toEqual({ name: 'janus/angular-15-to-16', remote: 'state-repo' });
    expect(Object.keys(state.repos)).toEqual(['ui-kit', 'shell', 'orders-remote']);
    expect(state.repos['ui-kit']).toEqual({
      goal_branch: 'ai/angular-15-to-16',
      base_commit: null,
      head_commit: null,
      pr: { id: null, url: null, state: null, version: null, approved: false },
      last_build: { id: null, status: 'unknown', classification: null, revision: null, explicit_trigger: false },
      prerelease_version: null,
      release_version: null,
      merged: false,
      merge_commit: null,
    });
    expect(state.plan).toEqual({ approved: false, approved_commit: null, approved_at: null, revision: 0 });
    expect(state.execution.budgets).toEqual({
      ci_fix_attempts: 0,
      e2e_fix_attempts: 0,
      ai_review_cycles: 0,
      no_progress_iterations: 0,
      work_packages_without_green: 0,
      sync_conflict_attempts: 0,
      infra_retries: 0,
    });
    expect(state.execution.work_packages).toEqual({});
    expect(state.execution.in_flight).toEqual({ step: null, started_at: null, agent_run_id: null });
    expect(state.verification.e2e.status).toBe('not_run');
    expect(state.gate).toEqual({ type: null, status: 'none', entered_at: null, checkpoint_commit: null });
    expect(state.release).toEqual({ order: [], done: [] });
    expect(state.telemetry).toEqual({ started_at: now.toISOString(), last_updated_at: now.toISOString() });
  });

  it('round-trips through the schema unchanged', () => {
    const state = initial();
    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe('stateSchema', () => {
  it('lists every goal status from the spec', () => {
    expect(GOAL_STATUSES).toEqual([
      'created', 'preparing', 'discovering', 'baselining', 'planning', 'awaiting_plan_approval',
      'executing', 'final_e2e', 'ai_review', 'qa', 'awaiting_human_review', 'fixing_review_feedback',
      'awaiting_merge', 'releasing', 'escalated', 'replanning', 'completed',
    ]);
  });

  it('rejects another version, unknown keys, and malformed shas', () => {
    const state = JSON.parse(JSON.stringify(initial())) as Record<string, unknown>;
    expect(issuesOf({ ...state, version: 1 }).some((issue) => issue.startsWith('version:'))).toBe(true);
    expect(issuesOf({ ...state, extra: true }).some((issue) => issue.startsWith('<root>: Unrecognized key'))).toBe(true);
    const repos = state['repos'] as Record<string, Record<string, unknown>>;
    const broken = { ...state, repos: { ...repos, 'ui-kit': { ...repos['ui-kit'], head_commit: 'abc' } } };
    expect(issuesOf(broken)).toContain('repos.ui-kit.head_commit: must be a full 40-character commit sha');
  });

  it('accepts a work package block with nested defaults', () => {
    const state = JSON.parse(JSON.stringify(initial())) as Record<string, unknown>;
    const execution = { ...(state['execution'] as object), work_packages: { 'wp-01': { repos: { 'ui-kit': {} } } } };
    const parsed = stateSchema.parse({ ...state, execution });
    expect(parsed.execution.work_packages['wp-01']).toEqual({
      status: 'pending',
      repos: { 'ui-kit': { commits: [], builds: [], attempts: 0, policy_violations: 0, last_failure_signature: null } },
      publish: { version: null, build_id: null },
      checkpoint: { outcome: null, run_id: null },
      regroups: [],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/state/state-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the schema**

`src/state/state-schema.ts`:
```ts
import { z } from 'zod';
import type { Goal } from '../config/goal-schema.js';

export const GOAL_STATUSES = [
  'created',
  'preparing',
  'discovering',
  'baselining',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'final_e2e',
  'ai_review',
  'qa',
  'awaiting_human_review',
  'fixing_review_feedback',
  'awaiting_merge',
  'releasing',
  'escalated',
  'replanning',
  'completed',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit sha');
const nullableSha = sha.nullable();
const isoDate = z.string().datetime();
const nullableString = z.string().nullable();
const nonNegativeInt = z.number().int().nonnegative();

const prSchema = z
  .object({
    id: z.number().int().nullable().default(null),
    url: nullableString.default(null),
    state: z.enum(['OPEN', 'MERGED', 'DECLINED']).nullable().default(null),
    version: z.number().int().nullable().default(null),
    approved: z.boolean().default(false),
  })
  .strict()
  .default({});

const lastBuildSchema = z
  .object({
    id: nullableString.default(null),
    status: z.enum(['unknown', 'queued', 'running', 'finished']).default('unknown'),
    classification: z.enum(['success', 'tests_failed', 'build_failed', 'infra']).nullable().default(null),
    revision: nullableSha.default(null),
    explicit_trigger: z.boolean().default(false),
  })
  .strict()
  .default({});

export const repoStateSchema = z
  .object({
    goal_branch: z.string().min(1),
    base_commit: nullableSha.default(null),
    head_commit: nullableSha.default(null),
    pr: prSchema,
    last_build: lastBuildSchema,
    prerelease_version: nullableString.default(null),
    release_version: nullableString.default(null),
    merged: z.boolean().default(false),
    merge_commit: nullableSha.default(null),
  })
  .strict();

export type RepoState = z.infer<typeof repoStateSchema>;

const workPackageRepoSchema = z
  .object({
    commits: z.array(sha).default([]),
    builds: z.array(z.string()).default([]),
    attempts: nonNegativeInt.default(0),
    policy_violations: nonNegativeInt.default(0),
    last_failure_signature: nullableString.default(null),
  })
  .strict();

export const workPackageStateSchema = z
  .object({
    status: z.enum(['pending', 'in_progress', 'expected_red', 'green', 'done', 'skipped']).default('pending'),
    repos: z.record(z.string(), workPackageRepoSchema).default({}),
    publish: z
      .object({ version: nullableString.default(null), build_id: nullableString.default(null) })
      .strict()
      .default({}),
    checkpoint: z
      .object({
        outcome: z.enum(['PASS', 'CONTINUE_WITH_REFINED_TASKS', 'REGROUP_VERIFICATION', 'ESCALATE']).nullable().default(null),
        run_id: nullableString.default(null),
      })
      .strict()
      .default({}),
    regroups: z.array(z.string()).default([]),
  })
  .strict();

const baselineRepoSchema = z
  .object({
    commit: nullableSha.default(null),
    local: z.record(z.string(), z.enum(['pass', 'fail', 'skipped'])).default({}),
    pr_build: z
      .object({
        id: nullableString.default(null),
        status: z.enum(['unknown', 'success', 'tests_failed', 'build_failed', 'infra']).default('unknown'),
      })
      .strict()
      .default({}),
  })
  .strict();

const baselineExceptionSchema = z
  .object({
    id: z.string().min(1),
    repo: z.string().min(1),
    kind: z.enum(['test', 'build', 'e2e']),
    identity: z.string().min(1),
    reason: z.string().default(''),
    approved_by: nullableString.default(null),
    approved_at: isoDate.nullable().default(null),
  })
  .strict();

const openCommentSchema = z
  .object({
    repo: z.string().min(1),
    comment_id: z.string().min(1),
    author: z.string().min(1),
    path: nullableString.default(null),
    line: z.number().int().nullable().default(null),
    text: z.string(),
    status: z.enum(['open', 'fixed', 'answered']).default('open'),
  })
  .strict();

export const stateSchema = z
  .object({
    version: z.literal(2),
    goal: z.object({ id: z.string().min(1), status: z.enum(GOAL_STATUSES) }).strict(),
    state_branch: z.object({ name: z.string().min(1), remote: z.string().min(1) }).strict(),
    repos: z.record(z.string(), repoStateSchema),
    plan: z
      .object({
        approved: z.boolean().default(false),
        approved_commit: nullableSha.default(null),
        approved_at: isoDate.nullable().default(null),
        revision: nonNegativeInt.default(0),
      })
      .strict()
      .default({}),
    baseline: z
      .object({
        approved: z.boolean().default(false),
        repos: z.record(z.string(), baselineRepoSchema).default({}),
        e2e: z
          .object({
            id: nullableString.default(null),
            status: z.enum(['not_run', 'running', 'passed', 'failed']).default('not_run'),
            branches: z.record(z.string(), z.string()).default({}),
          })
          .strict()
          .default({}),
        exceptions: z.array(baselineExceptionSchema).default([]),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        current_work_package: nullableString.default(null),
        current_verification_group: nullableString.default(null),
        work_packages: z.record(z.string(), workPackageStateSchema).default({}),
        in_flight: z
          .object({
            step: nullableString.default(null),
            started_at: isoDate.nullable().default(null),
            agent_run_id: nullableString.default(null),
          })
          .strict()
          .default({}),
        budgets: z
          .object({
            ci_fix_attempts: nonNegativeInt.default(0),
            e2e_fix_attempts: nonNegativeInt.default(0),
            ai_review_cycles: nonNegativeInt.default(0),
            no_progress_iterations: nonNegativeInt.default(0),
            work_packages_without_green: nonNegativeInt.default(0),
            sync_conflict_attempts: nonNegativeInt.default(0),
            infra_retries: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    verification: z
      .object({
        e2e: z
          .object({
            status: z.enum(['not_run', 'running', 'passed', 'failed', 'invalidated']).default('not_run'),
            build_id: nullableString.default(null),
            heads: z.record(z.string(), sha).default({}),
            reruns: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
        ai_review: z
          .object({
            status: z.enum(['not_run', 'running', 'passed', 'findings']).default('not_run'),
            run_id: nullableString.default(null),
            findings_open: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
        qa_recommendation: z
          .object({
            status: z.enum(['not_run', 'running', 'done']).default('not_run'),
            run_id: nullableString.default(null),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    gate: z
      .object({
        type: z.enum(['plan_approval', 'revised_plan_approval', 'pr_review', 'merge']).nullable().default(null),
        status: z.enum(['none', 'waiting', 'passed']).default('none'),
        entered_at: isoDate.nullable().default(null),
        checkpoint_commit: nullableSha.default(null),
      })
      .strict()
      .default({}),
    review_loop: z
      .object({
        activity_cursor: z.record(z.string(), z.string()).default({}),
        open_comments: z.array(openCommentSchema).default([]),
      })
      .strict()
      .default({}),
    release: z
      .object({ order: z.array(z.string()).default([]), done: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    telemetry: z
      .object({ started_at: isoDate.nullable().default(null), last_updated_at: isoDate.nullable().default(null) })
      .strict()
      .default({}),
  })
  .strict();

export type JanusState = z.infer<typeof stateSchema>;

export interface InitialStateInput {
  goal: Goal;
  stateBranch: { name: string; remote: string };
  now: Date;
}

/** The state of a freshly created goal: status `created`, one repo entry per goal repo, everything else at its default. */
export function createInitialState(input: InitialStateInput): JanusState {
  const repos: Record<string, { goal_branch: string }> = {};
  for (const repo of input.goal.repos) {
    repos[repo.name] = { goal_branch: `ai/${input.goal.id}` };
  }
  const timestamp = input.now.toISOString();
  return stateSchema.parse({
    version: 2,
    goal: { id: input.goal.id, status: 'created' },
    state_branch: input.stateBranch,
    repos,
    telemetry: { started_at: timestamp, last_updated_at: timestamp },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/state/state-schema.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/state/state-schema.ts tests/state/state-schema.test.ts
git commit -m "feat(state): add state.yaml schema v2 and initial state factory"
```

---

### Task 6: State store, decisions log, telemetry events

**Files:**
- Create: `src/state/files.ts`, `src/state/state-store.ts`, `src/state/decisions.ts`, `src/telemetry/events.ts`, `tests/state/state-store.test.ts`, `tests/state/decisions.test.ts`, `tests/telemetry/events.test.ts`

**Interfaces:**
- Consumes: `stateSchema`, `JanusState`, `createInitialState` (Task 5); `readYamlFile`, `ConfigError`, `formatZodIssues` (T01).
- Produces: constants `STATE_FILE = 'state.yaml'`, `GOAL_FILE = 'goal.yaml'`, `CONFIG_FILE = 'config.yaml'`, `HANDOVER_FILE = 'handover.md'`, `DECISIONS_FILE = 'decisions.md'`, `EVENTS_FILE = 'telemetry/events.jsonl'`; `readState(janusDir): JanusState`, `writeState(janusDir, state)` (atomic: temp file then rename); `DECISIONS_HEADER`, `interface DecisionEntry { at: string; by: string; title: string; body: string }`, `appendDecision(janusDir, entry)`; `interface TelemetryEvent { type: string; [key: string]: unknown }`, `interface RecordedEvent extends TelemetryEvent { timestamp: string }`, `appendEvent(janusDir, event, now?): RecordedEvent`, `readEvents(janusDir): RecordedEvent[]`.

- [ ] **Step 1: Write the failing tests**

`tests/state/state-store.test.ts`:
```ts
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { STATE_FILE } from '../../src/state/files.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { validGoal } from '../fixtures/valid-goal.js';
import { tempDir } from '../helpers/git-fixtures.js';

function freshState() {
  return createInitialState({
    goal: goalSchema.parse(validGoal),
    stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' },
    now: new Date('2026-09-19T12:00:00.000Z'),
  });
}

describe('state store', () => {
  it('writes YAML and reads back an equal state', () => {
    const janusDir = tempDir();
    const state = freshState();
    writeState(janusDir, state);
    expect(readFileSync(join(janusDir, STATE_FILE), 'utf8')).toContain('version: 2');
    expect(readState(janusDir)).toEqual(state);
  });

  it('leaves no temp file behind', () => {
    const janusDir = tempDir();
    writeState(janusDir, freshState());
    expect(readdirSync(janusDir)).toEqual([STATE_FILE]);
  });

  it('reports a missing state file as ConfigError', () => {
    const janusDir = tempDir();
    expect(() => readState(janusDir)).toThrowError(ConfigError);
    expect(existsSync(join(janusDir, STATE_FILE))).toBe(false);
  });

  it('reports schema violations with the field path', () => {
    const janusDir = tempDir();
    writeFileSync(join(janusDir, STATE_FILE), 'version: 3\n');
    try {
      readState(janusDir);
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.some((issue) => issue.startsWith('version:'))).toBe(true);
    }
  });
});
```

`tests/state/decisions.test.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecision, DECISIONS_HEADER } from '../../src/state/decisions.js';
import { DECISIONS_FILE } from '../../src/state/files.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('appendDecision', () => {
  it('appends a dated block after existing content', () => {
    const janusDir = tempDir();
    writeFileSync(join(janusDir, DECISIONS_FILE), DECISIONS_HEADER);
    appendDecision(janusDir, {
      at: '2026-09-19T12:00:00.000Z',
      by: 'janus init',
      title: 'Workspace created',
      body: 'State branch janus/x on state-repo.',
    });
    const text = readFileSync(join(janusDir, DECISIONS_FILE), 'utf8');
    expect(text.startsWith(DECISIONS_HEADER)).toBe(true);
    expect(text).toContain('## Workspace created (2026-09-19T12:00:00.000Z)');
    expect(text).toContain('By: janus init');
    expect(text.trimEnd().endsWith('State branch janus/x on state-repo.')).toBe(true);
  });

  it('creates the file with the header when it does not exist', () => {
    const janusDir = tempDir();
    appendDecision(janusDir, { at: '2026-09-19T12:00:00.000Z', by: 'human', title: 'T', body: 'B' });
    const text = readFileSync(join(janusDir, DECISIONS_FILE), 'utf8');
    expect(text.startsWith(DECISIONS_HEADER)).toBe(true);
    expect(text).toContain('## T (2026-09-19T12:00:00.000Z)');
  });
});
```

`tests/telemetry/events.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENTS_FILE } from '../../src/state/files.js';
import { appendEvent, readEvents } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('telemetry events', () => {
  it('appends one JSON line per event with a timestamp first', () => {
    const janusDir = tempDir();
    const now = new Date('2026-09-19T12:00:00.000Z');
    const recorded = appendEvent(janusDir, { type: 'goal.created', goal_id: 'g' }, now);
    appendEvent(janusDir, { type: 'stage.entered', stage: 'preparing' }, now);
    expect(recorded).toEqual({ timestamp: '2026-09-19T12:00:00.000Z', type: 'goal.created', goal_id: 'g' });
    const lines = readFileSync(join(janusDir, EVENTS_FILE), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(recorded);
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
  });

  it('reads an empty list when no events exist', () => {
    expect(readEvents(tempDir())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/state/state-store.test.ts tests/state/decisions.test.ts tests/telemetry/events.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the modules**

`src/state/files.ts`:
```ts
/** File names inside the `.janus/` state checkout (spec §5). */
export const STATE_FILE = 'state.yaml';
export const GOAL_FILE = 'goal.yaml';
export const CONFIG_FILE = 'config.yaml';
export const HANDOVER_FILE = 'handover.md';
export const DECISIONS_FILE = 'decisions.md';
export const EVENTS_FILE = 'telemetry/events.jsonl';
```

`src/state/state-store.ts`:
```ts
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { ConfigError, formatZodIssues } from '../config/errors.js';
import { readYamlFile } from '../config/yaml.js';
import { STATE_FILE } from './files.js';
import { stateSchema } from './state-schema.js';
import type { JanusState } from './state-schema.js';

export function statePath(janusDir: string): string {
  return join(janusDir, STATE_FILE);
}

export function readState(janusDir: string): JanusState {
  const path = statePath(janusDir);
  const result = stateSchema.safeParse(readYamlFile(path) ?? {});
  if (!result.success) {
    throw new ConfigError(path, formatZodIssues(result.error));
  }
  return result.data;
}

/** Writes the state to a temp file in the same directory and renames it into place, so readers never see a partial file. */
export function writeState(janusDir: string, state: JanusState): void {
  const path = statePath(janusDir);
  const temp = `${path}.tmp`;
  writeFileSync(temp, stringify(state, { lineWidth: 0 }));
  renameSync(temp, path);
}
```

`src/state/decisions.ts`:
```ts
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_FILE } from './files.js';

export const DECISIONS_HEADER = '# Decisions\n\nAppend-only log of significant decisions and their reasons.\n';

export interface DecisionEntry {
  at: string;
  by: string;
  title: string;
  body: string;
}

export function appendDecision(janusDir: string, entry: DecisionEntry): void {
  const path = join(janusDir, DECISIONS_FILE);
  if (!existsSync(path)) {
    writeFileSync(path, DECISIONS_HEADER);
  }
  const block = `\n## ${entry.title} (${entry.at})\n\nBy: ${entry.by}\n\n${entry.body.trim()}\n`;
  appendFileSync(path, block);
}
```

`src/telemetry/events.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EVENTS_FILE } from '../state/files.js';

export interface TelemetryEvent {
  type: string;
  [key: string]: unknown;
}

export interface RecordedEvent extends TelemetryEvent {
  timestamp: string;
}

/** Appends one event as a JSON line under `.janus/telemetry/`. Telemetry never controls correctness (spec §27). */
export function appendEvent(janusDir: string, event: TelemetryEvent, now: Date = new Date()): RecordedEvent {
  const path = join(janusDir, EVENTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const recorded: RecordedEvent = { timestamp: now.toISOString(), ...event };
  appendFileSync(path, `${JSON.stringify(recorded)}\n`);
  return recorded;
}

export function readEvents(janusDir: string): RecordedEvent[] {
  const path = join(janusDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/state tests/telemetry`
Expected: PASS (state-schema 5, state-store 4, decisions 2, events 2).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/state/files.ts src/state/state-store.ts src/state/decisions.ts src/telemetry/events.ts tests/state/state-store.test.ts tests/state/decisions.test.ts tests/telemetry/events.test.ts
git commit -m "feat(state): add atomic state store, decisions log, and telemetry events"
```

---

### Task 7: Minimal handover renderer

**Files:**
- Create: `src/render/handover.ts`, `tests/render/handover.test.ts`

**Interfaces:**
- Consumes: `JanusState` (Task 5), `Goal` (T01).
- Produces: `renderHandover(state: JanusState, goal: Goal, now: Date): string` (markdown). T13 extends this; the checkpoint routine (Task 9) calls it.

- [ ] **Step 1: Write the failing test**

`tests/render/handover.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { renderHandover } from '../../src/render/handover.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { validGoal } from '../fixtures/valid-goal.js';

const now = new Date('2026-09-19T12:00:00.000Z');
const goal = goalSchema.parse(validGoal);

function state() {
  return createInitialState({ goal, stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' }, now });
}

describe('renderHandover', () => {
  it('summarizes goal, status, repos, and the next action', () => {
    const current = state();
    const uiKit = current.repos['ui-kit'];
    if (uiKit) uiKit.base_commit = 'a'.repeat(40);
    const text = renderHandover(current, goal, now);
    expect(text).toContain('# Handover: Upgrade Angular 15 to 16');
    expect(text).toContain('Generated 2026-09-19T12:00:00.000Z');
    expect(text).toContain('- Status: created');
    expect(text).toContain('- State branch: janus/angular-15-to-16 on state-repo');
    expect(text).toContain('| ui-kit | ai/angular-15-to-16 | aaaaaaa | - | - | no |');
    expect(text).toContain('| shell | ai/angular-15-to-16 | - | - | - | no |');
    expect(text).toContain('Run `janus run` to start prepare and discovery.');
  });

  it('points at the plan approval command when waiting at gate 1', () => {
    const current = state();
    current.goal.status = 'awaiting_plan_approval';
    current.gate.type = 'plan_approval';
    current.gate.status = 'waiting';
    const text = renderHandover(current, goal, now);
    expect(text).toContain('- Gate: plan_approval (waiting)');
    expect(text).toContain('janus approve plan --commit <sha>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test tests/render/handover.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the renderer**

`src/render/handover.ts`:
```ts
import type { Goal } from '../config/goal-schema.js';
import type { JanusState } from '../state/state-schema.js';

/** The human-readable handover regenerated at every checkpoint (spec §5, §7). state.yaml stays authoritative. */
export function renderHandover(state: JanusState, goal: Goal, now: Date): string {
  const lines: string[] = [];
  lines.push(`# Handover: ${goal.title}`, '');
  lines.push(
    `Generated ${now.toISOString()} by Janus. Rewritten at every checkpoint; state.yaml is the authoritative view.`,
    '',
  );
  lines.push('## Where we are', '');
  lines.push(`- Goal: ${state.goal.id} (Angular ${goal.source_version} -> ${goal.target_version})`);
  lines.push(`- Status: ${state.goal.status}`);
  lines.push(`- State branch: ${state.state_branch.name} on ${state.state_branch.remote}`);
  lines.push(`- Current work package: ${state.execution.current_work_package ?? 'none'}`);
  lines.push(`- Gate: ${state.gate.type === null ? 'none' : `${state.gate.type} (${state.gate.status})`}`, '');
  lines.push('## Repositories', '');
  lines.push('| Repo | Goal branch | Base commit | Head commit | PR | Merged |');
  lines.push('|---|---|---|---|---|---|');
  for (const repo of goal.repos) {
    const repoState = state.repos[repo.name];
    if (!repoState) continue;
    lines.push(
      `| ${repo.name} | ${repoState.goal_branch} | ${short(repoState.base_commit)} | ${short(repoState.head_commit)} | ${repoState.pr.url ?? '-'} | ${repoState.merged ? 'yes' : 'no'} |`,
    );
  }
  lines.push('', '## Next action', '', nextAction(state), '');
  return lines.join('\n');
}

function short(sha: string | null): string {
  return sha === null ? '-' : sha.slice(0, 7);
}

function nextAction(state: JanusState): string {
  switch (state.goal.status) {
    case 'created':
      return 'Run `janus run` to start prepare and discovery.';
    case 'awaiting_plan_approval':
      return 'Review .janus/plan.md and run `janus approve plan --commit <sha>`.';
    case 'escalated':
      return 'Read .janus/escalation.md and run `janus escalation resolve --direction "..."`.';
    case 'completed':
      return 'Goal complete. Nothing to do.';
    default:
      return 'Run `janus run` to continue.';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/render/handover.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/render/handover.ts tests/render/handover.test.ts
git commit -m "feat(render): add minimal handover renderer"
```

---

### Task 8: Clone URLs: schema extensions, remote resolution, spec alignment

**Files:**
- Modify: `src/config/goal-schema.ts`, `src/config/config-schema.ts`, `angular-ai-development-workflow-v2.md`, `tasks.md`
- Create: `src/workspace/remotes.ts`, `tests/workspace/remotes.test.ts`

**Interfaces:**
- Consumes: `Goal`, `GoalRepo`, `JanusConfig`, `ConfigError`, `parseConfig`, `goalSchema` (T01).
- Produces: goal repos gain optional `clone_url: string`; config gains `state.clone_url?: string` and `bitbucket.clone_url_template: string` (default `{url}/scm/{project}/{slug}.git`); `repoCloneUrl(repo: GoalRepo, config: JanusConfig): string`; `interface StateRemote { url: string; remoteName: string }`; `stateRemote(goal: Goal, config: JanusConfig): StateRemote`; `stateBranchName(goalId: string): string` returning `janus/<goalId>`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace/remotes.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { parseConfig } from '../../src/config/load-config.js';
import { repoCloneUrl, stateBranchName, stateRemote } from '../../src/workspace/remotes.js';
import { validGoal } from '../fixtures/valid-goal.js';

const fakeProviders = { workflow: { ci_provider: 'fake', scm_provider: 'fake' } };

describe('repoCloneUrl', () => {
  it('prefers an explicit clone_url', () => {
    const goal = goalSchema.parse({
      ...validGoal,
      repos: [{ ...validGoal.repos[0], clone_url: '/tmp/ui-kit.git' }, ...validGoal.repos.slice(1)],
    });
    const config = parseConfig(fakeProviders, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(repoCloneUrl(repo, config)).toBe('/tmp/ui-kit.git');
  });

  it('renders the bitbucket template with a lowercase project key', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig({ ...fakeProviders, bitbucket: { url: 'https://bb.example.internal/' } }, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(repoCloneUrl(repo, config)).toBe('https://bb.example.internal/scm/fe/ui-kit.git');
  });

  it('fails clearly when neither clone_url nor bitbucket.url exists', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig(fakeProviders, 'config.yaml');
    const repo = goal.repos[0];
    if (!repo) throw new Error('fixture has no repos');
    expect(() => repoCloneUrl(repo, config)).toThrowError(ConfigError);
    expect(() => repoCloneUrl(repo, config)).toThrowError(/repos\.ui-kit\.clone_url: required/);
  });
});

describe('stateRemote', () => {
  it('uses state.clone_url when configured', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig({ ...fakeProviders, state: { clone_url: '/tmp/state.git' } }, 'config.yaml');
    expect(stateRemote(goal, config)).toEqual({ url: '/tmp/state.git', remoteName: 'state-repo' });
  });

  it('renders state.repo through the bitbucket template', () => {
    const goal = goalSchema.parse(validGoal);
    const config = parseConfig(
      { ...fakeProviders, bitbucket: { url: 'https://bb.example.internal' }, state: { repo: { project: 'FE', slug: 'janus-state' } } },
      'config.yaml',
    );
    expect(stateRemote(goal, config)).toEqual({ url: 'https://bb.example.internal/scm/fe/janus-state.git', remoteName: 'state-repo' });
  });

  it('falls back to the first repo of the goal', () => {
    const goal = goalSchema.parse({
      ...validGoal,
      repos: [{ ...validGoal.repos[0], clone_url: '/tmp/ui-kit.git' }, ...validGoal.repos.slice(1)],
    });
    const config = parseConfig(fakeProviders, 'config.yaml');
    expect(stateRemote(goal, config)).toEqual({ url: '/tmp/ui-kit.git', remoteName: 'ui-kit' });
  });
});

describe('stateBranchName', () => {
  it('prefixes the goal id', () => {
    expect(stateBranchName('angular-15-to-16')).toBe('janus/angular-15-to-16');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/workspace/remotes.test.ts`
Expected: FAIL, module not found (and, once it exists, unknown key `clone_url` until the schemas change).

- [ ] **Step 3: Extend the schemas**

In `src/config/goal-schema.ts`, inside `repoSchema`, add after the `package_name` line:
```ts
    clone_url: z.string().min(1).optional(),
```

In `src/config/config-schema.ts`, replace the `state` block:
```ts
    state: z
      .object({
        repo: z.object({ project: z.string().min(1), slug: z.string().min(1) }).strict().optional(),
        clone_url: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
```
and inside the `bitbucket` object add after `required_reviewers`:
```ts
        clone_url_template: z.string().min(1).default('{url}/scm/{project}/{slug}.git'),
```

- [ ] **Step 4: Write the remote resolution**

`src/workspace/remotes.ts`:
```ts
import { ConfigError } from '../config/errors.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal, GoalRepo } from '../config/goal-schema.js';

export interface StateRemote {
  /** Clone URL of the repository that holds the state branch. */
  url: string;
  /** `state-repo` for a dedicated repository, otherwise the name of the goal repo that hosts the branch. */
  remoteName: string;
}

export function stateBranchName(goalId: string): string {
  return `janus/${goalId}`;
}

/** Clone URL for a goal repo: explicit `clone_url`, else the bitbucket template rendered with the lowercase project key. */
export function repoCloneUrl(repo: GoalRepo, config: JanusConfig): string {
  if (repo.clone_url !== undefined) return repo.clone_url;
  if (config.bitbucket.url === undefined) {
    throw new ConfigError('goal.yaml', [`repos.${repo.name}.clone_url: required because bitbucket.url is not configured`]);
  }
  return renderTemplate(config, repo.scm.project, repo.scm.slug);
}

/** Where the state branch lives: `state.clone_url`, else `state.repo` through the template, else the first goal repo. */
export function stateRemote(goal: Goal, config: JanusConfig): StateRemote {
  if (config.state.clone_url !== undefined) {
    return { url: config.state.clone_url, remoteName: 'state-repo' };
  }
  if (config.state.repo !== undefined) {
    if (config.bitbucket.url === undefined) {
      throw new ConfigError('config.yaml', ['state.clone_url: required because bitbucket.url is not configured']);
    }
    return { url: renderTemplate(config, config.state.repo.project, config.state.repo.slug), remoteName: 'state-repo' };
  }
  const first = goal.repos[0];
  if (!first) {
    throw new ConfigError('goal.yaml', ['repos: at least one repo is required to host the state branch']);
  }
  return { url: repoCloneUrl(first, config), remoteName: first.name };
}

function renderTemplate(config: JanusConfig, project: string, slug: string): string {
  const base = (config.bitbucket.url ?? '').replace(/\/+$/, '');
  return config.bitbucket.clone_url_template
    .replace('{url}', base)
    .replace('{project}', project.toLowerCase())
    .replace('{slug}', slug);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/workspace/remotes.test.ts tests/config`
Expected: PASS; the existing config and goal tests still pass (the new fields are optional or defaulted).

- [ ] **Step 6: Align the spec and tasks wording**

Run this script from the repo root; it fails loudly if any anchor text is missing, which means the spec changed and the edit must be redone by hand:
```bash
python3 - <<'PY'
import sys
p = 'angular-ai-development-workflow-v2.md'
s = open(p).read()
edits = [
  ("    scm: { project: FE, slug: ui-kit }\n    base_branch: main\n    package_name: \"@acme/ui-kit\"",
   "    scm: { project: FE, slug: ui-kit }\n    # clone_url: https://...   optional; derived from bitbucket.clone_url_template when absent\n    base_branch: main\n    package_name: \"@acme/ui-kit\""),
  ("Alternatively `janus init` writes a workspace `.npmrc` with `store-dir=<workspace>/.pnpm-store` so a single writable root suffices; this is the default.",
   "Alternatively Janus sets `npm_config_store_dir=<workspace>/.pnpm-store` in every code-writing agent's environment so a single writable root suffices; this is the default (`agents.pnpm_store: workspace`). No `.npmrc` is written, because pnpm reads `.npmrc` only from a project root."),
  ("state:\n  repo: { project: FE, slug: janus-state }   # optional dedicated state repo",
   "state:\n  repo: { project: FE, slug: janus-state }   # optional dedicated state repo, rendered through bitbucket.clone_url_template\n  clone_url: null                              # or an explicit clone URL for the state repo"),
  ("  token_env: JANUS_BITBUCKET_TOKEN\n  required_reviewers: []",
   "  token_env: JANUS_BITBUCKET_TOKEN\n  required_reviewers: []\n  clone_url_template: \"{url}/scm/{project}/{slug}.git\""),
]
for old, new in edits:
    if s.count(old) != 1:
        sys.exit(f'anchor not found exactly once: {old[:60]!r}')
    s = s.replace(old, new)
open(p, 'w').write(s)
t = 'tasks.md'
s = open(t).read()
old = "`.pnpm-store/` with workspace `.npmrc`"
if s.count(old) != 1:
    sys.exit('tasks.md anchor not found')
open(t, 'w').write(s.replace(old, "`.pnpm-store/` (handed to agents via `npm_config_store_dir`, no `.npmrc`)"))
print('ok')
PY
```
Expected: prints `ok`.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/config/goal-schema.ts src/config/config-schema.ts src/workspace/remotes.ts tests/workspace/remotes.test.ts angular-ai-development-workflow-v2.md tasks.md
git commit -m "feat(workspace): resolve repo and state clone urls from goal and config"
```

---

### Task 9: State branch repo and checkpoint

**Files:**
- Create: `src/workspace/state-branch.ts`, `src/state/checkpoint.ts`, `tests/workspace/state-branch.test.ts`, `tests/state/checkpoint.test.ts`

**Interfaces:**
- Consumes: `initRepo`, `addRemote`, `clone`, `revParse`, `commitAll`, `push`, `PushRejectedError`, `remoteHead` (Task 2); `writeState` (Task 6); `appendDecision`, `DecisionEntry` (Task 6); `renderHandover` (Task 7); `HANDOVER_FILE` (Task 6); `JanusState`, `createInitialState` (Task 5); `Goal` (T01).
- Produces: `initStateRepo({ janusDir, branch, remoteUrl, files: Record<string, string> }): Promise<void>` (fresh repo on `branch`, `origin` set, files written, nothing committed); `openStateRepo({ janusDir, branch, remoteUrl }): Promise<string>` (single-branch clone, returns head sha); `checkpoint({ janusDir, state, goal, message, push, decision?, now? }): Promise<{ commit: string; pushed: boolean }>`; `class StateBranchDivergedError extends Error`.

- [ ] **Step 1: Write the failing tests**

`tests/workspace/state-branch.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, currentBranch, push, remoteHead } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { initStateRepo, openStateRepo } from '../../src/workspace/state-branch.js';
import { createBareRepo, tempDir } from '../helpers/git-fixtures.js';

describe('initStateRepo', () => {
  it('creates a repo on the state branch with origin and the given files, uncommitted', async () => {
    const bare = await createBareRepo('state', 'janus/g');
    const janusDir = join(tempDir(), '.janus');
    await initStateRepo({ janusDir, branch: 'janus/g', remoteUrl: bare, files: { 'goal.yaml': 'id: g\n', 'telemetry/events.jsonl': '' } });
    expect(await currentBranch(janusDir)).toBe('janus/g');
    expect(await runGit(janusDir, ['remote', 'get-url', 'origin'])).toBe(bare);
    expect(readFileSync(join(janusDir, 'goal.yaml'), 'utf8')).toBe('id: g\n');
    expect(existsSync(join(janusDir, 'telemetry', 'events.jsonl'))).toBe(true);
    expect(await runGit(janusDir, ['status', '--porcelain'])).toContain('goal.yaml');
    await expect(runGit(janusDir, ['rev-parse', 'HEAD'])).rejects.toThrow();
  });
});

describe('openStateRepo', () => {
  it('clones only the state branch and returns its head', async () => {
    const bare = await createBareRepo('state', 'janus/g');
    const source = join(tempDir(), '.janus');
    await initStateRepo({ janusDir: source, branch: 'janus/g', remoteUrl: bare, files: { 'state.yaml': 'version: 2\n' } });
    const sha = await commitAll(source, 'chore(janus): first');
    await push(source, 'origin', 'janus/g', { setUpstream: true });
    writeFileSync(join(source, 'other.txt'), 'x\n');
    await runGit(source, ['checkout', '-q', '-b', 'other']);
    await commitAll(source, 'chore(janus): other branch');
    await push(source, 'origin', 'other');

    const target = join(tempDir(), '.janus');
    expect(await openStateRepo({ janusDir: target, branch: 'janus/g', remoteUrl: bare })).toBe(sha);
    expect(await currentBranch(target)).toBe('janus/g');
    expect(readFileSync(join(target, 'state.yaml'), 'utf8')).toBe('version: 2\n');
    expect(await runGit(target, ['branch', '-r'])).not.toContain('origin/other');
    expect(await remoteHead(target, 'origin', 'janus/g')).toBe(sha);
  });
});
```

`tests/state/checkpoint.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { clone, commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { checkpoint, StateBranchDivergedError } from '../../src/state/checkpoint.js';
import { DECISIONS_HEADER } from '../../src/state/decisions.js';
import { DECISIONS_FILE, HANDOVER_FILE } from '../../src/state/files.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { readState } from '../../src/state/state-store.js';
import { initStateRepo } from '../../src/workspace/state-branch.js';
import { validGoal } from '../fixtures/valid-goal.js';
import { createBareRepo, tempDir } from '../helpers/git-fixtures.js';

const goal = goalSchema.parse(validGoal);
const branch = 'janus/angular-15-to-16';

async function stateRepo() {
  const bare = await createBareRepo('state', branch);
  const janusDir = join(tempDir(), '.janus');
  await initStateRepo({ janusDir, branch, remoteUrl: bare, files: { [DECISIONS_FILE]: DECISIONS_HEADER } });
  const state = createInitialState({ goal, stateBranch: { name: branch, remote: 'state-repo' }, now: new Date('2026-09-19T12:00:00.000Z') });
  return { bare, janusDir, state };
}

describe('checkpoint', () => {
  it('writes state and handover, appends the decision, commits, and pushes fast-forward', async () => {
    const { bare, janusDir, state } = await stateRepo();
    const now = new Date('2026-09-19T12:05:00.000Z');
    const result = await checkpoint({
      janusDir,
      state,
      goal,
      message: 'chore(janus): initialize workspace',
      push: true,
      decision: { at: now.toISOString(), by: 'janus init', title: 'Workspace created', body: 'first' },
      now,
    });
    expect(result.pushed).toBe(true);
    expect(result.commit).toBe(await revParse(janusDir, 'HEAD'));
    expect(await remoteHead(janusDir, 'origin', branch)).toBe(result.commit);
    expect(readState(janusDir).telemetry.last_updated_at).toBe('2026-09-19T12:05:00.000Z');
    expect(readFileSync(join(janusDir, HANDOVER_FILE), 'utf8')).toContain('Generated 2026-09-19T12:05:00.000Z');
    expect(readFileSync(join(janusDir, DECISIONS_FILE), 'utf8')).toContain('## Workspace created');
    expect(await runGit(janusDir, ['status', '--porcelain'])).toBe('');
    expect(await runGit(janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): initialize workspace');
    void bare;
  });

  it('commits without pushing when asked', async () => {
    const { janusDir, state } = await stateRepo();
    const result = await checkpoint({ janusDir, state, goal, message: 'chore(janus): local only', push: false });
    expect(result.pushed).toBe(false);
    expect(await remoteHead(janusDir, 'origin', branch)).toBeNull();
    expect(existsSync(join(janusDir, HANDOVER_FILE))).toBe(true);
  });

  it('fails with StateBranchDivergedError when the remote moved', async () => {
    const { bare, janusDir, state } = await stateRepo();
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): one', push: true });
    const other = join(tempDir(), 'other');
    await clone(bare, other, { branch });
    await commitAll(other, 'chore(janus): elsewhere', { allowEmpty: true });
    await runGit(other, ['push', '-q', 'origin', branch]);
    await expect(checkpoint({ janusDir, state, goal, message: 'chore(janus): two', push: true })).rejects.toBeInstanceOf(
      StateBranchDivergedError,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/workspace/state-branch.test.ts tests/state/checkpoint.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the state-branch module and the checkpoint**

`src/workspace/state-branch.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { addRemote, clone, initRepo, revParse } from '../git/ops.js';

export interface InitStateRepoInput {
  janusDir: string;
  branch: string;
  remoteUrl: string;
  /** Relative path -> content. Written but not committed; the first checkpoint commits. */
  files: Record<string, string>;
}

/** Creates `.janus/` as a brand-new repository whose only branch is the state branch, with `origin` pointing at the state remote. */
export async function initStateRepo(input: InitStateRepoInput): Promise<void> {
  mkdirSync(input.janusDir, { recursive: true });
  await initRepo(input.janusDir, input.branch);
  await addRemote(input.janusDir, 'origin', input.remoteUrl);
  for (const [relative, content] of Object.entries(input.files)) {
    const path = join(input.janusDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

export interface OpenStateRepoInput {
  janusDir: string;
  branch: string;
  remoteUrl: string;
}

/** Clones only the state branch into `.janus/` and returns its head sha. */
export async function openStateRepo(input: OpenStateRepoInput): Promise<string> {
  mkdirSync(dirname(input.janusDir), { recursive: true });
  await clone(input.remoteUrl, input.janusDir, { branch: input.branch, singleBranch: true });
  return revParse(input.janusDir, 'HEAD');
}
```

`src/state/checkpoint.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Goal } from '../config/goal-schema.js';
import { commitAll, push, PushRejectedError } from '../git/ops.js';
import { renderHandover } from '../render/handover.js';
import { appendDecision } from './decisions.js';
import type { DecisionEntry } from './decisions.js';
import { HANDOVER_FILE } from './files.js';
import type { JanusState } from './state-schema.js';
import { writeState } from './state-store.js';

export class StateBranchDivergedError extends Error {
  constructor(branch: string, remote: string) {
    super(`state branch ${branch} on ${remote} has moved; fetch and reconcile .janus/ before running again`);
    this.name = 'StateBranchDivergedError';
  }
}

export interface CheckpointInput {
  janusDir: string;
  state: JanusState;
  goal: Goal;
  message: string;
  push: boolean;
  decision?: DecisionEntry;
  now?: Date;
}

export interface CheckpointResult {
  commit: string;
  pushed: boolean;
}

/** Spec §7: writes state.yaml and handover.md, appends any decision, commits on the state branch, and pushes fast-forward only. */
export async function checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
  const now = input.now ?? new Date();
  input.state.telemetry.last_updated_at = now.toISOString();
  writeState(input.janusDir, input.state);
  writeFileSync(join(input.janusDir, HANDOVER_FILE), renderHandover(input.state, input.goal, now));
  if (input.decision) {
    appendDecision(input.janusDir, input.decision);
  }
  const commit = await commitAll(input.janusDir, input.message, { allowEmpty: true });
  if (!input.push) {
    return { commit, pushed: false };
  }
  try {
    await push(input.janusDir, 'origin', input.state.state_branch.name, { setUpstream: true });
  } catch (error) {
    if (error instanceof PushRejectedError) {
      throw new StateBranchDivergedError(input.state.state_branch.name, input.state.state_branch.remote);
    }
    throw error;
  }
  return { commit, pushed: true };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/workspace/state-branch.test.ts tests/state/checkpoint.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm test`
```bash
git add src/workspace/state-branch.ts src/state/checkpoint.ts tests/workspace/state-branch.test.ts tests/state/checkpoint.test.ts
git commit -m "feat(state): add state-branch repo setup and fast-forward checkpoints"
```

---

### Task 10: `janus init --goal` creates a workspace

**Files:**
- Create: `src/workspace/create-workspace.ts`, `tests/helpers/workspace-fixtures.ts`, `tests/cli/init-create.test.ts`
- Modify: `src/cli/commands/init.ts` (replace), `src/cli/main.ts` (Locked mapping), `tests/cli/main.test.ts`, `tests/cli/init.test.ts`

**Interfaces:**
- Consumes: `workspacePaths`, `createWorkspaceDirs`, `ensureEmptyOrMissing` (Task 4); `acquireLock`, `releaseLock`, `WorkspaceLockedError` (Task 4); `repoCloneUrl`, `stateRemote`, `stateBranchName`, `StateRemote` (Task 8); `initStateRepo` (Task 9); `checkpoint` (Task 9); `createInitialState`, `JanusState` (Task 5); `appendEvent` (Task 6); `DECISIONS_HEADER` (Task 6); `GOAL_FILE`, `CONFIG_FILE`, `DECISIONS_FILE` (Task 6); `clone`, `revParse` (Task 2); `loadGoal`, `loadConfig`, `ConfigError` (T01).
- Produces: `createWorkspace({ goal, repoOrder, config, goalFileText, configFileText, workspaceRoot, now?, log }): Promise<{ paths: WorkspacePaths; state: JanusState; stateCommit: string; stateRemote: StateRemote; reclaimedLock: LockInfo | null }>`; test helper `goalFixture(): Promise<{ dir, goalId, goalPath, configPath, goalText, uiKit, shell, stateBare }>`; `janus init --goal` exits 0 after creating the workspace. Task 11 replaces the `--resume` branch of `runInit`.

- [ ] **Step 1: Write the shared fixture and the failing tests**

`tests/helpers/workspace-fixtures.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createBareRepo, createRemoteWithCommit, tempDir } from './git-fixtures.js';
import type { RemoteFixture } from './git-fixtures.js';

export interface GoalFixture {
  dir: string;
  goalId: string;
  goalPath: string;
  configPath: string;
  goalText: string;
  uiKit: RemoteFixture;
  shell: RemoteFixture;
  stateBare: string;
}

/** Two bare product remotes with one commit each, a bare state remote, and goal/config files pointing at them with fake providers. */
export async function goalFixture(): Promise<GoalFixture> {
  const goalId = 'angular-15-to-16';
  const dir = tempDir('janus-goal-');
  const uiKit = await createRemoteWithCommit('ui-kit');
  const shell = await createRemoteWithCommit('shell');
  const stateBare = await createBareRepo('janus-state', `janus/${goalId}`);
  const goal = {
    id: goalId,
    source_version: '15',
    target_version: '16',
    title: 'Upgrade Angular 15 to 16',
    repos: [
      {
        name: 'ui-kit',
        kind: 'library',
        scm: { project: 'FE', slug: 'ui-kit' },
        base_branch: 'main',
        clone_url: uiKit.bare,
        ci: { pr_build_type_id: 'Fe_UiKit_Build' },
      },
      {
        name: 'shell',
        kind: 'shell',
        scm: { project: 'FE', slug: 'shell' },
        base_branch: 'main',
        clone_url: shell.bare,
        ci: { pr_build_type_id: 'Fe_Shell_Build' },
        depends_on: ['ui-kit'],
      },
    ],
    e2e: { build_type_id: 'Fe_E2E_Full', branch_params: { shell: 'env.SHELL_BRANCH' } },
  };
  const goalText = stringify(goal);
  const goalPath = join(dir, 'goal.yaml');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(goalPath, goalText);
  writeFileSync(
    configPath,
    stringify({
      workflow: { agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' },
      state: { clone_url: stateBare },
    }),
  );
  return { dir, goalId, goalPath, configPath, goalText, uiKit, shell, stateBare };
}
```

`tests/cli/init-create.test.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { currentBranch, remoteHead, revParse } from '../../src/git/ops.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';
import { goalFixture } from '../helpers/workspace-fixtures.js';

describe('janus init --goal', () => {
  it('clones repos, creates and pushes the state branch, and checkpoints', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: Angular 15 -> 16, 2 repos');
    expect(result.stdout).toContain('repo order: ui-kit, shell');
    expect(result.stdout).toContain(`workspace: ${workspace}`);
    expect(result.stdout).toMatch(/checkpoint: [0-9a-f]{7}/);

    expect(existsSync(join(workspace, 'repos', 'ui-kit', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, 'repos', 'shell', 'README.md'))).toBe(true);
    expect(existsSync(join(workspace, '.pnpm-store'))).toBe(true);
    expect(existsSync(join(workspace, 'fake'))).toBe(true);
    expect(existsSync(join(workspace, 'janus.lock'))).toBe(false);

    const janusDir = join(workspace, '.janus');
    const state = readState(janusDir);
    expect(state.goal.status).toBe('created');
    expect(state.state_branch).toEqual({ name: 'janus/angular-15-to-16', remote: 'state-repo' });
    expect(state.repos['ui-kit']?.base_commit).toBe(fixture.uiKit.head);
    expect(state.repos['shell']?.base_commit).toBe(fixture.shell.head);
    expect(readFileSync(join(janusDir, 'goal.yaml'), 'utf8')).toBe(fixture.goalText);
    expect(existsSync(join(janusDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(janusDir, 'handover.md'))).toBe(true);
    expect(readFileSync(join(janusDir, 'decisions.md'), 'utf8')).toContain('## Workspace created');
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created']);

    expect(await currentBranch(janusDir)).toBe('janus/angular-15-to-16');
    const head = await revParse(janusDir, 'HEAD');
    expect(await remoteHead(janusDir, 'origin', 'janus/angular-15-to-16')).toBe(head);
    expect(await currentBranch(join(workspace, 'repos', 'shell'))).toBe('main');
  });

  it('refuses a non-empty workspace directory', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'leftover.txt'), 'x');
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('exists and is not empty');
  });

  it('fails clearly when no config.yaml sits next to the goal and none is given', async () => {
    const fixture = await goalFixture();
    rmSync(fixture.configPath);
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', join(tempDir(), 'ws')]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('config.yaml not found next to the goal file');
  });

  it('exits 13 when another janus process holds the lock', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'janus.lock'), JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }));
    const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', workspace]);
    expect(result.code).toBe(ExitCode.Locked);
    expect(result.stderr).toContain('locked by pid');
  });
});
```

In `tests/cli/init.test.ts`, replace the first test (`validates the goal, prints the summary, and reports workspace creation as not implemented`) with:
```ts
  it('validates the goal and then requires a config file', async () => {
    const dir = tempDir();
    const goalPath = join(dir, 'goal.yaml');
    writeFileSync(goalPath, stringify(validGoal));
    const result = await runCli(['init', '--goal', goalPath]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('config.yaml not found next to the goal file');
  });
```
(Keep the other four tests unchanged. Note the fourth test passes an invalid `--config`; the goal is validated first, so it still exits 2 naming `workflow.ci_provider`.)

In `tests/cli/main.test.ts`, add to the `exitCodeForError` describe block:
```ts
  it('exits 13 with the message for a locked workspace', () => {
    const io = fakeIo();
    const error = new WorkspaceLockedError('/ws/janus.lock', { pid: 1, acquired_at: '2026-09-19T00:00:00.000Z' });
    expect(exitCodeForError(error, io)).toBe(ExitCode.Locked);
    expect(io.stderrText).toContain('locked by pid 1');
  });
```
with `import { WorkspaceLockedError } from '../../src/workspace/lock.js';` added to that file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/cli`
Expected: FAIL: `init-create` cannot find the workspace module; `init.test.ts` first case gets exit 3; `main.test.ts` cannot find `WorkspaceLockedError` mapping (exit 1 instead of 13).

- [ ] **Step 3: Write createWorkspace**

`src/workspace/create-workspace.ts`:
```ts
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal, GoalRepo } from '../config/goal-schema.js';
import { clone, revParse } from '../git/ops.js';
import { checkpoint } from '../state/checkpoint.js';
import { DECISIONS_HEADER } from '../state/decisions.js';
import { CONFIG_FILE, DECISIONS_FILE, GOAL_FILE } from '../state/files.js';
import { createInitialState } from '../state/state-schema.js';
import type { JanusState } from '../state/state-schema.js';
import { appendEvent } from '../telemetry/events.js';
import { createWorkspaceDirs, ensureEmptyOrMissing, workspacePaths } from './layout.js';
import type { WorkspacePaths } from './layout.js';
import { acquireLock, releaseLock } from './lock.js';
import type { LockInfo } from './lock.js';
import { repoCloneUrl, stateBranchName, stateRemote } from './remotes.js';
import type { StateRemote } from './remotes.js';
import { initStateRepo } from './state-branch.js';

export interface CreateWorkspaceInput {
  goal: Goal;
  repoOrder: string[];
  config: JanusConfig;
  goalFileText: string;
  configFileText: string;
  workspaceRoot: string;
  now?: Date;
  log: (line: string) => void;
}

export interface CreateWorkspaceResult {
  paths: WorkspacePaths;
  state: JanusState;
  stateCommit: string;
  stateRemote: StateRemote;
  reclaimedLock: LockInfo | null;
}

/** `janus init --goal`: clone every repo at its base branch, create the state repo, and make the first pushed checkpoint (spec §5, §7). */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const now = input.now ?? new Date();
  const paths = workspacePaths(input.workspaceRoot);
  ensureEmptyOrMissing(paths.root);
  createWorkspaceDirs(paths);
  const { reclaimed } = acquireLock(paths.lockFile, now);
  try {
    const remote = stateRemote(input.goal, input.config);
    const branch = stateBranchName(input.goal.id);
    const state = createInitialState({ goal: input.goal, stateBranch: { name: branch, remote: remote.remoteName }, now });
    const reposByName = new Map<string, GoalRepo>(input.goal.repos.map((repo) => [repo.name, repo]));

    for (const name of input.repoOrder) {
      const repo = reposByName.get(name);
      const repoState = state.repos[name];
      if (!repo || !repoState) continue;
      const url = repoCloneUrl(repo, input.config);
      input.log(`cloning ${name} (${repo.base_branch}) from ${url}`);
      await clone(url, paths.repoDir(name), { branch: repo.base_branch });
      repoState.base_commit = await revParse(paths.repoDir(name), 'HEAD');
    }

    input.log(`creating state branch ${branch} -> ${remote.url}`);
    await initStateRepo({
      janusDir: paths.janusDir,
      branch,
      remoteUrl: remote.url,
      files: {
        [GOAL_FILE]: input.goalFileText,
        [CONFIG_FILE]: input.configFileText,
        [DECISIONS_FILE]: DECISIONS_HEADER,
      },
    });
    appendEvent(paths.janusDir, { type: 'goal.created', goal_id: input.goal.id, repos: input.repoOrder }, now);
    const { commit } = await checkpoint({
      janusDir: paths.janusDir,
      state,
      goal: input.goal,
      message: `chore(janus): initialize workspace for ${input.goal.id}`,
      push: true,
      decision: {
        at: now.toISOString(),
        by: 'janus init',
        title: 'Workspace created',
        body: `State branch ${branch} on ${remote.remoteName} (${remote.url}). Repos in order: ${input.repoOrder.join(', ')}.`,
      },
      now,
    });
    return { paths, state, stateCommit: commit, stateRemote: remote, reclaimedLock: reclaimed };
  } finally {
    releaseLock(paths.lockFile);
  }
}
```

- [ ] **Step 4: Replace the init command and map the lock error**

`src/cli/commands/init.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { loadConfig } from '../../config/load-config.js';
import { loadGoal } from '../../config/load-goal.js';
import { createWorkspace } from '../../workspace/create-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';
import { notImplemented } from '../not-implemented.js';

interface InitOptions {
  goal?: string;
  config?: string;
  workspace?: string;
  resume?: string;
}

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('Create a goal workspace from a goal file, or rebuild one from a state branch')
    .argument('[goal-id]', 'goal id, used with --resume')
    .option('--goal <file>', 'path to goal.yaml')
    .option('--config <file>', 'path to config.yaml (default: config.yaml next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action(async (goalId: string | undefined, options: InitOptions) => {
      ctx.exitCode = await runInit(ctx, goalId, options);
    });
}

async function runInit(ctx: CliContext, goalId: string | undefined, options: InitOptions): Promise<ExitCode> {
  if (options.resume !== undefined) {
    void goalId;
    return notImplemented(ctx, 'init --resume', 'T02');
  }
  if (options.goal === undefined) {
    ctx.io.stderr('janus: either --goal <file> or --resume <state-remote> is required\n');
    return ExitCode.UsageError;
  }
  const goalPath = resolve(ctx.io.cwd, options.goal);
  const configPath = options.config !== undefined ? resolve(ctx.io.cwd, options.config) : join(dirname(goalPath), 'config.yaml');
  const { goal, repoOrder } = loadGoal(goalPath);
  if (options.config === undefined && !existsSync(configPath)) {
    throw new ConfigError(configPath, ['config.yaml not found next to the goal file; pass --config <file>']);
  }
  const config = loadConfig(configPath);
  ctx.io.stdout(
    `goal ${goal.id}: Angular ${goal.source_version} -> ${goal.target_version}, ${goal.repos.length} repos\n`,
  );
  ctx.io.stdout(`repo order: ${repoOrder.join(', ')}\n`);
  const result = await createWorkspace({
    goal,
    repoOrder,
    config,
    goalFileText: readFileSync(goalPath, 'utf8'),
    configFileText: readFileSync(configPath, 'utf8'),
    workspaceRoot: resolve(ctx.io.cwd, options.workspace ?? goal.id),
    log: (line) => ctx.io.stdout(`${line}\n`),
  });
  if (result.reclaimedLock !== null) {
    ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${result.reclaimedLock.pid}\n`);
  }
  ctx.io.stdout(`workspace: ${result.paths.root}\n`);
  ctx.io.stdout(`state branch: ${result.state.state_branch.name} -> ${result.stateRemote.url}\n`);
  ctx.io.stdout(`checkpoint: ${result.stateCommit.slice(0, 7)}\n`);
  return ExitCode.Ok;
}
```

In `src/cli/main.ts`, add the import `import { WorkspaceLockedError } from '../workspace/lock.js';` and, inside `exitCodeForError`, insert before the `ConfigError` branch:
```ts
  if (error instanceof WorkspaceLockedError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.Locked;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS, all files. The `commands.test.ts` case `['init', '--resume', ...]` still passes (stub kept until Task 11).

- [ ] **Step 6: Lint, typecheck, build, try it, commit**

Run: `pnpm lint && pnpm typecheck && pnpm build`
```bash
git add src/workspace/create-workspace.ts src/cli/commands/init.ts src/cli/main.ts tests/helpers/workspace-fixtures.ts tests/cli/init-create.test.ts tests/cli/init.test.ts tests/cli/main.test.ts
git commit -m "feat(cli): create a goal workspace with janus init --goal"
```

---

### Task 11: `janus init --resume` rebuilds a workspace from the state branch

**Files:**
- Create: `src/workspace/resume-workspace.ts`, `tests/cli/init-resume.test.ts`
- Modify: `src/cli/commands/init.ts`, `tests/cli/commands.test.ts`

**Interfaces:**
- Consumes: `openStateRepo` (Task 9); `readState` (Task 6); `loadGoal`, `loadConfig`, `ConfigError` (T01); `repoCloneUrl` (Task 8); `clone`, `fetch`, `checkoutBranch`, `revParse` (Task 2); layout and lock (Task 4); `GOAL_FILE`, `CONFIG_FILE` (Task 6); `stateBranchName` (Task 8).
- Produces: `resumeWorkspace({ stateRemoteUrl, goalId, workspaceRoot, log }): Promise<{ paths; state; goal; config; stateCommit; warnings: string[]; reclaimedLock }>`; `janus init --resume <state-remote> <goal-id>` exits 0 and prints warnings for repos whose goal-branch head differs from the recorded one.

- [ ] **Step 1: Write the failing test and drop the stub case**

`tests/cli/init-resume.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { checkoutBranch, commitAll, currentBranch, push, revParse } from '../../src/git/ops.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { readState } from '../../src/state/state-store.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';
import { goalFixture } from '../helpers/workspace-fixtures.js';

describe('janus init --resume', () => {
  it('rebuilds an identical workspace from the state branch alone', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    expect((await runCli(['init', '--goal', fixture.goalPath, '--workspace', first])).code).toBe(ExitCode.Ok);

    // Simulate progress: ui-kit has a goal branch with one commit, recorded in state and checkpointed.
    const goalBranch = `ai/${fixture.goalId}`;
    const uiKitDir = join(first, 'repos', 'ui-kit');
    await checkoutBranch(uiKitDir, goalBranch, 'HEAD');
    writeFileSync(join(uiKitDir, 'upgrade.txt'), 'angular 16\n');
    const head = await commitAll(uiKitDir, 'feat(ui-kit): upgrade');
    await push(uiKitDir, 'origin', goalBranch, { setUpstream: true });
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    const uiKit = state.repos['ui-kit'];
    if (!uiKit) throw new Error('state has no ui-kit');
    uiKit.head_commit = head;
    state.goal.status = 'executing';
    const { goal } = loadGoal(join(janusDir, 'goal.yaml'));
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): progress', push: true });

    const second = join(tempDir(), 'ws2');
    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', second]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(`workspace: ${second}`);

    expect(readFileSync(join(second, '.janus', 'state.yaml'), 'utf8')).toBe(readFileSync(join(janusDir, 'state.yaml'), 'utf8'));
    expect(readFileSync(join(second, '.janus', 'goal.yaml'), 'utf8')).toBe(fixture.goalText);
    expect(await revParse(join(second, 'repos', 'ui-kit'), 'HEAD')).toBe(head);
    expect(await currentBranch(join(second, 'repos', 'ui-kit'))).toBe(goalBranch);
    expect(await revParse(join(second, 'repos', 'shell'), 'HEAD')).toBe(fixture.shell.head);
    expect(await currentBranch(join(second, 'repos', 'shell'))).toBe('main');
    expect(existsSync(join(second, 'janus.lock'))).toBe(false);
  });

  it('warns when a goal branch moved past the recorded head', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    await runCli(['init', '--goal', fixture.goalPath, '--workspace', first]);
    const goalBranch = `ai/${fixture.goalId}`;
    const uiKitDir = join(first, 'repos', 'ui-kit');
    await checkoutBranch(uiKitDir, goalBranch, 'HEAD');
    const recorded = await commitAll(uiKitDir, 'feat(ui-kit): one', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch, { setUpstream: true });
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    const uiKit = state.repos['ui-kit'];
    if (!uiKit) throw new Error('state has no ui-kit');
    uiKit.head_commit = recorded;
    const { goal } = loadGoal(join(janusDir, 'goal.yaml'));
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): progress', push: true });
    await commitAll(uiKitDir, 'feat(ui-kit): two', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch);

    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', join(tempDir(), 'ws2')]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('ui-kit: goal branch head');
    expect(result.stderr).toContain('differs from recorded');
  });

  it('requires the goal id', async () => {
    const fixture = await goalFixture();
    const result = await runCli(['init', '--resume', fixture.stateBare]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('init --resume requires the goal id');
  });
});
```

In `tests/cli/commands.test.ts`, delete the line `['init', '--resume', 'ssh://git/state.git', 'angular-15-to-16'],` from the `stubbed` table (init now has its own tests).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test tests/cli/init-resume.test.ts`
Expected: FAIL, the first two cases exit 3 (`init --resume is not implemented yet`), the third exits 3 instead of 2.

- [ ] **Step 3: Write resumeWorkspace**

`src/workspace/resume-workspace.ts`:
```ts
import { join } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { ConfigError } from '../config/errors.js';
import type { Goal, GoalRepo } from '../config/goal-schema.js';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import { checkoutBranch, clone, fetch, revParse } from '../git/ops.js';
import { CONFIG_FILE, GOAL_FILE } from '../state/files.js';
import type { JanusState } from '../state/state-schema.js';
import { readState } from '../state/state-store.js';
import { createWorkspaceDirs, ensureEmptyOrMissing, workspacePaths } from './layout.js';
import type { WorkspacePaths } from './layout.js';
import { acquireLock, releaseLock } from './lock.js';
import type { LockInfo } from './lock.js';
import { repoCloneUrl, stateBranchName } from './remotes.js';
import { openStateRepo } from './state-branch.js';

export interface ResumeWorkspaceInput {
  stateRemoteUrl: string;
  goalId: string;
  workspaceRoot: string;
  log: (line: string) => void;
}

export interface ResumeWorkspaceResult {
  paths: WorkspacePaths;
  state: JanusState;
  goal: Goal;
  config: JanusConfig;
  stateCommit: string;
  warnings: string[];
  reclaimedLock: LockInfo | null;
}

/** `janus init --resume`: rebuild a workspace from committed state only (spec §7 rule 5). Drift is reported, not fixed; `janus run` reconciles. */
export async function resumeWorkspace(input: ResumeWorkspaceInput): Promise<ResumeWorkspaceResult> {
  const paths = workspacePaths(input.workspaceRoot);
  ensureEmptyOrMissing(paths.root);
  createWorkspaceDirs(paths);
  const { reclaimed } = acquireLock(paths.lockFile);
  try {
    const branch = stateBranchName(input.goalId);
    input.log(`cloning state branch ${branch} from ${input.stateRemoteUrl}`);
    const stateCommit = await openStateRepo({ janusDir: paths.janusDir, branch, remoteUrl: input.stateRemoteUrl });
    const state = readState(paths.janusDir);
    if (state.goal.id !== input.goalId) {
      throw new ConfigError(paths.janusDir, [`state branch holds goal "${state.goal.id}", not "${input.goalId}"`]);
    }
    const { goal, repoOrder } = loadGoal(join(paths.janusDir, GOAL_FILE));
    const config = loadConfig(join(paths.janusDir, CONFIG_FILE));
    const reposByName = new Map<string, GoalRepo>(goal.repos.map((repo) => [repo.name, repo]));
    const warnings: string[] = [];

    for (const name of repoOrder) {
      const repo = reposByName.get(name);
      const repoState = state.repos[name];
      if (!repo || !repoState) continue;
      const url = repoCloneUrl(repo, config);
      const dir = paths.repoDir(name);
      input.log(`cloning ${name} (${repo.base_branch}) from ${url}`);
      await clone(url, dir, { branch: repo.base_branch });
      if (repoState.head_commit !== null) {
        await fetch(dir, 'origin', repoState.goal_branch);
        await checkoutBranch(dir, repoState.goal_branch, 'FETCH_HEAD');
        const head = await revParse(dir, 'HEAD');
        if (head !== repoState.head_commit) {
          warnings.push(
            `${name}: goal branch head ${head.slice(0, 7)} differs from recorded ${repoState.head_commit.slice(0, 7)}; janus run will reconcile`,
          );
        }
      }
    }
    return { paths, state, goal, config, stateCommit, warnings, reclaimedLock: reclaimed };
  } finally {
    releaseLock(paths.lockFile);
  }
}
```

- [ ] **Step 4: Wire `--resume` into init**

In `src/cli/commands/init.ts`: add `import { resumeWorkspace } from '../../workspace/resume-workspace.js';`, remove the `notImplemented` import, and replace the `--resume` branch at the top of `runInit` with:
```ts
  if (options.resume !== undefined) {
    if (goalId === undefined) {
      ctx.io.stderr('janus: init --resume requires the goal id, for example: janus init --resume <state-remote> angular-15-to-16\n');
      return ExitCode.UsageError;
    }
    const result = await resumeWorkspace({
      stateRemoteUrl: options.resume,
      goalId,
      workspaceRoot: resolve(ctx.io.cwd, options.workspace ?? goalId),
      log: (line) => ctx.io.stdout(`${line}\n`),
    });
    if (result.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${result.reclaimedLock.pid}\n`);
    }
    for (const warning of result.warnings) {
      ctx.io.stderr(`janus: warning: ${warning}\n`);
    }
    ctx.io.stdout(`goal ${result.goal.id}: status ${result.state.goal.status}\n`);
    ctx.io.stdout(`workspace: ${result.paths.root}\n`);
    ctx.io.stdout(`state branch: ${result.state.state_branch.name} at ${result.stateCommit.slice(0, 7)}\n`);
    return ExitCode.Ok;
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS, all files, including the trimmed `commands.test.ts` table.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `pnpm lint && pnpm typecheck && pnpm build`
```bash
git add src/workspace/resume-workspace.ts src/cli/commands/init.ts tests/cli/init-resume.test.ts tests/cli/commands.test.ts
git commit -m "feat(cli): rebuild a workspace from the state branch with janus init --resume"
```

---

### Task 12: README and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the status and add a workspace section**

Replace the `## Status` paragraph in `README.md` with:
```markdown
## Status

Early scaffold. The CLI exists with every command from spec §8; most report "not implemented" and name the task that delivers them. `janus init --goal goal.yaml` creates a goal workspace, and `janus init --resume <state-remote> <goal-id>` rebuilds one from the state branch alone.

## Workspace

`janus init --goal goal.yaml [--config config.yaml] [--workspace DIR]` clones every repository listed in the goal at its base branch, creates the `janus/<goal-id>` state branch as a plain clone under `.janus/`, and makes the first checkpoint (state, handover, decisions, telemetry) on it. The state branch is pushed to `state.clone_url` (or `state.repo`) when configured, otherwise to the first repository of the goal.

```text
<workspace>/
  .janus/          state branch checkout: goal.yaml, config.yaml, state.yaml, handover.md, decisions.md, telemetry/
  repos/<name>/    one clone per repository
  fake/            persisted fake provider state (fake providers only)
  .pnpm-store/     workspace-local pnpm store handed to agents
  janus.lock       present only while a janus process runs
```

Repositories are cloned from `clone_url` in `goal.yaml` when present, otherwise from `bitbucket.clone_url_template` rendered with `bitbucket.url`.
```

- [ ] **Step 2: Run everything the CI workflow runs**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build && node bin/janus.js init --help`
Expected: all green; help shows `--goal`, `--config`, `--workspace`, `--resume`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): describe workspace creation and resume"
```

---

## Self-Review

**Spec coverage for T02 (tasks.md):**
- `state.yaml` schema v2 per §6 with `execution.work_packages.<id>`, per-repo `merged`, `release`, `review_loop`: Task 5.
- Workspace layout per §5 (`.janus/` single-branch clone, `repos/<name>`, `fake/`, `.pnpm-store/`, `janus.lock` with PID): Tasks 4, 9, 10. The `.npmrc` wording is replaced by an env-var ruling recorded in Global Constraints and applied to the spec in Task 8.
- Git module (clone, fetch, branch from commit, merge without rebase, commit, fast-forward-only push, diff collection including untracked, reset, patch export, reflog): Tasks 2 and 3. Patch export is `workingTreeDiff().patch` written by callers; no separate function is needed.
- Checkpoint (stage state, minimal handover, evidence, decisions; commit; optional push): Task 9. Evidence files are simply files under `.janus/` that `commitAll` picks up.
- `janus init --goal` and `janus init --resume`: Tasks 10 and 11.
- `decisions.md` and `telemetry/events.jsonl` append helpers: Task 6.
- Done-when: the round trip in Task 11 builds a workspace from temp repos, checkpoints, and rebuilds an identical workspace elsewhere; stale-lock reclaim is covered in Task 4 and surfaced on stderr in Tasks 10 and 11.
- Deferred from the T01 final review and folded in here: `init --resume` enforces the goal id (Task 11); `WorkspaceLockedError` maps to exit 13 (Task 10). Still deferred: version constant from package.json, `suite_repo_map` validation, `@types/node` alignment.

**Placeholder scan:** none.

**Type consistency:** `WorkspacePaths` (Task 4) is used by Tasks 10 and 11; `LockInfo`/`acquireLock` (Task 4) by Tasks 10 and 11; `StateRemote`/`stateRemote`/`repoCloneUrl`/`stateBranchName` (Task 8) by Tasks 10 and 11; `initStateRepo`/`openStateRepo` (Task 9) by Tasks 10 and 11; `checkpoint` (Task 9) by Tasks 10 and 11's test; `createInitialState`/`JanusState` (Task 5) by Tasks 6, 7, 9, 10; `readState`/`writeState` (Task 6) by Tasks 9, 10, 11; `GOAL_FILE`/`CONFIG_FILE`/`DECISIONS_FILE`/`HANDOVER_FILE` (Task 6) by Tasks 9, 10, 11; `renderHandover` (Task 7) by Task 9; git functions (Tasks 2, 3) by Tasks 9, 10, 11 and their tests; `goalFixture` (Task 10) by Task 11.

**Known wording dependencies:** the `up_to_date` merge detection matches both `Already up to date.` and the older hyphenated form; `PushRejectedError` detection matches `rejected`, `non-fast-forward`, or `fetch first` in git's stderr. If a git version words these differently, widen the regex and note it in the report.
