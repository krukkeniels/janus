import { join } from 'node:path';
import { ExitCode } from '../../src/cli/exit-codes.js';
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
