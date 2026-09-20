import type { RenderedPrompt } from '../agents/render.js';
import type { AgentOutcome, AgentTask } from '../agents/types.js';

/**
 * §3.2 `AgentRunner`: `run(task: AgentTask): Promise<AgentResult>`. Implementations: the Codex adapter (§18.4)
 * and the scripted fake (§18.5). A runner executes one task and reports what happened; it writes no telemetry and
 * no evidence — `runAgent` in `src/agents/run.ts` does that around every runner.
 *
 * The §18.2 prompt is rendered by `runAgent` and passed in, not rendered by the runner: that is what makes the
 * context-size limit, the generated-file guard and the recorded `prompt_bytes`/`truncations` identical on the
 * fake path and the Codex path. A runner that does not need the text (the fake) may simply ignore the parameter.
 */
export interface AgentRunner {
  readonly name: 'codex' | 'fake';
  run(task: AgentTask, prompt: RenderedPrompt): Promise<AgentOutcome>;
}

export type { AgentOutcome, AgentTask, RenderedPrompt };

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
