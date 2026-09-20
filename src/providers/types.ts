import type { AgentRole } from '../config/config-schema.js';

/**
 * What the engine needs to start one agent run.
 *
 * T05 replaces this with the real §18.1 `AgentTask` (class, cwd, writable roots, network, timeout, the §18.2
 * context package, and the per-role output schema). Until then it carries only the three fields the engine
 * already records in `execution.in_flight` (§6) and in the `agent.finished` telemetry event (§27).
 */
export interface AgentRunRequest {
  /** `execution.in_flight.agent_run_id`, and the basename of `evidence/agents/<run-id>.yaml`. */
  runId: string;
  role: AgentRole;
  /** The repo the run is assigned to, or null for workspace-level roles. */
  repo: string | null;
}

/**
 * What one agent run answers.
 *
 * T05 replaces this with the validated §18.3 output contract (`changes_made`, `findings`, `evidence`,
 * `new_tasks`, `predicted_failures`, `handover`, ...). `status` already uses the §18.3 vocabulary.
 */
export interface AgentRunOutcome {
  runId: string;
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
}

/** §3.2 `AgentRunner`. Real implementation: the Codex adapter (§18.4), which lands in T05. */
export interface AgentRunner {
  readonly name: 'codex' | 'fake';
  run(request: AgentRunRequest): Promise<AgentRunOutcome>;
}

/**
 * §3.2 `CiProvider`.
 *
 * T09 replaces this with the full surface — `triggerBuild`, `waitForBuild`, `failureDigest`, the `BuildRef` and
 * `BuildOutcome` shapes, the tests_failed / build_failed / infra classification, and the `local` provider.
 */
export interface CiProvider {
  readonly name: 'teamcity' | 'local' | 'fake';
  /** §3.2 `findBuild`, narrowed to the build id (`repos.<name>.last_build.id`) until T09 introduces `BuildRef`. */
  findBuild(repo: string, revision: string, buildTypeId: string): Promise<string | null>;
}

/**
 * §3.2 `ScmProvider`.
 *
 * T10 replaces this with the full surface — `createPullRequest`, `getPullRequest`, `listActivitySince`,
 * `addComment`, and the `PullRef` / `PullState` / `Activity` shapes.
 */
export interface ScmProvider {
  readonly name: 'bitbucket-server' | 'fake';
  /** §3.2 `currentUser`: the account Janus posts as, so it can skip its own comments. */
  currentUser(): Promise<string>;
  /** §3.2 `ensureBranch`: makes `name` exist on `repo`, created from `base` when it does not. */
  ensureBranch(repo: string, name: string, base: string): Promise<void>;
}

/**
 * The provider bag a step receives through `StepContext`. Built once per `janus run` by the CLI (or by the
 * integration harness) and injected; never a module singleton, so a test can swap any of the three.
 */
export interface Providers {
  agent: AgentRunner;
  ci: CiProvider;
  scm: ScmProvider;
}
