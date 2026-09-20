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

### S2 — output-schema compliance and token cost per role (open question 3, bullets 5 and 6)

Model `gpt-5.6-sol`, profile `default`, one attempt each, against a small scratch `ui-kit` repository.

| Role | Class | Prompt bytes | Truncations | Schema valid | Status | Input | Cached | Output | Reasoning | Total | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| discovery | report-writing | 3490 | 0 | yes | completed | 167229 | 141696 | 6252 | 1413 | 173481 | 141085 ms |
| planning | report-writing | 3468 | 0 | yes | completed | 218783 | 194688 | 4369 | 1312 | 223152 | 122672 ms |
| implementation | code-writing | 3512 | 0 | yes | completed | 85405 | 50560 | 2108 | 642 | 87513 | 52697 ms |
| debug | code-writing | 3444 | 0 | yes | completed | 99733 | 81536 | 1288 | 236 | 101021 | 39685 ms |

**For comparison, §3.3's third sandbox class (`read-only`: `checkpoint`/`review`/`triage`).** None of `tasks.md`
T06's four named roles use it, but Task 3 flagged that this class's token cost was never captured anywhere
observable (`task-3-report.md`, "Concerns / notes for the controller"). This task closes that gap at no extra
real-Codex cost, by recording (probe `S2-read-only`) the pre-existing T05 smoke test's own read-only "pong" turn
through `recordProbe`, rather than spending a fifth real-Codex call solely to observe it: role `review`, sandbox
`read-only`, status `completed` — input 17099 / cached 0 / output 182 / reasoning 83 / total 17281 tokens; wall
time 9223 ms. Its 0 cached-input tokens (versus the roughly 55-90% cache-hit fraction the four roles above show)
is expected, not a defect: it is the first real-Codex turn in the whole suite invocation, run before any of that
invocation's other turns had sent the ~16k-token Codex preamble for the server-side cache to reuse.

**Input-token floor.** Even a trivial read-only turn costs roughly 14.5k input tokens before any Janus context —
that is Codex's own instruction preamble. Every number above includes it, so the marginal cost of a §18.2 context
package is `input - 14500`, not `input`.

**Schema compliance.** All four roles produced a complete §18.3 result on the first attempt: every one of the
thirteen base-shape fields was present, `handover.next_action` was non-empty, and `validateAgentResult` raised no
`invalid_output` failure for any role. No schema was relaxed and no probe was retried to reach this result.

**Prompt findings.**
- **The plan slice's relative repository path was miscalibrated for the report-writing cwd, and both
  report-writing roles routed around it silently instead of failing loudly.** `.janus/reports/<run-id>/` is three
  directories below the workspace root, so the correct relative path to `repos/ui-kit` from there is
  `../../../repos/ui-kit` — but this probe's `discovery` and `planning` plan slices (per this task's brief,
  applied verbatim) say `../../repos/ui-kit`, one level too shallow. Neither role failed: `discovery` searched the
  filesystem, found the repository at the correct depth, and explicitly surfaced the mismatch as decision item 1
  in its report ("The approved plan's literal `../../repos/ui-kit` did not exist from the assigned report
  directory"); `planning` also located and read the real `package.json` correctly but did not remark on the path
  being wrong. A model silently self-correcting a bad path is good resilience here, but it is a risk in
  production: if a work package's repository path is ever subtly wrong in a way where *something* still exists at
  the literal (incorrect) path, a model that self-corrects by searching rather than failing could act on the
  wrong repository without anyone noticing. Task 7 should flag this as a reason path fields in the context
  package are worth validating (e.g., existence-checked) before the prompt is sent, not left for the model to
  discover.
- **`changes_made` is not a reliable self-audit in either direction.** Task 5's A2 finding was an
  under-report (2 claimed vs 3 actual). Here `discovery` over-reported: it claimed `changes_made.length === 2`
  but its report directory holds exactly one file, `angular-major-upgrade.md`. `planning`, `implementation` and
  `debug` all matched the real tree exactly (`planning` wrote `plan.md` and `plan.yaml`, 2 files, claimed 2;
  `implementation` left `src/sum.js` and `src/sum.test.js` modified, claimed 2; `debug` left only `src/sum.js`
  modified, claimed 1). Combined with A2, this confirms Task 5's recommendation: any verification step that
  trusts `changes_made` alone, in either direction, should cross-check it against the real tree rather than rely
  on the agent's self-report.
- **`implementation` and `debug` both honored their narrow scope exactly.** `implementation` added `product(a, b)`
  and its test, changed nothing else, and explicitly noted in its summary that the full suite remains red because
  of the pre-existing `sum` defect — it did not opportunistically fix the debug role's target bug. `debug` fixed
  only `src/sum.js` (`a - b` -> `a + b`) and left `src/sum.test.js` untouched, honoring "fix the source, not the
  test."

## Findings and resulting changes

### 1. `parseCodexUsage` recorded `total: 0` for every real run (probe R1)

**Evidence.** codex-cli 0.146.0 emits `turn.completed.usage` with no `total_tokens` key.
**Change.** `src/agents/codex/jsonl.ts` derives `total = input_tokens + output_tokens` when the key is absent.
**Also changed.** The hand-written fixtures spelled an item's kind `item_type`; the binary spells it `type`.
**Not changed.** `cache_write_input_tokens` is real but unmodelled — §18.6's comparison names input, cached,
output and reasoning, and nothing consumes a fifth counter.

### 2. Every read-only agent would have failed at spawn (probe R2)

**Evidence.** `codex exec -s read-only -C <non-repo>` exits 1 with
`Not inside a trusted directory and --skip-git-repo-check was not specified.`, before any model call. §3.3 puts
`checkpoint`, `review` and `triage` at the workspace root, which is not a git repository.
**Change.** §18.4's flag ban narrowed to the write-capable classes; `SandboxPlan.skipGitRepoCheck` and
`AgentTask.skipGitRepoCheck` added, set for the read-only class only; `buildCodexArgs` emits the flag;
`AgentEvidence.skip_git_repo_check` records it. §3.3 gained a sentence saying the workspace root is deliberately
not a repository, and why.
**Rejected.** A repo cwd for read-only roles (no single repo to pick for workspace-level roles); `git init` at the
workspace root (nests a fourth repository around `.janus/` and every `repos/<name>`, adds an unaudited reflog);
a `projects.<dir>.trust_level` override (does not work on 0.146.0).
**Needs ratification by the spec owner.**

### 3. The report-writing cwd only passes Codex's trust check because `.janus/` is a real checkout (probes S1a, S1b)

**Evidence.** `.janus/reports/<run-id>/`, `-s workspace-write`, network off, one `--add-dir`: the report landed
inside the report directory, nothing was written to the sibling repo, and the run was not refused — because
`.janus/` is a single-branch git clone (§5), not because Codex's git-work-tree check is lenient. A code-writing
role installed dependencies entirely through `npm_config_store_dir`, with no `.npmrc` written anywhere and HEAD
unmoved (§32 rule 11).
**Change.** No production change: this confirms T05's sandbox plan and pnpm store setup as specified. Recorded as
an operational warning — any future hand-built test workspace must `git init` `.janus/` or the report-writing
class fails at spawn for a reason unrelated to the agent.
**Not changed.** Nothing in `src/workspace/` or `src/agents/sandbox.ts`; both probes passed against the existing
design.

### 4. `ng update --allow-dirty` does not refuse a dirty tree, and the measured footprint is a minimal-scaffold floor, not a typical one (probes A1, A2)

**Evidence.** `ng update @angular/core@16 @angular/cli@16 --allow-dirty` on a bare `ng new` scaffold proceeded
past a dirty tree (printed a warning, exit 0) and changed 3 files: `package.json`, `pnpm-lock.yaml`, and
`src/main.ts` (the one file already dirty before the migration ran, not a migration edit). Every individual
migration schematic reported "Migration completed (No changes made)", because the scaffold has almost no
application code — no route guards, resolvers, or `moduleId` usage for the CLI to rewrite. A code-writing agent
completed the same upgrade unsupervised in ~2.3 minutes, well inside budget, and its production build was green
afterward — but it reported `changes_made.length === 2` while the tree held 3 changed files: an under-report.
**Change.** §12's `allowed_scope` guidance amended to say the measured count is a minimal-scaffold floor, not a
typical footprint, and that `allowed_scope` must cover `package.json`, the lockfile, and `src/**` broadly because
a real multi-repo upgrade will touch far more of `src/**` than this scaffold did. `ANGULAR_GUIDANCE`
(`src/agents/prompts/shared.ts`) carries the same floor framing plus the reason (a bare scaffold has almost no
application code to rewrite), and now tells every role to report `changes_made` verified with `git status
--porcelain`, not from memory. `implementation`'s template text gained a matching sentence tying `changes_made`
to the orchestrator's policy check.
**Not changed.** No runtime scope validator was added; §12 states the qualitative floor, and `changes_made`
verification against the real tree is deferred to T08/T12 (see "Feeds into other tasks" below), not built here.

### 5. All four S2 roles produced a schema-valid result on the first attempt — a real, not tautological, pass (probe S2)

**Evidence.** `discovery`, `planning`, `implementation` and `debug` each answered a real Codex turn with every
§18.3 base-shape field present, a non-empty `handover.next_action`, and no `invalid_output` failure — nothing was
relaxed or retried to get there. Per-role cost, transcribed from Task 6's report:

| Role | Class | Input | Cached | Output | Reasoning | Total | Wall time |
|---|---|---|---|---|---|---|---|
| discovery | report-writing | 167229 | 141696 | 6252 | 1413 | 173481 | 141085 ms |
| planning | report-writing | 218783 | 194688 | 4369 | 1312 | 223152 | 122672 ms |
| implementation | code-writing | 85405 | 50560 | 2108 | 642 | 87513 | 52697 ms |
| debug | code-writing | 99733 | 81536 | 1288 | 236 | 101021 | 39685 ms |
| review (read-only, comparison row) | read-only | 17099 | 0 | 182 | 83 | 17281 | 9223 ms |

Even a trivial read-only turn costs roughly 14.5k input tokens before any Janus context — Codex's own instruction
preamble — so the marginal cost of a §18.2 context package is `input - 14500`, not `input`.
**Change (schema compliance).** None needed; this is a positive finding recorded as-is, not a defect to fix.
**Change (silent path self-correction).** The plan slice's relative repository path was one directory level too
shallow for the report-writing cwd (`../../repos/ui-kit` instead of `../../../repos/ui-kit`). Neither role
failed: `discovery` searched the filesystem, found the repository, and surfaced the mismatch as a decision item in
its report; `planning` also found the right path but never mentioned the discrepancy. Since Janus edits several
repositories per goal, an agent that silently self-corrects a bad path — rather than failing loudly — risks acting
on the wrong repository undetected. `discovery`'s and `planning`'s template text (`src/agents/prompts/templates.ts`)
each gained a sentence instructing the agent to report an unresolvable path and stop, rather than search for a
plausible match. This is the prompt-side half only; runtime existence-checking of path fields before the prompt is
sent is recorded below as a recommendation for a later task, not built here.
**Change (`changes_made` unreliable in both directions).** Task 5's A2 agent under-reported (2 claimed vs 3
actual). Here `discovery` over-reported (2 claimed vs 1 actual file in its report directory); `planning`,
`implementation` and `debug` matched the real tree exactly. `ANGULAR_GUIDANCE` and `implementation`'s template
text now both instruct agents to enumerate changed files with `git status --porcelain` rather than reconstruct the
list from memory, and to treat `changes_made` as unverified until cross-checked. The verification-side
consequence (T08/T12 cross-checking `changes_made` against the real tree) is recorded below, not built here.
**Change (scope discipline).** `implementation` and `debug` both honored their narrow scope exactly — neither
opportunistically fixed the other's target bug. Recorded as a positive finding; no change needed.

## Feeds into other tasks

| Finding | Goes to |
|---|---|
| Read-only runs need `--skip-git-repo-check` | T07 `codex.probe.read_only`, which probes exactly that shape |
| `.janus/` must be a git checkout for report-writing to spawn | every future hand-built test workspace; §5 already requires it |
| The workspace pnpm store needs no `.npmrc` | T07 `pnpm.store` |
| Measured `ng update` footprint is a minimal-scaffold floor, not a typical one | §12 `allowed_scope` floor (done here); T11's `plan.yaml` validator; T08's scope check |
| Per-role token baselines | §18.6 comparisons; T21's `janus telemetry compare`; T22's dogfood budget |
| Per-role schema compliance | T05 prompt templates (done here); T12's attempt accounting |
| A model can silently self-correct an unresolvable repository path by searching instead of failing | prompt-side fix done here (T07); runtime path existence-validation in the context package is a recommendation for a later task, not built here |
| `changes_made` is unreliable in both directions (over- and under-report) | prompt-side fix done here (T07); T08's and T12's verification should cross-check `changes_made` against `git status --porcelain` on the real tree rather than trust the self-report |
