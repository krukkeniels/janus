# Janus: High-Level Task Breakdown

Each task below is intended to become one implementation plan (superpowers `writing-plans`) and one execution cycle. Tasks are ordered by dependency; tasks marked with the same letter in "Parallel" can be built concurrently once their dependencies are done.

Source spec: `angular-ai-development-workflow-v2.md` (section numbers referenced as §N).

Conventions for every task: TypeScript strict, Node 20+, pnpm, vitest, zod for schemas, conventional commits `type(scope): subject`, no work merged without tests.

---

## T01 Repository bootstrap and CLI skeleton

Depends on: nothing. Parallel: A.

- pnpm project, TypeScript strict, ESLint, vitest, `tsup` or `tsc` build, `bin/janus` entry
- CLI framework (commander or similar) with the command surface of §8 stubbed: `init`, `run`, `status`, `approve`, `reject`, `escalation`, `review sync`, `doctor`, `agent run`, `ci`
- distinct exit codes for run outcomes (gate, wait, escalated, completed, error)
- `config.yaml` schema (zod) matching §28 with defaults; loader with env-var token resolution
- `goal.yaml` schema (zod) matching §4; validation of repo graph (acyclic `depends_on`, `coupled_with` symmetry, E2E `branch_params` refer to known repos)
- README stub, CONTRIBUTING with the test pyramid of §29

Done when: `janus --help` works, config and goal files validate with useful errors, CI (GitHub Actions on this repo) runs lint and tests.

## T02 State model, workspace, state branch, checkpoints

Depends on: T01.

- `state.yaml` schema v2 (zod) per §6, load/save with atomic writes
- workspace layout per §5: `.janus/` worktree of orphan branch `janus/<goal-id>`, `repos/<name>` clones, `janus.lock`
- git operations module (wrapping `git` CLI): clone, fetch, create branch from commit, worktree add, commit, push fast-forward-only, diff collection (tracked + untracked, excluding ignored), reset, patch export
- checkpoint function: stage state, handover, evidence, decisions; commit on state branch; optional push; return commit sha
- `janus init --goal` and `janus init --resume` (§8)
- `decisions.md` append helper, `telemetry/events.jsonl` append helper

Done when: integration test creates a workspace from three temp repos, checkpoints, clones the state branch elsewhere, and `init --resume` rebuilds an identical workspace.

## T03 Engine core: state machine, run loop, gates, resume

Depends on: T02.

- explicit state machine for `goal.status` (§6) with allowed transitions and a transition log
- step abstraction: `in_flight` bracketing, checkpoint after each step, idempotency flags
- `janus run` loop with `--until`, `--max-wait`, `--dry-run`, lock file, exit codes
- resume reconciliation (§7): head verification, remote drift detection, in-flight recovery for agent, CI-wait, and idempotent steps
- gate representation and `janus approve|reject` recording approver, commit, timestamp into state and `decisions.md`
- budget accounting primitives (§20) and guardrail-hit -> escalation transition hook (escalation content comes in T12)
- telemetry event emission for stage, gate, budget, guardrail events (§27)

Done when: unit tests cover every transition and every resume case with stubbed steps; a scripted "steps" test runs from `created` to `completed` with no real providers.

## T04 Agent runner: contract, context packages, Codex adapter, fake runner

Depends on: T02. Parallel: B (with T05, T06, T07).

- `AgentTask`, `AgentResult`, `ContextPackage` types (§18)
- per-role JSON output schemas (`additionalProperties: false`) and zod validators; role list per §18.1
- context package renderer with byte budget and explicit truncation markers (§18.2)
- prompt templates per role (markdown files, versioned) including the git-write prohibition and report paths
- Codex adapter: build the `codex exec` invocation of §18.4, stream JSONL, capture `turn.completed.usage`, enforce timeout and kill, read `-o` last message, validate, write `evidence/agents/<run-id>.yaml`
- fake runner: scripted by role and attempt; applies patches, writes reports, returns canned results (§18.5)
- `janus agent run <role> --task FILE` debug command
- one opt-in smoke test that runs real Codex (`read-only`, trivial prompt) when `JANUS_REAL_CODEX=1`

Done when: adapter unit tests pass against recorded JSONL streams; fake runner drives a scripted task; real-Codex smoke test passes locally.

## T05 Policy checks and orchestrator commit/push

Depends on: T02. Parallel: B.

- diff analysis: changed, added, deleted, renamed files; per-file hunks
- checks of §14: forbidden test patterns (added lines only), test file deletion/rename, test count decrease (count `it(`/`test(` occurrences per repo before/after), forbidden paths, Angular major beyond target (package.json diff), allowed-scope globs, diff size, secret patterns
- result object written to `evidence/policy/<attempt-id>.yaml`; patch export on violation; working tree reset
- commit message convention with work package id and agent run id; push via git module
- config wiring for `policy.*`

Done when: unit tests with fixture diffs for every check, including the false-positive cases (pattern inside a string or comment is still flagged, documented as accepted).

## T06 CI providers: interface, failure digest, local, fake, teamcity

Depends on: T02. Parallel: B.

- `CiProvider` interface, `BuildRef`, `BuildOutcome`, `FailureDigest` types (§3.2, §16)
- failure digest builder with caps (§16.2) and failure signature (§16.3), shared by all providers
- `local` provider: runs configured commands per repo (§28 `local_ci`), captures exit codes and output, parses JUnit or Karma/Jest summary output when present for failed test identities, produces digest
- `fake` provider: scripted outcomes per (repo, attempt), supports "no build appears" to exercise explicit trigger
- `teamcity` provider: find by revision, queue check, trigger via `buildQueue` with branch, revision and properties, poll state, fetch problems, failed tests with details, plain log download streamed to tail buffer; Bearer token from env
- provider contract test suite that all three implementations pass
- `janus ci wait|trigger|digest` debug commands

Done when: contract suite green for all providers; TeamCity adapter tested against recorded HTTP fixtures (nock/msw) for success, failure, queued, cancelled, and missing-build cases.

## T07 SCM providers: interface, fake, bitbucket-server

Depends on: T02. Parallel: B.

- `ScmProvider` interface and types (§3.2, §15, §24)
- `bitbucket-server` adapter: create PR, get PR (state, version, reviewer statuses), activities since cursor with comment anchors, add comment, find PR by branch; Bearer token; pagination
- `fake` adapter: in-memory PRs; test hooks to inject comments, NEEDS_WORK, approvals, merges
- PR description renderer (links to state branch, plan commit, sibling PRs, progress table)
- provider contract test suite

Done when: contract suite green for both; Bitbucket adapter tested against recorded fixtures including paginated activities and inline comment anchors.

## T08 Discovery and baseline stages

Depends on: T03, T04, T06.

- discovery stage: per-repo agents for the six areas plus integration discovery, bounded parallelism, read-only sandbox, report paths, `discovery/summary.yaml` merge (§10)
- baseline stage: local checks per repo via `local` provider, PR build per repo via configured provider, goal E2E on base branches; evidence under `evidence/baseline/`; proposed exceptions with stable identities (§11)
- handover and status output for these stages (uses T13 renderer stubs if not yet done)

Done when: engine integration test runs discovery and baseline with fake runner and fake CI and produces the expected files and state.

## T09 Planning, plan.yaml validation, Gate 1

Depends on: T08.

- planning agent task and schema; writes `plan.md` and `plan.yaml` (§12)
- `plan.yaml` validator: repos exist, acyclic packages, coupled repos share a group, red windows within guardrails, `requires_publish` only on libraries with a publish build type
- Gate 1 flow: checkpoint, `awaiting_plan_approval`, `janus approve plan --commit --exception`, exception approval recorded in `baseline.exceptions`
- branch and PR creation for all repos after approval (§15)

Done when: integration test reaches Gate 1, rejects an invalid `plan.yaml`, approves a valid one, and creates branches and PRs on the fake SCM.

## T10 Execution loop: work packages, groups, debug loop, budgets, publish

Depends on: T05, T09.

- package scheduler honoring `depends_on`, repo dependency order, and groups (§13)
- implementation agent per repo per package; policy check; commit; push
- PR build loop per repo: find, trigger if absent, wait, digest, classify defect vs coupled-expected (§16.1, §16.5)
- debug agent loop with attempt budget, no-progress detection, policy re-check
- verification group boundary evaluation; E2E trigger when `e2e_after` (E2E stage from T11 or a stub)
- prerelease publish trigger and version propagation to dependents
- AI checkpoint per package with outcome handling including regroup re-validation (§21)
- budget resets at verification boundaries; guardrail hits route to escalation

Done when: integration tests cover green path, defect fix within budget, budget exhaustion, no-progress escalation, coupled red inside a group, policy violation retry, publish propagation, and crash-resume mid-package.

## T11 E2E, final review, QA, human review loop, completion

Depends on: T07, T10.

- E2E stage: trigger with branch params, validity heads, invalidation on any commit, failure loop (§17)
- final AI review agent across repos, findings schema, fix agent per repo, cycle budget (§22)
- QA recommendation agent, output to evidence and PR comments (§23)
- human review loop: activity polling with cursors, comments to fix tasks per repo, NEEDS_WORK handling, all-PRs-approved detection, `awaiting_merge`, merge detection, `completed` with release-order handover (§24)
- `janus review sync`

Done when: integration tests cover E2E invalidation, review findings loop, human comment loop with inline comments, approval on all PRs, merge in order, and goal completion.

## T12 Escalation and replanning

Depends on: T10.

- escalation package renderer (`escalation.md`) with v1 structure plus repo and package (§25)
- `janus escalation show|resolve --direction`
- replanning agent task; plan revision counter; Gate 2; resume execution from the current package

Done when: integration test escalates on budget exhaustion, resolves with direction, produces a revised plan, gates, approves, and resumes.

## T13 Rendering: handover, status, PR descriptions

Depends on: T03. Parallel: C (with T14).

- `handover.md` generator from state plus last agent handover, regenerated at every checkpoint (§5, §7)
- `janus status` human and `--json` output: stage, per-repo branch/PR/build, budgets, gate, merge order, open escalation
- PR description updates at package boundaries

Done when: snapshot tests for handover and status across representative states.

## T14 Telemetry metrics and cost

Depends on: T03. Parallel: C.

- event catalogue of §27 emitted from all stages (audit existing emit sites)
- `janus status --telemetry`: derive v1 metrics from events; human wait time from gate events; optional cost from price table

Done when: metrics test computes expected numbers from a fixture event log.

## T15 Integration harness and dogfood runbook

Depends on: T11, T12.

- reusable test harness: builds N temp git repos with a dependency graph, seeds fake runner scripts, fake CI, fake SCM; helper assertions on state, evidence, and reflogs (verify no agent git writes, §31.29)
- full goal run to completion and every escalation path as one suite (`pnpm test:integration`)
- dogfood runbook: run against an external throwaway Angular 15 app with real Codex, `local` CI provider, fake SCM; checklist of expected artifacts; how to inspect evidence

Done when: suite green in CI; runbook executed once locally and its findings folded back into T04, T05, T06 as needed.

## T16 Documentation and first-contact runbook

Depends on: T15.

- README: concepts, workspace layout, CLI, configuration reference generated from the zod schemas
- operator runbook for the work network: `janus doctor`, token setup, read-only TeamCity and Bitbucket checks, TeamCity branch-spec and E2E parameter prerequisites (§33), baseline-only first run, then a one-repo goal, then the multi-repo goal
- troubleshooting: common TeamCity locator issues, missing builds, drift, lock file

Done when: a colleague can follow the runbook without the author present.

---

## Stretch (not v1)

- Claude Code `AgentRunner`
- Bitbucket Cloud `ScmProvider`
- TeamCity webhook receiver to replace polling
- Spec Kit `workflow.yml` wrapper that calls `janus` commands
- selective E2E based on change impact

## Suggested build order

```text
T01 -> T02 -> T03 -> T08 -> T09 -> T10 -> T11 -> T15 -> T16
              \-> T04 ----^        ^       ^
              \-> T05 -------------/       |
              \-> T06 ----^                |
              \-> T07 ---------------------/
       T03 -> T13, T14 (any time after T03)
       T10 -> T12 (before T15)
```
