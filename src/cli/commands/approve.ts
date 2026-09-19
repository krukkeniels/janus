import type { Command } from 'commander';
import { createEngine } from '../../engine/engine.js';
import { approvePlan } from '../../engine/gates.js';
import { formatIdentity, gitIdentity } from '../../git/identity.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface ApproveOptions {
  commit: string;
  exception?: string[];
}

export function registerApprove(program: Command, ctx: CliContext): void {
  const approve = program.command('approve').description('Pass a human gate');

  approve
    .command('plan')
    .description('Approve the technical plan, baseline, and listed exceptions (Gate 1)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the plan being approved')
    .option('--exception <id...>', 'baseline exception ids to approve')
    .action(async (options: ApproveOptions) => {
      ctx.exitCode = await approveCommand(ctx, 'plan_approval', options);
    });

  approve
    .command('revised-plan')
    .description('Approve a revised plan after an escalation (Gate 2)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the revised plan')
    .action(async (options: ApproveOptions) => {
      ctx.exitCode = await approveCommand(ctx, 'revised_plan_approval', options);
    });
}

async function approveCommand(ctx: CliContext, gate: 'plan_approval' | 'revised_plan_approval', options: ApproveOptions): Promise<ExitCode> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const approver = await gitIdentity(workspace.paths.janusDir);
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await approvePlan(engine, { gate, commit: options.commit, exceptions: options.exception ?? [], approver });
    ctx.io.stdout(`gate ${gate} passed at ${result.commit.slice(0, 7)} by ${formatIdentity(approver)}\n`);
    ctx.io.stdout(
      `goal ${workspace.state.goal.id}: ${workspace.state.goal.status} (checkpoint ${result.checkpoint.commit.slice(0, 7)}); run janus run to continue\n`,
    );
    return ExitCode.Ok;
  } finally {
    workspace.release();
  }
}
