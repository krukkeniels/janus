# Janus: Angular AI Development Workflow v2

Status: draft for review. Supersedes `angular-ai-development-workflow-v1.md`.

---

## 0. What changed from v1 and why

| Topic | v1 | v2 | Reason |
|---|---|---|---|
| Workflow layer | Spec Kit "or equivalent" | Janus owns a small TypeScript state machine | Spec Kit's Codex step discards output, has no output schema, sandbox or cwd control, and keeps run state outside Git. Every real step would be a shell step anyway. |
| Goal shape | One repo, one branch, one PR | One goal spans N repos in dependency order; one branch and one PR per repo | The application is spread over several repositories with mixed coupling (Module Federation, shared libraries, independent apps). |
| State location | `.ai-dev/` on the goal branch | `.janus/` on a dedicated orphan branch `janus/<goal-id>`, checked out in a goal workspace | Keeps PR diffs clean; lets discovery and plan be checkpointed before any code branch exists. |
| Who commits | Implicit | Only the orchestrator commits and pushes. Agents never run git write operations | Codex `workspace-write` makes `.git` read-only. Orchestrator commits are where policy checks run. |
| Test integrity | Prompted rule | Deterministic policy checks on every diff before commit | Makes "never weaken tests" enforceable. |
| Baseline checks | Run by discovery agents | Run by the orchestrator through the CI provider | Codex read-only sandbox blocks the disk writes tests need; agents stay strictly read-only. |
| CI / SCM coupling | TeamCity and Bitbucket hard-wired | `CiProvider` and `ScmProvider` interfaces with `teamcity`, `local`, `fake` and `bitbucket-server`, `fake` implementations | Work systems are unreachable from the development network; Janus must be testable without them. |
| PR build discovery | "observe automatic build" | Find build by `revision:<sha>` and build type; trigger explicitly if none appears within a window | TeamCity has no PR-number locator; PR builds run on the source branch. |
| Failure handoff | "latest TeamCity failure" | Bounded failure digest (problems, failed tests, log tail) | Build logs are unpaginated and can be tens of MB. |
| Plan format | `plan.md` | `plan.md` for humans plus `plan.yaml` for the engine | Work packages and groups must be machine-readable; approval binds to one commit of both. |
| No-progress rule | "may evolve" | Concrete failure-signature heuristic | Budgets need a testable definition. |
| CLI | Not defined | `init`, `run`, `status`, `approve`, `reject`, `escalation`, `doctor` | Human gates are CLI commands; runtime is a step-wise CLI. |

Everything else in v1 (principles, gates, autonomy rules, safety rules, telemetry intent) carries over unchanged unless stated below.

---

## 1. Purpose

Janus is a controlled, resumable, agent-driven workflow for upgrading a large, multi-repository Angular application one major version at a time.

The first reference goal is:

> Upgrade Angular 15 to Angular 16 across the repositories that make up the application.

Janus is optimized for Codex CLI as the agent runtime. The engine, state, and task contracts are agent-agnostic so a Claude Code adapter can be added later without changing workflow semantics.

The key operating principle is unchanged:

> State survives. Agents do not.

---

## 2. Scope

### In scope

- one Angular major upgrade per goal
- one goal spanning N repositories with an explicit dependency order
- one long-lived goal branch and one long-lived pull request per repository
- read-only discovery per repository plus one cross-repository integration discovery
- orchestrator-run baseline verification (local checks, per-repo CI builds, goal-level E2E)
- human-approved technical plan (`plan.md` + `plan.yaml`)
- sequential work packages, each scoped to one or more repositories
- verification groups for coupled work, including cross-repository groups
- per-repository CI build feedback loop with bounded fresh debug agents
- goal-level full E2E through the CI provider, with per-repository branch names passed as parameters
- fresh agent process per meaningful task
- deterministic policy checks on every diff before commit
- AI checkpoint per work package, independent final AI review, QA recommendation
- human PR review loop across all PRs, human merge in dependency order
- structured escalation and replanning
- Git-based state, handover, and resume
- telemetry from the first run
- step-wise CLI runtime on a developer machine
- fakes and a local CI provider so the whole loop is testable without TeamCity or Bitbucket

### Out of scope for v1 of Janus

- multi-major upgrades in one goal
- autonomous merge
- autonomous approval of baseline exceptions
- parallel code-changing agents on the same repository
- selective E2E execution
- automatic architectural changes
- weakening, skipping, or removing tests to obtain green CI
- publishing final (non-prerelease) library versions; Janus may trigger prerelease publishes through CI where configured, and records the post-merge release order in the handover
- a daemon or webhook receiver (polling only)
- replacing TeamCity or Bitbucket
- a general-purpose agent framework
- Bitbucket Cloud (interface allows it; not implemented)

---

## 3. Architecture

```text
                        +--------------------+
                        |     Human User     |
                        |  CLI gates, PR     |
                        +---------+----------+
                                  |
                                  v
+-----------------+     +---------+----------+     +------------------+
|  ScmProvider    |<--->|    Janus engine    |<--->|   CiProvider     |
|  bitbucket-     |     |  state machine     |     |   teamcity       |
|  server | fake  |     |  budgets, gates    |     |   local | fake   |
+-----------------+     |  checkpoints       |     +------------------+
                        +---------+----------+
                                  |
                   +--------------+---------------+
                   |                              |
                   v                              v
         +---------+----------+        +----------+---------+
         |    AgentRunner     |        |   Goal workspace   |
         |  codex | fake      |        |  .janus/  (state)  |
         |  fresh process per |        |  repos/<name>/     |
         |  task              |        |  (code, one branch |
         +--------------------+        |   per repo)        |
                                       +--------------------+
```

### 3.1 Janus engine (TypeScript, Node 20+, pnpm)

Owns:

- the goal state machine and the `run` loop
- human gates and their CLI commands
- retry and review budgets, no-progress detection
- building minimal context packages for agents
- validating agent output against JSON schemas
- policy checks on diffs
- commits and pushes on code branches; checkpoints on the state branch
- CI observation and triggering through `CiProvider`
- PR creation, comment polling, approval detection through `ScmProvider`
- failure digests, handover, escalation packages, status rendering
- telemetry events

### 3.2 Provider interfaces

All three are small TypeScript interfaces with at least one real and one fake implementation. Fakes are first-class, not test-only hacks: they are how Janus is developed and how the full loop is exercised from a network without TeamCity or Bitbucket.

```text
AgentRunner
  run(task: AgentTask): Promise<AgentResult>
  implementations: codex, fake (scripted)

CiProvider
  findBuild(repo, revision, buildTypeId): Promise<BuildRef | null>
  triggerBuild(repo, buildTypeId, branch, revision, params): Promise<BuildRef>
  waitForBuild(ref, timeout): Promise<BuildOutcome>
  failureDigest(ref, limits): Promise<FailureDigest>
  implementations: teamcity, local, fake

ScmProvider
  ensureBranch(repo, name, base): Promise<void>
  createPullRequest(repo, branch, base, title, body): Promise<PullRef>
  getPullRequest(ref): Promise<PullState>          // OPEN|MERGED|DECLINED, reviewer statuses
  listActivitySince(ref, cursor): Promise<Activity[]> // comments incl. inline, approvals, NEEDS_WORK
  addComment(ref, text): Promise<void>
  implementations: bitbucket-server, fake
```

The `local` CI provider runs configured shell commands (install, build, test, e2e) in the repository checkout and produces the same `BuildOutcome` and `FailureDigest` shapes as TeamCity. It serves both the "local or sandbox" baseline checks in v1 and as the development stand-in for TeamCity.

### 3.3 Agents

Codex processes started fresh per task through `codex exec`. They:

- read the repository and `.janus/` freely
- write code only in the repository they are assigned (`workspace-write` sandbox, cwd = that repo)
- write reports only into designated `.janus/` paths given in the task (`--add-dir`)
- return a JSON result conforming to the role's output schema (`--output-schema`)
- never run `git commit`, `git push`, `git checkout` or other history-changing commands (enforced by the sandbox making `.git` read-only, and stated in every task prompt)

### 3.4 TeamCity and Bitbucket

Unchanged roles: TeamCity is the source of execution evidence; Bitbucket is the source of truth for branches, PRs, human review, and merge.

---

## 4. Goal model

One Angular major upgrade is one goal. A goal declares its repositories and their relationships.

```yaml
# .janus/goal.yaml
id: angular-15-to-16
source_version: "15"
target_version: "16"
title: Upgrade Angular 15 to 16

repos:
  - name: ui-kit
    kind: library            # library | app | shell | remote
    scm: { project: FE, slug: ui-kit }
    base_branch: main
    ci:
      pr_build_type_id: Fe_UiKit_Build
      publish_build_type_id: Fe_UiKit_PublishPrerelease   # optional
    depends_on: []

  - name: shell
    kind: shell
    scm: { project: FE, slug: shell }
    base_branch: main
    ci: { pr_build_type_id: Fe_Shell_Build }
    depends_on: [ui-kit]

  - name: orders-remote
    kind: remote
    scm: { project: FE, slug: orders-remote }
    base_branch: develop
    ci: { pr_build_type_id: Fe_Orders_Build }
    depends_on: [ui-kit]
    coupled_with: [shell]    # runtime-coupled: Module Federation shared singletons

e2e:
  build_type_id: Fe_E2E_Full
  branch_params:             # how each repo's branch is passed to the E2E build
    shell: env.SHELL_BRANCH
    orders-remote: env.ORDERS_BRANCH
  extra_params: {}

success_criteria:
  - every repo builds and passes its PR build on Angular 16
  - full E2E green on the deployed goal branches
  - no product behavior change
non_goals:
  - Angular 17 features
  - standalone-component migration beyond what Angular 16 requires
```

Rules:

- `depends_on` orders work: a repository's upgrade work package cannot start before the packages of its dependencies reach the required state (for libraries: prerelease published; for coupled runtime peers: same verification group).
- `coupled_with` declares runtime coupling (Module Federation shared singletons). Coupling is symmetric; declaring it on one side is enough and the engine normalizes it. Coupled repositories are placed in the same verification group by the planner; the goal-level E2E is the only place their combination is verified.
- Each repository gets its own goal branch `ai/<goal-id>` and its own PR against its own base branch.
- A goal is complete only when every PR is merged.

Later majors are separate goals, as in v1.

---

## 5. Workspace and Git layout

`janus init` creates a goal workspace on the developer machine:

```text
<workspace>/
  .janus/                 # worktree of orphan branch janus/<goal-id> (state branch)
  repos/
    ui-kit/               # clone, on ai/<goal-id> once created
    shell/
    orders-remote/
  janus.lock              # run lock, not committed
```

The state branch is pushed to a configured remote. Default: the first repository in `goal.yaml`, branch `janus/<goal-id>`. A dedicated state repository may be configured instead.

### `.janus/` contents

```text
.janus/
  config.yaml             # policy and provider configuration, no secrets
  goal.yaml               # goal definition (section 4)
  state.yaml              # authoritative runtime state (section 6)
  plan.md                 # approved technical plan, human-readable
  plan.yaml               # approved plan, machine-readable (section 12)
  decisions.md            # append-only decision log
  handover.md             # regenerated at every checkpoint
  escalation.md           # present only while escalated

  discovery/
    <repo>/
      dependencies.md
      build-tooling.md
      tests.md
      e2e.md
      architecture.md
      ci.md
    integration.md        # cross-repo: MF shared deps, lib version graph, E2E topology
    summary.yaml          # merged structured findings

  evidence/
    baseline/             # per repo: local results, build refs; goal: e2e ref
    builds/<repo>/<build-id>.yaml       # outcome + digest reference
    digests/<repo>/<build-id>.md        # failure digest (bounded)
    e2e/<build-id>.yaml
    policy/<attempt-id>.yaml            # policy-check results
    agents/<run-id>.yaml                # agent result (validated JSON), token usage, duration
    reviews/
    qa/

  telemetry/
    events.jsonl          # append-only
```

Secrets (TeamCity token, Bitbucket token) come from environment variables only and are never written under `.janus/`.

---

## 6. State schema

`state.yaml` is authoritative. Version 2. Fields may be added within v2 but not removed or repurposed.

```yaml
version: 2

goal:
  id: angular-15-to-16
  status: planning        # created | discovering | baselining | planning |
                          # awaiting_plan_approval | executing | final_e2e |
                          # ai_review | qa | awaiting_human_review |
                          # fixing_review_feedback | awaiting_merge |
                          # escalated | replanning | completed

state_branch:
  name: janus/angular-15-to-16
  remote: ui-kit          # repo name or "state-repo"

repos:
  ui-kit:
    goal_branch: ai/angular-15-to-16
    base_commit: null
    head_commit: null
    pr: { id: null, url: null, state: null, version: null }
    last_build: { id: null, status: unknown, revision: null }
    prerelease_version: null
  shell: { ... }

plan:
  approved: false
  approved_commit: null   # state-branch commit containing plan.md + plan.yaml
  approved_at: null
  revision: 0

baseline:
  approved: false
  repos:
    ui-kit: { commit: null, local: {}, pr_build: { id: null, status: unknown } }
  e2e: { id: null, status: not_run, branches: {} }
  exceptions: []          # each: { id, repo, kind: test|build|e2e, identity, reason, approved_by, approved_at }

execution:
  current_work_package: null
  current_verification_group: null
  completed_work_packages: []
  in_flight:               # set while a step is executing; used to detect crashes on resume
    step: null
    started_at: null
    agent_run_id: null
  budgets:
    ci_fix_attempts: 0     # resets per verification boundary
    ai_review_cycles: 0
    no_progress_iterations: 0
    work_packages_without_green: 0
  last_failure_signature: null

verification:
  e2e:
    status: not_run        # not_run | running | passed | failed | invalidated
    build_id: null
    heads: {}              # repo -> commit the result is valid for
  ai_review: { status: not_run, run_id: null, findings_open: 0 }
  qa_recommendation: { status: not_run, run_id: null }

gate:
  type: null               # plan_approval | revised_plan_approval | pr_review | merge
  status: none             # none | waiting | passed
  entered_at: null
  checkpoint_commit: null

review_loop:
  activity_cursor: {}      # repo -> last processed activity id
  open_comments: []

telemetry:
  started_at: null
  last_updated_at: null
```

---

## 7. Checkpoint rule and resume semantics

Every meaningful state transition ends in a checkpoint commit on the state branch. A checkpoint contains the updated `state.yaml`, regenerated `handover.md`, new evidence files, and any `decisions.md` append. Code changes are committed on the repository's goal branch before the checkpoint that references them.

Rules:

1. A human gate is never entered before a checkpoint exists; `gate.checkpoint_commit` records it.
2. `janus run` starts by loading committed state, then reconciles with reality: for each repo it verifies that the local goal branch head equals `repos.<name>.head_commit` and fetches the remote to detect drift (for example a human pushed to the goal branch). Drift is recorded and, if it is not a fast-forward, escalated.
3. If `execution.in_flight.step` is set at load time, the previous process died mid-step. Resume behavior by step type:
   - agent run: the uncommitted diff in the assigned repo is saved to `evidence/agents/<run-id>.interrupted.patch`, the working tree is reset, the run counts as a failed attempt, and the step re-runs.
   - CI wait: resume waiting on the recorded build id.
   - any other step: re-run (all such steps are idempotent).
4. State pushes are fast-forward only. If the remote state branch moved, `run` stops and asks the human to reconcile.
5. A fresh Janus process on another machine can resume from `git clone` of the state branch plus `janus init --resume`, which re-clones the repositories at their recorded heads.

---

## 8. CLI surface and run model

```text
janus init --goal goal.yaml [--workspace DIR]     create workspace, clone repos, create state branch, first checkpoint
janus init --resume <state-remote> <goal-id>      rebuild a workspace from committed state
janus run [--until STAGE] [--max-wait 45m] [--dry-run]
janus status [--json]
janus approve plan [--commit SHA] [--exception ID ...]
janus approve revised-plan [--commit SHA]
janus reject plan --reason "..."
janus escalation show | resolve --direction "..."
janus review sync                                 fetch PR activity now (also done by run)
janus doctor                                      check codex, git, tokens, provider reachability
janus agent run <role> --task FILE                debug: run one agent task by hand
janus ci wait|trigger|digest ...                  debug helpers
```

Run model:

- `janus run` advances the state machine step by step until one of: a human gate, a blocking wait longer than `--max-wait`, an escalation, or completion. It then prints a status summary and exits with a distinct exit code per reason.
- Every step is bracketed by `in_flight` set/clear and ends with a checkpoint.
- A lock file prevents two concurrent runs in one workspace.
- `--dry-run` prints the next steps without executing agents, commits, or CI calls.
- Human gates are passed only by `janus approve ...`, which records who approved (from git identity), the approved state-branch commit, and appends to `decisions.md`.

---

## 9. Core workflow

```text
init
  |
discovery (per repo x areas, parallel, read-only) + integration discovery
  |
baseline (orchestrator: local checks per repo, PR build per repo on base, goal E2E on base branches)
  |
planning (fresh agent -> plan.md + plan.yaml, proposed baseline exceptions)
  |
GATE 1: approve plan + baseline + exceptions
  |
create goal branches + PRs (all repos)
  |
execute work packages in plan order
  |   for each WP (scoped to repos R):
  |     fresh implementation agent per repo in R
  |     policy checks -> commit -> push (per repo)
  |     per-repo CI build: wait for automatic, trigger if absent
  |       red -> diagnose: defect | coupled-expected
  |            defect -> fresh debug agent (bounded)
  |            coupled -> continue inside verification group
  |     group boundary -> all group repos green; E2E if group flagged high-risk
  |     library prerelease publish if WP requires it
  |     AI checkpoint (fresh)
  |
final E2E (goal-level, all goal branches)
  |
independent AI review (fresh) -> findings -> fresh fix agent -> CI -> E2E if invalidated -> review
  |
QA recommendation (fresh)
  |
GATE 3: human review of all PRs -> comments -> fresh fix agent -> CI -> E2E if invalidated -> AI review -> QA refresh
  |
GATE 4: human merges in dependency order
  |
completed
```

Escalation can happen from any autonomous step and leads to `escalated` -> human direction -> `replanning` -> GATE 2 -> `executing`.

---

## 10. Discovery

Discovery is read-only with respect to product code. Agents run with the Codex `read-only` sandbox; the orchestrator gives each agent an `--add-dir` for its report path under `.janus/discovery/`.

Per repository, run in parallel (bounded by `agents.max_parallel`):

1. Angular and dependency compatibility
2. build tooling and Module Federation
3. CI configuration and build flow (reads `.teamcity/` or equivalent if present in repo; TeamCity API is not called by agents)
4. unit/integration test topology
5. E2E topology and coverage (for repos that host E2E code)
6. architecture and high-risk areas

Then one cross-repository integration discovery agent reads all per-repo reports and produces `integration.md`: shared singleton versions across shell and remotes, library version graph, publish flow, E2E environment topology, recommended upgrade order.

Each agent writes a markdown report and returns structured findings:

```yaml
area: e2e
repo: shell
findings: []
risks: []
known_gaps: []
recommended_work: []
evidence: []
confidence: high | medium | low
```

The orchestrator merges the structured parts into `discovery/summary.yaml`. Discovery agents may not run tests, builds, or installs (read-only sandbox); they may read existing local artifacts and CI evidence collected by the orchestrator.

---

## 11. Baseline

Run by the orchestrator, not by agents, before planning finishes.

Per repository at its base-branch head:

- local checks through the `local` CI provider where configured (install, build, unit tests, lint)
- PR build through the configured CI provider on the base branch

Goal-level:

- full E2E on the base branches through the CI provider

Results are stored under `evidence/baseline/` and summarized in `state.yaml`. Failures become proposed baseline exceptions with a stable identity (test name, build problem identity, or E2E scenario id). Only a human approves exceptions, at Gate 1. No new exception may be created autonomously later; a newly discovered pre-existing failure escalates.

---

## 12. Technical plan and Gate 1

A fresh planning agent receives the goal, discovery summary and reports, baseline results, and guardrails. It writes:

- `plan.md`: human-readable, using the v1 section list (Goal, Baseline, Known Risks, Upgrade Strategy, Work Packages, Verification Groups, Verification Strategy, E2E Strategy, Autonomy, Guardrails, Known Baseline Exceptions, Escalation Rules), plus a Repository Order section.
- `plan.yaml`: the engine's view.

```yaml
version: 1
work_packages:
  - id: wp-01-ui-kit-angular
    title: Upgrade ui-kit to Angular 16
    repos: [ui-kit]
    objective: ...
    allowed_scope: [package.json, angular.json, src/**]
    definition_of_done: [...]
    verification: { pr_build: required }
    requires_publish: true          # library prerelease after green
    depends_on: []
    risks: [...]
  - id: wp-02-shell-angular
    repos: [shell]
    depends_on: [wp-01-ui-kit-angular]
  - id: wp-03-orders-angular
    repos: [orders-remote]
    depends_on: [wp-01-ui-kit-angular]

verification_groups:
  - id: vg-runtime-core
    work_packages: [wp-02-shell-angular, wp-03-orders-angular]
    reason: Module Federation shared singletons must match
    e2e_after: true
    max_red_window: 2               # work packages allowed red inside the group

proposed_exceptions: [...]
```

The engine validates `plan.yaml`: every repo referenced exists, `depends_on` is acyclic, coupled repos share a group, red windows respect `guardrails.max_work_packages_without_green`.

Gate 1: the human runs `janus approve plan --commit <state-sha> [--exception <id> ...]`. Approval covers plan, work packages, groups, verification strategy, baseline, and the listed exceptions. No code-changing execution may begin before approval.

---

## 13. Work packages and verification groups

Unchanged from v1 except:

- a work package lists its `repos`; one implementation agent runs per repo, sequentially, in dependency order
- a package may declare `requires_publish: true`; after its repos are green the orchestrator triggers the repo's `publish_build_type_id` and records the resulting prerelease version in `repos.<name>.prerelease_version`; dependent packages receive that version in their context
- groups may span repositories; the group boundary condition is "every repo in the group green on its PR build" plus E2E when `e2e_after` is true
- dynamic regrouping is allowed under the v1 conditions; the engine re-validates `plan.yaml` after any regroup and records the reason in `decisions.md`

---

## 14. Commit model and policy checks

Agents never commit. After an implementation, debug, or fix agent finishes, the orchestrator:

1. collects the diff in the assigned repo (tracked and untracked, excluding ignored files)
2. runs policy checks
3. on pass: commits with a conventional message referencing the work package and agent run id, then pushes
4. on violation: writes `evidence/policy/<attempt-id>.yaml`, saves the diff as a patch in evidence, resets the working tree, counts one attempt against the current budget, and includes the violation report in the next fresh agent's context

Policy checks (deterministic, configurable, all on by default):

| Check | Default |
|---|---|
| forbidden test patterns added | `xit(`, `xdescribe(`, `fit(`, `fdescribe(`, `.skip(`, `.only(`, `it.todo(`; `expect(true).toBe(true)`-style tautologies |
| deleted or renamed test files | violation unless the work package explicitly allows it |
| net decrease in test count beyond threshold | configurable percentage per repo |
| forbidden paths | `.teamcity/**`, `.github/**`, and other CI paths as configured. Test-runner configs (`karma.conf.js`, `jest.config.*`) may be edited, but lowering a coverage threshold or excluding test files in them is a violation |
| Angular version beyond target | any `@angular/*` dependency whose major exceeds `target_version` |
| scope | files outside the work package `allowed_scope` globs |
| diff size | `max_changed_files`, `max_diff_lines` when set |
| secrets | common token patterns |

The AI checkpoint remains responsible for judgment calls the deterministic checks cannot make (weakened assertions, behavior changes).

---

## 15. Pull request model

After Gate 1 the orchestrator creates, for every repository, the goal branch from the recorded base commit and one PR against the repo's base branch. PR descriptions link to the state branch, the plan commit, and the other PRs of the goal. PR descriptions are updated by the orchestrator at each work package boundary with progress and CI state.

All PRs remain open until the human merges them. Bitbucket Server HTTP access tokens cannot merge, which enforces the human-merge rule.

---

## 16. CI provider and PR build loop

### 16.1 Finding the build

After a push of commit `S` on repo `R`:

1. poll `findBuild(R, S, pr_build_type_id)` every `ci.poll_interval` (default 30s) for `ci.appearance_timeout` (default 5m)
2. if no build appears, `triggerBuild(R, pr_build_type_id, ai/<goal-id>, S)` and record that it was triggered explicitly
3. `waitForBuild` until finished or `ci.build_timeout`

TeamCity mapping: locator `revision:(S),buildType:(id:X),defaultFilter:false,state:any`; queued builds also checked via `buildQueue`; status `SUCCESS | FAILURE | UNKNOWN` (cancelled or failed-to-start count as failure with a distinct reason).

### 16.2 Failure digest

Before any debug agent runs, the orchestrator produces a bounded digest:

- build problems (type, identity, details)
- failed tests: name, `newFailure` flag, first N lines of details; capped at `digest.max_tests` (default 50)
- log tail: last `digest.log_tail_lines` (default 400) of the plain build log, plus up to `digest.max_error_windows` windows around lines matching error patterns
- links: build URL, log URL
- classification hints: known baseline exception identities matched

Digests are stored under `evidence/digests/` and capped at `digest.max_bytes` (default 64 KB).

### 16.3 Failure signature and no-progress

`failure_signature = sha256(sorted(failed test identities) + sorted(problem identities))` excluding approved baseline exceptions.

A debug attempt is a no-progress iteration when the resulting signature equals `execution.last_failure_signature`. Two consecutive no-progress iterations (default `max_no_progress_iterations: 2`) escalate even if `max_ci_fix_attempts` remains.

### 16.4 Debug agent

A fresh debug agent receives: goal, plan slice, current work package, repo, diff of the package so far, the failure digest, previous attempt summaries (one paragraph each, no reasoning), policy-violation reports if any, guardrails, remaining attempt budget.

### 16.5 Coupled red

If the failure is classified by the implementation agent's result (`expected_temporary_failure: true` with a stated dependency on a later package in the same group) and the engine confirms the group and red window allow it, the red is recorded and execution continues to the next package in the group. The window and the `max_work_packages_without_green` guardrail bound this.

---

## 17. E2E

E2E is goal-level. It is triggered by the orchestrator only, always the full suite:

- baseline: base branches of all repos
- after a verification group with `e2e_after: true`
- before final AI review
- after any code change that invalidates the previous result

Validity: `verification.e2e.heads` records the head commit of every repository the run covered. Any new commit on any goal branch sets status to `invalidated`.

Trigger parameters: for each repo listed in `e2e.branch_params`, the repo's goal branch name (or base branch for the baseline). The E2E build configuration is responsible for deploying or pointing at an environment; Janus passes parameters and waits.

Failure handling: the same digest, debug, budget, and escalation model as PR builds, with the debug agent scoped to the repository the digest and plan point at. If the failing repository cannot be determined, the engine escalates with the digest rather than guessing.

---

## 18. Agent model

### 18.1 Task contract

```yaml
AgentTask:
  run_id: string
  role: discovery | integration_discovery | planning | implementation | debug |
        checkpoint | review | fix | qa | replanning
  repo: string | null          # cwd for the agent
  writable_paths: []           # extra --add-dir entries under .janus/
  sandbox: read-only | workspace-write
  network: boolean             # sandbox_workspace_write.network_access
  timeout_minutes: number
  context: ContextPackage      # section 18.2, rendered to the prompt
  output_schema: JSONSchema    # per role
```

### 18.2 Context package

Rendered into the prompt in this order. Nothing else is injected; in particular no previous agent reasoning.

```text
GOAL (from goal.yaml, trimmed)
REPOSITORY (name, kind, dependencies, coupled repos, base branch)
APPROVED PLAN SLICE (this work package and its group)
CURRENT STATE (relevant subset of state.yaml)
RELEVANT DIFF (this package so far, or full branch diff for review)
LATEST VERIFICATION EVIDENCE (digest or build refs)
PREVIOUS ATTEMPTS (summaries only)
KNOWN BASELINE EXCEPTIONS
GUARDRAILS AND FORBIDDEN ACTIONS (including: never run git write commands)
BUDGET (remaining attempts / cycles)
OUTPUT CONTRACT (schema summary, where to write reports)
```

Context size is bounded by `agents.max_context_bytes`; diffs and digests are truncated with markers, never silently.

### 18.3 Output contract

Minimum shape for every role (roles extend it):

```yaml
status: completed | blocked | failed
summary: string
changes_made: []
findings: []
evidence: []
new_tasks: []
expected_temporary_failure: false
plan_change_required: false
architecture_change_required: false
behavior_change_required: false
recommended_next_action: string
handover:
  current_state: string
  next_action: string
  risks: []
```

The orchestrator validates against the JSON schema; invalid output is one failed attempt, and the validation error is included in the retry context.

### 18.4 Codex adapter

Invocation shape:

```text
codex exec -C <repo-or-workspace> \
  -s <read-only|workspace-write> \
  -c sandbox_workspace_write.network_access=<bool> \
  --add-dir <.janus/...> \
  --output-schema <schema.json> \
  --json -o <last-message.json> \
  [--ephemeral] [-m <model>] [-c model_reasoning_effort=<x>] \
  - < prompt.md
```

The adapter parses the JSONL stream for `turn.completed.usage` (input, cached input, output, reasoning tokens), records duration, exit code, and the validated final message under `evidence/agents/<run-id>.yaml`, and terminates the process after the timeout. `--skip-git-repo-check` is never used. The adapter never relies on Codex session state; `resume` is not used.

Per-role settings (`config.yaml` `agents.roles.<role>`): model, reasoning effort, sandbox, network, timeout. The reviewer role may be pinned to a different model than implementers.

### 18.5 Fake runner

A scripted runner used in tests and dry runs: given a task, it applies a prepared patch (or none), writes prepared reports, and returns a prepared result. Scripts are keyed by role and attempt number so escalation paths can be tested deterministically.

---

## 19. Autonomy rules

As in v1, with these additions to the "may not" list:

- run any git write command (commit, push, checkout, reset, rebase, stash)
- modify files outside the assigned repository or designated `.janus/` paths
- change files under forbidden paths (section 14)
- publish packages directly (only the orchestrator triggers publish builds)

---

## 20. Guardrails

```yaml
guardrails:
  max_ci_fix_attempts: 5            # per verification boundary
  max_ai_review_cycles: 3
  max_no_progress_iterations: 2
  max_work_packages_without_green: 3
  max_policy_violations_per_package: 2
  max_changed_files: null
  max_diff_lines: null
  max_agent_runtime_minutes: 60
  max_goal_runtime_hours: null
  require_human_for: [architecture_change, scope_change, acceptance_criteria_change,
                      product_behavior_change, new_baseline_exception, repo_order_change]
  forbidden: [disable_tests, skip_failing_tests, remove_failing_tests,
              weaken_assertions_for_green, bypass_quality_checks,
              upgrade_beyond_target_major, git_write_by_agent, edit_ci_config]
```

Null disables a limit. Hitting any limit escalates (section 25).

---

## 21. AI checkpoint after each work package

Unchanged from v1. The checkpoint agent runs read-only, receives the package diff per repo, policy-check results, build outcomes, and the plan slice. Outcomes: `PASS`, `CONTINUE_WITH_REFINED_TASKS`, `REGROUP_VERIFICATION`, `ESCALATE`. `REGROUP_VERIFICATION` proposals are applied only if `plan.yaml` re-validates.

---

## 22. Independent final AI review

Unchanged from v1, applied across repositories: the reviewer receives every repo's full branch diff, CI and E2E evidence, the plan, and the goal. It never receives implementation agent output. Findings are structured (repo, file, severity, category, description, suggested action). A fresh fix agent addresses findings per repo; CI and E2E invalidation rules apply; the cycle counter is `max_ai_review_cycles`.

---

## 23. QA recommendation

Unchanged from v1, with per-repository change-impact sections and one goal-level section covering cross-repository behavior (Module Federation boundaries, shared library consumers). Output goes to `evidence/qa/` and is posted as a comment on each PR.

---

## 24. Human review loop, merge, completion

`janus run` (or `janus review sync`) polls each PR's activity stream since `review_loop.activity_cursor`:

- new comments (general or inline) become fix tasks grouped per repo; a fresh fix agent runs per repo; then CI, E2E if invalidated, fresh AI review, QA refresh if the diff changed
- `NEEDS_WORK` is treated as comments present
- `APPROVED` on every PR by the required reviewers moves the goal to `awaiting_merge`

Merge order is derived from `depends_on` and shown by `janus status`. After all PRs are merged (detected by polling PR state), the goal moves to `completed`, the final handover records the post-merge release order for libraries (replace prerelease versions with released versions), and telemetry is finalized.

---

## 25. Escalation and replanning

Unchanged from v1. `escalation.md` follows the v1 escalation package structure and additionally names the repository and work package. `janus escalation resolve --direction "..."` records the human direction in `decisions.md`, starts a fresh replanning agent that updates `plan.md` and `plan.yaml`, checkpoints, and enters Gate 2. Execution resumes only after `janus approve revised-plan`.

---

## 26. Human gates

Four mandatory gates as in v1:

1. plan approval (`janus approve plan`)
2. revised plan approval (`janus approve revised-plan`)
3. PR approval (in Bitbucket, all PRs)
4. merge (in Bitbucket, all PRs, dependency order)

Gate entry time and exit time are recorded to measure human wait time.

---

## 27. Telemetry

Append-only events in `telemetry/events.jsonl`. Minimum event types:

```text
goal.created, stage.entered, stage.exited
agent.started, agent.finished          (role, repo, run_id, tokens, duration, status)
policy.checked                          (attempt_id, pass, violations)
commit.created, push.completed
ci.build.found, ci.build.triggered, ci.build.finished   (repo, build_id, status, duration)
e2e.triggered, e2e.finished, e2e.invalidated
budget.incremented, guardrail.hit
gate.entered, gate.passed               (type, waited_seconds)
escalation.created, escalation.resolved
pr.created, pr.comment.received, pr.approved, pr.merged
goal.completed
```

`janus status --telemetry` derives the v1 metrics (human time, autonomous time, runs by role, fix iterations, review cycles, escalations, tokens, packages completed, regroups, tests added, QA recommendations) from events. Cost estimation is optional and uses a price table in `config.yaml` when present.

---

## 28. Configuration

`.janus/config.yaml` (committed, no secrets):

```yaml
workflow:
  agent_runner: codex            # codex | fake
  ci_provider: teamcity          # teamcity | local | fake
  scm_provider: bitbucket-server # bitbucket-server | fake
  sequential_execution: true
  create_prs_early: true

teamcity:
  url: https://teamcity.example.internal
  token_env: JANUS_TEAMCITY_TOKEN
  poll_interval_seconds: 30
  appearance_timeout_minutes: 5
  build_timeout_minutes: 90
  e2e_timeout_minutes: 240

bitbucket:
  url: https://bitbucket.example.internal
  token_env: JANUS_BITBUCKET_TOKEN
  required_reviewers: []         # empty: any approval counts

local_ci:                        # used by ci_provider: local and for baseline local checks
  repos:
    ui-kit:
      install: pnpm install --frozen-lockfile
      build: pnpm build
      test: pnpm test -- --watch=false
  e2e: pnpm --dir e2e run full

agents:
  max_parallel: 4
  max_context_bytes: 200000
  roles:
    implementation: { sandbox: workspace-write, network: true, timeout_minutes: 60 }
    debug:          { sandbox: workspace-write, network: true, timeout_minutes: 45 }
    fix:            { sandbox: workspace-write, network: true, timeout_minutes: 45 }
    discovery:      { sandbox: read-only, network: false, timeout_minutes: 30 }
    planning:       { sandbox: read-only, network: false, timeout_minutes: 45 }
    checkpoint:     { sandbox: read-only, network: false, timeout_minutes: 20 }
    review:         { sandbox: read-only, network: false, timeout_minutes: 60, model: null }
    qa:             { sandbox: read-only, network: false, timeout_minutes: 30 }

policy:
  forbidden_test_patterns: ["xit(", "xdescribe(", "fit(", "fdescribe(", ".skip(", ".only("]
  forbidden_paths: [".teamcity/**", ".github/**"]
  max_test_count_decrease_percent: 0
  allow_test_file_deletion: false

digest:
  max_tests: 50
  log_tail_lines: 400
  max_error_windows: 10
  max_bytes: 65536

guardrails:                      # see section 20 for semantics
  max_ci_fix_attempts: 5
  max_ai_review_cycles: 3
  max_no_progress_iterations: 2
  max_work_packages_without_green: 3
  max_policy_violations_per_package: 2
  max_agent_runtime_minutes: 60

telemetry:
  price_table: null
```

Secrets: `JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN`. Codex authentication is handled outside Janus.

---

## 29. Testing strategy for Janus itself

Janus is developed on a network where TeamCity and Bitbucket are unreachable, so the test pyramid is:

1. **Unit tests** (vitest): state transitions, `plan.yaml` validation, policy checks, failure signature, digest truncation, context package rendering, output validation, budget accounting.
2. **Adapter contract tests**: TeamCity and Bitbucket Server adapters run against recorded HTTP fixtures (request and response pairs captured from documentation and, later, from the real systems). The `local` and `fake` providers must pass the same provider contract test suite as the real adapters.
3. **Engine integration tests**: temporary git repositories (two or three, with dependencies) plus the fake runner, fake CI, and fake SCM drive a whole goal from `init` to `completed`, and separately through each escalation path, resume after simulated crash, policy violation, coupled red, E2E invalidation, and human comment loops.
4. **Dogfood run**: a throwaway Angular 15 application (outside this repository) run with the real Codex runner, the `local` CI provider, and the fake SCM provider. This is the first real end-to-end exercise and is documented as a runbook, not automated.
5. **First contact runbook** for the work network: `janus doctor`, read-only TeamCity and Bitbucket calls, baseline only, then a small goal.

---

## 30. Implementation phases

Detailed in `tasks.md`. Summary:

1. repository bootstrap and CLI skeleton
2. state model, state branch, workspace, checkpoints
3. engine core: state machine, run loop, gates, locking, resume, telemetry events
4. agent runner: contract, context packages, schemas, Codex adapter, fake runner
5. policy checks, orchestrator commit and push
6. CI providers: interface, digest, `local`, `fake`, `teamcity`
7. SCM providers: interface, `fake`, `bitbucket-server`
8. discovery and baseline stages
9. planning, `plan.yaml` validation, Gate 1
10. execution loop: packages, groups, debug loop, budgets, checkpoints, publish
11. E2E, final review, QA, human review loop, completion
12. escalation and replanning
13. rendering: handover, escalation, status
14. telemetry metrics
15. integration harness and dogfood runbook
16. documentation and first-contact runbook

---

## 31. Acceptance criteria

v1 criteria 1 through 22 remain, reinterpreted per repository where relevant, plus:

23. a goal with three repositories and a dependency graph is executed in dependency order
24. a library work package can trigger a prerelease publish and dependents receive the version
25. every diff is policy-checked before commit and violations are evidenced and fed back
26. E2E results are invalidated by any new commit on any goal branch
27. the whole loop runs to completion and through every escalation path using only fakes
28. a workspace can be rebuilt on another machine from the state branch alone
29. no agent process ever performs a git write operation (verified in the integration harness by inspecting reflogs)

---

## 32. Non-negotiable safety rules

v1 rules 1 through 10 plus:

11. Agents never commit, push, or otherwise rewrite Git history.
12. Secrets never enter `.janus/`, prompts, or evidence.
13. Never trigger a publish of a non-prerelease version.

---

## 33. Assumptions and open items

- TeamCity PR builds run on the source branch with the Pull Requests build feature; the VCS root branch spec includes `ai/*`. If it does not, the explicit trigger path still works when the branch spec allows it; otherwise the branch spec must be widened by a TeamCity admin (recorded in the first-contact runbook).
- The E2E build configuration can accept per-repo branch parameters and handles deployment itself.
- Prerelease publishing is available as a TeamCity build configuration per library; if not, `requires_publish` packages escalate with a clear message.
- Bitbucket Server exposes inline comments through the activities endpoint with anchors; the fix agent receives file and line.
- The developer machine can run Codex with `workspace-write` and network enabled for installs; Codex uses bubblewrap on Linux.
- A Claude Code `AgentRunner` is out of scope but the contract is designed so it can be added.

---

## 34. Guiding principles

Unchanged from v1:

- State survives. Agents do not.
- Humans approve intent. Agents execute detail.
- CI is evidence, not orchestration.
- Green is required at meaningful boundaries.
- Planning is progressive.
- Automation must remain bounded.
- Independent review matters.
- Testing is part of implementation.

Added:

- Safety rules are enforced by code where they can be, and by review where they cannot.
- Fakes are part of the product, not an afterthought.
