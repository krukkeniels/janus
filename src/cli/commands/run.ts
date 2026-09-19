import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description('Advance the goal until the next gate, wait limit, escalation, or completion')
    .option('--until <stage>', 'stop once this stage is reached')
    .option('--max-wait <duration>', 'longest blocking wait before exiting, for example 45m')
    .option('--dry-run', 'print the next steps without running agents, commits, or CI calls')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'run', 'T03');
    });
}
