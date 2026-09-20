# T04 Integration Harness Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Janus the provider seam and the integration harness that every later task writes its scenarios into: a `providers` bag on `StepContext`, persisted fake AgentRunner / CiProvider / ScmProvider stubs under `<workspace>/fake/`, a fixture that builds N temporary git repositories with a `depends_on` graph plus a bare remote each and a bare state remote, a reflog audit that proves no agent process ever performed a git write (§31.29), and a `pnpm test:integration` lane whose smoke test drives `janus init` and one checkpoint end to end.

**Architecture:** The seam splits in two. **Ships** (`src/providers/**`): the three provider interfaces and their `fake` implementations, which persist JSON under `<workspace>/fake/` because §3.2 makes fakes first-class — an operator selects them with `workflow.agent_runner: fake` and runs the real CLI. **Does not ship** (`tests/integration/harness/**`): the temp-repo graph builder, the reflog audit, and the assertion helpers, which are test scaffolding and must stay out of `tsconfig.build.json` (`include: ["src/**/*.ts"]`). The engine reaches providers only through `StepContext.providers`, injected by `janus run` (via `createProviders`) or by the harness (via `CliOverrides.providers`) — never a module singleton. The reflog audit works by bracketing every `AgentRunner.run()` call with a snapshot of every reflog in every git repository the workspace touches; any ref update that lands inside that window is a §31.29 violation. Unit and integration tests become two vitest *projects* in the one existing `vitest.config.ts`, so `pnpm test` still runs everything and `pnpm test:integration` targets the new lane.

**Tech Stack:** Node 20+, TypeScript strict ESM (NodeNext), commander 14, zod 3, yaml 2, vitest 5 (projects), the system `git` binary.

**Spec:** `angular-ai-development-workflow-v2.md` §3.2 (provider interfaces), §5 (workspace and Git layout, `fake/`), §6 (state schema, `execution.in_flight`), §7 (checkpoint rule and resume semantics), §18.5 (fake runner), §29 item 3 (engine integration harness), §31 items 27–29 (acceptance criteria), §32 rule 11 (agents never commit or push). Task definition: `tasks.md` T04. Builds on T01 (`docs/superpowers/plans/2026-09-19-t01-bootstrap-cli.md`), T02 (`docs/superpowers/plans/2026-09-19-t02-state-workspace.md`), T03 (`docs/superpowers/plans/2026-09-19-t03-engine-core.md`).

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`); every relative import ends in `.js`; type-only imports use `import type` (ESLint `@typescript-eslint/consistent-type-imports`).
- TypeScript `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `!` non-null assertions: narrow with `if (x === undefined) throw ...`. Never pass `undefined` to an optional property; spread it in conditionally (`...(v === undefined ? {} : { k: v })`).
- Package manager is `pnpm`. Every commit message is `type(scope): subject` and ends, after a blank line, with the two trailer lines the controller gives the implementer.
- Local git only. No step in this plan pushes to any network remote; every "remote" is a bare repository in a temp directory.
- Exit codes come only from `src/cli/exit-codes.ts` (`Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`). No new exit code is added.
- §3.2: "All three are small TypeScript interfaces with at least one real and one fake implementation. Fakes are first-class: they are how Janus is developed and how the full loop is exercised from a network without TeamCity or Bitbucket. Fakes persist their state under `<workspace>/fake/` because every `janus run` is a new process."
- §5: "`fake/` # persisted fake provider state (only with fake providers)". "Secrets come from environment variables only and are never written under `.janus/`." Nothing in this plan writes a secret, a token, or an environment dump anywhere under `.janus/`; the fake stores live under `fake/`, which is outside `.janus/` and is never committed to the state branch.
- §18.5: "Scripted by role and attempt number; applies prepared patches, writes prepared reports, returns prepared results; state persisted under `fake/agents.json`."
- §29 item 3: "Engine integration harness: temp git repositories with a dependency graph, persisted fake runner, fake CI, fake SCM. Drives a goal from `init` to `completed` and through every escalation path, crash resume, policy violation, coupled red, base sync conflict, E2E invalidation and triage, comment loop, decline, partial merge, and release-and-bump. Asserts from reflogs that no agent process performed a git write." T04 builds the harness and the first (`init` + one checkpoint) scenario; every later task adds its own.
- §31.27: "the whole loop, every escalation path, and resume run to completion using only fakes." §31.29: "no agent process ever performs a git write (verified from reflogs in the harness)."
- §32 rule 11: "Agents never commit, push, or otherwise rewrite Git history."
- **Boundary with T05 (hard rule).** T05 owns the real agent contract: `AgentTask` (§18.1), the `ContextPackage` (§18.2), the per-role output schemas (§18.3), the Codex adapter (§18.4), model profiles and ladders (§18.6), prompt templates, and the fully scripted fake runner. This plan defines only the seam plus the smallest placeholder request/outcome pair that lets the smoke test type-check, and every such type carries a `T05 replaces this` doc comment. Do not invent `AgentTask`, `AgentResult`, or `ContextPackage` fields here.
- **Boundary with T09 and T10.** `CiProvider` is widened by T09 (`triggerBuild`, `waitForBuild`, `failureDigest`, `BuildRef`, digests and redaction, the `local` provider); `ScmProvider` is widened by T10 (pull requests, activity, comments). This plan gives each only §3.2 method signatures whose parameters and returns are primitives, each marked `T09 replaces this` / `T10 replaces this`.
- Controller rulings carried into this plan: providers live on `StepContext` as a bag injected by the CLI or the harness, never module singletons; the step registry keyed by goal status is the seam; `maxWaitMs` is per blocking wait, not per invocation; steps must not import `writeState` — the engine exposes `markInFlight(patch)`; reconciliation never pushes; secrets never written under `.janus/`.
- Every git-touching test uses real temporary repositories. The hermetic git environment (`GIT_AUTHOR_NAME=Janus Test`, `GIT_AUTHOR_EMAIL=janus@test.invalid`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) is set by `vitest.config.ts` and must apply to both projects.

---

## Decisions this plan locks in

**1. Where harness code lives.** `tsconfig.build.json` sets `"include": ["src/**/*.ts"]` and `"rootDir": "src"`, so anything under `src/` is published in `dist/`. Therefore:

- `src/providers/**` — the three interfaces and the three fakes. These **do** ship, because §3.2 makes fakes a supported runtime configuration (`workflow.agent_runner: fake`) and §30 slice 1 is built on them. They have no vitest import and no test-only code.
- `tests/integration/harness/**` — the temp-repo graph, the reflog audit, the `Harness` handle and its assertions. These import `vitest` (`onTestFinished`) and exist only to exercise the engine, so they stay out of `src/` and out of the published build. Task 10 verifies with `pnpm build && ls dist` that no harness file reached `dist/`.

**2. `pnpm test:integration` mechanism.** One config file, two vitest projects. `vitest.config.ts` gains `test.projects` with a `unit` project (`include: ['tests/**/*.test.ts']`, `exclude: [...configDefaults.exclude, 'tests/integration/**']`) and an `integration` project (`include: ['tests/integration/**/*.test.ts']`). Scripts: `test` stays `vitest run` (**both** projects), `test:unit` is `vitest run --project unit`, `test:integration` is `vitest run --project integration`.

*Tradeoff and why this side.* Excluding integration from `pnpm test` keeps the inner loop at ~1 s but makes `pnpm test` a false green: every T05+ implementer and reviewer in this project verifies with `pnpm test`, and §29 item 3 says the harness is where every later task's scenarios accumulate, so a lane nobody runs by default will rot. Including them costs wall-clock time as the suite grows. This plan takes the cost and keeps `pnpm test` authoritative, adds `pnpm test:unit` for the fast loop, and caps the integration lane's budget (below) so the cost stays bounded. `.github/workflows/ci.yml` keeps running `pnpm test` and gains `timeout-minutes: 15` on the job.

**3. Reflog audit (§31.29).** *What is recorded:* for every git repository the workspace touches — `.janus/`, each `repos/<name>/`, each bare product remote, and the bare state remote — the harness reads `HEAD`'s reflog and the reflog of every ref that `git for-each-ref` reports (local branches, tags, and remote-tracking refs such as `refs/remotes/origin/ai/<goal-id>`), as an ordered list of `"<sha> <reflog subject>"`, newest first. Remote-tracking refs are what make a `git push` visible from inside the workspace clone (`update by push`), and the bare repositories get `core.logAllRefUpdates true` at creation (bare repos default to false) so a push is also witnessed on the receiving side.
*What is compared:* `AgentRunner.run()` is wrapped by `auditAgentRunner`, which snapshots all of that immediately before `run()` and again in a `finally` immediately after. Reflogs only grow at the front, so the entries added during the window are the prefix of the new list that sits on top of the old one; if the new list is not the old list with a prefix added (a ref was deleted and recreated, or a reflog was rewritten — both of which are themselves git writes) the whole new list is reported. Every added entry is pushed into `harness.agentGitWrites` tagged with the `run_id` and `role` of the agent that was in flight.
*What failure looks like:* `expectNoAgentGitWrites(harness)` throws
`spec §31.29 violated: 1 git ref update(s) happened while an agent was running:` followed by one indented line per write —
`  repos/ui-kit refs/heads/ai/angular-15-to-16 3f2a9c1 "commit: agent wrote this" (during agent run run-0001, role implementation)` — naming the repository label, the ref, the short sha, the reflog subject git itself recorded, and the offending agent run. Task 8 has a test that makes an agent commit on purpose and asserts that message.

**4. How the graph fixture expresses `depends_on`.** `graphFixture(specs)` takes `RepoGraphSpec[]` (`name`, optional `kind`, `dependsOn`, `coupledWith`, `loadsRemotes`), creates one `createRemoteWithCommit` pair per repo plus one `createBareRepo` state remote, and renders a `goal.yaml` whose `repos[]` entries carry `depends_on: [...]` verbatim — omitting `depends_on`, `coupled_with`, and `loads_remotes` when empty so the file stays the shape the existing loaders already accept. `clone_url` points at each bare remote; `ci.pr_build_type_id` is derived as `Fe_<PascalName>_Build`; the `e2e` block is derived from the `shell`/`app` repos as `env.<NAME>_BRANCH`. The existing `goalFixture()` is reimplemented on top of it with the two specs it hardcodes today, so no existing test changes. The topological order is *not* computed by the fixture: `loadGoal` already runs `validateGoal`'s Kahn sort, and the smoke test asserts the order the real loader produces.

**5. Temp-directory cleanup and CI time budget.** `graphFixture` returns `tempRoots: string[]` — every `mkdtemp` root it created. `createHarness` adds the workspace's own temp root and registers `onTestFinished(() => harness.cleanup())`, which `rmSync(..., { recursive: true, force: true })`s all of them unless `JANUS_KEEP_TMP=1` is set (for debugging a failed run). Pre-existing unit-test fixtures are left alone; this plan only cleans up what the harness creates. Budget: the T04 integration lane must stay **under 90 seconds** wall clock on CI. The `integration` project sets `testTimeout: 120_000` and `hookTimeout: 120_000` (real `git clone` of four repositories per harness is slow on a cold CI runner), and the CI job gets `timeout-minutes: 15`. Task 10 measures the lane and records the number in the final report.

---

## File Structure

```text
vitest.config.ts                         modify: two projects (unit, integration), shared git env, integration timeouts
package.json                             modify: scripts test:unit, test:integration
.github/workflows/ci.yml                 modify: timeout-minutes: 15

src/providers/types.ts                   AgentRunner, CiProvider, ScmProvider, Providers + the T05/T09/T10 placeholder shapes
src/providers/fake/store.ts              FAKE_*_FILE, fakeStorePath, readFakeStore, writeFakeStore (atomic JSON under <workspace>/fake/)
src/providers/fake/agent-runner.ts       createFakeAgentRunner, FakeAgentStore, seedFakeAgents, readFakeAgents (fake/agents.json, §18.5)
src/providers/fake/ci.ts                 createFakeCiProvider, FakeCiStore, buildKey, seedFakeBuilds, readFakeCi (fake/ci.json)
src/providers/fake/scm.ts                createFakeScmProvider, FakeScmStore, readFakeScm (fake/scm.json)
src/providers/index.ts                   createProviders, ProviderNotImplementedError
src/engine/engine.ts                     modify: Engine.markInFlight(patch)
src/engine/steps.ts                      modify: StepContext.providers
src/engine/run-loop.ts                   modify: RunEngineInput.providers; markInFlight replaces the writeState calls
src/cli/context.ts                       modify: CliOverrides.providers
src/cli/commands/run.ts                  modify: build the providers bag after the --dry-run return
src/cli/main.ts                          modify: ProviderNotImplementedError -> ExitCode.NotImplemented
src/git/tree.ts                          modify: listRefs, reflogExists, reflog(cwd, ref = 'HEAD')

tests/helpers/workspace-fixtures.ts      modify: RepoGraphSpec, GraphFixture, graphFixture(); goalFixture() built on it
tests/helpers/engine-fixtures.ts         modify: WorkspaceFixture.fakeDir, testProviders(fakeDir, now?)
tests/integration/harness/git-audit.ts   AuditTarget, RefLogSnapshot, GitWrite, AgentGitWrite, captureRefLogs, diffRefLogs,
                                         formatGitWrites, auditAgentRunner
tests/integration/harness/harness.ts     Harness, HarnessOptions, createHarness, expectNoAgentGitWrites, expectStatePushed
tests/integration/lane.test.ts           the lane guard (env + collection)
tests/integration/git-audit.test.ts      snapshot/diff behaviour and the deliberate-violation case
tests/integration/smoke.test.ts          T04 done-when: init the graph, one checkpoint, one scripted agent step
tests/providers/store.test.ts            fake store round-trip
tests/providers/fake-agent-runner.test.ts scripted by role and attempt, persisted across processes
tests/providers/fake-ci-scm.test.ts      fake CI and fake SCM persistence
tests/providers/create-providers.test.ts factory selection and the not-implemented errors
tests/git/tree.test.ts                   modify: listRefs, reflogExists, reflog(ref) cases
tests/engine/engine.test.ts              modify: markInFlight case
tests/engine/steps.test.ts               modify: StepContext now carries providers
tests/engine/run-loop.test.ts            modify: three runEngine({...}) call sites gain providers
tests/cli/run.test.ts                    modify: a run with a non-fake provider exits 3
```

---

## Task 1: Integration test lane

**Files:**
- Modify: `vitest.config.ts` (whole file)
- Modify: `package.json:12-19` (the `scripts` block)
- Modify: `.github/workflows/ci.yml:9-11` (the `test` job header)
- Test: `tests/integration/lane.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: a vitest project named `integration` that collects `tests/integration/**/*.test.ts` and sets `JANUS_TEST_LANE=integration`; a project named `unit` that collects everything else under `tests/`; the scripts `pnpm test` (both), `pnpm test:unit`, `pnpm test:integration`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/lane.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('integration lane', () => {
  it('is collected only by the integration project and inherits the hermetic git environment', () => {
    expect(process.env['JANUS_TEST_LANE']).toBe('integration');
    expect(process.env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(process.env['GIT_COMMITTER_EMAIL']).toBe('janus@test.invalid');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/integration/lane.test.ts`
Expected: FAIL — `expected undefined to be 'integration'` (the current single config sets no `JANUS_TEST_LANE`).

- [ ] **Step 3: Rewrite `vitest.config.ts` with two projects**

```ts
import { configDefaults, defineConfig } from 'vitest/config';

/** Hermetic git identity with no user or system config, shared by both test projects. */
const gitEnv = {
  GIT_AUTHOR_NAME: 'Janus Test',
  GIT_AUTHOR_EMAIL: 'janus@test.invalid',
  GIT_COMMITTER_NAME: 'Janus Test',
  GIT_COMMITTER_EMAIL: 'janus@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'tests/integration/**'],
          env: { ...gitEnv },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          // Each harness clones four real git repositories; a cold CI runner is slow.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          env: { ...gitEnv, JANUS_TEST_LANE: 'integration' },
        },
      },
    ],
  },
});
```

- [ ] **Step 4: Add the scripts**

In `package.json`, replace the `test` and `test:watch` lines so the block reads:

```json
    "test": "vitest run",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:watch": "vitest --project unit",
```

- [ ] **Step 5: Give the CI job a timeout**

In `.github/workflows/ci.yml`, change the job header from

```yaml
  test:
    runs-on: ubuntu-latest
```

to

```yaml
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
```

(`pnpm test` in that workflow now runs both projects; no other workflow change is needed.)

- [ ] **Step 6: Run both lanes to verify**

Run: `pnpm test:integration`
Expected: PASS — `Test Files 1 passed (1)`.

Run: `pnpm test:unit`
Expected: PASS — 557 tests pass and `tests/integration/lane.test.ts` is **not** among the collected files.

Run: `pnpm test`
Expected: PASS — 558 tests across both projects.

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts package.json .github/workflows/ci.yml tests/integration/lane.test.ts
git commit -m "test(harness): add an integration test lane with pnpm test:integration"
```

---

## Task 2: Provider seam on StepContext, and `engine.markInFlight`

**Files:**
- Create: `src/providers/types.ts`
- Modify: `src/engine/engine.ts:11-51`
- Modify: `src/engine/steps.ts:1-11`
- Modify: `src/engine/run-loop.ts:1-13, 18-26, 82, 101-102, 135-137`
- Modify: `src/cli/context.ts:11-14`
- Test: `tests/engine/engine.test.ts`, `tests/engine/steps.test.ts:8`, `tests/engine/run-loop.test.ts:29, 117, 276`

**Interfaces:**
- Consumes: `Engine` and `StepContext` from T03; `AgentRole` from `src/config/config-schema.ts`; `InFlight`, `emptyInFlight` from `src/state/state-schema.ts`.
- Produces:
  - `interface Providers { agent: AgentRunner; ci: CiProvider; scm: ScmProvider }`
  - `interface AgentRunner { readonly name: 'codex' | 'fake'; run(request: AgentRunRequest): Promise<AgentRunOutcome> }`
  - `interface AgentRunRequest { runId: string; role: AgentRole; repo: string | null }`
  - `interface AgentRunOutcome { runId: string; status: 'completed' | 'blocked' | 'failed'; summary: string }`
  - `interface CiProvider { readonly name: 'teamcity' | 'local' | 'fake'; findBuild(repo: string, revision: string, buildTypeId: string): Promise<string | null> }`
  - `interface ScmProvider { readonly name: 'bitbucket-server' | 'fake'; currentUser(): Promise<string>; ensureBranch(repo: string, name: string, base: string): Promise<void> }`
  - `StepContext.providers: Providers`
  - `RunEngineInput.providers: Providers` (required)
  - `CliOverrides.providers?: Providers`
  - `Engine.markInFlight(patch: Partial<InFlight>): InFlight`

- [ ] **Step 1: Write the failing test for `markInFlight`**

Append to `tests/engine/engine.test.ts` (inside the existing `describe('createEngine', ...)` block):

```ts
  it('markInFlight merges the patch and writes state.yaml before the next checkpoint', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, () => new Date('2026-09-20T09:00:00.000Z'));
      const first = engine.markInFlight({ step: 'execute-work-packages', started_at: '2026-09-20T09:00:00.000Z' });
      expect(first.step).toBe('execute-work-packages');
      expect(readState(ws.janusDir).execution.in_flight.step).toBe('execute-work-packages');

      const second = engine.markInFlight({ agent_run_id: 'run-0001', repo: 'ui-kit', budget: 'ci_fix_attempts' });
      expect(second).toEqual({
        step: 'execute-work-packages',
        started_at: '2026-09-20T09:00:00.000Z',
        agent_run_id: 'run-0001',
        repo: 'ui-kit',
        budget: 'ci_fix_attempts',
      });
      expect(readState(ws.janusDir).execution.in_flight).toEqual(second);
      expect(workspace.state.execution.in_flight).toEqual(second);
    } finally {
      workspace.release();
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/engine/engine.test.ts`
Expected: FAIL — `engine.markInFlight is not a function`.

- [ ] **Step 3: Create the provider seam types**

Create `src/providers/types.ts`:

```ts
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
```

- [ ] **Step 4: Add `markInFlight` to the engine**

In `src/engine/engine.ts`, add to the imports:

```ts
import type { GoalStatus, InFlight } from '../state/state-schema.js';
import { writeState } from '../state/state-store.js';
```

(the existing `import type { GoalStatus } from '../state/state-schema.js';` line is replaced by the one above).

Add to the `Engine` interface, after `checkpoint`:

```ts
  /**
   * Spec §7 rule 3: records what the current step has in flight (`agent_run_id`, `repo`, `budget`) and writes
   * `state.yaml` immediately, so a crash before the next checkpoint is recoverable. Steps call this instead of
   * importing `writeState`; the value is merged into the existing `in_flight`.
   */
  markInFlight(patch: Partial<InFlight>): InFlight;
```

And to the object `createEngine` returns, after the `checkpoint:` property:

```ts
    markInFlight: (patch) => {
      const { state } = input.workspace;
      state.execution.in_flight = { ...state.execution.in_flight, ...patch };
      writeState(janusDir, state);
      return state.execution.in_flight;
    },
```

- [ ] **Step 5: Run the engine test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/engine/engine.test.ts`
Expected: PASS.

- [ ] **Step 6: Put `providers` on `StepContext` and `RunEngineInput`**

In `src/engine/steps.ts`, add the import and the field:

```ts
import type { Providers } from '../providers/types.js';
```

```ts
export interface StepContext {
  engine: Engine;
  /** `--max-wait` in milliseconds; a waiting step returns `wait_exceeded` once it has waited this long. */
  maxWaitMs: number;
  /** The model profile name for this invocation (`--model-profile` or `workflow_models.profile`). */
  modelProfile: string;
  /** The agent runner, CI, and SCM providers for this run, injected by the CLI or the integration harness. */
  providers: Providers;
}
```

In `src/engine/run-loop.ts`:
- replace `import { writeState } from '../state/state-store.js';` with `import type { Providers } from '../providers/types.js';` (placed in import order after `../git/ops.js`);
- add `providers: Providers;` to `RunEngineInput`, after `modelProfile: string;`;
- change line 82 to

```ts
  const ctx: StepContext = { engine, maxWaitMs: input.maxWaitMs, modelProfile: input.modelProfile, providers: input.providers };
```

- replace lines 101-102 with

```ts
    engine.markInFlight({ ...emptyInFlight(), step: step.name, started_at: engine.now().toISOString() });
```

- replace the `writeState(paths.janusDir, state);` inside `case 'not_implemented':` with

```ts
        engine.markInFlight(emptyInFlight());
```

In `src/cli/context.ts`, add the import and the override:

```ts
import type { Providers } from '../providers/types.js';
```

```ts
/** Test seams. `steps` replaces the production step registry of `janus run`; `providers` replaces the provider bag. */
export interface CliOverrides {
  steps?: StepRegistry;
  providers?: Providers;
}
```

- [ ] **Step 7: Update the three existing call sites and the step-context fixture**

`tests/engine/steps.test.ts` line 8 becomes:

```ts
const providers: Providers = {
  agent: { name: 'fake', run: async (request) => ({ runId: request.runId, status: 'completed', summary: 'unused' }) },
  ci: { name: 'fake', findBuild: async () => null },
  scm: { name: 'fake', currentUser: async () => 'janus-fake', ensureBranch: async () => undefined },
};
const ctx: StepContext = { engine: {} as Engine, maxWaitMs: 0, modelProfile: 'default', providers };
```

with `import type { Providers } from '../../src/providers/types.js';` added to its imports.

In `tests/engine/run-loop.test.ts`, add `providers: testProviders(workspace.paths.fakeDir),` to each of the three `runEngine({ ... })` calls (the helper at line ~29, the crash case at line ~117, the goal-runtime case at line ~276); `workspace` is the `openWorkspace` handle in scope at all three. Add `testProviders` to the existing import from `../helpers/engine-fixtures.js`. `testProviders` arrives in Task 3; until then use a literal bag identical to the one above.

- [ ] **Step 8: Run the engine and CLI tests**

Run: `pnpm exec vitest run --project unit tests/engine tests/cli`
Expected: PASS — the compile errors from the new required field are gone.

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/providers/types.ts src/engine/engine.ts src/engine/steps.ts src/engine/run-loop.ts src/cli/context.ts tests/engine
git commit -m "feat(providers): put a providers bag on StepContext and add engine.markInFlight"
```

---

## Task 3: Fake store and fake agent runner

**Files:**
- Create: `src/providers/fake/store.ts`
- Create: `src/providers/fake/agent-runner.ts`
- Modify: `tests/helpers/engine-fixtures.ts:20-33` (add `fakeDir`, add `testProviders`)
- Test: `tests/providers/store.test.ts`, `tests/providers/fake-agent-runner.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `AgentRunRequest`, `AgentRunOutcome` (Task 2); `AgentRole` from `src/config/config-schema.ts`.
- Produces:
  - `const FAKE_AGENTS_FILE = 'agents.json'`, `FAKE_CI_FILE = 'ci.json'`, `FAKE_SCM_FILE = 'scm.json'`
  - `fakeStorePath(fakeDir: string, file: string): string`
  - `readFakeStore<T>(fakeDir: string, file: string, fallback: T): T`
  - `writeFakeStore<T>(fakeDir: string, file: string, data: T): void`
  - `interface FakeAgentScriptEntry { status: AgentRunOutcome['status']; summary: string }`
  - `interface FakeAgentCall { run_id: string; role: AgentRole; repo: string | null; at: string; status: AgentRunOutcome['status'] }`
  - `interface FakeAgentStore { script: Partial<Record<AgentRole, FakeAgentScriptEntry[]>>; calls: FakeAgentCall[] }`
  - `emptyFakeAgentStore(): FakeAgentStore`, `seedFakeAgents(fakeDir, script): void`, `readFakeAgents(fakeDir): FakeAgentStore`
  - `createFakeAgentRunner(input: { fakeDir: string; now(): Date }): AgentRunner`
  - `testProviders(fakeDir: string, now?: () => Date): Providers` (test helper; its `ci` and `scm` members land in Task 4)

- [ ] **Step 1: Write the failing store test**

Create `tests/providers/store.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_AGENTS_FILE, fakeStorePath, readFakeStore, writeFakeStore } from '../../src/providers/fake/store.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('fake provider store', () => {
  it('round-trips through <workspace>/fake/<file> and creates the directory', () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
    writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 3 });
    expect(existsSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE))).toBe(true);
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 3 });
    expect(JSON.parse(readFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), 'utf8'))).toEqual({
      version: 1,
      data: { calls: 3 },
    });
  });

  it('falls back instead of throwing on a corrupt or foreign-version file', () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 1 });
    writeFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), '{ not json');
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
    writeFileSync(fakeStorePath(fakeDir, FAKE_AGENTS_FILE), JSON.stringify({ version: 2, data: { calls: 9 } }));
    expect(readFakeStore(fakeDir, FAKE_AGENTS_FILE, { calls: 0 })).toEqual({ calls: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/providers/store.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/providers/fake/store.js"`.

- [ ] **Step 3: Implement the store**

Create `src/providers/fake/store.ts`:

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Spec §18.5 names this file. */
export const FAKE_AGENTS_FILE = 'agents.json';
export const FAKE_CI_FILE = 'ci.json';
export const FAKE_SCM_FILE = 'scm.json';

interface StoreFile<T> {
  version: 1;
  data: T;
}

export function fakeStorePath(fakeDir: string, file: string): string {
  return join(fakeDir, file);
}

/**
 * Reads `<workspace>/fake/<file>` (spec §3.2: every `janus run` is a new process, so fakes persist here).
 * A missing, unreadable, corrupt, or foreign-version file yields `fallback` — a fake is never allowed to be the
 * reason a run crashes.
 */
export function readFakeStore<T>(fakeDir: string, file: string, fallback: T): T {
  let parsed: Partial<StoreFile<T>>;
  try {
    parsed = JSON.parse(readFileSync(fakeStorePath(fakeDir, file), 'utf8')) as Partial<StoreFile<T>>;
  } catch {
    return fallback;
  }
  if (parsed.version !== 1 || parsed.data === undefined) return fallback;
  return parsed.data;
}

/** Writes through a temp file and renames it into place, so an interrupted run never leaves half a store behind. */
export function writeFakeStore<T>(fakeDir: string, file: string, data: T): void {
  mkdirSync(fakeDir, { recursive: true });
  const path = fakeStorePath(fakeDir, file);
  const temp = `${path}.tmp`;
  const wrapper: StoreFile<T> = { version: 1, data };
  writeFileSync(temp, `${JSON.stringify(wrapper, null, 2)}\n`);
  renameSync(temp, path);
}
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/providers/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing fake-runner test**

Create `tests/providers/fake-agent-runner.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeAgentRunner, readFakeAgents, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T10:00:00.000Z');

describe('createFakeAgentRunner', () => {
  it('answers from the script by role and attempt number and records every call', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, {
      implementation: [
        { status: 'failed', summary: 'first attempt broke the build' },
        { status: 'completed', summary: 'second attempt is green' },
      ],
    });
    const runner = createFakeAgentRunner({ fakeDir, now: clock });

    const first = await runner.run({ runId: 'run-0001', role: 'implementation', repo: 'ui-kit' });
    expect(first).toEqual({ runId: 'run-0001', status: 'failed', summary: 'first attempt broke the build' });
    const second = await runner.run({ runId: 'run-0002', role: 'implementation', repo: 'ui-kit' });
    expect(second.status).toBe('completed');

    const store = readFakeAgents(fakeDir);
    expect(store.calls).toEqual([
      { run_id: 'run-0001', role: 'implementation', repo: 'ui-kit', at: '2026-09-20T10:00:00.000Z', status: 'failed' },
      { run_id: 'run-0002', role: 'implementation', repo: 'ui-kit', at: '2026-09-20T10:00:00.000Z', status: 'completed' },
    ]);
  });

  it('counts attempts per role and generates a completed answer past the end of the script', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, { review: [{ status: 'blocked', summary: 'needs the plan' }] });
    const runner = createFakeAgentRunner({ fakeDir, now: clock });

    expect((await runner.run({ runId: 'r1', role: 'review', repo: null })).status).toBe('blocked');
    expect(await runner.run({ runId: 'r2', role: 'review', repo: null })).toEqual({
      runId: 'r2',
      status: 'completed',
      summary: 'fake review agent attempt 2 completed',
    });
    // A different role starts at attempt 1 of its own script.
    expect((await runner.run({ runId: 'r3', role: 'planning', repo: null })).summary).toBe(
      'fake planning agent attempt 1 completed',
    );
  });

  it('continues the script in a second process because the store is on disk', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, {
      debug: [
        { status: 'failed', summary: 'still red' },
        { status: 'completed', summary: 'fixed' },
      ],
    });
    await createFakeAgentRunner({ fakeDir, now: clock }).run({ runId: 'a', role: 'debug', repo: 'shell' });
    const laterProcess = createFakeAgentRunner({ fakeDir, now: clock });
    expect((await laterProcess.run({ runId: 'b', role: 'debug', repo: 'shell' })).summary).toBe('fixed');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/providers/fake-agent-runner.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/providers/fake/agent-runner.js"`.

- [ ] **Step 7: Implement the fake agent runner**

Create `src/providers/fake/agent-runner.ts`:

```ts
import type { AgentRole } from '../../config/config-schema.js';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '../types.js';
import { FAKE_AGENTS_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * One scripted answer.
 *
 * T05 replaces this with the full §18.5 script: prepared patches applied to the repo, prepared reports written
 * under `.janus/reports/<run-id>/`, and prepared results validated against the §18.3 output schema.
 */
export interface FakeAgentScriptEntry {
  status: AgentRunOutcome['status'];
  summary: string;
}

export interface FakeAgentCall {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  at: string;
  status: AgentRunOutcome['status'];
}

/** The contents of `<workspace>/fake/agents.json` (spec §18.5). */
export interface FakeAgentStore {
  /** Answers consumed in order per role; a role that runs out falls back to a generated `completed`. */
  script: Partial<Record<AgentRole, FakeAgentScriptEntry[]>>;
  /** Every call made in this workspace, so a second `janus run` continues where the first stopped. */
  calls: FakeAgentCall[];
}

export function emptyFakeAgentStore(): FakeAgentStore {
  return { script: {}, calls: [] };
}

/** Seeds the script before a run and clears any recorded calls. */
export function seedFakeAgents(fakeDir: string, script: FakeAgentStore['script']): void {
  const store: FakeAgentStore = { script, calls: [] };
  writeFakeStore(fakeDir, FAKE_AGENTS_FILE, store);
}

export function readFakeAgents(fakeDir: string): FakeAgentStore {
  return readFakeStore(fakeDir, FAKE_AGENTS_FILE, emptyFakeAgentStore());
}

export interface FakeAgentRunnerInput {
  /** `WorkspacePaths.fakeDir`. */
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §18.5: scripted by role and attempt number, state persisted under `fake/agents.json`.
 *
 * It writes nothing but that one file and never invokes git, which is what makes the §31.29 reflog audit
 * meaningful: a git write observed while this runner is in flight is a real violation, not fixture noise.
 */
export function createFakeAgentRunner(input: FakeAgentRunnerInput): AgentRunner {
  return {
    name: 'fake',
    run: async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
      const store = readFakeAgents(input.fakeDir);
      const attempt = store.calls.filter((call) => call.role === request.role).length;
      const scripted = store.script[request.role]?.[attempt];
      const outcome: AgentRunOutcome = {
        runId: request.runId,
        status: scripted?.status ?? 'completed',
        summary: scripted?.summary ?? `fake ${request.role} agent attempt ${attempt + 1} completed`,
      };
      store.calls.push({
        run_id: request.runId,
        role: request.role,
        repo: request.repo,
        at: input.now().toISOString(),
        status: outcome.status,
      });
      writeFakeStore(input.fakeDir, FAKE_AGENTS_FILE, store);
      return outcome;
    },
  };
}
```

- [ ] **Step 8: Run the fake-runner test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/providers/fake-agent-runner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Add `fakeDir` and `testProviders` to the engine fixtures**

In `tests/helpers/engine-fixtures.ts`, add to the imports:

```ts
import { createFakeAgentRunner } from '../../src/providers/fake/agent-runner.js';
import type { Providers } from '../../src/providers/types.js';
```

Change `WorkspaceFixture` and `initWorkspace`'s return:

```ts
export interface WorkspaceFixture {
  fixture: GoalFixture;
  root: string;
  janusDir: string;
  fakeDir: string;
}
```

```ts
  return { fixture, root, janusDir: join(root, '.janus'), fakeDir: join(root, 'fake') };
```

And append:

```ts
/** A providers bag backed by the fakes, rooted at a workspace's `fake/` directory. */
export function testProviders(fakeDir: string, now: () => Date = () => new Date()): Providers {
  return {
    agent: createFakeAgentRunner({ fakeDir, now }),
    ci: { name: 'fake', findBuild: async () => null },
    scm: { name: 'fake', currentUser: async () => 'janus-fake', ensureBranch: async () => undefined },
  };
}
```

(Task 4 replaces the inline `ci` and `scm` literals with the real fakes.)

Then replace the literal provider bags added in Task 2 Step 7 of `tests/engine/run-loop.test.ts` with `testProviders(workspace.paths.fakeDir)`.

- [ ] **Step 10: Run the unit lane**

Run: `pnpm test:unit`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/providers/fake/store.ts src/providers/fake/agent-runner.ts tests/providers tests/helpers/engine-fixtures.ts tests/engine/run-loop.test.ts
git commit -m "feat(providers): add the persisted fake agent runner and its fake/ store"
```

---

## Task 4: Fake CI and fake SCM stubs

**Files:**
- Create: `src/providers/fake/ci.ts`
- Create: `src/providers/fake/scm.ts`
- Modify: `tests/helpers/engine-fixtures.ts` (`testProviders` uses the real fakes)
- Test: `tests/providers/fake-ci-scm.test.ts`

**Interfaces:**
- Consumes: `CiProvider`, `ScmProvider` (Task 2); `readFakeStore`, `writeFakeStore`, `FAKE_CI_FILE`, `FAKE_SCM_FILE` (Task 3).
- Produces:
  - `buildKey(repo: string, revision: string, buildTypeId: string): string`
  - `interface FakeCiCall { repo: string; revision: string; build_type_id: string; at: string; found: string | null }`
  - `interface FakeCiStore { builds: Record<string, string>; calls: FakeCiCall[] }`
  - `emptyFakeCiStore()`, `seedFakeBuilds(fakeDir, builds: Record<string, string>): void`, `readFakeCi(fakeDir): FakeCiStore`
  - `createFakeCiProvider(input: { fakeDir: string; now(): Date }): CiProvider`
  - `const FAKE_SCM_USER = 'janus-fake'`
  - `interface FakeScmCall { kind: 'currentUser' | 'ensureBranch'; repo: string | null; branch: string | null; at: string }`
  - `interface FakeScmStore { user: string; branches: Record<string, Record<string, string>>; calls: FakeScmCall[] }`
  - `emptyFakeScmStore()`, `readFakeScm(fakeDir): FakeScmStore`, `createFakeScmProvider(input: { fakeDir: string; now(): Date }): ScmProvider`

- [ ] **Step 1: Write the failing test**

Create `tests/providers/fake-ci-scm.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKey, createFakeCiProvider, readFakeCi, seedFakeBuilds } from '../../src/providers/fake/ci.js';
import { createFakeScmProvider, readFakeScm } from '../../src/providers/fake/scm.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T11:00:00.000Z');

describe('createFakeCiProvider', () => {
  it('finds a seeded build, answers null otherwise, and records every lookup', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeBuilds(fakeDir, { [buildKey('ui-kit', 'a'.repeat(40), 'Fe_UiKit_Build')]: 'build-17' });
    const ci = createFakeCiProvider({ fakeDir, now: clock });

    expect(await ci.findBuild('ui-kit', 'a'.repeat(40), 'Fe_UiKit_Build')).toBe('build-17');
    expect(await ci.findBuild('ui-kit', 'b'.repeat(40), 'Fe_UiKit_Build')).toBeNull();

    const store = readFakeCi(fakeDir);
    expect(store.calls.map((call) => call.found)).toEqual(['build-17', null]);
    expect(store.calls[0]).toEqual({
      repo: 'ui-kit',
      revision: 'a'.repeat(40),
      build_type_id: 'Fe_UiKit_Build',
      at: '2026-09-20T11:00:00.000Z',
      found: 'build-17',
    });
  });
});

describe('createFakeScmProvider', () => {
  it('reports a stable user and remembers branches across processes without touching git', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    const scm = createFakeScmProvider({ fakeDir, now: clock });

    expect(await scm.currentUser()).toBe('janus-fake');
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'main');
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'other-base');

    const later = createFakeScmProvider({ fakeDir, now: clock });
    await later.ensureBranch('shell', 'ai/angular-15-to-16', 'main');

    const store = readFakeScm(fakeDir);
    // The first base wins: ensureBranch is "make it exist", not "move it".
    expect(store.branches).toEqual({
      'ui-kit': { 'ai/angular-15-to-16': 'main' },
      shell: { 'ai/angular-15-to-16': 'main' },
    });
    expect(store.calls.map((call) => call.kind)).toEqual(['currentUser', 'ensureBranch', 'ensureBranch', 'ensureBranch']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/providers/fake-ci-scm.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/providers/fake/ci.js"`.

- [ ] **Step 3: Implement the fake CI provider**

Create `src/providers/fake/ci.ts`:

```ts
import type { CiProvider } from '../types.js';
import { FAKE_CI_FILE, readFakeStore, writeFakeStore } from './store.js';

/** The key a seeded build is stored under: one build per repo, revision, and build type. */
export function buildKey(repo: string, revision: string, buildTypeId: string): string {
  return `${repo}@${revision}#${buildTypeId}`;
}

export interface FakeCiCall {
  repo: string;
  revision: string;
  build_type_id: string;
  at: string;
  found: string | null;
}

/** The contents of `<workspace>/fake/ci.json`. T09 extends this with outcomes, digests, and triggered builds. */
export interface FakeCiStore {
  /** `buildKey(...)` -> build id. */
  builds: Record<string, string>;
  calls: FakeCiCall[];
}

export function emptyFakeCiStore(): FakeCiStore {
  return { builds: {}, calls: [] };
}

/** Seeds the builds the fake will find, clearing any recorded calls. */
export function seedFakeBuilds(fakeDir: string, builds: Record<string, string>): void {
  const store: FakeCiStore = { builds, calls: [] };
  writeFakeStore(fakeDir, FAKE_CI_FILE, store);
}

export function readFakeCi(fakeDir: string): FakeCiStore {
  return readFakeStore(fakeDir, FAKE_CI_FILE, emptyFakeCiStore());
}

export interface FakeCiProviderInput {
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §3.2 `fake` CI provider, persisted under `fake/ci.json`.
 *
 * T09 replaces it with the full provider (trigger, wait, classify, digest) and the contract suite that
 * `teamcity`, `local`, and `fake` all pass. Like every fake, it never invokes git.
 */
export function createFakeCiProvider(input: FakeCiProviderInput): CiProvider {
  return {
    name: 'fake',
    findBuild: async (repo, revision, buildTypeId) => {
      const store = readFakeCi(input.fakeDir);
      const found = store.builds[buildKey(repo, revision, buildTypeId)] ?? null;
      store.calls.push({ repo, revision, build_type_id: buildTypeId, at: input.now().toISOString(), found });
      writeFakeStore(input.fakeDir, FAKE_CI_FILE, store);
      return found;
    },
  };
}
```

- [ ] **Step 4: Implement the fake SCM provider**

Create `src/providers/fake/scm.ts`:

```ts
import type { ScmProvider } from '../types.js';
import { FAKE_SCM_FILE, readFakeStore, writeFakeStore } from './store.js';

/** The account the fake SCM reports; §3.2 uses it to skip Janus's own comments. */
export const FAKE_SCM_USER = 'janus-fake';

export interface FakeScmCall {
  kind: 'currentUser' | 'ensureBranch';
  repo: string | null;
  branch: string | null;
  at: string;
}

/** The contents of `<workspace>/fake/scm.json`. T10 extends this with pull requests, activity, and comments. */
export interface FakeScmStore {
  user: string;
  /** repo -> branch name -> the base it was created from. */
  branches: Record<string, Record<string, string>>;
  calls: FakeScmCall[];
}

export function emptyFakeScmStore(): FakeScmStore {
  return { user: FAKE_SCM_USER, branches: {}, calls: [] };
}

export function readFakeScm(fakeDir: string): FakeScmStore {
  return readFakeStore(fakeDir, FAKE_SCM_FILE, emptyFakeScmStore());
}

export interface FakeScmProviderInput {
  fakeDir: string;
  now(): Date;
}

/**
 * Spec §3.2 `fake` SCM provider, persisted under `fake/scm.json`.
 *
 * T10 replaces it with the full provider. `ensureBranch` only records that a branch should exist: it must never
 * run git, because the orchestrator — not the SCM provider and never an agent — owns every git write (§32 rule 11).
 */
export function createFakeScmProvider(input: FakeScmProviderInput): ScmProvider {
  const record = (store: FakeScmStore, call: FakeScmCall): void => {
    store.calls.push(call);
    writeFakeStore(input.fakeDir, FAKE_SCM_FILE, store);
  };
  return {
    name: 'fake',
    currentUser: async () => {
      const store = readFakeScm(input.fakeDir);
      record(store, { kind: 'currentUser', repo: null, branch: null, at: input.now().toISOString() });
      return store.user;
    },
    ensureBranch: async (repo, name, base) => {
      const store = readFakeScm(input.fakeDir);
      const branches = store.branches[repo] ?? {};
      if (!(name in branches)) branches[name] = base;
      store.branches[repo] = branches;
      record(store, { kind: 'ensureBranch', repo, branch: name, at: input.now().toISOString() });
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/providers/fake-ci-scm.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Point `testProviders` at the real fakes**

In `tests/helpers/engine-fixtures.ts`, add the imports and replace the inline `ci`/`scm` literals:

```ts
import { createFakeCiProvider } from '../../src/providers/fake/ci.js';
import { createFakeScmProvider } from '../../src/providers/fake/scm.js';
```

```ts
export function testProviders(fakeDir: string, now: () => Date = () => new Date()): Providers {
  return {
    agent: createFakeAgentRunner({ fakeDir, now }),
    ci: createFakeCiProvider({ fakeDir, now }),
    scm: createFakeScmProvider({ fakeDir, now }),
  };
}
```

- [ ] **Step 7: Run the unit lane and typecheck**

Run: `pnpm test:unit && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/providers/fake/ci.ts src/providers/fake/scm.ts tests/providers/fake-ci-scm.test.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(providers): add persisted fake CI and fake SCM stubs"
```

---

## Task 5: The `createProviders` factory wired into `janus run`

**Files:**
- Create: `src/providers/index.ts`
- Modify: `src/cli/commands/run.ts:1-12, 71-81`
- Modify: `src/cli/main.ts:1-11, 29-55`
- Test: `tests/providers/create-providers.test.ts`, `tests/cli/run.test.ts`

**Interfaces:**
- Consumes: `Providers` (Task 2); the three `create*` functions (Tasks 3, 4); `JanusConfig`; `WorkspacePaths`.
- Produces:
  - `class ProviderNotImplementedError extends Error { readonly task: string }`
  - `interface CreateProvidersInput { config: JanusConfig; paths: WorkspacePaths; now(): Date }`
  - `createProviders(input: CreateProvidersInput): Providers`
  - `exitCodeForError` maps `ProviderNotImplementedError` to `ExitCode.NotImplemented` (3).

- [ ] **Step 1: Write the failing test**

Create `tests/providers/create-providers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { createProviders, ProviderNotImplementedError } from '../../src/providers/index.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

const paths = () => workspacePaths(tempDir('janus-providers-'));
const now = () => new Date('2026-09-20T12:00:00.000Z');

function config(workflow: Record<string, string>) {
  return configSchema.parse({ workflow, teamcity: { url: 'https://tc.invalid' }, bitbucket: { url: 'https://bb.invalid' } });
}

describe('createProviders', () => {
  it('builds the three fakes rooted at the workspace fake/ directory', () => {
    const providers = createProviders({
      config: config({ agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' }),
      paths: paths(),
      now,
    });
    expect(providers.agent.name).toBe('fake');
    expect(providers.ci.name).toBe('fake');
    expect(providers.scm.name).toBe('fake');
  });

  it('names the task that will implement each real provider', () => {
    const attempt = (workflow: Record<string, string>): ProviderNotImplementedError => {
      try {
        createProviders({ config: config(workflow), paths: paths(), now });
      } catch (error) {
        if (error instanceof ProviderNotImplementedError) return error;
        throw error;
      }
      throw new Error('expected createProviders to throw');
    };

    const agent = attempt({ agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' });
    expect(agent.task).toBe('T05');
    expect(agent.message).toContain('agent runner "codex" is not implemented yet (planned in T05)');
    expect(agent.message).toContain('workflow.agent_runner: fake');

    expect(attempt({ agent_runner: 'fake', ci_provider: 'teamcity', scm_provider: 'fake' }).task).toBe('T09');
    expect(attempt({ agent_runner: 'fake', ci_provider: 'local', scm_provider: 'fake' }).task).toBe('T09');
    expect(attempt({ agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'bitbucket-server' }).task).toBe('T10');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/providers/create-providers.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/providers/index.js"`.

- [ ] **Step 3: Implement the factory**

Create `src/providers/index.ts`:

```ts
import type { JanusConfig } from '../config/config-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { createFakeAgentRunner } from './fake/agent-runner.js';
import { createFakeCiProvider } from './fake/ci.js';
import { createFakeScmProvider } from './fake/scm.js';
import type { Providers } from './types.js';

/** A provider `config.yaml` selects that no task has implemented yet. Maps to exit 3, like a placeholder step. */
export class ProviderNotImplementedError extends Error {
  /** The task that will implement it, for the operator's message. */
  readonly task: string;

  constructor(what: string, task: string, fallback: string) {
    super(`${what} is not implemented yet (planned in ${task}); set ${fallback} in .janus/config.yaml to use the fake`);
    this.name = 'ProviderNotImplementedError';
    this.task = task;
  }
}

export interface CreateProvidersInput {
  config: JanusConfig;
  paths: WorkspacePaths;
  now(): Date;
}

/**
 * Spec §3.2: builds the provider bag for one `janus run` from `workflow.*`. Every fake persists under
 * `<workspace>/fake/` (§5). Real adapters arrive with T05 (Codex), T09 (TeamCity and `local`), and T10 (Bitbucket).
 */
export function createProviders(input: CreateProvidersInput): Providers {
  const { workflow } = input.config;
  const fakeDir = input.paths.fakeDir;
  if (workflow.agent_runner !== 'fake') {
    throw new ProviderNotImplementedError(`agent runner "${workflow.agent_runner}"`, 'T05', 'workflow.agent_runner: fake');
  }
  if (workflow.ci_provider !== 'fake') {
    throw new ProviderNotImplementedError(`CI provider "${workflow.ci_provider}"`, 'T09', 'workflow.ci_provider: fake');
  }
  if (workflow.scm_provider !== 'fake') {
    throw new ProviderNotImplementedError(`SCM provider "${workflow.scm_provider}"`, 'T10', 'workflow.scm_provider: fake');
  }
  return {
    agent: createFakeAgentRunner({ fakeDir, now: input.now }),
    ci: createFakeCiProvider({ fakeDir, now: input.now }),
    scm: createFakeScmProvider({ fakeDir, now: input.now }),
  };
}

export type { AgentRunner, AgentRunOutcome, AgentRunRequest, CiProvider, Providers, ScmProvider } from './types.js';
```

- [ ] **Step 4: Run the factory test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/providers/create-providers.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing CLI test**

Append to `tests/cli/run.test.ts`, inside its top-level `describe`:

```ts
  it('exits 3 and names the task when config selects a provider that is not implemented yet', async () => {
    const ws = await initWorkspace();
    const configPath = join(ws.janusDir, CONFIG_FILE);
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['workflow'] = { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' };
    writeFileSync(configPath, stringify(config));

    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toContain('agent runner "codex" is not implemented yet (planned in T05)');
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
  });
```

Add whatever of `readFileSync`, `writeFileSync`, `existsSync`, `join`, `parse`, `stringify`, `CONFIG_FILE`, `initWorkspace`, `scriptedSteps`, `ExitCode`, `runCli` the file does not already import (`tests/engine/run-loop.test.ts` shows the same `parse`/`stringify` config-rewrite pattern).

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/cli/run.test.ts`
Expected: FAIL — `expected 1 to be 3` (the error currently falls through to `UnexpectedError`), or a missing-`providers` compile error.

- [ ] **Step 7: Wire the factory into `janus run` and the error into `main`**

In `src/cli/commands/run.ts`, add the import:

```ts
import { createProviders } from '../../providers/index.js';
```

and, inside `runCommand`, replace the `createEngine`/`runEngine` block (currently lines 76-81) with:

```ts
    // After the --dry-run return, so a dry run never has to satisfy the provider configuration.
    const providers = ctx.providers ?? createProviders({ config: workspace.config, paths: workspace.paths, now: () => new Date() });
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await runEngine({ engine, steps, until, maxWaitMs, modelProfile, providers });
```

In `src/cli/main.ts`, add the import:

```ts
import { ProviderNotImplementedError } from '../providers/index.js';
```

and add this branch to `exitCodeForError`, directly after the `GateError` branch:

```ts
  if (error instanceof ProviderNotImplementedError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.NotImplemented;
  }
```

- [ ] **Step 8: Run the CLI tests to verify they pass**

Run: `pnpm exec vitest run --project unit tests/cli`
Expected: PASS.

- [ ] **Step 9: Run the whole unit lane, lint, and typecheck**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/providers/index.ts src/cli/commands/run.ts src/cli/main.ts tests/providers/create-providers.test.ts tests/cli/run.test.ts
git commit -m "feat(providers): select providers from config in janus run"
```

---

## Task 6: Reflog primitives in the git module

**Files:**
- Modify: `src/git/tree.ts:61-77`
- Test: `tests/git/tree.test.ts:87-95`

**Interfaces:**
- Consumes: `runGit`, `GitError` from `src/git/run.ts`; the existing `ReflogEntry` type.
- Produces:
  - `listRefs(cwd: string): Promise<string[]>`
  - `reflogExists(cwd: string, ref: string): Promise<boolean>`
  - `reflog(cwd: string, ref?: string): Promise<ReflogEntry[]>` — `ref` defaults to `'HEAD'`, so every existing caller is unchanged.

- [ ] **Step 1: Write the failing test**

Replace the existing `describe('reflog', ...)` block in `tests/git/tree.test.ts` with:

```ts
describe('reflog', () => {
  it('lists HEAD movements newest first', async () => {
    const dir = await repoWithFile();
    const second = await commitAll(dir, 'chore(r): second', { allowEmpty: true });
    const entries = await reflog(dir);
    expect(entries[0]?.sha).toBe(second);
    expect(entries[0]?.subject).toContain('second');
    expect(entries.map((entry) => entry.selector)).toContain('HEAD@{0}');
  });

  it('reads the reflog of a named ref', async () => {
    const dir = await repoWithFile();
    await commitAll(dir, 'chore(r): second', { allowEmpty: true });
    const entries = await reflog(dir, 'refs/heads/main');
    expect(entries[0]?.selector).toBe('main@{0}');
    expect(entries[0]?.subject).toContain('second');
  });
});

describe('listRefs', () => {
  it('lists every ref in the repository', async () => {
    const dir = await repoWithFile();
    await runGit(dir, ['branch', 'side']);
    await runGit(dir, ['tag', 'v1']);
    expect(await listRefs(dir)).toEqual(['refs/heads/main', 'refs/heads/side', 'refs/tags/v1']);
  });
});

describe('reflogExists', () => {
  it('is true for a ref git logs and false for one it does not', async () => {
    const dir = await repoWithFile();
    expect(await reflogExists(dir, 'HEAD')).toBe(true);
    expect(await reflogExists(dir, 'refs/heads/main')).toBe(true);
    // A tag never gets a reflog, and `git reflog show` would silently fall back to a plain log for it.
    await runGit(dir, ['tag', 'v1']);
    expect(await reflogExists(dir, 'refs/tags/v1')).toBe(false);
    expect(await reflogExists(dir, 'refs/heads/does-not-exist')).toBe(false);
  });
});
```

Add `listRefs` and `reflogExists` to the existing `import { merge, reflog, resetHard, workingTreeDiff } from '../../src/git/tree.js';` line, and add `import { runGit } from '../../src/git/run.js';` if the file does not already import it.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/git/tree.test.ts`
Expected: FAIL — `listRefs is not a function`.

- [ ] **Step 3: Implement the three helpers**

In `src/git/tree.ts`, replace the existing `reflog` function with:

```ts
/** Every ref in the repository (branches, tags, remote-tracking), in git's own sorted order. */
export async function listRefs(cwd: string): Promise<string[]> {
  const output = await runGit(cwd, ['for-each-ref', '--format=%(refname)']);
  return output === '' ? [] : output.split('\n');
}

/**
 * True when `ref` has a reflog.
 *
 * `git reflog show <ref>` on a ref without one silently falls back to a plain log of that ref, which would make
 * an audit report commits that were never ref *updates*; callers check this first.
 */
export async function reflogExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await runGit(cwd, ['reflog', 'exists', ref]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return false;
    throw error;
  }
}

/** Reflog of `ref` (HEAD by default), newest first. Used to audit that no agent process moved a ref (§31.29). */
export async function reflog(cwd: string, ref = 'HEAD'): Promise<ReflogEntry[]> {
  const output = await runGit(cwd, ['reflog', 'show', '--format=%H%x1f%gd%x1f%gs', ref]);
  if (output === '') return [];
  return output.split('\n').map((line) => {
    const [sha = '', selector = '', subject = ''] = line.split(FIELD_SEPARATOR);
    return { sha, selector, subject };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/git/tree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git/tree.ts tests/git/tree.test.ts
git commit -m "feat(git): read any ref's reflog and list refs for the write audit"
```

---

## Task 7: Multi-repo graph fixture with `depends_on`

**Files:**
- Modify: `tests/helpers/workspace-fixtures.ts` (whole file)
- Test: `tests/helpers/graph-fixture.test.ts` (create — a unit test, since it exercises the fixture itself)

**Interfaces:**
- Consumes: `createBareRepo`, `createRemoteWithCommit`, `tempDir`, `RemoteFixture` from `tests/helpers/git-fixtures.ts`; `runGit`; `loadGoal`.
- Produces:
  - `interface RepoGraphSpec { name: string; kind?: GoalRepo['kind']; dependsOn?: string[]; coupledWith?: string[]; loadsRemotes?: string[] }`
  - `interface GraphFixtureOptions { goalId?: string; e2e?: { build_type_id: string; branch_params: Record<string, string> } }`
  - `interface GraphFixture { dir; goalId; goalPath; configPath; goalText; stateBare; repos: Record<string, RemoteFixture>; names: string[]; tempRoots: string[] }`
  - `graphFixture(specs: RepoGraphSpec[], options?: GraphFixtureOptions): Promise<GraphFixture>`
  - `goalFixture(): Promise<GoalFixture>` — unchanged signature and fields, now implemented on top of `graphFixture`.

- [ ] **Step 1: Write the failing test**

Create `tests/helpers/graph-fixture.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGoal } from '../../src/config/load-goal.js';
import { runGit } from '../../src/git/run.js';
import { goalFixture, graphFixture } from './workspace-fixtures.js';

describe('graphFixture', () => {
  it('writes a goal.yaml the real loader accepts and orders topologically', async () => {
    const fixture = await graphFixture([
      { name: 'ui-kit', kind: 'library' },
      { name: 'orders-remote', kind: 'remote', dependsOn: ['ui-kit'] },
      { name: 'shell', kind: 'shell', dependsOn: ['ui-kit', 'orders-remote'], loadsRemotes: ['orders-remote'] },
    ]);

    const { goal, repoOrder } = loadGoal(fixture.goalPath);
    expect(repoOrder).toEqual(['ui-kit', 'orders-remote', 'shell']);
    expect(goal.repos.map((repo) => repo.depends_on)).toEqual([[], ['ui-kit'], ['ui-kit', 'orders-remote']]);
    expect(goal.repos[2]?.loads_remotes).toEqual(['orders-remote']);
    expect(goal.repos[0]?.clone_url).toBe(fixture.repos['ui-kit']?.bare);
    expect(goal.e2e.branch_params).toEqual({ shell: 'env.SHELL_BRANCH' });
    expect(goal.repos[1]?.ci.pr_build_type_id).toBe('Fe_OrdersRemote_Build');
  });

  it('omits empty relation lists and enables reflogs on every bare remote', async () => {
    const fixture = await graphFixture([{ name: 'ui-kit', kind: 'library' }]);
    expect(readFileSync(fixture.goalPath, 'utf8')).not.toContain('depends_on');
    expect(readFileSync(fixture.goalPath, 'utf8')).not.toContain('coupled_with');
    const bare = fixture.repos['ui-kit']?.bare;
    if (bare === undefined) throw new Error('expected a ui-kit remote');
    expect(await runGit(bare, ['config', '--get', 'core.logAllRefUpdates'])).toBe('true');
    expect(await runGit(fixture.stateBare, ['config', '--get', 'core.logAllRefUpdates'])).toBe('true');
    expect(fixture.tempRoots.length).toBeGreaterThanOrEqual(3);
  });
});

describe('goalFixture', () => {
  it('still produces the two-repo ui-kit/shell goal the existing tests rely on', async () => {
    const fixture = await goalFixture();
    const { goal, repoOrder } = loadGoal(fixture.goalPath);
    expect(repoOrder).toEqual(['ui-kit', 'shell']);
    expect(goal.id).toBe('angular-15-to-16');
    expect(fixture.goalText).toContain(`clone_url: ${fixture.uiKit.bare}`);
    expect(goal.e2e.branch_params).toEqual({ shell: 'env.SHELL_BRANCH' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/helpers/graph-fixture.test.ts`
Expected: FAIL — `graphFixture is not a function`.

- [ ] **Step 3: Rewrite `tests/helpers/workspace-fixtures.ts`**

```ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import type { GoalRepo } from '../../src/config/goal-schema.js';
import { runGit } from '../../src/git/run.js';
import { createBareRepo, createRemoteWithCommit, tempDir } from './git-fixtures.js';
import type { RemoteFixture } from './git-fixtures.js';

/** One node of the `depends_on` graph a fixture builds (spec §4). */
export interface RepoGraphSpec {
  name: string;
  /** Defaults to `library`. */
  kind?: GoalRepo['kind'];
  depends_on?: never;
  dependsOn?: string[];
  coupledWith?: string[];
  loadsRemotes?: string[];
}

export interface GraphFixtureE2e {
  build_type_id: string;
  branch_params: Record<string, string>;
}

export interface GraphFixtureOptions {
  goalId?: string;
  /** Overrides the derived `e2e` block. */
  e2e?: GraphFixtureE2e;
}

export interface GraphFixture {
  dir: string;
  goalId: string;
  goalPath: string;
  configPath: string;
  goalText: string;
  stateBare: string;
  /** Repo name -> its bare remote and the working clone it was built from. */
  repos: Record<string, RemoteFixture>;
  /** Declaration order; `loadGoal` computes the topological order. */
  names: string[];
  /** Every mkdtemp root this fixture created, so a caller can remove them all. */
  tempRoots: string[];
}

/** `ui-kit` -> `UiKit`, for the TeamCity-style build type ids. */
function pascalCase(name: string): string {
  return name
    .split('-')
    .map((part) => (part === '' ? '' : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('');
}

/** `env.<NAME>_BRANCH` for every deployable repo, matching the §4 goal example. */
function deriveE2e(specs: readonly RepoGraphSpec[]): GraphFixtureE2e {
  const branchParams: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.kind === 'shell' || spec.kind === 'app') {
      branchParams[spec.name] = `env.${spec.name.replace(/-/g, '_').toUpperCase()}_BRANCH`;
    }
  }
  return { build_type_id: 'Fe_E2E_Full', branch_params: branchParams };
}

/**
 * N working repos with one commit each and a bare clone as their remote, a bare state remote, and the
 * `goal.yaml` / `config.yaml` pair that points at them with fake providers. `depends_on`, `coupled_with`, and
 * `loads_remotes` are written verbatim and omitted when empty, so the file stays the shape §4 describes and the
 * existing `loadGoal` / `validateGoal` accept unchanged. Bare repos get `core.logAllRefUpdates` (off by default
 * in a bare repo) so a push into them is witnessed by the §31.29 reflog audit.
 */
export async function graphFixture(specs: RepoGraphSpec[], options: GraphFixtureOptions = {}): Promise<GraphFixture> {
  const goalId = options.goalId ?? 'angular-15-to-16';
  const dir = tempDir('janus-goal-');
  const tempRoots = [dir];
  const repos: Record<string, RemoteFixture> = {};

  for (const spec of specs) {
    const remote = await createRemoteWithCommit(spec.name);
    await runGit(remote.bare, ['config', 'core.logAllRefUpdates', 'true']);
    repos[spec.name] = remote;
    tempRoots.push(dirname(remote.bare));
  }
  const stateBare = await createBareRepo('janus-state', `janus/${goalId}`);
  await runGit(stateBare, ['config', 'core.logAllRefUpdates', 'true']);
  tempRoots.push(dirname(stateBare));

  const goalRepos = specs.map((spec) => {
    const remote = repos[spec.name];
    if (remote === undefined) throw new Error(`graphFixture: no remote was created for ${spec.name}`);
    const dependsOn = spec.dependsOn ?? [];
    const coupledWith = spec.coupledWith ?? [];
    const loadsRemotes = spec.loadsRemotes ?? [];
    return {
      name: spec.name,
      kind: spec.kind ?? 'library',
      scm: { project: 'FE', slug: spec.name },
      base_branch: 'main',
      clone_url: remote.bare,
      ci: { pr_build_type_id: `Fe_${pascalCase(spec.name)}_Build` },
      ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
      ...(coupledWith.length === 0 ? {} : { coupled_with: coupledWith }),
      ...(loadsRemotes.length === 0 ? {} : { loads_remotes: loadsRemotes }),
    };
  });

  const goal = {
    id: goalId,
    source_version: '15',
    target_version: '16',
    title: 'Upgrade Angular 15 to 16',
    repos: goalRepos,
    e2e: options.e2e ?? deriveE2e(specs),
  };
  const goalText = stringify(goal);
  const goalPath = join(dir, 'goal.yaml');
  const configPath = join(dir, 'config.yaml');
  writeFileSync(goalPath, goalText);
  writeFileSync(
    configPath,
    stringify({
      workflow: { agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' },
      state: { clone_url: stateBare },
    }),
  );
  return { dir, goalId, goalPath, configPath, goalText, stateBare, repos, names: specs.map((spec) => spec.name), tempRoots };
}

export interface GoalFixture {
  dir: string;
  goalId: string;
  goalPath: string;
  configPath: string;
  goalText: string;
  uiKit: RemoteFixture;
  shell: RemoteFixture;
  stateBare: string;
}

const DEFAULT_SPECS: RepoGraphSpec[] = [
  { name: 'ui-kit', kind: 'library' },
  { name: 'shell', kind: 'shell', dependsOn: ['ui-kit'] },
];

/** Two bare product remotes with one commit each, a bare state remote, and goal/config files with fake providers. */
export async function goalFixture(): Promise<GoalFixture> {
  const graph = await graphFixture(DEFAULT_SPECS);
  const uiKit = graph.repos['ui-kit'];
  const shell = graph.repos['shell'];
  if (uiKit === undefined || shell === undefined) {
    throw new Error('goalFixture: the graph fixture did not create both ui-kit and shell');
  }
  return {
    dir: graph.dir,
    goalId: graph.goalId,
    goalPath: graph.goalPath,
    configPath: graph.configPath,
    goalText: graph.goalText,
    uiKit,
    shell,
    stateBare: graph.stateBare,
  };
}
```

(The `depends_on?: never` member on `RepoGraphSpec` is deliberate: it makes the snake_case spelling a compile error, so a caller cannot silently write `depends_on` and have it ignored.)

- [ ] **Step 4: Run the fixture test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/helpers/graph-fixture.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole unit lane to prove nothing regressed**

Run: `pnpm test:unit`
Expected: PASS — every test that uses `goalFixture()` (`tests/cli/init-create.test.ts`, `tests/cli/init-resume.test.ts`, everything via `initWorkspace`) is green.

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/workspace-fixtures.ts tests/helpers/graph-fixture.test.ts
git commit -m "test(harness): build goal fixtures from an N-repo depends_on graph"
```

---

## Task 8: The git-write audit (§31.29)

**Files:**
- Create: `tests/integration/harness/git-audit.ts`
- Test: `tests/integration/git-audit.test.ts`

**Interfaces:**
- Consumes: `listRefs`, `reflog`, `reflogExists` (Task 6); `AgentRunner`, `AgentRunRequest`, `AgentRunOutcome` (Task 2).
- Produces:
  - `interface AuditTarget { label: string; dir: string }`
  - `type RefLogs = Map<string, string[]>` and `type RefLogSnapshot = Map<string, RefLogs>`
  - `interface GitWrite { label: string; ref: string; sha: string; subject: string }`
  - `interface AgentGitWrite extends GitWrite { runId: string; role: string }`
  - `captureRefLogs(targets: readonly AuditTarget[]): Promise<RefLogSnapshot>`
  - `diffRefLogs(before: RefLogSnapshot, after: RefLogSnapshot): GitWrite[]`
  - `formatGitWrites(writes: readonly AgentGitWrite[]): string`
  - `auditAgentRunner(inner: AgentRunner, targets: readonly AuditTarget[], sink: AgentGitWrite[]): AgentRunner`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/git-audit.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { auditAgentRunner, captureRefLogs, diffRefLogs, formatGitWrites } from './harness/git-audit.js';
import type { AgentGitWrite } from './harness/git-audit.js';

async function repo(name: string): Promise<string> {
  const dir = join(tempDir(`janus-audit-${name}-`), name);
  mkdirSync(dir, { recursive: true });
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  await commitAll(dir, 'chore(init): initial commit');
  return dir;
}

const quiet: AgentRunner = {
  name: 'fake',
  run: async (request) => ({ runId: request.runId, status: 'completed', summary: 'wrote a file, touched no git' }),
};

describe('captureRefLogs and diffRefLogs', () => {
  it('reports nothing when no ref moved', async () => {
    const dir = await repo('quiet');
    const targets = [{ label: 'repos/quiet', dir }];
    const before = await captureRefLogs(targets);
    writeFileSync(join(dir, 'note.txt'), 'an agent may write files\n');
    expect(diffRefLogs(before, await captureRefLogs(targets))).toEqual([]);
  });

  it('reports a commit, a branch creation, and a push', async () => {
    const dir = await repo('busy');
    const bare = join(tempDir('janus-audit-bare-'), 'busy.git');
    await runGit(tempDir('janus-audit-init-'), ['init', '-q', '--bare', '-b', 'main', bare]);
    await runGit(bare, ['config', 'core.logAllRefUpdates', 'true']);
    await runGit(dir, ['remote', 'add', 'origin', bare]);
    const targets = [
      { label: 'repos/busy', dir },
      { label: 'remote:busy', dir: bare },
    ];

    const before = await captureRefLogs(targets);
    await runGit(dir, ['checkout', '-q', '-b', 'ai/goal']);
    const sha = await commitAll(dir, 'feat(busy): agent wrote this', { allowEmpty: true });
    await runGit(dir, ['push', '-q', 'origin', 'ai/goal:ai/goal']);
    const writes = diffRefLogs(before, await captureRefLogs(targets));

    expect(writes.map((write) => `${write.label} ${write.ref}`)).toEqual(
      expect.arrayContaining([
        'repos/busy HEAD',
        'repos/busy refs/heads/ai/goal',
        'repos/busy refs/remotes/origin/ai/goal',
        'remote:busy refs/heads/ai/goal',
      ]),
    );
    expect(writes.some((write) => write.sha === sha && write.subject.includes('agent wrote this'))).toBe(true);
  });
});

describe('auditAgentRunner', () => {
  it('records nothing for an agent that only writes files', async () => {
    const dir = await repo('clean');
    const sink: AgentGitWrite[] = [];
    const runner = auditAgentRunner(quiet, [{ label: 'repos/clean', dir }], sink);
    const outcome = await runner.run({ runId: 'run-0001', role: 'implementation', repo: 'clean' });
    expect(outcome.status).toBe('completed');
    expect(sink).toEqual([]);
  });

  it('records a git write made inside the agent window and formats it for the failure message', async () => {
    const dir = await repo('naughty');
    const sink: AgentGitWrite[] = [];
    const committing: AgentRunner = {
      name: 'fake',
      run: async (request) => {
        await commitAll(dir, 'feat(naughty): commit: agent wrote this', { allowEmpty: true });
        return { runId: request.runId, status: 'completed', summary: 'committed, which it must not do' };
      },
    };
    const runner = auditAgentRunner(committing, [{ label: 'repos/naughty', dir }], sink);
    await runner.run({ runId: 'run-0007', role: 'implementation', repo: 'naughty' });

    expect(sink.length).toBeGreaterThan(0);
    expect(sink.every((write) => write.runId === 'run-0007' && write.role === 'implementation')).toBe(true);
    const message = formatGitWrites(sink);
    expect(message).toContain('repos/naughty');
    expect(message).toContain('agent wrote this');
    expect(message).toContain('(during agent run run-0007, role implementation)');
  });

  it('still records the writes when the agent throws', async () => {
    const dir = await repo('throwing');
    const sink: AgentGitWrite[] = [];
    const runner = auditAgentRunner(
      {
        name: 'fake',
        run: async () => {
          await commitAll(dir, 'feat(throwing): sneaky', { allowEmpty: true });
          throw new Error('agent crashed');
        },
      },
      [{ label: 'repos/throwing', dir }],
      sink,
    );
    await expect(runner.run({ runId: 'run-0008', role: 'debug', repo: 'throwing' })).rejects.toThrow('agent crashed');
    expect(sink.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — `Failed to resolve import "./harness/git-audit.js"`.

- [ ] **Step 3: Implement the audit**

Create `tests/integration/harness/git-audit.ts`:

```ts
import { listRefs, reflog, reflogExists } from '../../../src/git/tree.js';
import type { AgentRunOutcome, AgentRunRequest, AgentRunner } from '../../../src/providers/types.js';

/** One audited git repository: a label used in failure messages and the directory git runs in. */
export interface AuditTarget {
  label: string;
  dir: string;
}

/** ref -> its reflog entries as `"<sha> <subject>"`, newest first. */
export type RefLogs = Map<string, string[]>;

/** target label -> that target's reflogs. */
export type RefLogSnapshot = Map<string, RefLogs>;

/** A ref update that appeared between two snapshots. */
export interface GitWrite {
  label: string;
  ref: string;
  sha: string;
  subject: string;
}

/** A git write that happened while an agent's `run()` was in flight: a spec §31.29 violation. */
export interface AgentGitWrite extends GitWrite {
  runId: string;
  role: string;
}

/**
 * Reads HEAD's reflog plus the reflog of every ref `git for-each-ref` reports, for every target.
 *
 * Remote-tracking refs are included on purpose: they are how a `git push` from inside a workspace clone becomes
 * visible ("update by push"). The bare repositories the fixtures create enable `core.logAllRefUpdates`, so a push
 * is witnessed on the receiving side too.
 */
export async function captureRefLogs(targets: readonly AuditTarget[]): Promise<RefLogSnapshot> {
  const snapshot: RefLogSnapshot = new Map();
  for (const target of targets) {
    const refs: RefLogs = new Map();
    for (const ref of ['HEAD', ...(await listRefs(target.dir))]) {
      if (!(await reflogExists(target.dir, ref))) continue;
      const entries = await reflog(target.dir, ref);
      refs.set(
        ref,
        entries.map((entry) => `${entry.sha} ${entry.subject}`),
      );
    }
    snapshot.set(target.label, refs);
  }
  return snapshot;
}

/**
 * Entries present in `after` but not in `before`.
 *
 * A reflog only grows at the front, so the entries added during the window are the prefix of the new list that
 * sits on top of the old one. When the new list is not the old list with a prefix added — a ref was deleted and
 * recreated, or a reflog was rewritten, both of which are themselves git writes — the whole new list is reported.
 */
export function diffRefLogs(before: RefLogSnapshot, after: RefLogSnapshot): GitWrite[] {
  const writes: GitWrite[] = [];
  for (const [label, refs] of after) {
    const previousRefs = before.get(label) ?? new Map<string, string[]>();
    for (const [ref, entries] of refs) {
      const previous = previousRefs.get(ref) ?? [];
      const grew = entries.length >= previous.length && sameTail(entries, previous);
      const added = grew ? entries.slice(0, entries.length - previous.length) : entries;
      for (const entry of added) {
        const space = entry.indexOf(' ');
        const sha = space === -1 ? entry : entry.slice(0, space);
        const subject = space === -1 ? '' : entry.slice(space + 1);
        writes.push({ label, ref, sha, subject });
      }
    }
  }
  return writes;
}

function sameTail(entries: readonly string[], previous: readonly string[]): boolean {
  const offset = entries.length - previous.length;
  return previous.every((entry, index) => entries[offset + index] === entry);
}

/** One indented line per violation, for the `expectNoAgentGitWrites` failure message. */
export function formatGitWrites(writes: readonly AgentGitWrite[]): string {
  return writes
    .map(
      (write) =>
        `  ${write.label} ${write.ref} ${write.sha.slice(0, 7)} "${write.subject}" (during agent run ${write.runId}, role ${write.role})`,
    )
    .join('\n');
}

/**
 * Spec §31.29 and §32 rule 11.
 *
 * Wraps an AgentRunner so that every `run()` is bracketed by a reflog snapshot of every git repository the
 * workspace touches; any ref update inside that window is pushed into `sink`. The second snapshot is taken in a
 * `finally`, so an agent that writes and then throws is still caught.
 */
export function auditAgentRunner(inner: AgentRunner, targets: readonly AuditTarget[], sink: AgentGitWrite[]): AgentRunner {
  return {
    name: inner.name,
    run: async (request: AgentRunRequest): Promise<AgentRunOutcome> => {
      const before = await captureRefLogs(targets);
      try {
        return await inner.run(request);
      } finally {
        for (const write of diffRefLogs(before, await captureRefLogs(targets))) {
          sink.push({ ...write, runId: request.runId, role: request.role });
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:integration`
Expected: PASS (5 tests across `lane.test.ts` and `git-audit.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/harness/git-audit.ts tests/integration/git-audit.test.ts
git commit -m "test(harness): audit reflogs so an agent git write fails the suite"
```

---

## Task 9: The harness handle

**Files:**
- Create: `tests/integration/harness/harness.ts`
- Test: `tests/integration/harness.test.ts` (create)

**Interfaces:**
- Consumes: `graphFixture`, `RepoGraphSpec`, `GraphFixture` (Task 7); the three fakes and `seedFakeAgents` (Tasks 3, 4); `auditAgentRunner`, `AgentGitWrite`, `AuditTarget`, `formatGitWrites` (Task 8); `runCli`, `CliResult`; `workspacePaths`; `readState`; `readEvents`; `remoteHead`, `revParse`; `EVIDENCE_DIR`; `onTestFinished` from vitest.
- Produces:
  - `interface HarnessOptions { goalId?: string; agents?: FakeAgentStore['script']; now?: () => Date; agentRunner?: AgentRunner }`
  - `interface Harness { fixture; root; janusDir; fakeDir; stateBranch; providers; agentGitWrites; auditTargets; run(argv, overrides?); state(); events(); evidence(relativePath); cleanup() }`
  - `createHarness(specs: RepoGraphSpec[], options?: HarnessOptions): Promise<Harness>`
  - `expectNoAgentGitWrites(harness: Harness): void`
  - `expectStatePushed(harness: Harness): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `tests/integration/harness.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { readFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { createHarness, expectNoAgentGitWrites } from './harness/harness.js';

const SPECS = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit'] },
];

describe('createHarness', () => {
  it('initializes a workspace, seeds the agent script, and audits every repository', async () => {
    const harness = await createHarness(SPECS, {
      agents: { discovery: [{ status: 'completed', summary: 'scripted discovery' }] },
      now: () => new Date('2026-09-20T13:00:00.000Z'),
    });

    expect(harness.state().goal.status).toBe('created');
    expect(existsSync(harness.fakeDir)).toBe(true);
    expect(harness.auditTargets.map((target) => target.label).sort()).toEqual(
      ['.janus', 'remote:shell', 'remote:state', 'remote:ui-kit', 'repos/shell', 'repos/ui-kit'].sort(),
    );

    const outcome = await harness.providers.agent.run({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' });
    expect(outcome.summary).toBe('scripted discovery');
    expect(readFakeAgents(harness.fakeDir).calls).toHaveLength(1);
    expectNoAgentGitWrites(harness);
  });

  it('runs the CLI in the workspace with the audited providers injected', async () => {
    const harness = await createHarness(SPECS);
    const result = await harness.run(['run', '--dry-run']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: created');
  });

  it('explains which evidence files exist when one is missing', async () => {
    const harness = await createHarness(SPECS);
    expect(() => harness.evidence('agents/run-9999.yaml')).toThrow('no evidence file agents/run-9999.yaml');
  });

  it('removes every temp directory it created', async () => {
    const harness = await createHarness(SPECS);
    const root = harness.root;
    const bare = harness.fixture.repos['ui-kit']?.bare;
    if (bare === undefined) throw new Error('expected a ui-kit remote');
    harness.cleanup();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(join(harness.fixture.dir, 'goal.yaml'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — `Failed to resolve import "./harness/harness.js"`.

- [ ] **Step 3: Implement the harness**

Create `tests/integration/harness/harness.ts`:

```ts
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { CliOverrides } from '../../../src/cli/context.js';
import { ExitCode } from '../../../src/cli/exit-codes.js';
import { remoteHead, revParse } from '../../../src/git/ops.js';
import { createFakeAgentRunner, seedFakeAgents } from '../../../src/providers/fake/agent-runner.js';
import type { FakeAgentStore } from '../../../src/providers/fake/agent-runner.js';
import { createFakeCiProvider } from '../../../src/providers/fake/ci.js';
import { createFakeScmProvider } from '../../../src/providers/fake/scm.js';
import type { AgentRunner, Providers } from '../../../src/providers/types.js';
import { EVIDENCE_DIR } from '../../../src/state/files.js';
import type { JanusState } from '../../../src/state/state-schema.js';
import { readState } from '../../../src/state/state-store.js';
import { readEvents } from '../../../src/telemetry/events.js';
import type { RecordedEvent } from '../../../src/telemetry/events.js';
import { workspacePaths } from '../../../src/workspace/layout.js';
import { stateBranchName } from '../../../src/workspace/remotes.js';
import { tempDir } from '../../helpers/git-fixtures.js';
import { runCli } from '../../helpers/run-cli.js';
import type { CliResult } from '../../helpers/run-cli.js';
import { graphFixture } from '../../helpers/workspace-fixtures.js';
import type { GraphFixture, RepoGraphSpec } from '../../helpers/workspace-fixtures.js';
import { auditAgentRunner, formatGitWrites } from './git-audit.js';
import type { AgentGitWrite, AuditTarget } from './git-audit.js';

export interface HarnessOptions {
  goalId?: string;
  /** Seeds `fake/agents.json` (spec §18.5) before the first run. */
  agents?: FakeAgentStore['script'];
  /** Fixed clock for the fakes, so their persisted stores are deterministic. */
  now?: () => Date;
  /** Replaces the fake agent runner; the audit wrapper is applied to whatever is passed. */
  agentRunner?: AgentRunner;
}

export interface Harness {
  fixture: GraphFixture;
  root: string;
  janusDir: string;
  fakeDir: string;
  stateBranch: string;
  /** The audited provider bag the CLI is given on every `run`. */
  providers: Providers;
  /** Spec §31.29: git writes observed while an agent was in flight. Empty on a healthy run. */
  agentGitWrites: AgentGitWrite[];
  auditTargets: AuditTarget[];
  run(argv: string[], overrides?: CliOverrides): Promise<CliResult>;
  state(): JanusState;
  events(): RecordedEvent[];
  /** Reads `.janus/evidence/<relativePath>`, failing with the directory listing when it is missing. */
  evidence(relativePath: string): string;
  cleanup(): void;
}

/**
 * Spec §29 item 3: a goal workspace built from N temporary git repositories with a `depends_on` graph, a bare
 * remote per repo, a bare state remote, and the persisted fakes, with every `AgentRunner.run()` bracketed by the
 * §31.29 reflog audit. `janus init` has already run when this resolves.
 */
export async function createHarness(specs: RepoGraphSpec[], options: HarnessOptions = {}): Promise<Harness> {
  const fixture = await graphFixture(specs, options.goalId === undefined ? {} : { goalId: options.goalId });
  const workspaceParent = tempDir('janus-harness-');
  const root = join(workspaceParent, 'ws');
  const init = await runCli(['init', '--goal', fixture.goalPath, '--workspace', root]);
  if (init.code !== ExitCode.Ok) {
    throw new Error(`harness: janus init failed (${init.code})\n${init.stdout}\n${init.stderr}`);
  }

  const paths = workspacePaths(root);
  const now = options.now ?? (() => new Date());
  if (options.agents !== undefined) seedFakeAgents(paths.fakeDir, options.agents);

  const auditTargets: AuditTarget[] = [
    { label: '.janus', dir: paths.janusDir },
    ...fixture.names.map((name) => ({ label: `repos/${name}`, dir: paths.repoDir(name) })),
    ...fixture.names.map((name) => {
      const remote = fixture.repos[name];
      if (remote === undefined) throw new Error(`harness: no remote for ${name}`);
      return { label: `remote:${name}`, dir: remote.bare };
    }),
    { label: 'remote:state', dir: fixture.stateBare },
  ];

  const agentGitWrites: AgentGitWrite[] = [];
  const inner = options.agentRunner ?? createFakeAgentRunner({ fakeDir: paths.fakeDir, now });
  const providers: Providers = {
    agent: auditAgentRunner(inner, auditTargets, agentGitWrites),
    ci: createFakeCiProvider({ fakeDir: paths.fakeDir, now }),
    scm: createFakeScmProvider({ fakeDir: paths.fakeDir, now }),
  };

  const cleanup = (): void => {
    if (process.env['JANUS_KEEP_TMP'] === '1') return;
    for (const dir of [workspaceParent, ...fixture.tempRoots]) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const harness: Harness = {
    fixture,
    root: paths.root,
    janusDir: paths.janusDir,
    fakeDir: paths.fakeDir,
    stateBranch: stateBranchName(fixture.goalId),
    providers,
    agentGitWrites,
    auditTargets,
    run: (argv, overrides = {}) => runCli(argv, { cwd: paths.root }, { providers, ...overrides }),
    state: () => readState(paths.janusDir),
    events: () => readEvents(paths.janusDir),
    evidence: (relativePath) => {
      const path = join(paths.janusDir, EVIDENCE_DIR, relativePath);
      if (!existsSync(path)) {
        const dir = dirname(path);
        const listing = existsSync(dir) ? readdirSync(dir).join(', ') : '(the directory does not exist)';
        throw new Error(`no evidence file ${relativePath}; ${dir} holds: ${listing}`);
      }
      return readFileSync(path, 'utf8');
    },
    cleanup,
  };
  onTestFinished(() => {
    cleanup();
  });
  return harness;
}

/** Spec §31.29: fails with every offending reflog entry when any agent performed a git write. */
export function expectNoAgentGitWrites(harness: Harness): void {
  if (harness.agentGitWrites.length === 0) return;
  throw new Error(
    `spec §31.29 violated: ${harness.agentGitWrites.length} git ref update(s) happened while an agent was running:\n${formatGitWrites(harness.agentGitWrites)}`,
  );
}

/** Spec §7: the state branch checkout and its bare remote are at the same commit. */
export async function expectStatePushed(harness: Harness): Promise<void> {
  const head = await revParse(harness.janusDir, 'HEAD');
  const remote = await remoteHead(harness.janusDir, 'origin', harness.stateBranch);
  if (remote !== head) {
    throw new Error(`state branch ${harness.stateBranch}: local HEAD ${head} but remote ${remote ?? '(absent)'}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:integration`
Expected: PASS (9 tests).

- [ ] **Step 5: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/harness/harness.ts tests/integration/harness.test.ts
git commit -m "test(harness): add the integration harness handle with state and evidence assertions"
```

---

## Task 10: The smoke test — `init` and one checkpoint

**Files:**
- Create: `tests/integration/smoke.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `createHarness`, `expectNoAgentGitWrites`, `expectStatePushed` (Task 9); `defaultSteps`, `Step`, `StepRegistry` from `src/engine/steps.ts`; `readFakeAgents`; `revParse`; `runGit`; `ExitCode`.
- Produces: the T04 done-when evidence — `init` and one checkpoint run through the harness on a three-repo `depends_on` graph, with state, evidence, and reflog assertions.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/smoke.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { defaultSteps } from '../../src/engine/steps.js';
import type { Step } from '../../src/engine/steps.js';
import { commitAll, currentBranch, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readFakeAgents } from '../../src/providers/fake/agent-runner.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { EVIDENCE_DIR } from '../../src/state/files.js';
import { createHarness, expectNoAgentGitWrites, expectStatePushed } from './harness/harness.js';

/** A three-repo dependency graph: a library, a Module Federation remote that uses it, and the shell that loads both. */
const GRAPH = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'orders-remote', kind: 'remote' as const, dependsOn: ['ui-kit'] },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit', 'orders-remote'], loadsRemotes: ['orders-remote'] },
];

describe('T04 smoke: init and one checkpoint through the harness', () => {
  it('clones the graph in dependency order and pushes the first checkpoint', async () => {
    const harness = await createHarness(GRAPH);

    const state = harness.state();
    expect(Object.keys(state.repos)).toEqual(['ui-kit', 'orders-remote', 'shell']);
    expect(state.goal.status).toBe('created');
    for (const name of ['ui-kit', 'orders-remote', 'shell']) {
      const dir = join(harness.root, 'repos', name);
      expect(await currentBranch(dir)).toBe('main');
      expect(state.repos[name]?.base_commit).toBe(await revParse(dir, 'HEAD'));
      expect(state.repos[name]?.goal_branch).toBe('ai/angular-15-to-16');
    }
    await expectStatePushed(harness);
    expect(harness.events().map((event) => event['type'])).toEqual(['goal.created']);
    expectNoAgentGitWrites(harness);
  });

  it('advances one stage and leaves exactly one new checkpoint on the state branch', async () => {
    const harness = await createHarness(GRAPH);
    const before = await runGit(harness.janusDir, ['rev-list', '--count', 'HEAD']);

    const result = await harness.run(['run', '--until', 'preparing']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('reached stage preparing (--until)');

    const after = await runGit(harness.janusDir, ['rev-list', '--count', 'HEAD']);
    expect(Number(after) - Number(before)).toBe(1);
    expect(await runGit(harness.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): start: goal started');
    expect(harness.state().goal.status).toBe('preparing');
    expect(harness.state().execution.in_flight.step).toBeNull();
    await expectStatePushed(harness);
    expect(harness.events().map((event) => event['type'])).toContain('stage.entered');
    expectNoAgentGitWrites(harness);
  });

  it('runs a scripted agent step that persists to fake/agents.json and writes evidence, with no git writes', async () => {
    const harness = await createHarness(GRAPH, {
      agents: { discovery: [{ status: 'completed', summary: 'discovery found 3 repos' }] },
      now: () => new Date('2026-09-20T14:00:00.000Z'),
    });

    const discoveryStep: Step = {
      name: 'prepare',
      run: async ({ engine, providers }) => {
        engine.markInFlight({ agent_run_id: 'run-0001', repo: 'ui-kit' });
        const outcome = await providers.agent.run({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' });
        const path = join(engine.workspace.paths.janusDir, EVIDENCE_DIR, 'agents', `${outcome.runId}.yaml`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `run_id: ${outcome.runId}\nstatus: ${outcome.status}\nsummary: ${outcome.summary}\n`);
        engine.emit({ type: 'agent.finished', run_id: outcome.runId, repo: 'ui-kit', status: outcome.status, step: 'prepare' });
        return { kind: 'advance', to: 'discovering', summary: outcome.summary };
      },
    };

    const result = await harness.run(['run', '--until', 'discovering'], {
      steps: { ...defaultSteps(), preparing: discoveryStep },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(harness.state().goal.status).toBe('discovering');

    expect(harness.evidence('agents/run-0001.yaml')).toContain('summary: discovery found 3 repos');
    const agents = readFakeAgents(harness.fakeDir);
    expect(agents.calls).toEqual([
      { run_id: 'run-0001', role: 'discovery', repo: 'ui-kit', at: '2026-09-20T14:00:00.000Z', status: 'completed' },
    ]);
    expect(harness.events().some((event) => event['type'] === 'agent.finished')).toBe(true);
    await expectStatePushed(harness);
    expectNoAgentGitWrites(harness);
  });

  it('fails the run when an agent performs a git write (spec §31.29)', async () => {
    // The runner is built before the harness exists, so it reads the repo path from a binding the harness fills in.
    let repoDir = '';
    const naughty: AgentRunner = {
      name: 'fake',
      run: async (request) => {
        await commitAll(repoDir, 'feat(ui-kit): agent committed', { allowEmpty: true });
        return { runId: request.runId, status: 'completed', summary: 'committed, which agents must never do' };
      },
    };
    const harness = await createHarness(GRAPH, { agentRunner: naughty });
    repoDir = join(harness.root, 'repos', 'ui-kit');

    await harness.providers.agent.run({ runId: 'run-0042', role: 'implementation', repo: 'ui-kit' });

    expect(harness.agentGitWrites.length).toBeGreaterThan(0);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/spec §31.29 violated/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/repos\/ui-kit/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/agent committed/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/during agent run run-0042, role implementation/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration`
Expected: FAIL — the smoke file fails at the first new assertion it cannot satisfy (for example a missing `--until preparing` stop message or a missing evidence file), not with an import error, because every module it imports already exists.

- [ ] **Step 3: Make it pass**

No production change should be needed: Tasks 2 through 9 supply everything. If an assertion fails, fix the **assertion** to match the behaviour T03 already specifies (for example the exact `chore(janus): start: goal started` checkpoint subject, or the exact `--until` message from `run-loop.ts`), and re-run. Do not change engine behaviour in this task; if a genuine engine bug surfaces, stop and report it to the controller.

- [ ] **Step 4: Run the integration lane to verify it passes and measure the budget**

Run: `pnpm test:integration`
Expected: PASS. Record the reported `Duration`; it must be under 90 seconds. If it is not, reduce the smoke graph from three repos to two and re-measure.

- [ ] **Step 5: Verify the harness did not reach the published build**

Run: `pnpm build && find dist -name 'harness*' -o -name 'git-audit*' | head`
Expected: no output (only `src/**` is compiled into `dist/`).

Run: `ls dist/providers`
Expected: `fake  index.d.ts  index.js  index.js.map  types.d.ts  types.js  types.js.map` — the providers *do* ship, the harness does not.

- [ ] **Step 6: Run the full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all four exit 0; `pnpm test` reports both projects green.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/smoke.test.ts
git commit -m "test(harness): drive init and one checkpoint through the integration harness"
```

---

## Self-Review

**1. Spec coverage.**

| Requirement | Task |
|---|---|
| §3.2 provider interfaces, one fake each | 2 (interfaces), 3, 4 (fakes) |
| §3.2 fakes persist under `<workspace>/fake/` | 3 (`store.ts`), 3, 4 (`agents.json`, `ci.json`, `scm.json`) |
| §5 `fake/` directory; no secrets under `.janus/` | 3 (store writes only to `fakeDir`); Global Constraints |
| §18.5 fake runner scripted by role and attempt, `fake/agents.json` | 3 |
| §29 item 3 temp git repos with a dependency graph | 7 (`graphFixture`), 9 (`createHarness`) |
| §29 item 3 persisted fake runner, fake CI, fake SCM | 3, 4 |
| §29 item 3 asserts from reflogs that no agent performed a git write | 6 (primitives), 8 (audit), 9 (`expectNoAgentGitWrites`), 10 (positive and negative tests) |
| §31.27 the loop runs on fakes only | 5 (`createProviders` makes fakes the only working configuration today) |
| §31.29 no agent git write, verified from reflogs | 8, 10 |
| §32 rule 11 agents never commit or push | 3, 4 (fakes never invoke git), 8, 10 |
| tasks.md T04: N temp repos with a dependency graph, a bare remote each, a bare state remote | 7 |
| tasks.md T04: assertions on state, evidence files, reflogs | 9 (`state()`, `evidence()`, `expectStatePushed`, `expectNoAgentGitWrites`) |
| tasks.md T04: `pnpm test:integration` target | 1 |
| tasks.md T04 done-when: a smoke test runs `init` and one checkpoint | 10 |
| Controller ruling: providers bag on `StepContext`, injected, never a singleton | 2 |
| Controller ruling: steps must not import `writeState`; `engine.markInFlight` | 2 |
| Controller ruling: `maxWaitMs` is per blocking wait | unchanged from T03; no task touches it |
| Controller ruling: reconciliation never pushes | unchanged from T03; no task touches `reconcile.ts` |

No gap found. §29 item 3's remaining scenarios (escalation paths, crash resume, policy violation, coupled red, base sync conflict, E2E invalidation, comment loop, decline, partial merge, release-and-bump) are explicitly later tasks' additions to this harness, as tasks.md states.

**2. Placeholder scan.** No "TBD", "implement later", "add appropriate error handling", "handle edge cases", or "similar to Task N" appears. Every code step carries the literal code. The two deliberate *product* placeholders — `AgentRunRequest`/`AgentRunOutcome` and the narrowed `CiProvider`/`ScmProvider` — are complete, compiling types with doc comments naming T05, T09, and T10, as the controller required; they are not plan placeholders. Task 10 Step 4 says "no production change should be needed" and states exactly what to do if an assertion fails, rather than leaving it open.

**3. Type consistency.** Checked across tasks: `Providers` / `AgentRunner` / `AgentRunRequest` / `AgentRunOutcome` / `CiProvider` / `ScmProvider` (Task 2) are used with the same names and fields in Tasks 3, 4, 5, 8, 9, 10. `AgentRunRequest.runId` is camelCase everywhere in TypeScript, while the persisted store field is `run_id` (matching `state.yaml` and telemetry conventions) — Task 3's test asserts both spellings explicitly so the mapping is pinned. `fakeDir` is the name in `WorkspacePaths`, `FakeAgentRunnerInput`, `FakeCiProviderInput`, `FakeScmProviderInput`, `testProviders`, and `Harness`. `createHarness`'s `HarnessOptions.agents` has the type `FakeAgentStore['script']`, which is exactly what `seedFakeAgents` takes. `AuditTarget` / `AgentGitWrite` / `formatGitWrites` (Task 8) are consumed with those names in Task 9. `reflog(cwd, ref = 'HEAD')` keeps the one-argument call in `captureRefLogs`'s neighbours and in the existing tests. `RepoGraphSpec` uses `dependsOn` (camelCase) in TypeScript and emits `depends_on` in YAML; Task 7's `depends_on?: never` member makes the wrong spelling a compile error. Fixed during review: Task 10's fourth test originally built a throwaway harness with an unusable runner alongside the real one; it now builds exactly one harness whose runner reads the repo path from a binding the harness fills in.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-t04-integration-harness.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
