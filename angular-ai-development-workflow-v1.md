# Angular AI Development Workflow v1

## 1. Purpose

This specification defines a controlled, resumable, agent-driven workflow for upgrading a large Angular application one major version at a time.

The first reference goal is:

> Upgrade Angular 15 to Angular 16.

The workflow is optimized for Codex, but the core model should remain agent-agnostic where practical.

The system must support:

- human-approved technical planning before code changes
- fresh agents for meaningful tasks
- persistent state in Git
- automatic PR build feedback through TeamCity
- agent-triggered full E2E runs through TeamCity
- bounded autonomous fix loops
- independent AI review
- QA recommendations based on actual code impact and existing test coverage
- structured human gates
- safe handover between agents
- telemetry for later tuning

The key operating principle is:

> State survives. Agents do not.

---

## 2. Scope

### In scope

- one Angular major upgrade per goal
- one long-lived goal branch
- one long-lived pull request for the goal
- read-only discovery before approval
- human-approved technical plan
- sequential work packages by default
- verification groups for coupled work packages
- automatic TeamCity feedback loops
- full E2E execution through the TeamCity API
- fresh Codex process per meaningful task
- independent AI review
- QA recommendation generation
- structured escalation and replanning
- human PR review
- human merge
- configurable guardrails
- Git-based state and handover
- telemetry collection

### Out of scope for v1

- multi-major upgrades in one goal
- autonomous merge
- autonomous approval of baseline exceptions
- parallel code-changing agents on the same branch
- selective E2E execution
- automatic architectural changes
- weakening, skipping, or removing tests to obtain green CI
- replacing TeamCity or Bitbucket
- building a general-purpose agent framework

---

## 3. High-Level Architecture

```text
                    +----------------------+
                    |      Human User      |
                    +----------+-----------+
                               |
                         approves / reviews
                               |
                               v
+------------------+   +-------+--------+   +------------------+
|     Bitbucket    |<->|   Orchestrator |<->|     TeamCity     |
| branch + PR      |   |                |   | build + E2E      |
+------------------+   +-------+--------+   +------------------+
                               |
                               | launches fresh bounded tasks
                               v
                      +--------+---------+
                      |   Codex Agents   |
                      | disposable       |
                      +------------------+
                               |
                               v
                      +------------------+
                      | Git workflow state|
                      | .ai-dev/         |
                      +------------------+
```

### Responsibility split

#### Spec Kit or equivalent workflow layer

Use for:

- workflow stages
- human gates
- loops
- resume behavior
- high-level run state
- plan/spec/task workflow structure

#### Thin custom orchestration layer

Owns:

- starting fresh Codex processes
- constructing minimal agent context
- Bitbucket branch and PR integration
- observing TeamCity PR builds
- triggering TeamCity E2E builds
- enforcing retry budgets
- updating Git workflow state
- checkpoint commits
- telemetry
- escalation packaging

#### Codex agents

Perform bounded tasks only.

Examples:

- discovery
- planning
- implementation
- debugging
- AI checkpoint review
- final AI review
- QA analysis
- plan revision

Agents do not own long-lived workflow state.

#### TeamCity

Source of execution evidence for:

- PR builds
- automated tests
- full E2E
- environment-dependent checks

#### Bitbucket

Source of truth for:

- goal branch
- evolving PR
- commits
- human review
- final merge

---

## 4. Core Workflow

```text
Goal created
    |
    v
Read-only discovery
    |
    v
Baseline verification
    |
    v
Technical plan
    |
    v
HUMAN GATE: approve plan + baseline exceptions
    |
    v
Create goal branch + PR
    |
    v
Execute work packages
    |
    +--> push
    |      |
    |      v
    |   TeamCity PR build
    |      |
    |   +--+--+
    |   |     |
    | green  red
    |   |     |
    |   |     v
    |   |  fresh debug agent
    |   |     |
    |   |   fix + push
    |   |     |
    |   +-----+
    |
    v
AI checkpoint
    |
    v
Next work package / verification group
    |
    v
Final full E2E
    |
    v
Fresh independent AI review
    |
    +--> findings -> fresh fix agent -> TeamCity -> AI review
    |
    v
Fresh QA recommendation agent
    |
    v
Human PR review
    |
    +--> comments -> fresh fix agent -> TeamCity -> AI review -> QA refresh
    |
    v
Human approves PR
    |
    v
Human merges
    |
    v
Goal complete
```

---

## 5. Goal Model

One Angular major upgrade is one goal.

Example:

```text
Goal: Angular 15 -> 16
```

Do not model Angular 15 -> 22 as one goal.

Later majors become separate goals:

```text
Angular 15 -> 16
Angular 16 -> 17
Angular 17 -> 18
...
```

Each goal has:

- one goal branch
- one PR
- one approved technical plan
- one state file
- multiple work packages
- zero or more verification groups
- one final AI review
- one QA recommendation
- one human PR approval
- one human merge

---

## 6. Git Layout

Use a small persistent state directory:

```text
.ai-dev/
  goal.md
  plan.md
  state.yaml
  decisions.md
  handover.md

  discovery/
    dependencies.md
    build-tooling.md
    teamcity.md
    tests.md
    e2e.md
    architecture.md

  evidence/
    baseline/
    teamcity/
    e2e/
    reviews/
    qa/

  telemetry/
    run.jsonl
```

### File responsibilities

#### `goal.md`

Stable description of:

- goal
- target Angular version
- scope
- success criteria
- non-goals

#### `plan.md`

Current approved technical plan.

This file is updated when the plan changes.

Git history preserves earlier versions.

#### `state.yaml`

Authoritative machine-readable runtime state.

#### `decisions.md`

Append-only human-readable record of significant decisions and reasons.

#### `handover.md`

Concise current handover for the next human or agent.

It must be rewritten at every checkpoint.

#### `discovery/`

Read-only discovery outputs.

#### `evidence/`

References or snapshots of verification evidence.

#### `telemetry/run.jsonl`

Append-only workflow telemetry events.

---

## 7. State Schema

Minimum `state.yaml` structure:

```yaml
version: 1

goal:
  id: angular-15-to-16
  source_version: "15"
  target_version: "16"
  status: planning

git:
  base_branch: main
  goal_branch: ai/angular-15-to-16
  pr_id: null
  current_commit: null

plan:
  approved: false
  approved_commit: null
  approved_at: null

baseline:
  commit: null
  approved: false
  exceptions: []

execution:
  current_work_package: null
  current_verification_group: null
  completed_work_packages: []
  teamcity_fix_attempts: 0
  ai_review_cycles: 0
  no_progress_iterations: 0

verification:
  pr_build:
    status: unknown
    build_id: null
  e2e:
    status: not_run
    build_id: null
  ai_review:
    status: not_run
  qa_recommendation:
    status: not_run

gate:
  type: null
  status: none
  reason: null

telemetry:
  started_at: null
  last_updated_at: null
```

The schema may be extended, but existing fields must remain backward compatible within v1.

---

## 8. Checkpoint Rule

Every meaningful state transition must end in a Git checkpoint commit.

A checkpoint must include:

- updated `state.yaml`
- updated `handover.md`
- relevant evidence references
- relevant `decisions.md` changes
- implementation changes, if applicable

A human gate must never be entered before a checkpoint commit exists.

A fresh agent must be able to resume using committed state only.

---

## 9. Discovery Phase

Discovery is read-only with respect to product code.

Discovery agents may:

- inspect source
- inspect dependencies
- inspect Angular configuration
- inspect Module Federation
- inspect build tooling
- inspect TeamCity configuration
- inspect tests
- inspect E2E structure
- inspect architecture
- run existing local checks
- trigger existing TeamCity builds
- trigger existing E2E through TeamCity
- produce reports

Discovery agents may not:

- modify product code
- modify build configuration
- upgrade packages
- apply migrations
- change tests
- commit implementation changes

### Parallel discovery agents

Run independent discovery agents in parallel for:

1. Angular and dependency compatibility
2. Build tooling and Module Federation
3. TeamCity configuration and build flow
4. Unit/integration test topology
5. E2E topology and coverage
6. Architecture and high-risk areas

Each agent must return structured findings:

```yaml
area: e2e

findings: []
risks: []
known_gaps: []
recommended_work: []
evidence: []

confidence: high
```

A fresh planning agent combines these reports.

---

## 10. Baseline Verification

Before plan approval, establish a verified baseline at a specific commit.

Run every verification environment that will later be used to judge the upgrade.

### Local or sandbox where available

Examples:

- dependency installation
- compilation
- unit tests
- static checks
- other locally available tests

### TeamCity

Run:

- normal build
- required automated tests
- full E2E

Record:

```yaml
baseline:
  commit: abc123

  local:
    build: pass
    unit_tests: pass

  teamcity:
    pr_build: pass
    e2e: pass

  proposed_exceptions: []
```

### Baseline exceptions

Existing failures or flaky tests may be proposed by the planning system.

Only a human may approve them.

No new baseline exception may be created autonomously during execution.

A newly discovered pre-existing failure requires escalation.

---

## 11. Technical Plan

The plan must be detailed enough to approve:

- approach
- boundaries
- known risks
- work packages
- likely verification groups
- verification strategy
- expected high-risk areas
- approved exceptions
- autonomy boundaries

The plan should not attempt to predict every file-level task.

For a large application, use progressive planning.

### Example plan structure

```text
# Angular 15 -> 16 Technical Plan

## Goal

## Baseline

## Known Risks

## Upgrade Strategy

## Work Packages

## Verification Groups

## Verification Strategy

## E2E Strategy

## Autonomy

## Guardrails

## Known Baseline Exceptions

## Escalation Rules
```

### Human approval gate

The human approves together:

- technical approach
- work-package structure
- verification strategy
- known risks
- baseline state
- baseline exceptions

No code-changing execution may begin before approval.

---

## 12. Work Packages

A work package is a bounded unit of implementation and handover.

Examples:

- Angular dependency migration
- TypeScript compatibility
- Module Federation compatibility
- build tooling
- compilation fixes
- router migration
- test updates
- E2E additions
- cleanup required by Angular 16

Work packages are mostly sequential in v1.

### Work-package requirements

Each work package must define:

- objective
- allowed scope
- expected files or areas
- dependencies
- definition of done
- verification requirements
- known risks

### Detailed task creation

Execution agents may create or refine technical tasks autonomously inside an approved work package.

They may not silently change:

- goal
- product behavior
- acceptance criteria
- architecture
- major scope

---

## 13. Verification Groups

A work package does not have to independently produce green TeamCity.

Some upgrade work is naturally coupled.

Example:

```text
Verification Group: Core Migration

- Angular dependency upgrade
- Module Federation compatibility
- TypeScript compatibility

Required outcome:
TeamCity green at group boundary
```

### Behavior

After every work package:

- push changes
- allow automatic TeamCity PR build
- collect the result

If red:

1. diagnose whether the result is:
   - a defect in the current package
   - an expected temporary failure caused by a coupled future package

2. if defect:
   - start fresh debugging agent

3. if coupled:
   - record the dependency
   - continue into the required package

### Dynamic regrouping

Agents may propose or create new verification groups during execution if:

- the work remains inside approved scope
- no architecture or behavior change is introduced
- the reason is recorded
- configured red-window limits are respected

Obvious groups should be identified during planning.

Unexpected groups may be created dynamically.

---

## 14. Pull Request Model

Create the goal PR early, after plan approval and branch creation.

Use one PR for the entire goal.

Example branch:

```text
ai/angular-15-to-16
```

Every implementation checkpoint pushes to the same branch.

TeamCity automatically runs the normal PR build after pushes.

The PR becomes the visible integration surface for:

- evolving diff
- commits
- CI state
- human review
- final approval

---

## 15. TeamCity PR Build Loop

The orchestrator owns TeamCity interaction.

Codex does not directly control TeamCity.

### Normal flow

```text
agent change
    |
commit
    |
push
    |
automatic TeamCity PR build
    |
+---+---+
|       |
green   red
|       |
|       v
|   diagnosis
|       |
|   fresh fix agent
|       |
+-------+
```

### Debug agent inputs

A fresh debug agent receives:

- goal
- relevant approved plan section
- current work package
- current diff or relevant files
- latest TeamCity failure
- previous attempt summaries
- guardrails
- remaining attempt budget

It does not receive prior chat history.

---

## 16. E2E

E2E is not automatically triggered by normal PR builds.

The orchestrator must trigger it through the TeamCity API.

For v1:

> Always run the full E2E suite.

Do not implement selective E2E execution in v1.

### Default E2E points

Run full E2E:

1. during baseline discovery
2. after high-risk verification groups when configured
3. before final AI review
4. again after any later change that could invalidate the previous final E2E result

If E2E fails:

```text
E2E fail
   |
fresh debug agent
   |
fix + push
   |
PR build
   |
green
   |
trigger full E2E again
```

The same bounded retry model applies.

---

## 17. Fresh-Agent Model

Use a genuinely fresh Codex process for each meaningful task.

Examples:

- one discovery task
- planning
- one work package
- one debugging attempt
- one AI checkpoint
- final AI review
- QA recommendation
- plan revision

### Minimal context principle

Provide only the information necessary for the task.

The agent may inspect additional repository history or evidence if needed.

### Default context package

```text
GOAL

APPROVED PLAN SLICE

CURRENT WORK PACKAGE OR TASK

CURRENT STATE

RELEVANT DIFF

LATEST VERIFICATION EVIDENCE

KNOWN BASELINE EXCEPTIONS

GUARDRAILS

RETRY / REVIEW BUDGET

EXPECTED OUTPUT CONTRACT
```

Do not inject previous agent reasoning.

---

## 18. Agent Output Contract

Every agent run must return a structured result.

Minimum form:

```yaml
status: completed | blocked | failed

summary: ""

changes_made: []

findings: []

evidence: []

new_tasks: []

plan_change_required: false

architecture_change_required: false

behavior_change_required: false

recommended_next_action: ""

handover:
  current_state: ""
  next_action: ""
  risks: []
```

The orchestrator validates the output before accepting it.

---

## 19. Autonomy Rules

Agents may autonomously:

- refine implementation tasks
- fix compilation failures
- fix test failures caused by the upgrade
- add automated tests
- update tests when legitimately required by Angular 16 compatibility
- refactor inside approved scope
- update dependencies required for Angular 16
- create technical verification groups
- reorder work packages when needed
- add implementation evidence

Agents may not autonomously:

- change product behavior
- change acceptance criteria
- materially change architecture
- expand business scope
- upgrade beyond the target Angular major
- weaken test expectations
- remove failing tests to obtain green CI
- skip tests to obtain green CI
- disable quality checks
- change TeamCity configuration to obtain green
- create new baseline exceptions
- merge the PR

---

## 20. Guardrails

All guardrails must be configurable.

Example defaults:

```yaml
guardrails:
  max_teamcity_fix_attempts: 5
  max_ai_review_cycles: 3
  max_no_progress_iterations: 2
  max_work_packages_without_green: 3

  max_changed_files: null
  max_diff_lines: null
  max_runtime_minutes: null

  require_human_for:
    - architecture_change
    - scope_change
    - acceptance_criteria_change
    - product_behavior_change
    - new_baseline_exception

  forbidden:
    - disable_tests
    - skip_failing_tests
    - remove_failing_tests
    - weaken_assertions_for_green
    - bypass_quality_checks
    - upgrade_beyond_target_major
```

Null means disabled.

### No-progress detection

A no-progress iteration should be recorded when:

- the same failure repeats without meaningful new evidence
- successive changes do not improve the failure state
- the agent repeats substantially the same attempted fix

The exact heuristic may evolve.

---

## 21. AI Checkpoint After Each Work Package

Every completed work package gets a lightweight fresh AI checkpoint.

The checkpoint verifies both:

### A. Package completion

- definition of done met
- required evidence present
- expected files or areas addressed
- required build state reached where applicable

### B. Accumulated drift

- still inside Angular 15 -> 16 scope
- no unexpected architecture changes
- no product behavior changes
- no unrelated diff growth
- no weakened tests
- remaining plan still makes sense

Possible outcomes:

```text
PASS
CONTINUE_WITH_REFINED_TASKS
REGROUP_VERIFICATION
ESCALATE
```

---

## 22. Independent Final AI Review

After:

- all work packages complete
- required TeamCity PR build green
- final full E2E green

start a fresh independent review agent.

The reviewer receives:

- approved plan
- goal and acceptance criteria
- complete branch diff
- TeamCity evidence
- E2E evidence
- relevant repository context

The reviewer must not receive implementation-agent reasoning.

### Reviewer checks

- plan compliance
- scope compliance
- regression risks
- test integrity
- unnecessary changes
- migration correctness
- suspicious workarounds
- maintainability
- unresolved TODOs or temporary fixes

### Review loop

```text
AI review
    |
findings?
+---+---+
|       |
no      yes
|       |
|    fresh fix agent
|       |
|    TeamCity
|       |
|    E2E if required
|       |
+-------+
```

Use configurable `max_ai_review_cycles`.

---

## 23. QA Recommendation Agent

After final AI review passes, run a fresh QA recommendation agent.

Its purpose is not to replace QA.

Its purpose is to answer:

> Given the actual diff and automated evidence, what still needs validation?

### Inputs

- approved plan
- complete diff
- affected code areas
- unit/integration tests
- full E2E result
- existing E2E topology
- TeamCity results
- Sonar or equivalent static-analysis evidence if available
- final AI review

### Output

Example:

```text
## QA Recommendation

### Change impact

### Already covered automatically

### Coverage gaps

### Recommended automated tests

### Recommended manual tests

### Areas not requiring manual regression

### Residual risks
```

### Test policy

The workflow should prefer additional automated tests over repetitive manual regression when appropriate.

Agents may add tests autonomously during implementation when they increase confidence in already-approved behavior.

They may not redefine expected behavior through tests.

---

## 24. Human PR Review Loop

After:

- TeamCity green
- full E2E green
- final AI review pass
- QA recommendation generated

the PR enters human review.

If the human leaves comments:

```text
human comments
    |
fresh fix agent
    |
commit + push
    |
TeamCity
    |
E2E if invalidated
    |
fresh AI review
    |
QA recommendation refresh if needed
    |
back to human PR review
```

The loop continues until the human approves.

---

## 25. Merge

Merge is always a human action in v1.

The orchestrator must never merge automatically.

After merge:

- update state to `completed`
- write final handover/summary
- persist final telemetry
- checkpoint any workflow metadata not already committed

---

## 26. Escalation

When a guardrail is hit, the system stops autonomous execution.

Before stopping it must:

1. update state
2. write handover
3. write escalation package
4. checkpoint commit

### Escalation package

Must include:

```text
Why execution stopped

What was being attempted

What was tried

Latest evidence

Current branch / PR state

Relevant failures

Remaining risks

Recommended next step

Whether plan, architecture, scope, or behavior must change

Decision required from human
```

Do not escalate with only "agent is stuck".

---

## 27. Replanning Flow

When human direction is required:

```text
guardrail hit
    |
escalation package
    |
human direction
    |
fresh planning agent
    |
update plan.md
    |
update decisions.md
    |
checkpoint
    |
HUMAN GATE: approve revised plan
    |
resume execution
```

The human provides direction.

The fresh planning agent translates that direction into an updated technical plan.

Execution does not resume until the new plan is approved.

`plan.md` remains the current approved plan.

Git history preserves previous plans.

`state.yaml` records the exact commit of the approved plan.

---

## 28. Human Gates

Mandatory v1 gates:

### Gate 1: Technical plan approval

Human approves:

- plan
- work packages
- likely verification groups
- verification strategy
- baseline
- baseline exceptions

### Gate 2: Revised plan approval

Triggered after material escalation requiring plan change.

### Gate 3: PR approval

Human reviews final PR.

### Gate 4: Merge

Human performs merge.

No additional mandatory human gates should be introduced unless needed by configured policy.

---

## 29. Telemetry

Telemetry must be collected from the first run.

Minimum metrics:

```text
human_time
autonomous_ai_time
total_elapsed_time

agent_runs
agent_runs_by_role

teamcity_fix_iterations
ai_review_cycles
human_escalations

token_usage
estimated_cost

work_packages_completed
verification_groups_created
dynamic_regroups

automated_tests_added
manual_qa_recommended
manual_qa_avoided_estimate

baseline_failures
new_regressions_detected
```

Prefer append-only telemetry events.

Example:

```json
{
  "timestamp": "2026-09-18T19:00:00Z",
  "type": "teamcity_build_finished",
  "work_package": "module-federation",
  "status": "failed",
  "attempt": 2,
  "duration_seconds": 482
}
```

Telemetry must not control correctness.

It exists to tune the workflow later.

---

## 30. Configuration

Keep policy separate from implementation.

Example:

```yaml
workflow:
  target_agent: codex
  sequential_execution: true
  create_pr_early: true

guardrails:
  max_teamcity_fix_attempts: 5
  max_ai_review_cycles: 3
  max_no_progress_iterations: 2
  max_work_packages_without_green: 3

verification:
  pr_build:
    trigger: automatic
    after_every_push: true

  e2e:
    trigger: orchestrator
    full_suite: true
    baseline: true
    before_final_review: true

qa:
  generate_recommendation: true
  prefer_automated_test_over_manual: true
  require_human_qa_review: false

agents:
  fresh_process_per_task: true
  inject_previous_reasoning: false

git:
  checkpoint_every_state_transition: true
  one_goal_branch: true
```

All defaults should be easy to change without code changes.

---

## 31. Codex Reference Adapter

v1 should optimize for Codex while keeping workflow semantics generic.

The Codex adapter is responsible for:

- launching a new Codex process
- setting working directory
- passing bounded task instructions
- exposing approved tools
- passing context package
- capturing structured output
- capturing token/cost telemetry when available
- terminating the process after the bounded task

The orchestration model must not depend on hidden Codex conversation state.

A future Claude Code adapter should be able to implement the same task contract.

---

## 32. Planning Method

Use a deliberate planning phase before any implementation.

A Superpowers-style workflow is appropriate for:

- brainstorming the migration approach
- investigating the codebase
- writing the technical plan
- systematic debugging
- verification before completion
- independent review

Do not adopt any methodology blindly.

For an Angular migration, existing regression coverage and TeamCity feedback are more important than forcing a strict greenfield TDD workflow.

The planning model should remain:

```text
Discover
    |
Plan
    |
Human approves
    |
Execute autonomously
```

---

## 33. Implementation Priorities

Build v1 in this order:

### Phase 1: State and workflow skeleton

- `.ai-dev/` artifacts
- state schema
- checkpoints
- handover generation
- human gate representation

### Phase 2: Codex task runner

- fresh process launch
- context package
- structured output
- task result validation

### Phase 3: Git and Bitbucket

- goal branch
- early PR
- push updates
- PR metadata

### Phase 4: TeamCity

- observe automatic PR builds
- retrieve build status and failures
- trigger full E2E
- retrieve E2E results

### Phase 5: Autonomous loops

- TeamCity debug loop
- retry budgets
- no-progress detection
- verification groups
- escalation

### Phase 6: Review and QA

- work-package AI checkpoint
- final independent AI review
- QA recommendation
- human review feedback loop

### Phase 7: Telemetry

- timing
- iterations
- agents
- tokens/cost
- QA metrics

---

## 34. Acceptance Criteria for the Orchestrator

The v1 implementation is complete when it can execute a real Angular 15 -> 16 goal with the following behavior:

1. discovery runs without modifying product code
2. baseline local and TeamCity verification is recorded
3. a technical plan is produced
4. execution cannot begin before human approval
5. a goal branch and PR are created
6. work packages are executed mostly sequentially
7. every meaningful task uses a fresh Codex process
8. every push is observed through TeamCity
9. TeamCity failures automatically start bounded fresh debugging attempts
10. coupled packages can form verification groups
11. full E2E can be triggered automatically through TeamCity
12. guardrail exhaustion creates a structured escalation
13. material plan changes require fresh planning and human reapproval
14. every meaningful state transition is checkpointed in Git
15. a fresh agent can resume using only committed state
16. final AI review is independent of implementation agents
17. AI review findings automatically loop back through fix and verification
18. QA recommendation is generated from actual change impact
19. human PR comments loop back through fix and verification
20. only a human can merge
21. telemetry is persisted
22. the workflow can resume after process interruption without relying on chat history

---

## 35. Non-Negotiable Safety Rules

1. Never weaken verification to obtain green CI.
2. Never silently change product behavior.
3. Never silently change architecture.
4. Never create new baseline exceptions autonomously.
5. Never upgrade beyond the approved Angular major.
6. Never rely on agent conversation history as persistent state.
7. Never enter a human gate without a checkpoint commit.
8. Never let an implementation agent approve its own final work.
9. Never merge automatically in v1.
10. Never continue indefinitely after repeated failure.

---

## 36. Guiding Principles

### State survives. Agents do not.

All durable knowledge must live outside agent sessions.

### Humans approve intent. Agents execute detail.

Humans approve direction, exceptions, major changes, and final code.

### CI is evidence, not orchestration.

TeamCity remains the real verification system.

The orchestrator reacts to it.

### Green is required at meaningful boundaries.

Temporary red states are allowed during coupled migration work.

Final verified states must be green except for explicitly approved baseline exceptions.

### Planning is progressive.

Approve the approach and boundaries first.

Discover detailed tasks during execution.

### Automation must remain bounded.

Every loop has limits.

Every limit produces a useful escalation.

### Independent review matters.

The final reviewer must not inherit the implementation agent's reasoning.

### Testing is part of implementation.

Automated coverage should evolve with the migration, not be deferred entirely to QA.

