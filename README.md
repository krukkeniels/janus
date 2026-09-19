# Janus

Agent-driven, resumable orchestrator for upgrading a multi-repository Angular application one major version at a time. Fresh Codex agents do bounded tasks; Janus owns state, gates, budgets, policy checks, CI observation, and Git checkpoints.

Design: `angular-ai-development-workflow-v2.md`. Task breakdown: `tasks.md`. Implementation plans: `docs/superpowers/plans/`.

## Status

Early scaffold. The CLI exists with every command from spec §8; most report "not implemented" and name the task that delivers them. `janus init --goal goal.yaml` creates a goal workspace, and `janus init --resume <state-remote> <goal-id>` rebuilds one from the state branch alone.

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

Node 20 or newer and pnpm are required, though the dev toolchain (ESLint 10) needs Node 20.19 or newer. Tokens for TeamCity and Bitbucket come from environment variables named in `config.yaml` (`JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN` by default) and are never read from files.
