import { join } from 'node:path';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { createEngine } from '../../src/engine/engine.js';
import type { Engine } from '../../src/engine/engine.js';
import { checkoutBranch, commitAll, push } from '../../src/git/ops.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { GOAL_FILE } from '../../src/state/files.js';
import { readState } from '../../src/state/state-store.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { tempDir } from './git-fixtures.js';
import { runCli } from './run-cli.js';
import { goalFixture } from './workspace-fixtures.js';
import type { GoalFixture } from './workspace-fixtures.js';

export interface WorkspaceFixture {
  fixture: GoalFixture;
  root: string;
  janusDir: string;
}

/** A freshly initialized workspace (status `created`) built by `janus init --goal` against temp bare remotes. */
export async function initWorkspace(): Promise<WorkspaceFixture> {
  const fixture = await goalFixture();
  const root = join(tempDir(), 'ws');
  const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', root]);
  if (result.code !== ExitCode.Ok) throw new Error(`janus init failed (${result.code}): ${result.stderr}`);
  return { fixture, root, janusDir: join(root, '.janus') };
}

export interface TestEngine {
  engine: Engine;
  lines: string[];
  warnings: string[];
}

/** An engine that pushes to the fixture's bare state remote and captures log output. */
export function testEngine(workspace: Workspace, now?: () => Date): TestEngine {
  const lines: string[] = [];
  const warnings: string[] = [];
  const engine = createEngine({
    workspace,
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...(now === undefined ? {} : { now }),
  });
  return { engine, lines, warnings };
}

/**
 * Creates the goal branch of `repoName` from its base head with one empty commit, pushes it, records it as
 * `head_commit`, and checkpoints. Call before `openWorkspace`, never while a Workspace is open. Returns the sha.
 */
export async function createGoalBranch(ws: WorkspaceFixture, repoName: string): Promise<string> {
  const dir = join(ws.root, 'repos', repoName);
  const goalBranch = `ai/${ws.fixture.goalId}`;
  await checkoutBranch(dir, goalBranch, 'HEAD');
  const head = await commitAll(dir, `feat(${repoName}): start upgrade`, { allowEmpty: true });
  await push(dir, 'origin', goalBranch, { setUpstream: true });
  const state = readState(ws.janusDir);
  const repoState = state.repos[repoName];
  if (!repoState) throw new Error(`state has no repo ${repoName}`);
  repoState.head_commit = head;
  const { goal } = loadGoal(join(ws.janusDir, GOAL_FILE));
  await checkpoint({ janusDir: ws.janusDir, state, goal, message: `chore(janus): record ${repoName} goal branch`, push: true });
  return head;
}
