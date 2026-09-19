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

/** HEAD reflog, newest first. Used later to audit that no agent process ever moved HEAD. */
export async function reflog(cwd: string): Promise<ReflogEntry[]> {
  const output = await runGit(cwd, ['reflog', 'show', '--format=%H%x1f%gd%x1f%gs', 'HEAD']);
  if (output === '') return [];
  return output.split('\n').map((line) => {
    const [sha = '', selector = '', subject = ''] = line.split(FIELD_SEPARATOR);
    return { sha, selector, subject };
  });
}
