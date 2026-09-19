import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { ConfigError } from '../config/errors.js';
import type { Goal } from '../config/goal-schema.js';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import { currentBranch } from '../git/ops.js';
import { runGit } from '../git/run.js';
import { CONFIG_FILE, GOAL_FILE, STATE_FILE } from '../state/files.js';
import type { JanusState } from '../state/state-schema.js';
import { readState } from '../state/state-store.js';
import { workspacePaths } from './layout.js';
import type { WorkspacePaths } from './layout.js';
import { acquireLock, releaseLock } from './lock.js';
import type { LockInfo } from './lock.js';
import { stateBranchName, stateRemote } from './remotes.js';

/** An opened, locked goal workspace. `state` is the live runtime state: mutate it and checkpoint; never re-read it while open. */
export interface Workspace {
  paths: WorkspacePaths;
  state: JanusState;
  goal: Goal;
  repoOrder: string[];
  config: JanusConfig;
  /** Clone URL that `.janus/`'s `origin` points at. */
  stateRemoteUrl: string;
  reclaimedLock: LockInfo | null;
  /** Releases the lock. Safe to call more than once. */
  release(): void;
}

export function isWorkspaceRoot(dir: string): boolean {
  return existsSync(join(dir, '.janus', STATE_FILE));
}

/** The nearest directory at or above `cwd` that holds `.janus/state.yaml`. */
export function findWorkspaceRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError(cwd, ['not inside a janus workspace (no .janus/state.yaml here or in any parent directory)']);
    }
    dir = parent;
  }
}

export interface OpenWorkspaceOptions {
  now?: Date;
}

/**
 * Locks the workspace and loads everything a command needs, verifying that `.janus/` is the state branch checkout
 * of this goal and that its `origin` is the configured state remote. The caller must `release()`.
 */
export async function openWorkspace(root: string, options: OpenWorkspaceOptions = {}): Promise<Workspace> {
  const paths = workspacePaths(root);
  if (!isWorkspaceRoot(paths.root)) {
    throw new ConfigError(paths.root, ['not a janus workspace: .janus/state.yaml not found']);
  }
  const { reclaimed } = acquireLock(paths.lockFile, options.now ?? new Date());
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseLock(paths.lockFile);
  };
  try {
    const state = readState(paths.janusDir);
    const { goal, repoOrder } = loadGoal(join(paths.janusDir, GOAL_FILE));
    const config = loadConfig(join(paths.janusDir, CONFIG_FILE));
    const issues: string[] = [];
    const expectedBranch = stateBranchName(state.goal.id);
    if (goal.id !== state.goal.id) issues.push(`goal.yaml id ${goal.id} does not match state goal id ${state.goal.id}`);
    if (state.state_branch.name !== expectedBranch) {
      issues.push(`state_branch.name is ${state.state_branch.name}, expected ${expectedBranch}`);
    }
    const branch = await currentBranch(paths.janusDir);
    if (branch !== expectedBranch) issues.push(`.janus is on branch ${branch ?? '(detached HEAD)'}, expected ${expectedBranch}`);
    const originUrl = await runGit(paths.janusDir, ['remote', 'get-url', 'origin']);
    const remote = stateRemote(goal, config);
    if (originUrl !== remote.url) issues.push(`.janus origin is ${originUrl}, expected the state remote ${remote.url}`);
    if (state.state_branch.remote !== remote.remoteName) {
      issues.push(`state_branch.remote is ${state.state_branch.remote}, expected ${remote.remoteName}`);
    }
    if (issues.length > 0) throw new ConfigError(paths.janusDir, issues);
    return { paths, state, goal, repoOrder, config, stateRemoteUrl: originUrl, reclaimedLock: reclaimed, release };
  } catch (error) {
    release();
    throw error;
  }
}
