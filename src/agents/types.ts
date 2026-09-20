import type { AgentRole, Effort } from '../config/config-schema.js';
import type { AgentTokenUsage } from '../telemetry/events.js';
import type { ContextPackage } from './context.js';
import type { JsonSchema } from './json-schema.js';
import type { AgentResult } from './output-schema.js';
import type { SandboxClass } from './roles.js';

export type { AgentTokenUsage };
export type { AgentResult };

/** Spec §18.6: the model and effort this attempt resolved to, and where in the role's ladder it came from. */
export interface ResolvedModel {
  model: string;
  effort: Effort;
  /** Index into the role's ladder, or null when the role has no ladder. */
  ladderIndex: number | null;
  ladderLength: number | null;
}

/** Why the adapter could not hand back a validated §18.3 result. */
export type AgentFailureKind = 'timeout' | 'nonzero_exit' | 'invalid_output' | 'spawn_failed';

export interface AgentRunFailure {
  kind: AgentFailureKind;
  /**
   * Spec §18.3: "Invalid output is one failed attempt; the validation error is included in the retry context."
   * This string is what the caller puts into the next attempt's PREVIOUS ATTEMPTS section.
   */
  detail: string;
}

/**
 * Spec §18.1 task contract. Built by `buildAgentTask` (Task 8) and handed to `AgentRunner.run`.
 *
 * Field names are camelCase because this is an in-memory value Janus constructs; each one names its §18.1 field
 * where the spelling differs. `model`, `attempt` and `promptVersion` are not in §18.1's list: §18.4 passes the
 * model and effort as `codex exec` arguments and §18.6 requires the resolved model, the attempt and the prompt
 * version stamped on every evidence file and event, so they travel with the task rather than forcing every runner
 * to re-read the config.
 */
export interface AgentTask {
  /** §18.1 `run_id`. Also the basename of `evidence/agents/<run-id>.yaml` and of `reports/<run-id>/`. */
  runId: string;
  role: AgentRole;
  /** §18.1 `class`. */
  sandboxClass: SandboxClass;
  /** §18.1 `repo`: the repository this run is assigned to, or null for workspace-level roles. */
  repo: string | null;
  /** §18.1 `cwd`: absolute. */
  cwd: string;
  /** §18.1 `writable_roots`: absolute paths passed as `--add-dir`. Empty for the read-only class. */
  writableRoots: string[];
  /** §18.1 `network`: `sandbox_workspace_write.network_access`. */
  network: boolean;
  /** §18.1 `timeout_minutes`: `agents.roles.<role>.timeout_minutes`, capped by `max_agent_runtime_minutes`. */
  timeoutMinutes: number;
  /** §18.1 `context`. */
  context: ContextPackage;
  /** §18.1 `output_schema`: generated from the role's zod schema (§14). */
  outputSchema: JsonSchema;
  /** §18.6: the resolved model for this attempt. */
  model: ResolvedModel;
  /** 1-based attempt within the current failure. Attempt 1 uses ladder entry 0. */
  attempt: number;
  /** §18.6: the version of the role's prompt template, stamped on evidence and events. */
  promptVersion: string;
  /** §18.6: the active model profile name (`--model-profile` or `workflow_models.profile`). */
  profile: string;
  /** §18.6: `experiment.id` from `config.yaml`, or null. */
  experimentId: string | null;
  /** The `-s` value §18.4 passes; derived from the class, or `danger-full-access` when `allow_unsandboxed`. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Environment additions for the child process (for example `npm_config_store_dir`). Never holds a secret. */
  env: Record<string, string>;
  /** The keys of `env`, for the evidence file (spec §5, §32 rule 12): record which keys were set, never their values. */
  envKeys: string[];
}

/**
 * What one agent run answers.
 *
 * Replaces T04's `AgentRunOutcome`. `runId`, `status` and `summary` keep their T04 meanings so existing readers
 * are unaffected; everything else is new. Telemetry and the evidence file are **not** written here — `runAgent`
 * (Task 9) does that for every runner, so the Codex adapter and the fake do not each reimplement it.
 */
export interface AgentOutcome {
  runId: string;
  /** §18.3 `status`. `failed` when `failure` is set, because an unusable answer is one failed attempt. */
  status: AgentResult['status'];
  /** `result.summary` when there is a result, otherwise a rendering of `failure`. */
  summary: string;
  /** The validated §18.3 result, or null when the run produced none. */
  result: AgentResult | null;
  failure: AgentRunFailure | null;
  tokens: AgentTokenUsage | null;
  durationMs: number;
  /** Process exit code; null for a signal, a spawn failure, or the fake runner. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** `codex --version` for the Codex adapter; null for the fake runner. */
  runnerVersion: string | null;
}

export function outcomeSummary(result: AgentResult | null, failure: AgentRunFailure | null): string {
  if (result !== null) return result.summary;
  if (failure !== null) return `agent run failed (${failure.kind}): ${failure.detail}`;
  return 'agent run produced no result and reported no failure';
}
