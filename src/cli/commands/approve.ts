import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerApprove(program: Command, ctx: CliContext): void {
  const approve = program.command('approve').description('Pass a human gate');

  approve
    .command('plan')
    .description('Approve the technical plan, baseline, and listed exceptions (Gate 1)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the plan being approved')
    .option('--exception <id...>', 'baseline exception ids to approve')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'approve plan', 'T03');
    });

  approve
    .command('revised-plan')
    .description('Approve a revised plan after an escalation (Gate 2)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the revised plan')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'approve revised-plan', 'T03');
    });
}
