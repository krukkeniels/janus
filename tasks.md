# Janus: High-Level Task Breakdown (v2.1)

Each task is intended to become one implementation plan (superpowers `writing-plans`) and one execution cycle. Tasks are grouped into the vertical slices of spec §30. Within a slice, tasks are ordered by dependency; tasks sharing a "Parallel" letter can be built concurrently once their dependencies are done.

Source spec: `angular-ai-development-workflow-v2.md` (§N references).

Conventions for every task: TypeScript strict, Node 20+, pnpm, vitest, zod for schemas, conventional commits `type(scope): subject`, no task done without its tests green in CI.

## Status

Update this table when a task merges to `main`. A task is done when its plan's final whole-branch review is clean and the merged tree passes lint, typecheck, build, and tests.

| Task | Status | Merged | Notes |
|---|---|---|---|
| T01 | done | f2a35a2 (2026-09-19) | 77 tests; commander pinned to 14 for the Node 20 floor |
| T02 | done | 2055b8f (2026-09-19) | 151 tests; store dir via `npm_config_store_dir`, `clone_url` fields added |
| T03 | done | 48ae5d3 (2026-09-20) | 557 tests; gate-entry ordering fixed after final review; §6/§26/§27 spec edits |
| T04 | done | 437a35f (2026-09-20) | 597 tests; provider seam, persisted fakes, reflog audit, `pnpm test:integration` |
| T05 | done | 01d63fe (2026-09-20) | 727 tests; agent contract, generated output schemas, prompts, Codex adapter, fake runner, `janus agent run` |
| T06 to T24 | pending | | next: T06 (prompt spike); it must also verify the §3.3/§18.4 read-only cwd tension against real Codex |

---

# Slice 1: one repo, local CI, fake SCM, full loop

## T01 Repository bootstrap and CLI skeleton

Depends on: nothing.

- pnpm project, TypeScript strict, ESLint, vitest, build, `bin/janus`
- CLI framework with the §8 command surface stubbed; distinct exit codes per run outcome
- `config.yaml` schema (zod) per §28 with defaults; loader with env-var token resolution
- `goal.yaml` schema (zod) per §4: acyclic `depends_on`, `coupled_with` normalization, `loads_remotes` covered by `repos` or `acknowledged_outside_goal`, E2E `branch_params` refer to known repos
- GitHub Actions on this repo: lint, unit tests

Done when: `janus --help` works; invalid config and goal files fail with messages naming the field; CI green.

## T02 State model, workspace, state branch, checkpoints

Depends on: T01.

- `state.yaml` schema v2 (zod) per §6 including `execution.work_packages.<id>`, per-repo `merged`, `release`, `review_loop`
- workspace layout per §5: `.janus/` single-branch clone, `repos/<name>`, `fake/`, `.pnpm-store/` (handed to agents via `npm_config_store_dir`, no `.npmrc`), `janus.lock` with PID
- git module: clone, fetch, branch from commit, merge (no rebase), commit, fast-forward-only push, diff collection, reset, patch export, reflog read
- checkpoint: stage state, minimal handover (full renderer in T14), evidence, decisions; commit; optional push
- `janus init --goal`, `janus init --resume`
- `decisions.md` and `telemetry/events.jsonl` append helpers

Done when: integration test builds a workspace from temp repos, checkpoints, clones the state branch elsewhere, and `init --resume` rebuilds an identical workspace; stale lock with dead PID is reclaimed.

## T03 Engine core: state machine, run loop, gates, resume, budgets

Depends on: T02.

- explicit `goal.status` machine with allowed transitions and transition log
- step abstraction with `in_flight` bracketing and checkpoint after each step
- `janus run` with `--until`, `--max-wait`, `--dry-run`, lock, exit codes
- resume reconciliation per §7: head verification, goal and base branch drift, in-flight recovery per step type
- gates: Gate 1 and 2 by `janus approve --commit` (required) and `reject`; Gate 3 and 4 as SCM-observed placeholders
- budget table per §20 as a single module: increment, reset, escalate hooks; guardrail hit routes to `escalated`
- telemetry events for stage, gate, budget, guardrail

Done when: unit tests cover every transition, every budget row, every resume case with stubbed steps; a scripted run goes `created` to `completed` with no providers.

## T04 Integration harness skeleton

Depends on: T03. Parallel: A (with T05 to T08).

- helper that creates N temp git repos with a dependency graph, a bare "remote" for each, and a bare state remote
- scripted fake runner, fake CI, fake SCM stubs (full implementations land in T05 (runner), T09 (CI), T10 (SCM)) with persistence under `fake/`
- assertions on state, evidence files, and reflogs (no git writes by agent processes, §31.29)
- `pnpm test:integration` target

Done when: a smoke test runs `init` and one checkpoint through the harness. Every later task adds its scenarios here.

## T05 Agent runner: contract, context packages, Codex adapter, fake runner

Depends on: T03. Parallel: A.

- `AgentTask`, `AgentResult`, `ContextPackage`, sandbox classes per §18
- per-role output schemas (all fields required, `null` allowed) and zod validators
- context renderer with byte budgets, change summary, inline diff only for code-writing roles, Angular guidance block (§18.2, §18.4)
- prompt templates per role, versioned markdown
- Codex adapter per §18.4: invocation, JSONL parsing for usage, timeout kill, `-o` last message, validation, evidence file; writable roots for the pnpm store
- model profiles and ladders per §18.6: profile resolution per role and attempt, `--model-profile` override, `model_switch` attempt records, experiment and prompt-version stamping on evidence and events
- fake runner scripted by role and attempt, persisted
- `janus agent run <role> --task FILE`
- opt-in real-Codex smoke test (`JANUS_REAL_CODEX=1`) for a read-only echo and a workspace-write scratch install

Done when: adapter tests pass on recorded JSONL; fake runner drives a task; real smoke test passes locally.

## T06 Manual prompt spike (time-boxed, one week)

Depends on: T05. Parallel: A. Output is a report, not code.

- throwaway Angular 15 app outside this repo
- hand-run `codex exec` with the T05 context packages and schemas for discovery, planning, implementation, and debug roles
- verify: report-writing under `workspace-write` with report cwd; pnpm store as writable root; `ng update --allow-dirty` behavior; typical migration file footprint versus `allowed_scope`; output-schema compliance; token usage per role
- fold findings into T05 templates, T07 doctor probes, and §12 scope defaults

Done when: `docs/spikes/prompt-spike.md` records what worked, what failed, and the resulting template and config changes.

## T07 `janus doctor`

Depends on: T05. Parallel: A.

- checks: codex login, git identity, tokens present, every configured model accepted by Codex (one-token probe), provider reachability (skipped for fakes), user namespaces for bubblewrap, three real Codex probes (§18.4), pnpm store writability, `janus/*` branch-spec warning when the state repo is a product repo
- `--json` output contract

Done when: each check has a unit test with a simulated failure and a clear remediation message.

## T08 Policy checks and orchestrator commit/push

Depends on: T03. Parallel: A.

- diff analysis: changed, added, deleted, renamed; per-file hunks
- checks per §14 including runner-config threshold detection, lockfile-in-scope warning, secrets
- in-place fix attempt flow, then reset at the per-package limit; evidence and patch export
- commit message convention; push through git module

Done when: fixture-diff unit tests for every check, plus harness scenarios for pass, fix-in-place success, and reset after limit.

## T09 CI providers: interface, digest, redaction, `local`, `fake`

Depends on: T04. Parallel: B (with T10).

- `CiProvider` and types with outcome classification (`success | tests_failed | build_failed | infra`)
- digest builder with caps and redaction; failure signature with normalized error lines (§16.2, §16.3)
- `local` provider: configured commands per repo, JUnit or Karma/Jest summary parsing for failed test identities
- `fake` provider: scripted per (repo, attempt), supports missing build, infra outcome, persisted
- provider contract test suite

Done when: contract suite green for `local` and `fake`; redaction tests; signature tests showing distinct compile errors produce distinct signatures.

## T10 SCM providers: interface, `fake`

Depends on: T04. Parallel: B.

- `ScmProvider` and types per §3.2 including `currentUser`, reply comments, decline, merge commit
- `fake` provider persisted under `fake/scm.json` with test hooks and CLI hooks (`janus fake scm comment|approve|decline|merge`) for dogfooding
- PR description renderer
- provider contract test suite

Done when: contract suite green; hooks drive a PR through comment, approval, and merge across separate processes.

## T11 Prepare, discovery, baseline, planning, Gate 1

Depends on: T05, T08, T09, T10.

- prepare step via `local` provider (§10)
- discovery with configurable areas, report-writing class, report filing, `summary.yaml`; integration discovery with `loads_remotes` cross-check
- baseline: local checks, PR build via provider, E2E on base (E2E provider call only; triage comes in T17), orchestrator-owned exceptions with stable identities
- planning agent, `plan.yaml` validator (§12), Gate 1, branch creation, PR creation per `create_prs_early`

Done when: harness runs to Gate 1 on one repo, rejects an invalid plan, approves a valid one, creates the branch and PR on the fake SCM; exception identities are stable across two baseline runs.

## T12 Single-repo package loop: implement, verify, debug, escalate

Depends on: T11.

- package scheduler for one repo (multi-repo ordering in T18)
- implementation agent, policy flow, commit, push
- PR build loop: find, trigger if absent, wait, classify, infra retry (§16.1)
- debug loop with budgets, no-progress detection, policy re-check
- per-package state block updates; `expected_red` accepted only with verified subset (§16.5), single-repo groups only
- implementation `failed`/`blocked` handling per §20

Done when: harness scenarios: green path, defect fixed within budget, budget exhaustion, no-progress escalation, infra retry then escalate, policy violation retry, crash-resume mid-package, resume mid-CI-wait.

## T13 Final review, completion, escalation and replanning (single repo)

Depends on: T12.

- final AI review agent (read-only, runs `git diff`), findings schema, fix loop, cycle budget (§22)
- escalation package renderer, `janus escalation show|resolve`, replanning agent, Gate 2, resume from current package (§25)
- SCM-observed Gate 3 and 4 for one PR: comment loop with own-comment skip and `no_change_needed` replies, NEEDS_WORK, approval reset on new commits, decline escalation, merge detection, `completed` (§24, without release steps)

Done when: harness scenarios: review findings loop, escalate and replan, comment loop with inline anchors, decline, approval and merge to completion. Slice 1 is complete; dogfood runbook (T22) can start.

# Slice 2: real adapters

## T14 Rendering: handover, status, PR descriptions

Depends on: T03. Parallel: C (with T15, T16).

- full `handover.md` generator; `janus status` human and `--json` with per-repo state, budgets, gate, merge order, open escalation; PR description updates at package boundaries

Done when: snapshot tests across representative states; `--json` shape documented.

## T15 TeamCity provider

Depends on: T09. Parallel: C.

- find by revision, queue check, trigger with branch, revision and properties, poll, problems, failed tests with details, streamed plain log tail; Bearer token; classification mapping incl. `UNKNOWN`
- recorded HTTP fixtures for success, tests failed, build failed, queued, cancelled, missing build, merge-commit build
- fixture capture script for first contact (§29.6)

Done when: contract suite green; `janus ci wait|trigger|digest` work against fixtures.

## T16 Bitbucket Server provider

Depends on: T10. Parallel: C.

- create PR, get PR with reviewer statuses and merge commit, activities since cursor with anchors, add and reply comments, find by branch, `currentUser`; pagination; recorded fixtures

Done when: contract suite green including paginated activities and inline anchors.

# Slice 3: multi-repo

## T17 E2E stage with rerun, triage, invalidation

Depends on: T12, T15.

- trigger with branch params (base branch for merged repos), validity heads, invalidation on any commit, one automatic rerun, triage agent with `suite_repo_map`, debug under `e2e_fix_attempts`, escalation when triage is unsure (§17)

Done when: harness scenarios: flaky pass on rerun, triage names repo and debug fixes it, triage unsure escalates, invalidation after a later commit.

## T18 Multi-repo scheduling, base sync, partial merge

Depends on: T13.

- scheduler honoring `depends_on` across repos and packages
- base-branch sync at package start and before final E2E; sync-conflict agent with budget; sync evidence (§16.6)
- per-repo merged state; E2E and fix loops use base branches for merged repos; decline of one PR escalates the goal

Done when: harness scenarios with three repos: dependency order respected, clean sync, conflict resolved, conflict escalates, partial merge keeps the goal running.

## T19 Verification groups, coupled red, AI checkpoint

Depends on: T18.

- cross-repo groups, red windows, `work_packages_without_green`, E2E after group (§13, §16.5)
- AI checkpoint per package with regroup re-validation (§21)

Done when: harness scenarios: coupled red accepted with verified subset, rejected otherwise, red window exhaustion escalates, checkpoint outcomes handled.

## T20 Prerelease publish, release-and-bump, QA recommendation

Depends on: T18.

- version computation, publish trigger with `janus.version`, propagation to dependents, re-publish on later commits (§13)
- post-merge `releasing` flow: release build, consumer bump agent, CI, back to `awaiting_merge` (§24)
- QA agent output to evidence and PR comments (§23)

Done when: harness scenarios: publish then dependent pins version, re-publish after fix commit, library merge triggers release and consumer bumps before consumer merge; QA comment posted once per refresh.

# Slice 4: polish

## T21 Telemetry metrics and cost

Depends on: T03. Parallel: D.

- audit that every §27 event is emitted; `janus status --telemetry` deriving v1 metrics; human wait from gate events; optional cost table
- `janus telemetry export` and `janus telemetry compare` per §18.6: per model, role, and prompt version breakdown across one or more event logs

Done when: metrics test computes expected numbers from a fixture event log; compare test over two fixture logs with different models reports the expected per-model rows.

## T22 Dogfood runbook

Depends on: T13 (initial), T20 (full). Parallel: D.

- runbook for the throwaway Angular 15 app with real Codex, `local` CI, fake SCM and its hooks; expected artifacts checklist; how to inspect evidence
- executed once after Slice 1 and once after Slice 3; findings filed as issues

Done when: both runs recorded in `docs/dogfood/`.

## T23 Operator skill

Depends on: T14, T13.

- skill directory per §35: interview to `goal.yaml`/`config.yaml`, gate conversations, escalation assistance, status explanation; consumes only `--json` outputs and `.janus/` files; approval only on explicit instruction with echoed commit hash

Done when: a scripted conversation transcript test (fake runner, fake providers) reaches Gate 1 and approval through the skill without the skill touching `.janus/` directly.

## T24 Documentation and first-contact runbook

Depends on: T22, T23.

- README, configuration reference generated from schemas, CLI reference
- first-contact runbook for the work network: doctor, tokens, read-only calls with fixture capture, TeamCity prerequisites (§33), baseline-only run, one-repo goal, multi-repo goal; troubleshooting
- validated by a second developer following it on a fresh machine

Done when: the second developer's run notes are appended and any blocking step fixed.

---

## Stretch (not v1)

- Claude Code `AgentRunner`
- Bitbucket Cloud `ScmProvider`
- TeamCity webhook receiver
- selective E2E based on change impact

## Build order

```text
Slice 1: T01 -> T02 -> T03 -> T04 -> {T05, T08} -> T06 (spike) -> T07
                                   -> {T09, T10} -> T11 -> T12 -> T13
Slice 2: T14 | T15 | T16   (parallel, after T03 / T09 / T10)
Slice 3: T17 (after T12, T15) ; T18 (after T13) -> T19 -> T20
Slice 4: T21 | T22 | T23 -> T24
```
