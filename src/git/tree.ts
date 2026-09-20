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

const FIELD_SEPARATOR = '\x1f';

/** Every ref in the repository (branches, tags, remote-tracking), in git's own sorted order. */
export async function listRefs(cwd: string): Promise<string[]> {
  const output = await runGit(cwd, ['for-each-ref', '--format=%(refname)']);
  return output === '' ? [] : output.split('\n');
}

export interface RefSha {
  ref: string;
  /** `%(objectname)`: the object the ref points at directly, so an annotated tag reads as its tag object. */
  sha: string;
}

/**
 * Every ref with the object it points at, in git's own sorted order.
 *
 * The sha is what lets a caller watch a ref that git keeps no reflog for (`refs/tags/*` is never logged unless
 * `core.logAllRefUpdates=always`), by comparing where it points across two observations.
 */
export async function listRefShas(cwd: string): Promise<RefSha[]> {
  const output = await runGit(cwd, ['for-each-ref', '--format=%(refname) %(objectname)']);
  if (output === '') return [];
  return output.split('\n').map((line) => {
    const space = line.indexOf(' ');
    return space === -1 ? { ref: line, sha: '' } : { ref: line.slice(0, space), sha: line.slice(space + 1) };
  });
}

/**
 * True when `ref` has a reflog.
 *
 * `git reflog show <ref>` on a ref without one silently falls back to a plain log of that ref, which would make
 * an audit report commits that were never ref *updates*; callers check this first.
 */
export async function reflogExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ['reflog', 'exists', ref]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

/** Reflog of `ref` (HEAD by default), newest first. Used to audit that no agent process moved a ref (§31.29). */
export async function reflog(cwd: string, ref = 'HEAD'): Promise<ReflogEntry[]> {
  const output = await runGit(cwd, ['reflog', 'show', '--format=%H%x1f%gd%x1f%gs', ref]);
  if (output === '') return [];
  return output.split('\n').map((line) => {
    const [sha = '', selector = '', subject = ''] = line.split(FIELD_SEPARATOR);
    return { sha, selector, subject };
  });
}
