import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerReview(program: Command, ctx: CliContext): void {
  const review = program.command('review').description('Human PR review loop helpers');

  review
    .command('sync')
    .description('Fetch new PR activity now')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'review sync', 'T13');
    });
}
