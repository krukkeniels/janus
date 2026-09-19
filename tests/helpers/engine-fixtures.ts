import { join } from 'node:path';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createEngine } from '../../src/engine/engine.js';
import type { Engine } from '../../src/engine/engine.js';
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
