import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerStatus(program: Command, ctx: CliContext): void {
  program
    .command('status')
    .description('Show goal stage, per-repo state, budgets, gate, and merge order')
    .option('--json', 'machine-readable output')
    .option('--telemetry', 'include derived metrics')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'status', 'T14');
    });
}
