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
