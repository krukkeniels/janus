import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import type { AgentRole } from '../config/config-schema.js';
import { AGENTS_EVIDENCE_DIR } from '../state/files.js';
import type { AgentTokenUsage } from '../telemetry/events.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import type { AgentResult } from './output-schema.js';
import type { SandboxClass } from './roles.js';
import type { AgentOutcome, AgentRunFailure, AgentTask } from './types.js';

/**
 * Spec §5: `evidence/agents/<run-id>.yaml` — "validated result, token usage, duration". §18.6 adds the experiment
 * id, active profile, resolved model, effort, Codex version, and prompt template version.
 *
 * §32 rule 12: no secret ever reaches this file. Paths are workspace-relative so a home directory never lands on
 * the state branch, and the environment is recorded as **key names only** — the values, and `process.env` itself,
 * are never read here.
 */
export interface AgentEvidence {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  class: SandboxClass;
  attempt: number;
  status: AgentResult['status'];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  runner: 'codex' | 'fake';
  runner_version: string | null;
  model: string;
  effort: string;
  ladder_index: number | null;
  ladder_length: number | null;
  profile: string;
  experiment_id: string | null;
  prompt_version: string;
  prompt_bytes: number | null;
  truncations: string[];
  sandbox: AgentTask['sandbox'];
  network: boolean;
  timeout_minutes: number;
  /** Workspace-relative. */
  cwd: string;
  /** Workspace-relative. */
  writable_roots: string[];
  /** Names only. */
  env_keys: string[];
  tokens: AgentTokenUsage | null;
  failure: AgentRunFailure | null;
  result: AgentResult | null;
}

export interface BuildAgentEvidenceInput {
  task: AgentTask;
  paths: WorkspacePaths;
  runner: 'codex' | 'fake';
  startedAt: string;
  finishedAt: string;
  outcome: AgentOutcome;
}

export function buildAgentEvidence(input: BuildAgentEvidenceInput): AgentEvidence {
  const { task, outcome } = input;
  const rel = (path: string): string => relative(input.paths.root, path);
  return {
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    class: task.sandboxClass,
    attempt: task.attempt,
    status: outcome.status,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    duration_ms: outcome.durationMs,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    timed_out: outcome.timedOut,
    runner: input.runner,
    runner_version: outcome.runnerVersion,
    model: task.model.model,
    effort: task.model.effort,
    ladder_index: task.model.ladderIndex,
    ladder_length: task.model.ladderLength,
    profile: task.profile,
    experiment_id: task.experimentId,
    prompt_version: task.promptVersion,
    prompt_bytes: outcome.promptBytes,
    truncations: outcome.truncations,
    sandbox: task.sandbox,
    network: task.network,
    timeout_minutes: task.timeoutMinutes,
    cwd: rel(task.cwd),
    writable_roots: task.writableRoots.map(rel),
    env_keys: Object.keys(task.env),
    tokens: outcome.tokens,
    failure: outcome.failure,
    result: outcome.result,
  };
}

export function agentEvidencePath(janusDir: string, runId: string): string {
  return join(janusDir, AGENTS_EVIDENCE_DIR, `${runId}.yaml`);
}

/** Writes the file and returns its `.janus`-relative path, which is what state and telemetry reference. */
export function writeAgentEvidence(paths: WorkspacePaths, evidence: AgentEvidence): string {
  const path = agentEvidencePath(paths.janusDir, evidence.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(evidence));
  return relative(paths.janusDir, path);
}
