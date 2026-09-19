import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { ConfigError } from '../config/errors.js';
import type { Goal, GoalRepo } from '../config/goal-schema.js';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import { checkoutBranch, clone, fetch, isAncestor, revParse } from '../git/ops.js';
import { CONFIG_FILE, GOAL_FILE } from '../state/files.js';
import type { JanusState } from '../state/state-schema.js';
import { readState } from '../state/state-store.js';
import { createWorkspaceDirs, ensureEmptyOrMissing, removeWorkspaceArtifacts, workspacePaths } from './layout.js';
import type { WorkspacePaths } from './layout.js';
import { acquireLock, releaseLock, WorkspaceLockedError } from './lock.js';
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
  const rootExisted = existsSync(paths.root);
  ensureEmptyOrMissing(paths.root);
  createWorkspaceDirs(paths);
  let lockHeld = false;
  let reclaimed: LockInfo | null;
  try {
    ({ reclaimed } = acquireLock(paths.lockFile));
    lockHeld = true;
    const branch = stateBranchName(input.goalId);
    input.log(`cloning state branch ${branch} from ${input.stateRemoteUrl}`);
    const stateCommit = await openStateRepo({ janusDir: paths.janusDir, branch, remoteUrl: input.stateRemoteUrl });
    const state = readState(paths.janusDir);
    if (state.goal.id !== input.goalId) {
      throw new ConfigError(paths.janusDir, [`state branch holds goal "${state.goal.id}", not "${input.goalId}"`]);
    }
    if (state.state_branch.name !== branch) {
      throw new ConfigError(paths.janusDir, [`state branch name ${state.state_branch.name} does not match ${branch}`]);
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
        const headCommit = repoState.head_commit;
        const short = headCommit.slice(0, 7);
        if (await isAncestor(dir, headCommit, 'FETCH_HEAD')) {
          await checkoutBranch(dir, repoState.goal_branch, headCommit);
          const fetchHead = await revParse(dir, 'FETCH_HEAD');
          if (fetchHead !== headCommit) {
            warnings.push(`${name}: remote goal branch is ahead of recorded head ${short}; janus run will reconcile`);
          }
        } else {
          await checkoutBranch(dir, repoState.goal_branch, 'FETCH_HEAD');
          warnings.push(
            `${name}: recorded head ${short} is not reachable from the remote goal branch (non-fast-forward drift); janus run will reconcile`,
          );
        }
      }
    }
    return { paths, state, goal, config, stateCommit, warnings, reclaimedLock: reclaimed };
  } catch (error) {
    if (lockHeld) {
      releaseLock(paths.lockFile);
      lockHeld = false;
    }
    if (!(error instanceof WorkspaceLockedError)) {
      removeWorkspaceArtifacts(paths, rootExisted);
    }
    throw error;
  } finally {
    if (lockHeld) releaseLock(paths.lockFile);
  }
}
