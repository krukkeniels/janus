import type { AgentRole, JanusConfig } from '../config/config-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { buildContextPackage } from './context.js';
import type { ContextPackageInput } from './context.js';
import { resolveModel } from './models.js';
import { outputSchemaFor } from './output-schema.js';
import { promptVersionFor } from './prompts/templates.js';
import { sandboxClassFor } from './roles.js';
import { planSandbox } from './sandbox.js';
import type { AgentTask } from './types.js';

export interface BuildAgentTaskInput {
  runId: string;
  role: AgentRole;
  repo: string | null;
  /** 1-based attempt within the current failure; drives the §18.6 ladder. */
  attempt: number;
  paths: WorkspacePaths;
  config: JanusConfig;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  /** `pnpm store path`, needed only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
  /** The variable §18.2 sections. */
  context: ContextPackageInput;
  /** Repo-specific guardrails on top of §19's fixed list. */
  guardrails: string[];
  /** §18.2 BUDGET. */
  budget: string;
}

/**
 * Assembles one §18.1 `AgentTask`. This is the seam T11 and T12 call: a stage step decides *what* the agent
 * should see, this decides *how* the run is shaped — class, sandbox, roots, timeout, model, schema, prompt version.
 *
 * §20: "`max_agent_runtime_minutes` is the ceiling; per-role `timeout_minutes` may only be lower." The config
 * schema already rejects a role timeout above the ceiling, so the `Math.min` here is belt and braces for a config
 * that was hand-edited between load and use.
 */
export function buildAgentTask(input: BuildAgentTaskInput): AgentTask {
  const plan = planSandbox({
    role: input.role,
    runId: input.runId,
    repo: input.repo,
    paths: input.paths,
    config: input.config,
    globalPnpmStore: input.globalPnpmStore,
  });
  const timeoutMinutes = Math.min(
    input.config.agents.roles[input.role].timeout_minutes,
    input.config.guardrails.max_agent_runtime_minutes,
  );
  return {
    runId: input.runId,
    role: input.role,
    sandboxClass: sandboxClassFor(input.role),
    repo: input.repo,
    cwd: plan.cwd,
    writableRoots: plan.writableRoots,
    network: plan.network,
    timeoutMinutes,
    context: buildContextPackage({
      role: input.role,
      context: input.context,
      guardrails: input.guardrails,
      budget: input.budget,
    }),
    outputSchema: outputSchemaFor(input.role),
    model: resolveModel({ config: input.config, profile: input.profile, role: input.role, attempt: input.attempt }),
    attempt: input.attempt,
    promptVersion: promptVersionFor(input.role),
    profile: input.profile,
    experimentId: input.config.experiment.id,
    sandbox: plan.sandbox,
    env: plan.env,
  };
}
