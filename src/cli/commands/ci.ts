import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerCi(program: Command, ctx: CliContext): void {
  const ci = program.command('ci').description('Debug helpers for the CI provider');

  ci
    .command('wait')
    .description('Wait for a build to finish')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci wait', 'T09');
    });

  ci
    .command('trigger')
    .description('Trigger the PR build for a repository')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci trigger', 'T09');
    });

  ci
    .command('digest')
    .description('Produce the failure digest for a build')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'ci digest', 'T09');
    });
}
