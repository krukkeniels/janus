import type { Command } from 'commander';
import type { CliContext } from '../context.js';
import { notImplemented } from '../not-implemented.js';

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('Debug helpers for agent tasks');

  agent
    .command('run')
    .description('Run one agent task by hand')
    .argument('<role>', 'agent role, for example implementation or debug')
    .requiredOption('--task <file>', 'task file describing the context package')
    .action(() => {
      ctx.exitCode = notImplemented(ctx, 'agent run', 'T05');
    });
}
