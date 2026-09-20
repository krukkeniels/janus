import { mkdirSync } from 'node:fs';
import type { Engine } from '../engine/engine.js';
import type { AgentRunner } from '../providers/types.js';
import { buildAgentEvidence, writeAgentEvidence } from './evidence.js';
import { isModelSwitch } from './models.js';
import type { AgentOutcome, AgentTask, ResolvedModel } from './types.js';

export interface RunAgentInput {
  engine: Engine;
  runner: AgentRunner;
  task: AgentTask;
  /** The model the previous attempt at this same failure used, or null for the first attempt (§18.6). */
  previousModel: ResolvedModel | null;
}

export interface AgentRunRecord {
  outcome: AgentOutcome;
  /** `.janus`-relative path of `evidence/agents/<run-id>.yaml`. */
  evidencePath: string;
}

/**
 * Runs one agent task and records it: `agent.model_switch` when the ladder moved, `agent.started`, the run itself,
 * `evidence/agents/<run-id>.yaml`, then `agent.finished` (spec §18.4, §18.6, §27).
 *
 * Every runner goes through here, so the fake and the Codex adapter leave identical evidence and identical events —
 * which is what makes a harness scenario on the fake evidence for the real one.
 *
 * §7 rule 3: `execution.in_flight.agent_run_id` and `.repo` are set before the run and cleared after it. If the
 * runner throws they stay set on purpose, so the next `janus run` recovers the interrupted agent. The caller sets
 * `in_flight.budget` before calling, because §20 decides per stage which counter an interrupted run charges.
 *
 * Budgets are never touched here. §18.6: "Switching models never adds budget."
 */
export async function runAgent(input: RunAgentInput): Promise<AgentRunRecord> {
  const { engine, task } = input;
  const startedAt = engine.now().toISOString();

  if (isModelSwitch(input.previousModel, task.model) && input.previousModel !== null) {
    engine.emit({
      type: 'agent.model_switch',
      run_id: task.runId,
      role: task.role,
      repo: task.repo,
      attempt: task.attempt,
      from_model: input.previousModel.model,
      from_effort: input.previousModel.effort,
      to_model: task.model.model,
      to_effort: task.model.effort,
      // `AgentModelSwitchEvent.ladder_index` is non-null; the `?? 0` only ever matters for a role with no ladder,
      // and `isModelSwitch` can only fire there on an effort-only change (model is fixed with no ladder), so `0`
      // never claims a ladder step that did not happen.
      ladder_index: task.model.ladderIndex ?? 0,
      profile: task.profile,
      experiment_id: task.experimentId,
      budget_added: false,
    });
  }

  engine.emit({
    type: 'agent.started',
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    model: task.model.model,
    effort: task.model.effort,
    prompt_version: task.promptVersion,
    profile: task.profile,
    experiment_id: task.experimentId,
    attempt: task.attempt,
    sandbox: task.sandbox,
    network: task.network,
  });
  engine.markInFlight({ agent_run_id: task.runId, repo: task.repo });

  // `planSandbox` is I/O-free on purpose (so `--dry-run` and any other planning-only caller never touch the
  // filesystem); for the report-writing class it sets `task.cwd` to `.janus/reports/<run-id>/` without creating
  // it. This is the one place every runner passes through, fake and Codex alike, so the directory is created
  // here, right before the runner is invoked: the Codex adapter spawns with `task.cwd` as the child's cwd, and a
  // cwd that does not exist would fail the spawn.
  if (task.sandboxClass === 'report-writing') {
    mkdirSync(task.cwd, { recursive: true });
  }

  const outcome = await input.runner.run(task);
  const finishedAt = engine.now().toISOString();

  const evidencePath = writeAgentEvidence(
    engine.workspace.paths,
    buildAgentEvidence({ task, paths: engine.workspace.paths, runner: input.runner.name, startedAt, finishedAt, outcome }),
  );

  engine.emit({
    type: 'agent.finished',
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    status: outcome.status,
    model: task.model.model,
    effort: task.model.effort,
    prompt_version: task.promptVersion,
    profile: task.profile,
    experiment_id: task.experimentId,
    tokens: outcome.tokens,
    duration_ms: outcome.durationMs,
    exit_code: outcome.exitCode,
    failure: outcome.failure === null ? null : outcome.failure.kind,
    step: null,
    patch: null,
  });
  engine.markInFlight({ agent_run_id: null, repo: null });

  return { outcome, evidencePath };
}
