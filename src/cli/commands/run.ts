import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { createEngine } from '../../engine/engine.js';
import { describeNextStep, runEngine } from '../../engine/run-loop.js';
import type { RunResult } from '../../engine/run-loop.js';
import { defaultSteps } from '../../engine/steps.js';
import type { Providers } from '../../providers/types.js';
import { GOAL_STATUSES } from '../../state/state-schema.js';
import type { GoalStatus } from '../../state/state-schema.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { parseDuration } from '../duration.js';
import { ExitCode } from '../exit-codes.js';

interface RunCommandOptions {
  until?: string;
  maxWait?: string;
  dryRun?: boolean;
  modelProfile?: string;
}

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description('Advance the goal until the next gate, wait limit, escalation, or completion')
    .option('--until <stage>', 'stop once this stage is reached')
    .option('--max-wait <duration>', 'longest blocking wait before exiting, for example 45m', '45m')
    .option('--dry-run', 'print the next steps without running agents, commits, or CI calls')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(async (options: RunCommandOptions) => {
      ctx.exitCode = await runCommand(ctx, options);
    });
}

function parseUntil(value: string | undefined): GoalStatus | null {
  if (value === undefined) return null;
  const known = GOAL_STATUSES as readonly string[];
  if (!known.includes(value)) {
    throw new ConfigError('--until', [`unknown stage "${value}"; expected one of ${GOAL_STATUSES.join(', ')}`]);
  }
  return value as GoalStatus;
}

function exitCodeForRun(result: RunResult): ExitCode {
  switch (result.reason) {
    case 'completed':
    case 'until':
      return ExitCode.Ok;
    case 'gate':
      return ExitCode.GateWaiting;
    case 'wait_exceeded':
      return ExitCode.WaitExceeded;
    case 'escalated':
      return ExitCode.Escalated;
    case 'not_implemented':
      return ExitCode.NotImplemented;
  }
}

async function runCommand(ctx: CliContext, options: RunCommandOptions): Promise<ExitCode> {
  const until = parseUntil(options.until);
  const maxWaitMs = parseDuration(options.maxWait ?? '45m', '--max-wait');
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const modelProfile = options.modelProfile ?? workspace.config.workflow_models.profile;
    if (!(modelProfile in workspace.config.model_profiles)) {
      throw new ConfigError('--model-profile', [`model profile "${modelProfile}" is not defined in config.yaml model_profiles`]);
    }
    const steps = ctx.steps ?? defaultSteps();
    if (options.dryRun) {
      for (const line of describeNextStep(workspace, steps)) ctx.io.stdout(`${line}\n`);
      return ExitCode.Ok;
    }
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    // T05 replaces this literal with `createProviders(...)`, gated by `workflow.*` in config.yaml; until then
    // `ctx.providers` (the test seam) is the only way to supply anything other than the fakes.
    const providers: Providers = ctx.providers ?? {
      agent: { name: 'fake', run: async (request) => ({ runId: request.runId, status: 'completed', summary: 'unused' }) },
      ci: { name: 'fake', findBuild: async () => null },
      scm: { name: 'fake', currentUser: async () => 'janus-fake', ensureBranch: async () => undefined },
    };
    const result = await runEngine({ engine, steps, until, maxWaitMs, modelProfile, providers });
    ctx.io.stdout(`goal ${workspace.state.goal.id}: ${result.status} (state branch at ${result.stateCommit.slice(0, 7)}, ${result.steps} steps run)\n`);
    if (result.reason === 'not_implemented') {
      ctx.io.stderr(`janus: ${result.message}\n`);
    } else {
      ctx.io.stdout(`${result.message}\n`);
    }
    return exitCodeForRun(result);
  } finally {
    workspace.release();
  }
}
