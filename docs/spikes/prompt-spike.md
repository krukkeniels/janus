# T06 manual prompt spike — real Codex against a throwaway Angular 15 app

Spec: `angular-ai-development-workflow-v2.md` §29 item 4. Task: `tasks.md` T06. Time box: one week.

## Purpose

Validate the T05 prompts, context packages, sandbox plan and pnpm store setup against the real `codex` binary
before the execution loop is built on top of them, and settle three questions T05 could only mark as open:

1. **The read-only cwd tension.** §3.3 gives `checkpoint`, `review` and `triage` the workspace root as cwd;
   `src/workspace/layout.ts` never `git init`s that root; §18.4 forbids `--skip-git-repo-check`. Does real Codex
   refuse such a run?
2. **The real Codex JSONL event shape.** `tests/fixtures/codex/*.jsonl` were hand-written from the *expected*
   stream. Does `turn.completed.usage` look like that?
3. **First-contact behaviours.** Report-writing under `workspace-write` with a report cwd; the pnpm store as the
   single writable root; `ng update --allow-dirty`; the migration footprint against `allowed_scope`;
   output-schema compliance per role; token usage per role.

## Environment

| Item | Value |
|---|---|
| `codex` | `codex-cli 0.146.0` |
| Codex login | ChatGPT |
| Default model / effort | `gpt-5.6-sol` / `xhigh` (from `~/.codex/config.toml`, outside Janus per §28) |
| Janus Node | v24.5.0 |
| Spike-app Node | v18.20.8 via `nvm` (Angular CLI 15 declares `^14.20 || ^16.14 || ^18.10`) |
| pnpm | 10.33.0 |
| Spike app | `~/janus-spike/ng15-app`, `ng new` with `--routing --style=scss --package-manager=pnpm` |
| Spike root is a git repo? | no — deliberately, so probe R2 has a non-repo cwd |
| `ng build` baseline | green |
| `ng test` baseline | green — `ng test --watch=false --browsers=ChromeHeadless` ran 3/3 SUCCESS against the scaffolded ChromeHeadless launcher; no `CHROME_BIN` override was needed |
| Bubblewrap | `/usr/bin/bwrap` present; `unprivileged_userns_clone=1`; `max_user_namespaces=236542` |

Not reachable from this machine, and therefore never probed: Bitbucket Server, TeamCity.

## Runbook — how to re-run every probe

```bash
# 1. Janus's own Node, for the probe lane
cd /path/to/janus
export JANUS_REAL_CODEX=1
export JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl"
export JANUS_SPIKE_APP="$HOME/janus-spike/ng15-app"
pnpm test:integration -- tests/integration/codex-smoke.test.ts

# 2. Angular's Node, for anything that runs `ng`
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 18.20.8
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd ~/janus-spike/ng15-app && npx ng build
```

Without `JANUS_REAL_CODEX=1` the whole file is skipped, which is how CI and every other developer see it.
`JANUS_SPIKE_LOG` decides where probe records land; unset, they go to a temp file and nothing is committed.
`JANUS_SPIKE_APP` points the Angular probes at the app; unset, those probes skip themselves.

## Probe results

*(one section per probe, appended by the task that runs it)*

## Findings and resulting changes

*(written last, from the probe sections)*
