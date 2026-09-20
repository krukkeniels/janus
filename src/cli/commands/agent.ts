import { resolve } from 'node:path';
import type { Command } from 'commander';
import { buildCodexArgs } from '../../agents/codex/adapter.js';
import { renderContextPackage } from '../../agents/render.js';
import { runAgent } from '../../agents/run.js';
import { resolveGlobalPnpmStore } from '../../agents/sandbox.js';
import { buildAgentTask } from '../../agents/task.js';
import { contextInputFrom, loadAgentTaskFile } from '../../agents/task-file.js';
import { AGENT_ROLES } from '../../config/config-schema.js';
import type { AgentRole } from '../../config/config-schema.js';
import { ConfigError } from '../../config/errors.js';
import { createEngine } from '../../engine/engine.js';
import { createProviders } from '../../providers/index.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface AgentRunOptions {
  task: string;
  dryRun?: boolean;
  modelProfile?: string;
}

function parseRole(value: string): AgentRole {
  if (!(AGENT_ROLES as readonly string[]).includes(value)) {
    throw new ConfigError('<role>', [`unknown agent role "${value}"; expected one of ${AGENT_ROLES.join(', ')}`]);
  }
  return value as AgentRole;
}

/** `manual-<compact ISO>`, so a hand-run never collides with an engine run id and is obvious in the evidence directory. */
function manualRunId(now: Date): string {
  return `manual-${now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
}

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('Debug helpers for agent tasks');

  agent
    .command('run')
    .description('Run one agent task by hand')
    .argument('<role>', `agent role, one of ${AGENT_ROLES.join(', ')}`)
    .requiredOption('--task <file>', 'task file describing the context package')
    .option('--dry-run', 'print the rendered prompt and the codex invocation without running anything')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(async (role: string, options: AgentRunOptions) => {
      ctx.exitCode = await agentRunCommand(ctx, role, options);
    });
}

async function agentRunCommand(ctx: CliContext, roleArgument: string, options: AgentRunOptions): Promise<ExitCode> {
  const role = parseRole(roleArgument);
  const file = loadAgentTaskFile(resolve(ctx.io.cwd, options.task));
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    const { config, paths } = workspace;
    const profile = options.modelProfile ?? config.workflow_models.profile;
    if (!(profile in config.model_profiles)) {
      throw new ConfigError('--model-profile', [`model profile "${profile}" is not defined in config.yaml model_profiles`]);
    }
    const now = new Date();
    const task = buildAgentTask({
      runId: manualRunId(now),
      role,
      repo: file.repo,
      attempt: file.attempt,
      paths,
      config,
      profile,
      globalPnpmStore: config.agents.pnpm_store === 'global' ? await resolveGlobalPnpmStore() : null,
      context: contextInputFrom(file),
      guardrails: file.guardrails,
      budget: file.budget,
    });

    if (options.dryRun === true) {
      const rendered = renderContextPackage(task.context, {
        maxContextBytes: config.agents.max_context_bytes,
        maxInlineDiffBytes: config.agents.max_inline_diff_bytes,
      });
      ctx.io.stdout(`${rendered.text}\n`);
      ctx.io.stdout(`\n--- invocation (${rendered.bytes} prompt bytes, ${rendered.truncations.length} truncation(s)) ---\n`);
      const args = buildCodexArgs(task, { schemaPath: '<scratch>/schema.json', lastMessagePath: '<scratch>/last-message.json' });
      ctx.io.stdout(`codex ${args.join(' ')}\n`);
      return ExitCode.Ok;
    }

    const providers = ctx.providers ?? createProviders({ config, paths, now: () => new Date() });
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const record = await runAgent({ engine, runner: providers.agent, task, previousModel: null });
    const { outcome } = record;

    ctx.io.stdout(`run ${task.runId} (${role}${task.repo === null ? '' : ` in ${task.repo}`}, attempt ${task.attempt})\n`);
    ctx.io.stdout(`  status: ${outcome.status}\n`);
    ctx.io.stdout(`  model: ${task.model.model} (effort ${task.model.effort})\n`);
    ctx.io.stdout(`  prompt: ${task.promptVersion}, profile ${task.profile}\n`);
    ctx.io.stdout(`  duration: ${outcome.durationMs} ms, tokens: ${outcome.tokens === null ? 'not reported' : String(outcome.tokens.total)}\n`);
    ctx.io.stdout(`  summary: ${outcome.summary}\n`);
    ctx.io.stdout(`  evidence: ${record.evidencePath}\n`);
    ctx.io.stdout('  (evidence and telemetry are uncommitted; they are committed by the next janus run checkpoint)\n');

    if (outcome.status === 'completed') return ExitCode.Ok;
    ctx.io.stderr(`janus: agent run ${task.runId} ended ${outcome.status}: ${outcome.summary}\n`);
    return ExitCode.UnexpectedError;
  } finally {
    workspace.release();
  }
}
