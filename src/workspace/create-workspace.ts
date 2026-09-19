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
