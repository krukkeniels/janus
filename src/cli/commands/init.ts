import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { loadConfig } from '../../config/load-config.js';
import { loadGoal } from '../../config/load-goal.js';
import { createWorkspace } from '../../workspace/create-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';
import { notImplemented } from '../not-implemented.js';

interface InitOptions {
  goal?: string;
  config?: string;
  workspace?: string;
  resume?: string;
}

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('Create a goal workspace from a goal file, or rebuild one from a state branch')
    .argument('[goal-id]', 'goal id, used with --resume')
    .option('--goal <file>', 'path to goal.yaml')
    .option('--config <file>', 'path to config.yaml (default: config.yaml next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action(async (goalId: string | undefined, options: InitOptions) => {
      ctx.exitCode = await runInit(ctx, goalId, options);
    });
}

async function runInit(ctx: CliContext, goalId: string | undefined, options: InitOptions): Promise<ExitCode> {
  if (options.resume !== undefined) {
    void goalId;
    return notImplemented(ctx, 'init --resume', 'T02');
  }
  if (options.goal === undefined) {
    ctx.io.stderr('janus: either --goal <file> or --resume <state-remote> is required\n');
    return ExitCode.UsageError;
  }
  const goalPath = resolve(ctx.io.cwd, options.goal);
  const configPath = options.config !== undefined ? resolve(ctx.io.cwd, options.config) : join(dirname(goalPath), 'config.yaml');
  const { goal, repoOrder } = loadGoal(goalPath);
  if (options.config === undefined && !existsSync(configPath)) {
    throw new ConfigError(configPath, ['config.yaml not found next to the goal file; pass --config <file>']);
  }
  const config = loadConfig(configPath);
  ctx.io.stdout(
    `goal ${goal.id}: Angular ${goal.source_version} -> ${goal.target_version}, ${goal.repos.length} repos\n`,
  );
  ctx.io.stdout(`repo order: ${repoOrder.join(', ')}\n`);
  const result = await createWorkspace({
    goal,
    repoOrder,
    config,
    goalFileText: readFileSync(goalPath, 'utf8'),
    configFileText: readFileSync(configPath, 'utf8'),
    workspaceRoot: resolve(ctx.io.cwd, options.workspace ?? goal.id),
    log: (line) => ctx.io.stdout(`${line}\n`),
  });
  if (result.reclaimedLock !== null) {
    ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${result.reclaimedLock.pid}\n`);
  }
  ctx.io.stdout(`workspace: ${result.paths.root}\n`);
  ctx.io.stdout(`state branch: ${result.state.state_branch.name} -> ${result.stateRemote.url}\n`);
  ctx.io.stdout(`checkpoint: ${result.stateCommit.slice(0, 7)}\n`);
  return ExitCode.Ok;
}
