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

### R1 — the real Codex JSONL event shape (open question 2)

Ran a `workspace-write` implementation task in a scratch repo through `createCodexAgentRunner` with the real
`spawnCodex` wrapped so the stream could be kept. Captured to `tests/fixtures/codex/real-workspace-write.jsonl`.

| Observation | Result |
|---|---|
| Event types seen | `item.completed`, `item.started`, `thread.started`, `turn.completed`, `turn.started` |
| Unparseable lines | 0 (of 14 events) |
| `turn.completed.usage` keys | `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` |
| `total_tokens` present? | **no** |
| Reasoning-token spelling | flat `reasoning_output_tokens` (the nested `output_tokens_details.reasoning_tokens` form was not seen) |
| Item kind key | `item.type` — the hand-written fixtures said `item.item_type` |
| Codex banner stream | stderr, not stdout |

**Verdict: the fixtures were wrong, and so was the parser.** `parseCodexUsage` computed `total` from a
`total_tokens` key that does not exist, so every real run recorded `total: 0`.

**Changes:** `src/agents/codex/jsonl.ts` derives `total = input + output` when `total_tokens` is absent;
`implementation-success.jsonl` and `usage-nested.jsonl` renamed `item_type` to `type`;
`real-workspace-write.jsonl` added as the first fixture captured from the binary. `cache_write_input_tokens` is
recorded here and deliberately **not** added to `AgentTokenUsage` — §18.6's comparison names input, cached,
output and reasoning, and nothing consumes a fifth counter.

### R2 — the read-only cwd tension (open question 1)

| Variant | Exit | Note |
|---|---|---|
| `-s read-only -C <non-repo>` | 1 | stderr: `Not inside a trusted directory and --skip-git-repo-check was not specified.` — refused before any model call |
| the same `+ --skip-git-repo-check` | 0 | runs |
| the same in a `git init`-ed empty dir | 0 | runs |
| the same `+ -c projects."<dir>".trust_level="trusted"` | 1 | still refused |

**Verdict: the tension is real.** Every `checkpoint`, `review` and `triage` run would have failed at spawn, and
T05's own read-only smoke test was red.

**Options weighed:**

- **(a) exempt the read-only class from the §18.4 flag ban — CHOSEN.** A read-only run has zero `--add-dir`
  writable roots; it cannot write anything wherever it starts. Leaves §3.3's class table, the workspace layout and
  the §31.29 reflog audit untouched.
- (b) give read-only roles a repo cwd — rejected. `checkpoint` and `review` are workspace-level and span every
  repo; there is no single repo to pick.
- (c) `git init` the workspace root — verified to work, rejected. Nests `.janus/` and every `repos/<name>` inside a
  fourth repository, adds an unaudited reflog, and gives a `danger-full-access` agent a root index to dirty.
- (d) `-c projects."<dir>".trust_level="trusted"` — verified not to work on codex-cli 0.146.0.

**Changes:** `SandboxPlan.skipGitRepoCheck` / `AgentTask.skipGitRepoCheck`, set by `planSandbox` for the read-only
class only; `buildCodexArgs` emits the flag; `AgentEvidence.skip_git_repo_check` records it; §18.4 and §3.3 amended.
**This spec amendment needs the spec owner's ratification.**

### S1 — report-writing cwd and the pnpm store (open question 3, bullets 1 and 2)

**S1a — report-writing class.** cwd `.janus/reports/<run-id>/`, `-s workspace-write`,
`-c sandbox_workspace_write.network_access=false`, that directory the only `--add-dir`.

| Observation | Result |
|---|---|
| Wrote its report into the report directory | yes |
| Wrote anything into `repos/ui-kit/` | no |
| Could read a sibling repo it had no write access to | yes |
| Tokens (input / cached / output / reasoning / total) | 100610 / 81280 / 2696 / 588 / 103306 |
| Wall time | 65452 ms |

The report cwd passes Codex's git-work-tree check **because `.janus/` is a single-branch clone** (§5), not because
the check is lenient. Any future test that builds a workspace by hand must `git init` `.janus/` or this class will
fail at spawn for a reason that has nothing to do with the agent.

**S1b — the workspace pnpm store.**

| Observation | Result |
|---|---|
| Entries in `<workspace>/.pnpm-store` after the install | 1 |
| `.npmrc` created in the repo | no |
| `.npmrc` created at the workspace root | no |
| `node_modules` present | yes |
| Repo HEAD moved | no (§32 rule 11) |
| Tokens / wall time | 124582 / 103168 / 1977 / 928 / 126559 tokens; 52755 ms |

**Verdict:** confirmed as specified — a report-writing role writes only into its `.janus/reports/<run-id>/` cwd
(the git-work-tree check passes because `.janus/` is a real checkout, not by accident), and a code-writing role
installs entirely through `npm_config_store_dir` with no `.npmrc` written anywhere.

### A1 / A2 — `ng update --allow-dirty` and the migration footprint (open question 3, bullets 3 and 4)

**A1 — `ng update` run directly, no agent.** `~/janus-spike/ng15-footprint`, Angular 15 -> 16, one file
deliberately uncommitted first.

| Measure | Value |
|---|---|
| `ng update ... --allow-dirty` refused the dirty tree? | no — printed `Repository is not clean. Update changes will be mixed with pre-existing changes.` and proceeded |
| `ng update` exit code | 0 |
| Changed files | 3 |
| Lines added / removed | 1669 / 1144 |
| Top-level paths touched | `src` (1), `pnpm-lock.yaml` (1), `package.json` (1) |
| Paths outside §12's example `allowed_scope` | none |
| `pnpm install && ng build` after the migration | green |

The migration's own `** Executing migrations of package '@angular/core' **` / `'@angular/cli'` steps all reported
"Migration completed (No changes made)" on this scaffold — no interfaces to strip, no `moduleId` usage, no
`defaultProject`/`defaultCollection` config. The 3 changed files are `package.json` (dependency version bumps),
`pnpm-lock.yaml` (the resulting resolution), and `src/main.ts` (the pre-existing uncommitted line from Step 1, not
a migration edit). On a scaffold this bare, the footprint is dominated by the manifest and lockfile, not by
source-tree rewrites — a real application with `CanActivate`/`Resolve` guards or `moduleId` usage would add `src/**`
entries the migration itself changes.

**A2 — the same upgrade, run by a code-writing agent** under `-s workspace-write`,
`network_access=true`, writable roots `[repos/ng15-app, .pnpm-store]`, `npm_config_store_dir` set, Node 18 first on
`PATH`.

| Measure | Value |
|---|---|
| Result status | `completed` |
| `@angular/core` after the run | `^16.2.12` |
| Changed files it left in the tree | 3 |
| Files it *reported* in `changes_made` | 2 |
| HEAD moved / reflog moved | no, no (§32 rule 11) |
| Tokens (input / cached / output / reasoning / total) | 366012 / 338304 / 3755 / 1234 / 369767 |
| Wall time | 135762 ms (~2.3 minutes) |

**Recommended §12 default `allowed_scope` for an Angular application package**, derived from A1's footprint:

```yaml
allowed_scope:
  - package.json
  - pnpm-lock.yaml
  - angular.json
  - tsconfig*.json
  - src/**
  - projects/**
```

Step 5's scan against §12's example scope found nothing out of bounds on this scaffold — no `.browserslistrc`,
`karma.conf.js`, `.editorconfig`, `README.md`, or `e2e/**` edits, because the migration touched no such files
here. §12's example scope is sufficient for this footprint; the two-line placeholder for out-of-scope additions is
deliberately omitted above since Step 5 printed nothing.

**Verdict:** both A1 and A2 confirm §18.4's claims — `ng update --allow-dirty` does not refuse a dirty tree, and a
code-writing agent inside the T05 sandbox plan can complete the same upgrade unsupervised, in about 2.3 minutes on
this scaffold, well inside the 45-minute budget. `changes_made` **did under-report the real footprint** (2 vs the
3 files actually left dirty in the tree) — the agent's self-reported change list is not a reliable audit of what a
migration touched; Task 7 should have the planning prompt tell the agent to enumerate changed files with `git
status --porcelain` rather than reconstruct the list from memory, and any verification step that trusts
`changes_made` alone should cross-check it against the real tree.

## Findings and resulting changes

*(written last, from the probe sections)*
