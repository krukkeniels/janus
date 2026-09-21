# Janus

Janus upgrades a large multi-repository Angular application one major version at a time, by driving fresh AI agents through bounded tasks and refusing to let them do anything irreversible.

Design: [`angular-ai-development-workflow-v2.md`](angular-ai-development-workflow-v2.md). Task breakdown: [`tasks.md`](tasks.md). Implementation plans: [`docs/superpowers/plans/`](docs/superpowers/plans/).

## The idea

An Angular 15 → 16 upgrade across a dozen repositories is too large for one agent session and too repetitive for a person. The obvious approach — let an agent loose on the repo — fails in a specific way: when the build goes red, the cheapest way to make it green is to weaken the tests. An agent under pressure will delete a failing spec, add `xit(`, or lower a coverage threshold, and report success.

So Janus splits the work in two:

**Agents propose. Janus disposes.**

Agents read code, write code, and return structured JSON. They never commit, never push, never merge, never decide when they are done. Every `.git` directory is read-only to them. Janus owns all state, every Git write, every budget, and the gates where a human must say yes.

That division is what the rest of the system is built around.

## How a goal runs

A **goal** is one version bump across N repositories — `goal.yaml` names the repos, their dependency order, and the target version. Janus walks a goal through an explicit state machine:

```
created → preparing → discovering → baselining → planning
   → awaiting_plan_approval          [GATE 1: a human approves the plan]
   → executing  (work package → implement → policy check → commit → CI → debug → repeat)
   → final_e2e → ai_review → qa
   → awaiting_human_review → fixing_review_feedback → awaiting_merge
   → releasing → completed
```

with `escalated` and `replanning` as the two ways out when something needs a person.

Every transition is logged. After every step Janus writes a **checkpoint** — state, a handover document, evidence, decisions — and commits it to a separate `janus/<goal-id>` branch. Kill the process at any point and `janus run` picks up where it left off: it recovers the interrupted step, saves any uncommitted agent work as a patch, reconciles repository heads against what the state file expected, and continues.

### Four human gates

| Gate | When | How |
|---|---|---|
| `plan_approval` | the technical plan is ready | `janus approve plan --commit <sha>` |
| `revised_plan_approval` | after an escalation and replan | `janus approve revised-plan --commit <sha>` |
| `pr_review` | a pull request is open | observed on the SCM, not a CLI command |
| `merge` | the human merges | observed on the SCM |

Gates 1 and 2 require the state-branch commit sha that `janus run` printed when it entered the gate, so approval is always attached to an exact, reviewable state. The approver comes from the Git identity in `.janus/` and is written to `decisions.md`.

Janus never merges its own pull requests. The access tokens it uses are not permitted to.

## The pieces

### Agents and sandboxes

Twelve roles, each a fresh `codex exec` process with a JSON output schema. Roles fall into three sandbox classes that decide what the process can touch:

| Class | Roles | Sandbox | Can write |
|---|---|---|---|
| code-writing | implementation, debug, fix, sync_conflict | `workspace-write`, network on | its assigned repo, the pnpm store |
| report-writing | discovery, integration_discovery, planning, replanning, qa | `workspace-write`, network off | one report directory |
| read-only | checkpoint, review, triage | `read-only` | nothing |

All classes can *read* the whole workspace. None can write to `.git`.

### Policy checks — the gate on every agent diff

When a code-writing agent finishes, Janus reads the diff **from the Git tree** — never from the agent's own report of what it changed, because agents were measured miscounting in both directions — and runs ten deterministic checks:

| Check | Catches |
|---|---|
| `tests.forbidden_pattern_added` | `xit(`, `fdescribe(`, `.skip(`, `it.todo(`, tautological assertions |
| `tests.file_removed` | a deleted or renamed-away test file |
| `tests.count_decreased` | fewer tests than before, including tests commented out |
| `runner_config.weakened` | a lowered coverage threshold or a new test exclusion |
| `paths.forbidden` | edits to `.github/`, `.teamcity/`, other CI config |
| `scope.outside_allowed` | files outside the work package's approved scope |
| `angular.version_beyond_target` | an `@angular/*` major above the target |
| `size.limits` | diffs beyond the configured file or line caps |
| `secrets.detected` | credential-shaped content (never quoted back into evidence) |
| `lockfile.scope` | a warning: `package.json` in scope but its lockfile is not |

**On pass**, Janus commits with a conventional message carrying `Work-Package`, `Run-Id`, `Goal` and `Janus-Policy` trailers, then pushes.

**On violation**, it writes `evidence/policy/<attempt-id>.yaml`, hands one fresh fix agent the report and the diff, and re-checks. If it still fails — or the package has hit `max_policy_violations_per_package` — the tree is reset, the diff is exported as a patch a human can re-apply, and the attempt counts against the budget.

These checks are deliberately mechanical. Judgment calls — a weakened assertion, a subtle behaviour change — belong to the AI checkpoint that reviews each completed package.

### Budgets

Nine counters bound the loop so a stuck goal escalates instead of burning tokens forever:

`ci_fix_attempts` · `e2e_fix_attempts` · `ai_review_cycles` · `no_progress_iterations` · `work_packages_without_green` · `sync_conflict_attempts` · `infra_retries` · `policy_violations` (per package) · `goal_runtime_hours`

A failing build whose *failure signature* is unchanged counts as no progress, so an agent that keeps producing the same error stops early rather than at the attempt limit.

### Providers

Three interfaces, each with a real implementation and a fake:

| Interface | Real | Fake |
|---|---|---|
| `AgentRunner` | Codex (`codex exec`) | scripted per role and attempt |
| `CiProvider` | TeamCity, plus a `local` shell-command runner | scripted per repo and attempt |
| `ScmProvider` | Bitbucket Server | persisted, with CLI hooks |

Fakes are first-class, not test scaffolding: they are how Janus is developed on a machine with no access to the real build and review systems, and how the full loop is exercised end to end. Providers are injected per run, never module singletons.

## Workspace

`janus init --goal goal.yaml [--config config.yaml] [--workspace DIR]` clones every repository in the goal at its base branch, creates the `janus/<goal-id>` state branch as a plain clone under `.janus/`, and makes the first checkpoint on it.

```text
<workspace>/
  .janus/          state branch: goal.yaml, config.yaml, state.yaml, handover.md,
                   decisions.md, evidence/, telemetry/
  repos/<name>/    one clone per repository
  fake/            persisted fake provider state
  .pnpm-store/     workspace-local pnpm store handed to agents
  janus.lock       present only while a janus process runs
```

The state branch is pushed to `state.clone_url` (or `state.repo`) when configured, otherwise to the goal's first repository. `janus init --resume` rebuilds an identical workspace from that branch alone — the state branch is the single source of truth.

Repositories are cloned from `clone_url` in `goal.yaml` when present, otherwise from `bitbucket.clone_url_template`.

## Running

```bash
janus run [--until STAGE] [--max-wait 45m] [--dry-run] [--model-profile NAME]
```

Run it from anywhere inside a workspace. It takes the lock, loads `.janus/state.yaml`, then:

1. **recovers** an interrupted step — an agent run's uncommitted diff is saved to `.janus/evidence/agents/<run-id>.interrupted.patch`, the repo is reset, and the run counts against its budget;
2. **reconciles** every repo — a local goal branch that fast-forwarded past `head_commit` is adopted, a remote branch that is ahead is fast-forwarded locally, non-fast-forward drift escalates, base-branch movement is noted;
3. **runs stage steps** until it stops.

| Exit | Meaning |
|---|---|
| 0 | completed, or `--until` reached |
| 3 | the next step is not implemented yet |
| 10 | waiting at a human gate |
| 11 | a wait exceeded `--max-wait` |
| 12 | escalated |
| 13 | another janus process holds the lock |
| 2 | usage error |
| 1 | unexpected error |

Guardrail hits and step failures write `.janus/escalation.md` and move the goal to `escalated`.

### Command surface

```
janus init        --goal | --resume
janus run         advance to the next gate or stop
janus status      human or --json
janus approve     plan | revised-plan     janus reject plan --reason
janus doctor      preflight checks, --json contract
janus agent run   run one role against a task file
janus ci          wait | trigger | digest
janus escalation  show | resolve
janus review      telemetry export | compare
```

## `janus doctor`

Checks everything an agent run depends on and says what to do about each failure:

- the `codex` CLI, its login, and that every model in the active `model_profiles` entry is accepted (a one-token probe per model, ~14.5k input tokens each)
- three real sandbox probes: a read-only `codex exec`, a `workspace-write` install in a scratch project, and `ng update --allow-dirty --dry-run` when the workspace has an Angular repository
- user namespaces, which the Codex sandbox needs
- Git identity, provider token environment variables, and that the pnpm store is really writable
- provider reachability, skipped when the configured provider is a fake
- a warning when the state branch lives in a product repository, because that repository's CI must exclude `janus/*` from its VCS root branch spec

```bash
janus doctor          # human report; exits 1 if any check failed
janus doctor --json   # { version, generated_at, workspace, summary, checks[] }
```

It runs without a workspace too — configuration-dependent checks then report `skip`.

## Configuration

`config.yaml` is validated with zod and every key has a default. The blocks that matter most:

- **`workflow`** — which CI and SCM provider to use (`teamcity` / `local` / `fake`, `bitbucket-server` / `fake`)
- **`policy`** — forbidden test patterns, forbidden paths, test-count tolerance, whether test deletion is allowed
- **`guardrails`** — every budget ceiling, plus `max_changed_files` and `max_diff_lines`
- **`agents`** — context byte budgets, per-role timeouts, pnpm store mode
- **`model_profiles`** — model and reasoning effort per role, switchable with `--model-profile`
- **`digest`** — caps on failure-digest size, test count, and log tail

Tokens are read from environment variables named in the config (`JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN` by default) and never from files.

## Status

Built and merged: the CLI and both config schemas, the state model and workspace, the engine (state machine, run loop, gates, resume, budgets), the integration harness, the agent runner with the Codex adapter and prompt templates, `janus doctor`, and the policy-check and commit/push layer described above.

Not yet built: the real CI and SCM providers, the stage steps that string the loop together, the E2E stage, multi-repo scheduling, release automation, and the operator skill. Every stage step is currently a placeholder that reports which task will deliver it, and `janus run` exits 3 when it reaches one. `tasks.md` tracks the order.

This means the policy layer exists and is tested but nothing calls it yet — wiring it into the package loop is a later task, by design.

## Development

```bash
pnpm install
pnpm test          # vitest, both projects
pnpm test:unit
pnpm test:integration
pnpm lint
pnpm typecheck
pnpm build         # emits dist/
pnpm dev --help    # run the CLI from source
```

TypeScript strict throughout, ESM, zod for every schema, conventional commits (`type(scope): subject`). Node 20 or newer; the dev toolchain needs 20.19+.

### Real-Codex smoke test

`tests/integration/codex-smoke.test.ts` runs two real `codex exec` invocations — a read-only echo and a `workspace-write` `pnpm install` in a scratch project. Skipped unless you opt in, because it needs the `codex` binary and working credentials:

```bash
JANUS_REAL_CODEX=1 pnpm test:integration
```
