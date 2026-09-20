# Janus: Angular AI Development Workflow v2.1

Status: draft for review. Supersedes `angular-ai-development-workflow-v1.md`. v2.1 incorporates an independent review of v2.

---

## 0. What changed and why

### 0.1 v1 to v2

| Topic | v1 | v2 | Reason |
|---|---|---|---|
| Workflow layer | Spec Kit "or equivalent" | Janus owns a small TypeScript state machine | Spec Kit's Codex step discards output, has no output schema, sandbox or cwd control, and keeps run state outside Git. |
| Goal shape | One repo, one branch, one PR | One goal spans N repos in dependency order; one branch and one PR per repo | The application is spread over several repositories with mixed coupling. |
| State location | `.ai-dev/` on the goal branch | `.janus/` on a dedicated branch `janus/<goal-id>` in a goal workspace | Clean PR diffs; discovery and plan checkpointed before any code branch exists. |
| Who commits | Implicit | Only the orchestrator commits and pushes | Codex `workspace-write` makes `.git` read-only; orchestrator commits are where policy checks run. |
| Test integrity | Prompted rule | Deterministic policy checks on every diff | Makes "never weaken tests" enforceable. |
| Baseline checks | Run by discovery agents | Run by the orchestrator through the CI provider | Agents stay read-only with respect to product code. |
| CI / SCM coupling | Hard-wired | `CiProvider` and `ScmProvider` interfaces with real, `local`, and `fake` implementations | Work systems are unreachable from the development network. |
| PR build discovery | "observe automatic build" | Find by `revision:<sha>` and build type; trigger if absent | TeamCity has no PR-number locator. |
| Failure handoff | "latest TeamCity failure" | Bounded, redacted failure digest | Logs are unpaginated and can be tens of MB. |
| Plan format | `plan.md` | `plan.md` plus `plan.yaml` | Engine needs machine-readable packages and groups. |
| CLI | Not defined | `init`, `run`, `status`, `approve`, `reject`, `escalation`, `doctor` | Step-wise CLI runtime with CLI gates. |

### 0.2 v2 to v2.1 (independent review)

| Topic | Change |
|---|---|
| Sandbox model | Report-writing roles run `workspace-write` with a report directory as cwd; pnpm store and caches become writable roots; `ng update --allow-dirty` guidance; `doctor` probes all of it for real (§3.3, §18.4). |
| Base-branch drift | New sync step at package boundaries and before final E2E, with bounded conflict resolution (§16.6). |
| Post-merge release | Library merge triggers release build, consumer bump, CI, then consumer merge; Janus owns it (§24). |
| Partial merge | Per-repo `merged` state; E2E and fix loops use base branches for merged repos (§6, §17, §24). |
| Budgets | Explicit budget table with increment, reset, and escalation events (§20); per-work-package state block (§6). |
| Infra failures | Cancelled or failed-to-start builds re-trigger once and never consume a debug attempt (§16.1). |
| Discovery | Prepare step (install, build) before discovery; areas configurable, default three per repo; shell remotes outside the goal must be acknowledged (§10). |
| Exceptions | Orchestrator owns the exception list; planner annotates only (§11, §12). |
| Prerelease versions | Janus computes the version and passes it to the publish build; later commits re-trigger publish and consumer bumps (§13). |
| Policy violations | One in-place fix attempt before a reset (§14). |
| Failure signature | Includes normalized error lines, not only problem identities (§16.3). |
| E2E failures | One automatic rerun, then a read-only triage agent names the repo (§17). |
| Reviewer context | File list and stats inline; reviewer runs `git diff` itself (§18.2). |
| Review loop | Own comments skipped; `no_change_needed` replies; declined PR escalates (§24). |
| State clone | `.janus/` is a single-branch clone; dedicated state repo recommended (§5). |
| Fakes | Persist to disk so they survive across `janus run` processes (§29). |
| Operator skill | New section 35: thin conversational front door over the CLI. |
| Build order | Vertical slices, one repo first (§30). Manual prompt spike before the execution loop is built. |
| Model experiments | Named model profiles, per-role model ladders on retry, experiment tags on every agent run and event, and a `telemetry compare` command (§18.6). |

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
- one long-lived goal branch and one pull request per repository
- orchestrator-run prepare step (install, build) and read-only discovery per repository, plus cross-repository integration discovery
- orchestrator-run baseline verification (local checks, per-repo CI builds, goal-level E2E)
- human-approved technical plan (`plan.md` + `plan.yaml`)
- sequential work packages, each scoped to one or more repositories
- verification groups for coupled work
- base-branch sync during execution
- per-repository CI build feedback loop with bounded fresh debug agents
- goal-level full E2E through the CI provider, with per-repository branch names passed as parameters
- library prerelease publishing during execution and release-and-bump after merge, through CI builds
- fresh agent process per meaningful task
- deterministic policy checks on every diff before commit
- AI checkpoint per work package, independent final AI review, QA recommendation
- human PR review loop across all PRs, human merge in dependency order
- structured escalation and replanning
- Git-based state, handover, and resume
- telemetry from the first run
- step-wise CLI runtime on a developer machine, with a thin operator skill as the conversational front door
- fakes and a local CI provider so the whole loop is testable without TeamCity or Bitbucket

### Out of scope for v1 of Janus

- multi-major upgrades in one goal
- autonomous merge
- autonomous approval of baseline exceptions
- parallel code-changing agents on the same repository
- selective E2E execution
- automatic architectural changes
- weakening, skipping, or removing tests to obtain green CI
- a daemon or webhook receiver (polling only)
- replacing TeamCity or Bitbucket
- a general-purpose agent framework
- Bitbucket Cloud (interface allows it; not implemented)

---

## 3. Architecture

```text
                        +--------------------+
                        |     Human User     |
                        |  operator skill /  |
                        |  CLI gates, PRs    |
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
         |  task              |        |  fake/ (persisted) |
         +--------------------+        +--------------------+
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
- base-branch sync
- CI observation and triggering through `CiProvider`
- PR creation, comment polling, approval and merge detection through `ScmProvider`
- failure digests with redaction, handover, escalation packages, status rendering
- telemetry events

### 3.2 Provider interfaces

All three are small TypeScript interfaces with at least one real and one fake implementation. Fakes are first-class: they are how Janus is developed and how the full loop is exercised from a network without TeamCity or Bitbucket. Fakes persist their state under `<workspace>/fake/` because every `janus run` is a new process.

```text
AgentRunner
  run(task: AgentTask): Promise<AgentResult>
  implementations: codex, fake (scripted, persisted)

CiProvider
  findBuild(repo, revision, buildTypeId): Promise<BuildRef | null>
  triggerBuild(repo, buildTypeId, branch, revision, params): Promise<BuildRef>
  waitForBuild(ref, timeout): Promise<BuildOutcome>     // status + classification: tests_failed | build_failed | infra
  failureDigest(ref, limits): Promise<FailureDigest>    // redacted
  implementations: teamcity, local, fake

ScmProvider
  ensureBranch(repo, name, base): Promise<void>
  createPullRequest(repo, branch, base, title, body): Promise<PullRef>
  getPullRequest(ref): Promise<PullState>               // OPEN|MERGED|DECLINED, reviewer statuses, merge commit
  listActivitySince(ref, cursor): Promise<Activity[]>   // comments incl. inline anchors, approvals, NEEDS_WORK
  addComment(ref, text, replyTo?): Promise<void>
  currentUser(): Promise<string>                        // to skip Janus's own comments
  implementations: bitbucket-server, fake
```

The `local` CI provider runs configured shell commands (install, build, test, e2e) in the repository checkout and produces the same `BuildOutcome` and `FailureDigest` shapes as TeamCity.

### 3.3 Agents and sandboxes

Codex processes started fresh per task through `codex exec`. Roles fall into three sandbox classes:

| Class | Roles | Sandbox | cwd | Writable roots |
|---|---|---|---|---|
| code-writing | implementation, debug, fix, sync-conflict | `workspace-write`, network on | the assigned repo | repo, pnpm store and caches (§18.4) |
| report-writing | discovery, integration discovery, planning, replanning, qa | `workspace-write`, network off | `.janus/reports/<run-id>/` | that directory only |
| read-only | checkpoint, review, triage | `read-only` | the workspace root | none; results returned as JSON |

All classes can read the whole workspace (repos and `.janus/`). `.git` directories are read-only in every class, which is why agents cannot commit. Every prompt states that git write commands are forbidden. The workspace root is not a git repository, and is not made one: `git init`-ing it would nest `.janus/` — itself a git checkout — and every `repos/<name>` inside a fourth repository, and would add a reflog the §31.29 audit does not enumerate. The read-only class therefore starts outside a work tree, which §18.4 permits with `--skip-git-repo-check` for that class alone.

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
    # clone_url: https://...   optional; derived from bitbucket.clone_url_template when absent
    base_branch: main
    package_name: "@acme/ui-kit"
    ci:
      pr_build_type_id: Fe_UiKit_Build
      publish_build_type_id: Fe_UiKit_Publish      # accepts property janus.version
      release_build_type_id: Fe_UiKit_Release      # post-merge release; optional, else publish build with a release version
    depends_on: []

  - name: shell
    kind: shell
    scm: { project: FE, slug: shell }
    base_branch: main
    ci: { pr_build_type_id: Fe_Shell_Build }
    depends_on: [ui-kit]
    loads_remotes: [orders-remote, billing-remote]   # every remote the shell loads at runtime

  - name: orders-remote
    kind: remote
    scm: { project: FE, slug: orders-remote }
    base_branch: develop
    ci: { pr_build_type_id: Fe_Orders_Build }
    depends_on: [ui-kit]
    coupled_with: [shell]

acknowledged_outside_goal:
  - repo: billing-remote
    reason: retired next quarter; stays on Angular 15 behind a feature flag

e2e:
  build_type_id: Fe_E2E_Full
  branch_params:
    shell: env.SHELL_BRANCH
    orders-remote: env.ORDERS_BRANCH
  extra_params: {}
  suite_repo_map: {}         # optional: scenario prefix -> repo, used by E2E triage

success_criteria: [...]
non_goals: [...]
```

Rules:

- `depends_on` orders work: a repository's package cannot start before its dependencies reach the required state (libraries: prerelease published; coupled runtime peers: same verification group).
- `coupled_with` declares runtime coupling (Module Federation shared singletons). It is symmetric; the engine normalizes it. Coupled repositories share a verification group and are verified together only by the goal-level E2E.
- `loads_remotes` lists every remote a shell loads. Validation fails unless each is in `repos` or in `acknowledged_outside_goal`. Integration discovery cross-checks this list against the shell's federation config and reports discrepancies.
- Each repository gets its own goal branch `ai/<goal-id>` and its own PR.
- A goal is complete only when every PR is merged and post-merge release steps are done.

---

## 5. Workspace and Git layout

`janus init` creates a goal workspace on the developer machine:

```text
<workspace>/
  .janus/                 # single-branch clone of the state branch janus/<goal-id>
  repos/
    ui-kit/               # clone, on ai/<goal-id> once created
    shell/
    orders-remote/
  fake/                   # persisted fake provider state (only with fake providers)
  .pnpm-store/            # optional workspace-local pnpm store (§18.4)
  janus.lock              # run lock with PID and timestamp
```

The state branch lives in a dedicated state repository when one is configured (recommended). Otherwise it lives in the first repository of `goal.yaml`; in that case the TeamCity VCS root branch spec must exclude `janus/*` so state pushes do not trigger builds (`doctor` warns about this). `.janus/` is a plain single-branch clone, not a worktree, so re-cloning a product repo never breaks it.

### `.janus/` contents

```text
.janus/
  config.yaml             # policy and provider configuration, no secrets
  goal.yaml
  state.yaml              # authoritative runtime state (§6)
  plan.md                 # approved technical plan, human-readable
  plan.yaml               # approved plan, machine-readable (§12)
  decisions.md            # append-only decision log
  handover.md             # regenerated at every checkpoint
  escalation.md           # present only while escalated

  discovery/
    <repo>/<area>.md
    integration.md
    summary.yaml

  reports/<run-id>/       # raw agent-written reports before the orchestrator files them

  evidence/
    baseline/
    builds/<repo>/<build-id>.yaml
    digests/<repo>/<build-id>.md      # redacted, bounded
    e2e/<build-id>.yaml
    policy/<attempt-id>.yaml
    agents/<run-id>.yaml              # validated result, token usage, duration
    sync/<repo>/<sha>.yaml            # base-branch sync records
    reviews/
    qa/

  telemetry/
    events.jsonl
```

Secrets come from environment variables only and are never written under `.janus/`.

---

## 6. State schema

`state.yaml` is authoritative. Version 2. Fields may be added within v2 but not removed or repurposed.

```yaml
version: 2

goal:
  id: angular-15-to-16
  status: planning        # created | preparing | discovering | baselining | planning |
                          # awaiting_plan_approval | executing | final_e2e |
                          # ai_review | qa | awaiting_human_review |
                          # fixing_review_feedback | awaiting_merge | releasing |
                          # escalated | replanning | completed

state_branch:
  name: janus/angular-15-to-16
  remote: state-repo      # repo name or "state-repo"

repos:
  ui-kit:
    goal_branch: ai/angular-15-to-16
    base_commit: null       # base-branch commit the goal branch currently includes
    head_commit: null
    pr: { id: null, url: null, state: null, version: null, approved: false }
    last_build: { id: null, status: unknown, classification: null, revision: null, explicit_trigger: false }
    prerelease_version: null
    release_version: null
    merged: false
    merge_commit: null

plan:
  approved: false
  approved_commit: null
  approved_at: null
  revision: 0

baseline:
  approved: false
  repos:
    ui-kit: { commit: null, local: {}, pr_build: { id: null, status: unknown } }
  e2e: { id: null, status: not_run, branches: {} }
  exceptions: []          # { id, repo, kind: test|build|e2e, identity, reason, approved_by, approved_at }

execution:
  current_work_package: null
  current_verification_group: null
  work_packages:
    wp-01-ui-kit-angular:
      status: pending       # pending | in_progress | expected_red | green | done | skipped
      repos:
        ui-kit:
          commits: []
          builds: []
          attempts: 0
          policy_violations: 0
          last_failure_signature: null
      publish: { version: null, build_id: null }
      checkpoint: { outcome: null, run_id: null }
      regroups: []
  in_flight:
    step: null
    started_at: null
    agent_run_id: null
    repo: null              # repo the in-flight agent writes to; its uncommitted diff is saved and reset on recovery
    budget: null            # budget an interrupted agent run counts against (see §20)
  budgets:                 # see §20 for increment/reset rules
    ci_fix_attempts: 0
    e2e_fix_attempts: 0
    ai_review_cycles: 0
    no_progress_iterations: 0
    work_packages_without_green: 0
    sync_conflict_attempts: 0
    infra_retries: 0

verification:
  e2e:
    status: not_run        # not_run | running | passed | failed | invalidated
    build_id: null
    heads: {}              # repo -> commit (or base commit for merged repos)
    reruns: 0
  ai_review: { status: not_run, run_id: null, findings_open: 0 }
  qa_recommendation: { status: not_run, run_id: null }

gate:
  type: null               # plan_approval | revised_plan_approval | pr_review | merge
  status: none             # none | waiting | passed
  entered_at: null
  checkpoint_commit: null

review_loop:
  activity_cursor: {}      # repo -> last processed activity id
  open_comments: []        # { repo, comment_id, author, path, line, text, status: open|fixed|answered }

release:
  order: []                # repos in merge/release order
  done: []

telemetry:
  started_at: null
  last_updated_at: null
```

---

## 7. Checkpoint rule and resume semantics

Every meaningful state transition ends in a checkpoint commit on the state branch containing the updated `state.yaml`, regenerated `handover.md`, new evidence, and any `decisions.md` append. Code changes are committed on the goal branch before the checkpoint that references them.

Rules:

1. A human gate is never entered before a checkpoint exists; `gate.checkpoint_commit` records it.
2. `janus run` starts by loading committed state, then reconciles with reality: for each repo it verifies the local goal branch head equals `repos.<name>.head_commit`, fetches the remote goal branch and base branch, and records drift. Non-fast-forward drift on a goal branch escalates. New base-branch commits are noted and handled by the sync step (§16.6).
3. If `execution.in_flight.step` is set at load time, the previous process died mid-step:
   - agent run: the uncommitted diff in the assigned repo is saved to `evidence/agents/<run-id>.interrupted.patch`, the tree is reset, the run counts as one failed attempt against the budget of its role (§20), and the step re-runs.
   - CI or E2E wait: resume waiting on the recorded build id.
   - any other step: re-run (all such steps are idempotent).
4. State pushes are fast-forward only. If the remote state branch moved, `run` stops and asks the human to reconcile.
5. A fresh Janus process on another machine resumes with `janus init --resume`, which clones the state branch and re-clones the repositories at their recorded heads.
6. `janus.lock` stores PID and timestamp; a lock whose PID is dead is reclaimed with a warning.

---

## 8. CLI surface and run model

```text
janus init --goal goal.yaml [--workspace DIR]
janus init --resume <state-remote> <goal-id>
janus run [--until STAGE] [--max-wait 45m] [--dry-run]
janus run --model-profile <name>         per-invocation model profile override
janus status [--json] [--telemetry]
janus telemetry export [--csv] | compare <events.jsonl> ...
janus approve plan --commit SHA [--exception ID ...]
janus approve revised-plan --commit SHA
janus reject plan --reason "..."
janus escalation show [--json] | resolve --direction "..."
janus review sync
janus doctor [--json]
janus agent run <role> --task FILE       debug helper
janus ci wait|trigger|digest ...         debug helpers
```

Run model:

- `janus run` advances step by step until a human gate, a blocking wait longer than `--max-wait`, an escalation, or completion. It prints a status summary and exits with a distinct exit code per reason.
- Every step is bracketed by `in_flight` set/clear and ends with a checkpoint.
- Gates 1 and 2 are passed only by `janus approve`, which requires `--commit` so approval is bound to an exact state-branch commit, and records the approver from git identity in `decisions.md`. Gates 3 and 4 are observed from the SCM provider (approvals and merges) and recorded on the next run.
- `--json` outputs of `status`, `escalation show`, and `doctor` are stable contracts consumed by the operator skill (§35).

---

## 9. Core workflow

```text
init
  |
prepare (orchestrator: clone, install, build per repo via local CI provider)
  |
discovery (per repo, configurable areas, parallel) + integration discovery
  |
baseline (local checks per repo, PR build per repo on base, goal E2E on base branches)
  |
planning (fresh agent -> plan.md + plan.yaml)
  |
GATE 1: approve plan + baseline + exceptions
  |
create goal branches (+ PRs if create_prs_early)
  |
execute work packages in plan order
  |   sync from base (per repo touched)
  |   fresh implementation agent per repo
  |   policy checks -> commit -> push
  |   per-repo CI build: wait for automatic, trigger if absent
  |       infra failure -> re-trigger once
  |       red -> defect -> fresh debug agent (bounded)
  |             coupled-expected (verified) -> continue inside group
  |   group boundary -> all repos green; E2E if flagged
  |   prerelease publish if required; dependents receive version
  |   AI checkpoint (fresh)
  |
sync from base (all repos) -> final E2E (goal-level)
  |
independent AI review -> findings -> fresh fix agent -> CI -> E2E if invalidated -> review
  |
QA recommendation
  |
GATE 3: human review of all PRs -> comments -> fix -> CI -> E2E if invalidated -> AI review -> QA refresh
  |
GATE 4: human merges in dependency order
  |   library merged -> release build -> fix agent bumps consumers -> CI -> next merge
  |
completed
```

Escalation can happen from any autonomous step and leads to `escalated` -> human direction -> `replanning` -> GATE 2 -> `executing`.

---

## 10. Prepare and discovery

### Prepare

The orchestrator runs install and build per repository through the `local` CI provider before discovery, so agents can inspect `node_modules`, run `ng update` in listing mode, and read build output. Results are stored under `evidence/baseline/<repo>/local.yaml` and reused by the baseline stage.

### Discovery

Discovery agents are report-writing (§3.3): they read repositories freely and write into their report directory only. They may not run installs, builds, or tests.

Areas are configurable (`discovery.areas`). Default, three per repository:

1. dependencies and build tooling (Angular, TypeScript, RxJS, Module Federation, CLI config)
2. tests and E2E (unit topology, E2E hosting, coverage)
3. architecture, high-risk areas, and CI configuration files in the repo

Then one integration discovery agent reads all reports and produces `integration.md`: shared singleton versions across shell and remotes, library version graph, publish flow, E2E environment topology, recommended order, and a check of `loads_remotes` against the shell's federation config.

Each agent returns structured findings (`area`, `repo`, `findings`, `risks`, `known_gaps`, `recommended_work`, `evidence`, `confidence`). The orchestrator files reports under `discovery/` and merges the structured parts into `discovery/summary.yaml`.

---

## 11. Baseline

Run by the orchestrator, not by agents.

Per repository at its base-branch head: local checks (from prepare, plus tests and lint) and the PR build through the configured CI provider. Goal-level: full E2E on the base branches.

Failures become proposed baseline exceptions with stable identities (test identity, build problem identity, or E2E scenario id). The orchestrator owns this list; the planning agent may only annotate reasons. Only a human approves exceptions, at Gate 1. No new exception may be created autonomously later; a newly discovered pre-existing failure escalates.

---

## 12. Technical plan and Gate 1

A fresh planning agent receives the goal, discovery summary and reports, baseline results, and guardrails. It writes `plan.md` (v1 sections plus Repository Order) and `plan.yaml`:

```yaml
version: 1
work_packages:
  - id: wp-01-ui-kit-angular
    title: Upgrade ui-kit to Angular 16
    repos: [ui-kit]
    objective: ...
    allowed_scope: [package.json, pnpm-lock.yaml, angular.json, tsconfig*.json, src/**, projects/**]
    definition_of_done: [...]
    verification: { pr_build: required }
    requires_publish: true
    depends_on: []
    risks: [...]
  - id: wp-02-shell-angular
    repos: [shell]
    depends_on: [wp-01-ui-kit-angular]

verification_groups:
  - id: vg-runtime-core
    work_packages: [wp-02-shell-angular, wp-03-orders-angular]
    reason: Module Federation shared singletons must match
    e2e_after: true
    max_red_window: 2

exception_annotations:
  - id: baseline-ex-003
    reason: known flaky checkout test, tracked in JIRA FE-1234
```

Engine validation: every repo exists; `depends_on` is acyclic; coupled repos share a group; red windows respect `guardrails.max_work_packages_without_green`; `requires_publish` only on libraries with a publish build; `allowed_scope` is wide enough to include lockfiles and Angular CLI migration targets (the validator warns when `package.json` is in scope but the lockfile is not). T06 measured this on an Angular 15 to 16 application: `ng update @angular/core@16 @angular/cli@16 --allow-dirty` changed 3 files, spread over `package.json`, the lockfile, and `src/main.ts`. That run was against a bare `ng new` scaffold with almost no application code, so 3 files is a minimal-scaffold floor, not a typical footprint — a real application will have far more under `src/**` for the CLI migrations to rewrite. The example scope above is therefore the floor, not a suggestion: `allowed_scope` must cover `package.json`, the lockfile, and `src/**` broadly, because CLI migrations touch files across the whole repository and a scope drawn too tightly manufactures spurious policy violations. See `docs/spikes/prompt-spike.md`.

Gate 1: `janus approve plan --commit <state-sha> [--exception <id> ...]`. Approval covers plan, packages, groups, verification strategy, baseline, and the listed exceptions.

---

## 13. Work packages and verification groups

As in v1, with:

- a package lists its `repos`; one implementation agent runs per repo, sequentially, in dependency order
- `requires_publish: true`: after the repo is green, Janus computes `prerelease = <current>-janus.<goal-id>.<n>`, triggers `publish_build_type_id` with property `janus.version`, waits, and records the version; dependent packages receive it in context and must pin it. Any later commit on a `requires_publish` repo (debug, fix, review, sync) re-triggers publish and creates a bump task for dependents
- groups may span repositories; the boundary condition is every repo in the group green on its PR build plus E2E when `e2e_after` is true
- red windows are primarily intra-repository sequences; cross-repo runtime coupling is verified by E2E, not by allowing red PR builds
- dynamic regrouping is allowed under v1 conditions; the engine re-validates `plan.yaml` and records the reason

---

## 14. Commit model and policy checks

Agents never commit. After a code-writing agent finishes, the orchestrator:

1. collects the diff (tracked and untracked, excluding ignored files)
2. runs policy checks
3. on pass: commits with a conventional message referencing package and run id, then pushes
4. on violation: writes `evidence/policy/<attempt-id>.yaml`, then runs one fresh "remove the violation" fix agent with the report and the diff kept in place; if the re-check still fails, or `max_policy_violations_per_package` is reached, the tree is reset, the diff is saved as a patch, and the attempt counts against the role budget

Policy checks (deterministic, configurable, on by default):

| Check | Default |
|---|---|
| forbidden test patterns added | `xit(`, `xdescribe(`, `fit(`, `fdescribe(`, `.skip(`, `.only(`, `it.todo(`, tautological expectations |
| deleted or renamed test files | violation unless the package allows it |
| net decrease in test count | threshold per repo, default 0 percent |
| forbidden paths | `.teamcity/**`, `.github/**`, other CI paths as configured. Runner configs (`karma.conf.js`, `jest.config.*`) may change, but lowering coverage thresholds or excluding tests in them is a violation |
| Angular version beyond target | any `@angular/*` major above `target_version` |
| scope | files outside `allowed_scope` |
| diff size | `max_changed_files`, `max_diff_lines` when set |
| secrets | common token patterns |

The AI checkpoint remains responsible for judgment calls (weakened assertions, behavior changes).

Output-schema note: Codex strict schemas require every property to be present, so role schemas list all fields as required and use `null` for "not applicable".

---

## 15. Pull request model

Goal branches are created for every repository at Gate 1 from the recorded base commits. PRs are created either at Gate 1 (`create_prs_early: true`, default) or when a repository's first package starts. PR descriptions link to the state branch, the plan commit, and sibling PRs, and are updated at package boundaries. All PRs stay open until the human merges them. Bitbucket Server HTTP access tokens cannot merge, which enforces the human-merge rule.

---

## 16. CI provider and PR build loop

### 16.1 Finding and classifying the build

After a push of commit `S` on repo `R`:

1. poll `findBuild(R, S, pr_build_type_id)` every `poll_interval` for `appearance_timeout`
2. if no build appears, `triggerBuild` explicitly and record `explicit_trigger: true`
3. `waitForBuild` until finished or `build_timeout`

Outcome classification:

- `success`
- `tests_failed`: failed test occurrences present
- `build_failed`: build problems without failed tests (compile, lint, script exit code)
- `infra`: cancelled, failed to start, agent lost, VCS or artifact problems, timeout in queue

`infra` outcomes re-trigger once (`budgets.infra_retries`), then escalate without launching an agent. Only `tests_failed` and `build_failed` start the debug loop.

TeamCity mapping: locator `revision:(S),buildType:(id:X),defaultFilter:false,state:any`; queued builds via `buildQueue`; `UNKNOWN` status maps to `infra` unless failed tests exist. If the build configuration builds merge commits rather than branch heads, `revision:(S)` never matches and every push goes through the explicit trigger path (see §33).

### 16.2 Failure digest

Before any debug or triage agent runs, the orchestrator produces a bounded digest: build problems; failed tests with `newFailure` flag and the first N lines of details (`digest.max_tests`); log tail (`digest.log_tail_lines`) plus windows around error lines (`digest.max_error_windows`); links; baseline-exception matches. A redaction pass removes tokens, credentials, and query strings before anything is written under `evidence/`. Digests are capped at `digest.max_bytes`.

### 16.3 Failure signature and no-progress

```text
failure_signature = sha256(
  sorted(failed test identities)
  + sorted(problem identities)
  + sorted(normalized error lines)   # file paths, TS error codes, first line of each error window,
)                                     # with line numbers and timestamps stripped
```

excluding approved baseline exceptions. A debug attempt is a no-progress iteration when its resulting signature equals the previous one. `max_no_progress_iterations` consecutive no-progress iterations escalate even if attempts remain.

### 16.4 Debug agent

Receives: goal, plan slice, package, repo, package diff so far, digest, previous attempt summaries (one paragraph each), policy reports if any, guardrails, remaining budget, and Angular-specific guidance (§18.4).

### 16.5 Coupled red

An implementation agent may return `expected_temporary_failure: true` with the dependency it expects to resolve it. The engine accepts this only if the package is inside a verification group with remaining red window and the actual failed-test set is a subset of the predicted set in the agent's result; otherwise the failure is treated as a defect. Accepted coupled reds are recorded and execution continues to the next package in the group.

### 16.6 Base-branch sync

Goal branches live for weeks. At the start of each package for each repo it touches, and before final E2E for all repos, the orchestrator fetches the base branch and merges it into the goal branch (`merge`, never rebase, to preserve PR history). Clean merges are committed and pushed and trigger the normal PR build loop. Conflicts start a fresh sync-conflict agent (code-writing class) bounded by `max_sync_conflict_attempts`; the agent resolves conflicts only and the result goes through policy checks. Failure escalates. Every sync is recorded under `evidence/sync/`. `repos.<name>.base_commit` tracks the included base commit.

---

## 17. E2E

E2E is goal-level, orchestrator-triggered, always the full suite: baseline, after groups with `e2e_after`, before final AI review, and after any invalidating change.

Validity: `verification.e2e.heads` records the head commit of every repository (or the base branch commit for merged repos). Any new commit on any unmerged goal branch sets status to `invalidated`.

Trigger parameters: per repo in `branch_params`, the goal branch name, or the base branch name if the repo is merged or not part of the goal.

Failure handling:

1. one automatic rerun (`verification.e2e.reruns`) to absorb flakiness
2. a fresh read-only triage agent receives the digest, every repo's diff summary, and `suite_repo_map`, and returns the most likely repo and a rationale
3. a debug agent runs in that repo under `budgets.e2e_fix_attempts`
4. if triage cannot name a repo with at least medium confidence, escalate with the digest

---

## 18. Agent model

### 18.1 Task contract

```yaml
AgentTask:
  run_id: string
  role: discovery | integration_discovery | planning | replanning | implementation |
        debug | fix | sync_conflict | checkpoint | review | triage | qa
  class: code-writing | report-writing | read-only
  repo: string | null
  cwd: string
  writable_roots: []
  network: boolean
  timeout_minutes: number
  context: ContextPackage
  output_schema: JSONSchema
```

### 18.2 Context package

Rendered into the prompt in this order; nothing else is injected, in particular no previous agent reasoning.

```text
GOAL
REPOSITORY (name, kind, dependencies, coupled repos, base branch, prerelease versions to pin)
APPROVED PLAN SLICE
CURRENT STATE (relevant subset)
CHANGE SUMMARY (file list with added/removed line counts; lockfiles and generated files listed but never inlined)
INLINE DIFF (only for code-writing roles, only the current package, truncated with markers at agents.max_inline_diff_bytes)
LATEST VERIFICATION EVIDENCE (digest or build refs)
PREVIOUS ATTEMPTS (summaries only)
KNOWN BASELINE EXCEPTIONS
GUARDRAILS AND FORBIDDEN ACTIONS
ANGULAR GUIDANCE (package manager, ng update flags, migration expectations)
BUDGET
OUTPUT CONTRACT
```

Review, checkpoint, and triage agents receive the change summary and run `git diff` themselves inside the read-only sandbox instead of receiving inlined diffs.

### 18.3 Output contract

Minimum shape for every role; all fields required, `null` where not applicable:

```yaml
status: completed | blocked | failed
summary: string
changes_made: []
findings: []
evidence: []
new_tasks: []
expected_temporary_failure: false
predicted_failures: []            # test identities, when expected_temporary_failure is true
plan_change_required: false
architecture_change_required: false
behavior_change_required: false
recommended_next_action: string
handover: { current_state: string, next_action: string, risks: [] }
```

Invalid output is one failed attempt; the validation error is included in the retry context.

### 18.4 Codex adapter

```text
codex exec -C <cwd> -s <read-only|workspace-write> \
  -c sandbox_workspace_write.network_access=<bool> \
  --add-dir <root> ... \
  --output-schema <schema.json> --json -o <last-message.json> --ephemeral \
  [-m <model>] [-c model_reasoning_effort=<x>] - < prompt.md
```

Writable roots for code-writing agents: the repo, the pnpm store (`pnpm store path`), `~/.cache`, and `.angular/cache` locations outside the repo. Alternatively Janus sets `npm_config_store_dir=<workspace>/.pnpm-store` in every code-writing agent's environment so a single writable root suffices; this is the default (`agents.pnpm_store: workspace`). No `.npmrc` is written, because pnpm reads `.npmrc` only from a project root.

Angular guidance injected into code-writing prompts: use the repo's package manager; run `ng update` with `--allow-dirty` because the tree is intentionally uncommitted; expect CLI migrations to touch files across the repo; never edit CI configuration.

The adapter parses `turn.completed.usage`, records duration, exit code, and the validated final message under `evidence/agents/<run-id>.yaml`, and kills the process at timeout. `resume` is never used. `--skip-git-repo-check` is passed for the **read-only class only**: §3.3 puts that class's cwd at the workspace root, which is deliberately not a git repository, and real `codex exec` refuses to start there (`Not inside a trusted directory and --skip-git-repo-check was not specified.`). Under the `read-only` sandbox the run has an empty writable-root list and cannot write anything wherever it starts, so the flag's purpose — keeping a write-capable agent inside a known repository — does not apply to it. When `agents.allow_unsandboxed` turns that same role's sandbox into `danger-full-access`, the flag still adds no capability: the git check only decides whether the process starts, and containment for that configuration comes from the `allow_unsandboxed` gate itself, which is recorded in every checkpoint and backstopped by the §31 reflog audit. It is never passed for the code-writing or report-writing classes, whose cwd is always inside a git work tree. (T06 probe R2; `docs/spikes/prompt-spike.md`.)

Bubblewrap requires user namespaces. `janus doctor` runs three real probes: a read-only `codex exec` echo, a `workspace-write` install in a scratch project, and an `ng update --allow-dirty` dry run when Angular is present. If the sandbox cannot start (containers without user namespaces), doctor reports it; running with `danger-full-access` is possible only with `agents.allow_unsandboxed: true` and is recorded in every checkpoint, with the reflog audit (§31) as the remaining guard.

Per-role settings in `config.yaml`: model, reasoning effort, timeout. Class determines sandbox and network. The reviewer may use a different model than implementers.

### 18.5 Fake runner

Scripted by role and attempt number; applies prepared patches, writes prepared reports, returns prepared results; state persisted under `fake/agents.json`.

### 18.6 Model selection and experiments

Janus must make it cheap to compare models (for example `gpt-5.6-sol` against a smaller or faster model) per role without changing code or prompts.

**Model profiles.** `config.yaml` defines named profiles. A profile sets, per role, the model, reasoning effort, and an optional ladder of fallback models tried on successive retries of the same failure (cheap first, strong later, or the reverse). `workflow_models.profile` selects the default; `janus run --model-profile <name>` overrides for that invocation and is recorded in state and telemetry.

```yaml
model_profiles:
  default:
    "*":            { model: gpt-5.6-sol, effort: high }
    implementation: { model: gpt-5.6-sol, effort: xhigh }
    debug:          { model: gpt-5.6-sol, effort: high, ladder: [gpt-5.6-sol, gpt-5.6-sol:xhigh] }
    review:         { model: gpt-5.6-sol, effort: xhigh }
    discovery:      { model: gpt-5.6-sol, effort: medium }
  fast-first:
    "*":            { model: gpt-5.6-mini, effort: medium }
    implementation: { model: gpt-5.6-mini, effort: medium, ladder: [gpt-5.6-mini, gpt-5.6-sol] }
    debug:          { model: gpt-5.6-mini, effort: medium, ladder: [gpt-5.6-mini, gpt-5.6-sol, gpt-5.6-sol:xhigh] }
```

Model names are opaque strings passed to `codex exec -m`; `janus doctor` verifies each configured model is accepted by Codex with a one-token probe.

**Ladders.** For roles with a ladder, attempt `n` uses ladder entry `min(n, len-1)`. A ladder step is recorded as `model_switch` in the attempt record so no-progress detection can distinguish "same model, same failure" from "new model, same failure". Switching models never adds budget.

**Experiment tags.** `config.yaml` may declare `experiment: { id, hypothesis, notes }`. The id, active profile, resolved model, effort, Codex version, and prompt template version are stamped on every `evidence/agents/<run-id>.yaml` and on `agent.started` and `agent.finished` events. Prompt templates are versioned so a comparison never mixes prompt changes with model changes silently.

**Comparison.** `janus telemetry export` writes the event log with resolved dimensions as JSONL or CSV. `janus telemetry compare <events.jsonl> ...` accepts one or more event logs (from different workspaces or goals) and reports per model, per role, per prompt version: runs, success rate, attempts to green, no-progress iterations, policy violations, review findings caused, tokens (input, cached, output, reasoning), wall time, and estimated cost when a price table exists. Comparison is descriptive; it never changes workflow behavior.

**Within-goal experiments.** Two supported designs, both recorded in `decisions.md` when enabled:

- role split: different roles on different models (for example implementation on a strong model, checkpoint and triage on a cheaper one)
- attempt ladder: as above, which yields per-attempt outcome data for each model on the same failure

Randomized per-task assignment is out of scope for v1; comparisons across goals or across repeated dogfood runs are the intended method.

---

## 19. Autonomy rules

As in v1, with these additions to "may not":

- run any git write command
- modify files outside the assigned repository or the assigned report directory
- change files under forbidden paths
- publish packages directly
- resolve anything but conflicts during a sync-conflict task

---

## 20. Guardrails and budget table

| Counter | Incremented when | Reset when | Escalates at |
|---|---|---|---|
| `ci_fix_attempts` | a debug agent finishes (any status) or a code-writing run crashes, for a PR build failure | the repo's PR build goes green | `max_ci_fix_attempts` (5) |
| `e2e_fix_attempts` | a debug agent finishes for an E2E failure | E2E passes | `max_e2e_fix_attempts` (3) |
| `no_progress_iterations` | a debug attempt yields the same failure signature | signature changes or build goes green | `max_no_progress_iterations` (2) |
| `work_packages_without_green` | a package ends in `expected_red` | any package in the group goes green | `max_work_packages_without_green` (3) |
| `ai_review_cycles` | a final review returns findings | never within a goal | `max_ai_review_cycles` (3) |
| `policy_violations` (per package) | policy check fails after the in-place fix attempt | package completes | `max_policy_violations_per_package` (2) |
| `sync_conflict_attempts` | a sync-conflict agent finishes without a clean merge | sync succeeds | `max_sync_conflict_attempts` (2) |
| `infra_retries` | a build is classified `infra` | build finishes with a non-infra outcome | `max_infra_retries` (1) |

Other limits: `max_agent_runtime_minutes` is the ceiling; per-role `timeout_minutes` may only be lower. `max_changed_files`, `max_diff_lines`, `max_goal_runtime_hours` are null by default. Implementation agents returning `failed` or `blocked` count as one `ci_fix_attempts` increment when a build exists, otherwise escalate directly with the agent's summary. Planning, discovery, review, and qa agent failures retry once, then escalate.

`require_human_for` and `forbidden` lists are as in v2, plus `repo_order_change` and `git_write_by_agent`.

---

## 21. AI checkpoint after each work package

Unchanged from v1. The checkpoint agent is read-only, receives change summaries per repo, policy results, and build outcomes, and runs `git diff` itself. Outcomes: `PASS`, `CONTINUE_WITH_REFINED_TASKS`, `REGROUP_VERIFICATION`, `ESCALATE`.

---

## 22. Independent final AI review

Unchanged from v1, across repositories, with the reviewer inspecting diffs itself. Findings are structured (repo, file, severity, category, description, suggested action). A fresh fix agent addresses findings per repo; CI, publish re-trigger, and E2E invalidation rules apply; `ai_review_cycles` bounds the loop.

---

## 23. QA recommendation

Unchanged from v1, with per-repository sections and one goal-level section. Output goes to `evidence/qa/` and is posted as a comment on each PR by Janus's SCM user.

---

## 24. Human review loop, merge, release, completion

Polling each PR's activity stream since `review_loop.activity_cursor`:

- comments authored by Janus's own SCM user are skipped
- other new comments become fix tasks grouped per repo; the fix agent may answer `no_change_needed` with a rationale, which Janus posts as a reply and marks the comment `answered`
- `NEEDS_WORK` is treated as comments present
- new commits reset Bitbucket approvals; Janus records this and re-enters review
- `DECLINED` on any PR escalates with the decline reason
- `APPROVED` on every open PR by the required reviewers moves the goal to `awaiting_merge`

Merge and release, in dependency order shown by `janus status`:

1. the human merges a repo's PR; Janus detects `MERGED`, records `merged: true` and the merge commit
2. if the repo is a library with `requires_publish`, Janus enters `releasing`: triggers `release_build_type_id` (or the publish build with a release version), records `release_version`, runs a fresh fix agent in each consumer to replace the prerelease pin, then CI, then returns the consumers to `awaiting_merge`
3. coupled repos should be merged and deployed together; `status` says so
4. when every PR is merged and every release step is done, the goal is `completed`, the final handover is written, telemetry is finalized

---

## 25. Escalation and replanning

Unchanged from v1. `escalation.md` follows the v1 package structure plus repo, package, and budget snapshot. `janus escalation resolve --direction "..."` records the direction, runs a fresh replanning agent, checkpoints, and enters Gate 2. Execution resumes only after `janus approve revised-plan --commit`.

---

## 26. Human gates

1. plan approval (`janus approve plan --commit`)
2. revised plan approval (`janus approve revised-plan --commit`)
3. PR approval (in Bitbucket, all PRs)
4. merge (in Bitbucket, all PRs, dependency order)

Gate 2 waits in `awaiting_plan_approval` with `gate.type = revised_plan_approval`.

Gate entry and exit times are recorded to measure human wait time.

---

## 27. Telemetry

Append-only events in `telemetry/events.jsonl`:

```text
run.started, run.stopped
goal.created, stage.entered, stage.exited
agent.started, agent.finished        (role, repo, run_id, model, effort, prompt_version, profile, experiment_id, tokens, duration, status)
agent.model_switch
policy.checked, commit.created, push.completed
sync.started, sync.completed, sync.conflict
repo.drift
ci.build.found, ci.build.triggered, ci.build.finished, ci.build.infra_retry
e2e.triggered, e2e.rerun, e2e.finished, e2e.invalidated, e2e.triaged
publish.triggered, publish.finished, release.triggered, release.finished
budget.incremented, budget.reset, guardrail.hit
gate.entered, gate.passed, gate.rejected
escalation.created, escalation.resolved
pr.created, pr.comment.received, pr.comment.answered, pr.approved, pr.declined, pr.merged
goal.completed
```

`janus status --telemetry` derives the v1 metrics from events. `janus telemetry compare` breaks them down per model, role, and prompt version (§18.6). Cost estimation is optional via a price table.

---

## 28. Configuration

`.janus/config.yaml` (committed, no secrets):

```yaml
workflow:
  agent_runner: codex            # codex | fake
  ci_provider: teamcity          # teamcity | local | fake
  scm_provider: bitbucket-server # bitbucket-server | fake
  create_prs_early: true

state:
  repo: { project: FE, slug: janus-state }   # optional dedicated state repo, rendered through bitbucket.clone_url_template
  clone_url: null                              # or an explicit clone URL for the state repo

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
  required_reviewers: []
  clone_url_template: "{url}/scm/{project}/{slug}.git"

local_ci:
  repos:
    ui-kit:
      install: pnpm install --frozen-lockfile
      build: pnpm build
      test: pnpm test -- --watch=false
  e2e: pnpm --dir e2e run full

discovery:
  areas: [deps-and-build, tests-and-e2e, architecture-and-ci]

agents:
  max_parallel: 4
  max_context_bytes: 200000
  max_inline_diff_bytes: 60000
  pnpm_store: workspace           # workspace | global (adds store path as writable root)
  allow_unsandboxed: false
  roles:                          # timeouts only; models come from the active profile
    implementation: { timeout_minutes: 60 }
    debug:          { timeout_minutes: 45 }
    fix:            { timeout_minutes: 45 }
    sync_conflict:  { timeout_minutes: 30 }
    discovery:      { timeout_minutes: 30 }
    planning:       { timeout_minutes: 45 }
    checkpoint:     { timeout_minutes: 20 }
    review:         { timeout_minutes: 60 }
    triage:         { timeout_minutes: 20 }
    qa:             { timeout_minutes: 30 }

workflow_models:
  profile: default                # selected model profile; --model-profile overrides per run

model_profiles:                   # see §18.6
  default:
    "*":            { model: gpt-5.6-sol, effort: high }
    implementation: { model: gpt-5.6-sol, effort: xhigh }
    review:         { model: gpt-5.6-sol, effort: xhigh }
    debug:          { model: gpt-5.6-sol, effort: high, ladder: [gpt-5.6-sol, gpt-5.6-sol:xhigh] }

experiment:
  id: null
  hypothesis: null
  notes: null

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
  redact: true

guardrails:
  max_ci_fix_attempts: 5
  max_e2e_fix_attempts: 3
  max_ai_review_cycles: 3
  max_no_progress_iterations: 2
  max_work_packages_without_green: 3
  max_policy_violations_per_package: 2
  max_sync_conflict_attempts: 2
  max_infra_retries: 1
  max_agent_runtime_minutes: 60

telemetry:
  price_table: null
```

Secrets: `JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN`. Codex authentication is handled outside Janus.

---

## 29. Testing strategy for Janus itself

1. **Unit tests** (vitest): state transitions, `plan.yaml` and `goal.yaml` validation, policy checks, failure signature, digest truncation and redaction, context rendering, output validation, budget table.
2. **Provider contract tests**: one suite that `teamcity`, `local`, and `fake` CI providers all pass; likewise for SCM providers. Real adapters run against recorded HTTP fixtures; fixtures are refreshed from the real systems during first contact (§30).
3. **Engine integration harness**: temp git repositories with a dependency graph, persisted fake runner, fake CI, fake SCM. Drives a goal from `init` to `completed` and through every escalation path, crash resume, policy violation, coupled red, base sync conflict, E2E invalidation and triage, comment loop, decline, partial merge, and release-and-bump. Asserts from reflogs that no agent process performed a git write.
4. **Manual prompt spike** (before the execution loop is built): hand-run `codex exec` with the intended context packages and schemas against a throwaway Angular 15 app to validate prompts, the sandbox and pnpm store setup, `ng update --allow-dirty`, and the scope globs. Findings feed the prompt templates and doctor probes.
5. **Dogfood run**: the throwaway Angular 15 app with real Codex, `local` CI, persisted fake SCM, driven by the CLI. Documented as a runbook.
6. **First contact runbook** for the work network: `doctor`, read-only TeamCity and Bitbucket calls with fixture capture, baseline only, then a one-repo goal, then multi-repo.

---

## 30. Build order (vertical slices)

1. **Slice 1, one repo, local CI, fake SCM**: bootstrap, state, engine core, harness skeleton, agent runner, policy checks, `local` and fake CI, fake SCM, prepare, discovery, baseline, plan, Gate 1, package loop with debug budget and escalation, final review, completion, resume. No groups, publish, checkpoint, QA, or E2E yet.
2. **Slice 2, real adapters**: TeamCity and Bitbucket Server providers, doctor probes, digest redaction, review comment loop.
3. **Slice 3, multi-repo**: N repos in `depends_on` order, base sync, partial merge, E2E with triage, coupled groups, prerelease publish and release-and-bump, AI checkpoint, QA.
4. **Slice 4, polish**: telemetry metrics, operator skill, documentation, first contact.

`tasks.md` maps tasks onto these slices.

---

## 31. Acceptance criteria

v1 criteria 1 through 22, per repository where relevant, plus:

23. a goal with three repositories and a dependency graph executes in dependency order
24. a library package triggers a prerelease publish and dependents receive and pin the version
25. every diff is policy-checked before commit; violations are evidenced, fixed in place once, then fed back
26. E2E results are invalidated by any new commit on any unmerged goal branch
27. the whole loop, every escalation path, and resume run to completion using only fakes
28. a workspace can be rebuilt on another machine from the state branch alone
29. no agent process ever performs a git write (verified from reflogs in the harness)
30. base-branch changes are merged into goal branches before final E2E
31. after a library PR merges, consumers are bumped from prerelease to release and rebuilt before their merge
32. infrastructure build failures never consume a debug attempt
33. `janus doctor` detects a non-working sandbox, a read-only pnpm store, and a missing `janus/*` branch exclusion

---

## 32. Non-negotiable safety rules

v1 rules 1 through 10 plus:

11. Agents never commit, push, or otherwise rewrite Git history.
12. Secrets never enter `.janus/`, prompts, or evidence; digests are redacted.
13. Never trigger a release of a library except in the post-merge release step for a merged PR.
14. Approval commands bind to an explicit state-branch commit; no tool or skill may infer approval.

---

## 33. Assumptions and open items

- TeamCity PR builds run on the source branch and build branch heads, not merge commits. If merge commits are built, every push takes the explicit-trigger path, which still works.
- The VCS root branch spec includes `ai/*` and excludes `janus/*`.
- The E2E build accepts per-repo branch parameters and handles deployment itself.
- Publish and release builds accept a `janus.version` property.
- Bitbucket Server activities expose inline comment anchors with file and line.
- The developer machine supports bubblewrap user namespaces; containers may not.
- A Claude Code `AgentRunner` is out of scope but the contract supports it.

---

## 34. Guiding principles

Unchanged from v1, plus:

- Safety rules are enforced by code where they can be, and by review where they cannot.
- Fakes are part of the product, not an afterthought.
- The agent is the interface; the engine is the guarantor.

---

## 35. Operator skill

A thin skill for Claude Code or Codex that makes the CLI conversational. It is built last and never bypasses the engine.

It does:

- interview the developer and draft `goal.yaml` and `config.yaml`, then run `janus init` and `janus doctor` and help fix red probes
- summarize `plan.md` at Gate 1, answer questions from discovery reports and baseline evidence
- run `janus approve ... --commit <sha>` only when the developer explicitly asks, always echoing the commit hash first
- read `janus status --json` and explain progress, budgets, and merge order
- on escalation, read `escalation.md` and digests, help formulate direction, run `janus escalation resolve`
- tell the developer when to come back after long CI waits; on a new session, re-read status and continue

It does not: run agents itself, edit `.janus/` files, commit, infer approval, or hold workflow state in its conversation.

The skill consumes only the stable `--json` outputs and the files under `.janus/`. It ships as a skill directory in this repository.
