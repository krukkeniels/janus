import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerEscalation(program: Command, ctx: CliContext): void {
  const escalation = program.command('escalation').description('Inspect or resolve an escalation');

  escalation
    .command('show')
    .description('Print the current escalation package')
    .option('--json', 'machine-readable output')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'escalation show', 'T13');
    });

  escalation
    .command('resolve')
    .description('Record human direction and start replanning')
    .requiredOption('--direction <text>', 'the direction the planning agent must follow')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'escalation resolve', 'T13');
    });
}
