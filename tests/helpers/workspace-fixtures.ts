import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { GoalRepo } from '../../src/config/goal-schema.js';
import { runGit } from '../../src/git/run.js';
import { createBareRepo, createRemoteWithCommit, tempDir } from './git-fixtures.js';
import type { RemoteFixture } from './git-fixtures.js';

/** One node of the `depends_on` graph a fixture builds (spec §4). */
export interface RepoGraphSpec {
  name: string;
  /** Defaults to `library`. */
  kind?: GoalRepo['kind'];
  depends_on?: never;
  dependsOn?: string[];
  coupledWith?: string[];
  loadsRemotes?: string[];
}

export interface GraphFixtureE2e {
  build_type_id: string;
  branch_params: Record<string, string>;
}

export interface GraphFixtureOptions {
  goalId?: string;
  /** Overrides the derived `e2e` block. */
  e2e?: GraphFixtureE2e;
}

export interface GraphFixture {
  dir: string;
  goalId: string;
  goalPath: string;
  configPath: string;
  goalText: string;
  stateBare: string;
  /** Repo name -> its bare remote and the working clone it was built from. */
  repos: Record<string, RemoteFixture>;
  /** Declaration order; `loadGoal` computes the topological order. */
  names: string[];
  /** Every mkdtemp root this fixture created, so a caller can remove them all. */
  tempRoots: string[];
}

/** `ui-kit` -> `UiKit`, for the TeamCity-style build type ids. */
function pascalCase(name: string): string {
  return name
    .split('-')
    .map((part) => (part === '' ? '' : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');
}

/** `env.<NAME>_BRANCH` for every deployable repo, matching the §4 goal example. */
function deriveE2e(specs: readonly RepoGraphSpec[]): GraphFixtureE2e {
  const branchParams: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.kind === 'shell' || spec.kind === 'app') {
      branchParams[spec.name] = `env.${spec.name.replace(/-/g, '_').toUpperCase()}_BRANCH`;
    }
  }
  return { build_type_id: 'Fe_E2E_Full', branch_params: branchParams };
}

/**
 * N working repos with one commit each and a bare clone as their remote, a bare state remote, and the
 * `goal.yaml` / `config.yaml` pair that points at them with fake providers. `depends_on`, `coupled_with`, and
 * `loads_remotes` are written verbatim and omitted when empty, so the file stays the shape §4 describes and the
 * existing `loadGoal` / `validateGoal` accept unchanged. Bare repos get `core.logAllRefUpdates` (off by default
 * in a bare repo) so a push into them is witnessed by the §31.29 reflog audit.
 */
export async function graphFixture(specs: RepoGraphSpec[], options: GraphFixtureOptions = {}): Promise<GraphFixture> {
  const goalId = options.goalId ?? 'angular-15-to-16';
  const dir = tempDir('janus-goal-');
  const tempRoots = [dir];
  const repos: Record<string, RemoteFixture> = {};

  for (const spec of specs) {
    const remote = await createRemoteWithCommit(spec.name);
    await runGit(remote.bare, ['config', 'core.logAllRefUpdates', 'true']);
    repos[spec.name] = remote;
    tempRoots.push(dirname(remote.bare));
  }
  const stateBare = await createBareRepo('janus-state', `janus/${goalId}`);
  await runGit(stateBare, ['config', 'core.logAllRefUpdates', 'true']);
  tempRoots.push(dirname(stateBare));

  const goalRepos = specs.map((spec) => {
    const remote = repos[spec.name];
    if (remote === undefined) throw new Error(`graphFixture: no remote was created for ${spec.name}`);
    const dependsOn = spec.dependsOn ?? [];
    const coupledWith = spec.coupledWith ?? [];
    const loadsRemotes = spec.loadsRemotes ?? [];
    return {
      name: spec.name,
      kind: spec.kind ?? 'library',
      scm: { project: 'FE', slug: spec.name },
      base_branch: 'main',
      clone_url: remote.bare,
      ci: { pr_build_type_id: `Fe_${pascalCase(spec.name)}_Build` },
      ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
      ...(coupledWith.length === 0 ? {} : { coupled_with: coupledWith }),
      ...(loadsRemotes.length === 0 ? {} : { loads_remotes: loadsRemotes }),
    };
  });

  const goal = {
    id: goalId,
    source_version: '15',
    target_version: '16',
    title: 'Upgrade Angular 15 to 16',
    repos: goalRepos,
    e2e: options.e2e ?? deriveE2e(specs),
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
  return { dir, goalId, goalPath, configPath, goalText, stateBare, repos, names: specs.map((spec) => spec.name), tempRoots };
}

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

const DEFAULT_SPECS: RepoGraphSpec[] = [
  { name: 'ui-kit', kind: 'library' },
  { name: 'shell', kind: 'shell', dependsOn: ['ui-kit'] },
];

/** Two bare product remotes with one commit each, a bare state remote, and goal/config files with fake providers. */
export async function goalFixture(): Promise<GoalFixture> {
  const graph = await graphFixture(DEFAULT_SPECS);
  const uiKit = graph.repos['ui-kit'];
  const shell = graph.repos['shell'];
  if (uiKit === undefined || shell === undefined) {
    throw new Error('goalFixture: the graph fixture did not create both ui-kit and shell');
  }
  return {
    dir: graph.dir,
    goalId: graph.goalId,
    goalPath: graph.goalPath,
    configPath: graph.configPath,
    goalText: graph.goalText,
    uiKit,
    shell,
    stateBare: graph.stateBare,
  };
}
