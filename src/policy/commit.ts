import type { Engine } from '../engine/engine.js';
import { commitAll, push as gitPush } from '../git/ops.js';

export interface CommitMessageInput {
  /** The conventional-commit type: `feat` for an implementation commit, `fix` for a debug or review-fix commit. */
  type: string;
  /** The repository name, used as the conventional-commit scope. */
  repo: string;
  subject: string;
  workPackageId: string;
  goalId: string;
  /** The agent run whose work this commit carries, or null. */
  runId: string | null;
  /** `.janus`-relative path of the report that cleared this diff. */
  policyEvidence: string;
}

/** Header plus ": " plus "..." must still fit: a git subject line over 72 characters is a review annoyance. */
const MAX_HEADER = 72;

/**
 * Spec §14 step 3: "commits with a conventional message referencing package and run id".
 *
 * `type(scope): subject` with the repository as the scope — the same convention this project's own history uses —
 * and four trailers. §14 asks only for the package and the run id; the goal id is there because a state branch
 * outlives a workspace and `git log` on the product repo is often the only artifact a reviewer has, and the
 * policy-evidence path is there because §31.25 wants the evidence for a commit to be findable *from* the commit.
 *
 * These trailers are Janus's, for Janus's commits in a product repository. They are unrelated to the
 * `Co-Authored-By` / `Claude-Session` trailers this project's own commits carry.
 */
export function buildCommitMessage(input: CommitMessageInput): string {
  const collapsed = input.subject.replace(/\s+/gu, ' ').trim().replace(/\.$/u, '');
  const fallback = `apply work package ${input.workPackageId}`;
  const prefix = `${input.type}(${input.repo}): `;
  const room = MAX_HEADER - prefix.length;
  const chosen = collapsed === '' ? fallback : collapsed;
  const subject = chosen.length <= room ? chosen : `${chosen.slice(0, Math.max(room - 3, 0))}...`;
  return [
    `${prefix}${subject}`,
    '',
    `Work-Package: ${input.workPackageId}`,
    `Run-Id: ${input.runId ?? 'none'}`,
    `Goal: ${input.goalId}`,
    `Janus-Policy: ${input.policyEvidence}`,
  ].join('\n');
}

export interface CommitAndPushInput {
  engine: Engine;
  /** The repository work tree. */
  repoDir: string;
  repo: string;
  /** The goal branch, from `state.repos.<repo>.goal_branch`. */
  branch: string;
  /** The git remote name; `origin` everywhere in a Janus workspace. */
  remote?: string;
  message: string;
  workPackageId: string;
  /** For the `commit.created` event; the report already has the file list. */
  changedFiles: number;
  /** Default true. False only for a test or a caller that pushes later. */
  push?: boolean;
}

export interface CommitAndPushResult {
  commit: string;
  pushed: boolean;
}

/**
 * Spec §14 step 3 and §32 rule 11: the orchestrator — never an agent — stages every change, commits, and pushes.
 *
 * `commitAll` runs `git add -A`: it stages the **entire working tree** at `repoDir`, with no structural link to
 * the file set the policy report analysed. The caller is therefore required to invoke this immediately after the
 * policy check clears, with no intervening writes to `repoDir` — anything written into the work tree between the
 * check and this call is committed too. (Task 10 owns that sequencing; this function does not and should not
 * re-verify it — a check that aborts after the commit is already made is worse than the gap it would close.)
 *
 * The push is `git push` with no `--force` (see `src/git/ops.ts`), so git itself refuses a non-fast-forward and
 * `PushRejectedError` propagates to the caller. That is §16.6's base-branch-sync situation and is deliberately
 * **not** handled here: the commit exists and must not be thrown away, so the decision belongs to the stage step.
 */
export async function commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult> {
  const remote = input.remote ?? 'origin';
  const commit = await commitAll(input.repoDir, input.message);
  const subject = input.message.split('\n')[0] ?? '';
  input.engine.emit({
    type: 'commit.created',
    repo: input.repo,
    work_package: input.workPackageId,
    branch: input.branch,
    sha: commit,
    subject,
    changed_files: input.changedFiles,
  });
  if (input.push === false) return { commit, pushed: false };
  await gitPush(input.repoDir, remote, input.branch, { setUpstream: true });
  input.engine.emit({ type: 'push.completed', repo: input.repo, remote, branch: input.branch, sha: commit });
  return { commit, pushed: true };
}
