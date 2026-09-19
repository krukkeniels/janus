import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { loadConfig } from '../../config/load-config.js';
import { loadGoal } from '../../config/load-goal.js';
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
    .option('--config <file>', 'path to config.yaml (defaults next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action((_goalId: string | undefined, options: InitOptions) => {
      ctx.exitCode = runInit(ctx, options);
    });
}

function runInit(ctx: CliContext, options: InitOptions): ExitCode {
  if (options.resume !== undefined) {
    return notImplemented(ctx, 'init --resume', 'T02');
  }
  if (options.goal === undefined) {
    ctx.io.stderr('janus: either --goal <file> or --resume <state-remote> is required\n');
    return ExitCode.UsageError;
  }
  try {
    const { goal, repoOrder } = loadGoal(options.goal);
    if (options.config !== undefined) {
      loadConfig(options.config);
    }
    ctx.io.stdout(
      `goal ${goal.id}: Angular ${goal.source_version} -> ${goal.target_version}, ${goal.repos.length} repos\n`,
    );
    ctx.io.stdout(`repo order: ${repoOrder.join(', ')}\n`);
  } catch (error) {
    if (error instanceof ConfigError) {
      ctx.io.stderr(`janus: ${error.message}\n`);
      return ExitCode.UsageError;
    }
    throw error;
  }
  return notImplemented(ctx, 'workspace creation', 'T02');
}
