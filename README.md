# Janus

Agent-driven, resumable orchestrator for upgrading a multi-repository Angular application one major version at a time. Fresh Codex agents do bounded tasks; Janus owns state, gates, budgets, policy checks, CI observation, and Git checkpoints.

Design: `angular-ai-development-workflow-v2.md`. Task breakdown: `tasks.md`. Implementation plans: `docs/superpowers/plans/`.

## Status

Early scaffold. The CLI exists with every command from spec §8. `janus init --goal` creates a goal workspace, `janus init --resume` rebuilds one from the state branch alone, and `janus run` drives the goal state machine: it recovers an interrupted step, reconciles repo heads, runs one step per stage with `in_flight` bracketing and a checkpoint after each, and stops at human gates (`janus approve plan --commit <sha>`, `janus reject plan --reason`), escalations, exceeded waits, or completion. Every real stage step is still a placeholder that reports the task delivering it (T11 onward); the machine is exercised end to end with scripted steps in `tests/cli/scripted-run.test.ts`.

## Workspace

`janus init --goal goal.yaml [--config config.yaml] [--workspace DIR]` clones every repository listed in the goal at its base branch, creates the `janus/<goal-id>` state branch as a plain clone under `.janus/`, and makes the first checkpoint (state, handover, decisions, telemetry) on it. The state branch is pushed to `state.clone_url` (or `state.repo`) when configured, otherwise to the first repository of the goal.

```text
<workspace>/
  .janus/          state branch checkout: goal.yaml, config.yaml, state.yaml, handover.md, decisions.md, telemetry/
  repos/<name>/    one clone per repository
  fake/            persisted fake provider state (fake providers only)
  .pnpm-store/     workspace-local pnpm store handed to agents
  janus.lock       present only while a janus process runs
```

Repositories are cloned from `clone_url` in `goal.yaml` when present, otherwise from `bitbucket.clone_url_template` rendered with `bitbucket.url`.

## Running

`janus run [--until STAGE] [--max-wait 45m] [--dry-run] [--model-profile NAME]` must be run inside a workspace (any directory under it). It takes the workspace lock, loads `.janus/state.yaml`, and:

1. recovers an interrupted step if `execution.in_flight.step` is set: an agent run's uncommitted diff is saved to `.janus/evidence/agents/<run-id>.interrupted.patch`, the repo is reset, and the run counts against its budget (spec §7 rule 3);
2. reconciles every repo: a local goal branch that fast-forwarded past `head_commit` is adopted, a remote goal branch that is ahead is fast-forwarded locally, non-fast-forward drift escalates, and base-branch movement is only noted (§7 rule 2);
3. runs stage steps until it stops.

Exit codes: `0` completed or `--until` reached, `3` the next step is not implemented yet, `10` waiting at a human gate, `11` a wait exceeded `--max-wait`, `12` escalated, `13` another janus process holds the lock, `2` usage error, `1` unexpected error (including a moved remote state branch, which needs a manual reconcile).

Gates 1 and 2 are passed with `janus approve plan --commit <sha> [--exception <id> ...]` and `janus approve revised-plan --commit <sha>`; the sha must be the state-branch commit printed by `janus run` (the commit at which the gate was entered), and the approver is taken from the git identity in `.janus/` and written to `decisions.md`. `janus reject plan --reason "..."` sends the goal back to `planning` (or `replanning` after an escalation). Guardrail hits (spec §20) and step failures write `.janus/escalation.md` and move the goal to `escalated`; `janus escalation resolve` arrives with T13.

## `janus doctor`

Checks everything an agent run depends on, and says what to do about each failure:

- the `codex` CLI, its login, and that every model in the active `model_profiles` entry is accepted (a one-token
  probe per model, ~14.5k input tokens each)
- the three real §18.4 probes: a read-only `codex exec`, a `workspace-write` install in a scratch project, and
  `ng update --allow-dirty --dry-run` when the workspace has an Angular repository
- user namespaces, which the Codex sandbox needs
- git identity, the provider token environment variables, and that the pnpm store is really writable
- provider reachability, skipped when the configured provider is a fake
- a warning when the state branch lives in a product repository, because that repository's CI must exclude
  `janus/*` from its VCS root branch spec

```bash
janus doctor          # human report; exits 1 if any check failed
janus doctor --json   # the machine contract: { version, generated_at, workspace, summary, checks[] }
```

It runs without a workspace too — the configuration-dependent checks then report `skip`.

## Development

```bash
pnpm install
pnpm test          # vitest
pnpm lint          # eslint
pnpm typecheck     # tsc --noEmit
pnpm build         # emits dist/
pnpm dev --help    # run the CLI from source
node bin/janus.js --help
```

### Real-Codex smoke test

`tests/integration/codex-smoke.test.ts` runs two real `codex exec` invocations — a read-only echo and a
workspace-write `pnpm install` in a scratch project. It is skipped unless you opt in, because it needs the `codex`
binary and working Codex credentials:

```bash
JANUS_REAL_CODEX=1 pnpm test:integration
```

Node 20 or newer and pnpm are required, though the dev toolchain (ESLint 10) needs Node 20.19 or newer. Tokens for TeamCity and Bitbucket come from environment variables named in `config.yaml` (`JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN` by default) and are never read from files.
