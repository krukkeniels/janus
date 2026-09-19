import type { Command } from 'commander';
import { createEngine } from '../../engine/engine.js';
import { rejectPlan } from '../../engine/gates.js';
import { formatIdentity, gitIdentity } from '../../git/identity.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface RejectOptions {
  reason: string;
}

export function registerReject(program: Command, ctx: CliContext): void {
  const reject = program.command('reject').description('Reject a gate with a reason');

  reject
    .command('plan')
    .description('Reject the current plan and send it back to planning')
    .requiredOption('--reason <text>', 'why the plan is rejected')
    .action(async (options: RejectOptions) => {
      ctx.exitCode = await rejectCommand(ctx, options);
    });
}

async function rejectCommand(ctx: CliContext, options: RejectOptions): Promise<ExitCode> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const approver = await gitIdentity(workspace.paths.janusDir);
    const gate = workspace.state.gate.type;
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await rejectPlan(engine, { reason: options.reason, approver });
    ctx.io.stdout(`gate ${gate ?? 'plan_approval'} rejected by ${formatIdentity(approver)}\n`);
    ctx.io.stdout(`goal ${workspace.state.goal.id}: ${result.to} (checkpoint ${result.checkpoint.commit.slice(0, 7)}); run janus run to continue\n`);
    return ExitCode.Ok;
  } finally {
    workspace.release();
  }
}
