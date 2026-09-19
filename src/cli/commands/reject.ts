import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerReject(program: Command, ctx: CliContext): void {
  const reject = program.command('reject').description('Reject a gate with a reason');

  reject
    .command('plan')
    .description('Reject the current plan and send it back to planning')
    .requiredOption('--reason <text>', 'why the plan is rejected')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'reject plan', 'T03');
    });
}
