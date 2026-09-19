# Janus

Agent-driven, resumable orchestrator for upgrading a multi-repository Angular application one major version at a time. Fresh Codex agents do bounded tasks; Janus owns state, gates, budgets, policy checks, CI observation, and Git checkpoints.

Design: `angular-ai-development-workflow-v2.md`. Task breakdown: `tasks.md`. Implementation plans: `docs/superpowers/plans/`.

## Status

Early scaffold. The CLI exists with every command from spec §8; most report "not implemented" and name the task that delivers them. `janus init --goal goal.yaml` validates a goal file.

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
