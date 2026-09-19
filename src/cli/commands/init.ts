import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerInit(program: Command, ctx: CliContext): void {
  program
    .command('init')
    .description('Create a goal workspace from a goal file, or rebuild one from a state branch')
    .argument('[goal-id]', 'goal id, used with --resume')
    .option('--goal <file>', 'path to goal.yaml')
    .option('--config <file>', 'path to config.yaml (defaults next to the goal file)')
    .option('--workspace <dir>', 'workspace directory to create (default: ./<goal-id>)')
    .option('--resume <state-remote>', 'rebuild a workspace from a state branch remote')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'init', 'T02');
    });
}
