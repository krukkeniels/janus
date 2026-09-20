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

/**
 * Diff of the working tree against HEAD, including untracked files (registered as intent-to-add). Ignored files
 * are excluded.
 *
 * `--name-status -z` rather than the newline-and-tab form: with `-z` git emits NUL-separated records and never
 * quotes a path, while the default form C-quotes any path containing a non-ASCII byte
 * (`A\t"\303\246\303\270\303\245.txt"`) and cannot represent a path containing a newline at all. T08's policy
 * checks match these paths against `allowed_scope` and `forbidden_paths` globs (§12, §14, §28), so a quoted path
 * would silently miss every glob it should have hit — and a mis-split record would attribute a rename's old path
 * to the wrong file. T03 deferred this until a consumer arrived; T08 is that consumer.
 */
export async function workingTreeDiff(cwd: string): Promise<WorkingTreeDiff> {
  await runGit(cwd, ['add', '--intent-to-add', '.']);
  const nameStatus = await runGit(cwd, ['diff', 'HEAD', '--name-status', '-z', '-M']);
  const patch = await runGit(cwd, ['diff', 'HEAD', '-M']);
  return { files: parseNameStatusZ(nameStatus), patch };
}

/**
 * The `-z` record grammar: one status record (`A`, `M`, `D`, `T`, or `R<score>` / `C<score>`), then one path
 * record — or two, old then new, when the status is a rename or a copy. The stream ends with a NUL, so splitting
 * on `\0` yields a trailing empty record that is dropped.
 *
 * A copy is recorded as `R`: `ChangeStatus` has no `C` member, `-M` alone never enables copy detection (that is
 * `-C`), and for every policy check "this path came from that path" is the only thing that matters.
 *
 * An unmerged path (`U`) throws defensively. `git diff HEAD --name-status -z` does not emit `U` even during a merge
 * (only a ref-less `git diff --name-status` does), so the guard is not a production safeguard for this module —
 * real conflict detection lives in `merge()`'s `conflictedFiles` (§17.4). But `parseNameStatusZ` may be called by
 * other callers that diff without a ref, so the check protects against that.
 */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const records = output.split('\0').filter((record) => record !== '');
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < records.length) {
    const raw = records[index];
    if (raw === undefined) break;
    const status = raw.charAt(0);
    if (status === 'U') {
      throw new Error(`git diff --name-status -z: unmerged path ${records[index + 1] ?? '(unnamed)'}`);
    }
    if (status === 'R' || status === 'C') {
      const previousPath = records[index + 1];
      const path = records[index + 2];
      if (previousPath === undefined || path === undefined) {
        throw new Error(`git diff --name-status -z: incomplete rename record "${raw}"`);
      }
      files.push({ status: 'R', path, previousPath });
      index += 3;
      continue;
    }
    const path = records[index + 1];
    if (path === undefined) {
      throw new Error(`git diff --name-status -z: status "${raw}" with no path`);
    }
    files.push({ status: status as ChangeStatus, path });
    index += 2;
  }
  return files;
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
