import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerDoctor(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check codex, git, tokens, sandbox, and provider reachability')
    .option('--json', 'machine-readable output')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'doctor', 'T07');
    });
}
