import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerTelemetry(program: Command, ctx: CliContext): void {
  const telemetry = program.command('telemetry').description('Export and compare telemetry');

  telemetry
    .command('export')
    .description('Write the event log with resolved model dimensions')
    .option('--csv', 'CSV instead of JSONL')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'telemetry export', 'T21');
    });

  telemetry
    .command('compare')
    .description('Compare runs per model, role, and prompt version across event logs')
    .argument('<events...>', 'one or more events.jsonl files')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'telemetry compare', 'T21');
    });
}
