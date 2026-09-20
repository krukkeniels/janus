# T06 Prompt Spike and T07 `janus doctor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the §29.4 manual prompt spike against real Codex on a throwaway Angular 15 app, settle the three questions T05 left open (the read-only cwd tension, the real Codex JSONL event shape, and first-contact sandbox behaviour), fold the findings into the prompt templates and the spec — and then turn that same probe matrix into `janus doctor`: thirteen checks covering every bullet of `tasks.md` T07, each with a unit test that simulates its failure and asserts its remediation text, behind a stable `--json` contract.

**Architecture:** Two halves, in that order, because the second is written against what the first observed. **T06** adds no production module of its own: it extends `tests/integration/codex-smoke.test.ts` — the opt-in `JANUS_REAL_CODEX=1` lane T05 built — with one probe per open question, each recording a machine-readable record through a new `tests/helpers/codex-probe.ts` recorder, and writes `docs/spikes/prompt-spike.md` from those records. The only production code T06 touches is what a probe *disproves*: `src/agents/codex/jsonl.ts` (the usage shape), `src/agents/sandbox.ts` + `src/agents/codex/adapter.ts` (the read-only cwd ruling), and `src/agents/prompts/**` (template wording). **T07** adds `src/doctor/**`: a `DoctorCheck` contract, a `CommandRunner` process seam so every check is unit-testable without `codex`, `git`, `pnpm` or a network, six check modules, and a registry the CLI walks. `src/cli/commands/doctor.ts` stops calling `notImplemented` and renders either the human report or the `--json` document.

**Tech Stack:** Node 20+ for Janus itself, Node 18.20.8 (via `nvm`) for the Angular 15 spike app, TypeScript strict ESM (NodeNext), zod 3, yaml 2, commander 14, vitest 5 (`unit` and `integration` projects), `node:child_process`, the system `git` binary, `codex-cli` 0.146.0, pnpm 10.33.0.

**Spec:** `angular-ai-development-workflow-v2.md` — §3.3 (agents and sandboxes: the class table, cwd, writable roots), §5 (workspace layout, `.pnpm-store/`), §12 (`plan.yaml`, `allowed_scope`, the lockfile warning), §14 (policy checks, the output-schema note), §18 in full and §18.2 / §18.4 / §18.6 in particular (context package, Codex adapter invocation and the three doctor probes, model profiles and the one-token model check), §28 (configuration: `agents.*`, `model_profiles`, token env vars, `state.repo`), §29 items 4 and 6 (the manual prompt spike, the first-contact runbook), §31 items 29 and 33, §32 rules 11 and 12, §33 (assumptions: the `janus/*` branch-spec exclusion, bubblewrap user namespaces). Task definitions: `tasks.md` T06 and T07. Immediate predecessor: `docs/superpowers/plans/2026-09-20-t05-agent-runner.md` (assume fully landed; `main` at `7cec453`, 727 tests).

## Global Constraints

- Node `>=20` for Janus (`package.json` `engines`); ESM (`"type": "module"`); every relative import ends in `.js`; type-only imports use `import type`.
- TypeScript `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `!` non-null assertions: narrow with `if (x === undefined) throw ...`. Never pass `undefined` to an optional property; spread it in conditionally (`...(v === undefined ? {} : { k: v })`).
- Package manager is `pnpm`. `pnpm test` runs both vitest projects; `pnpm test:unit` and `pnpm test:integration` target one. `commander` stays pinned to `^14` for the Node 20 floor.
- **Every commit message is `type(scope): subject` — always with a scope — and ends, after a blank line, with these two trailer lines.** Every commit step below uses the two-`-m` form, which produces exactly that:

```bash
git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

- TDD throughout: write the failing test, run it and see it fail, write the minimal implementation, run it and see it pass, commit.
- Exit codes come only from `src/cli/exit-codes.ts` (`Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`). **No new exit code is added by this plan.**
- The test count after T05 is **727**. Every task below adds tests; no task may reduce that number. `pnpm test`, `pnpm test:integration`, `pnpm lint`, `pnpm typecheck` and `pnpm build` must all be green at every commit.
- §32 rule 12: "Secrets never enter `.janus/`, prompts, or evidence." No doctor check ever prints a token value, and no probe record ever contains one. Token checks report the **variable name** and whether it is set, never its content. `docs/spikes/prompt-spike.md` is committed to this repository, so nothing pasted into it may contain a credential, a session id, or a `~/`-absolute home path.
- §32 rule 11: "Agents never commit, push, or otherwise rewrite Git history." No probe and no doctor check runs a git command that moves a ref. The only git commands this plan runs are `git var`, `git init` (in throwaway temp directories owned by the probe, never in a workspace), `git rev-parse`, `git status`, `git reflog show` and `git diff`.
- **Target systems are not reachable from this machine.** Bitbucket Server and TeamCity do not answer. No test in this plan performs a network request: the provider-reachability check goes through an injected `HttpProbe` seam and every test supplies a fake. The one network user in the whole plan is `codex exec` itself, in the opt-in `JANUS_REAL_CODEX=1` lane which is skipped by default.
- §18.4: "`resume` and `--skip-git-repo-check` are never used." **Task 3 amends this sentence with evidence** and narrows it to write-capable sandboxes. Until Task 3 lands, it holds as written.
- §19's "may not" list and §32 rule 11 are rendered verbatim into the GUARDRAILS AND FORBIDDEN ACTIONS section of every prompt. Any edit to `src/agents/prompts/shared.ts` or `src/agents/prompts/templates.ts` changes a fingerprint in `PROMPT_FINGERPRINTS` and **must** be accompanied by a `version` bump of every affected role (§18.6: a comparison must never silently mix prompt changes with model changes).
- Providers are injected through `StepContext.providers`; never module singletons. Doctor follows the same rule: every process, filesystem and network call goes through a seam on `DoctorCheckContext`.
- The spike app lives **outside this repository**, at `~/janus-spike/`. Nothing under `~/janus-spike/` is ever added to git here. `~/Documents/kolonihave-arkitekten` is a real Angular 19 project belonging to the user and **must not be touched, read into a prompt, or used as the spike app**.

## Environment facts this plan was written against

These were verified on this machine while the plan was written. A step that depends on one says so. If one turns out to be false at execution time, that is itself a spike finding and belongs in `docs/spikes/prompt-spike.md`.

| Fact | Verified value |
|---|---|
| `codex` binary | `/home/race-day/.nvm/versions/node/v24.5.0/bin/codex`, `codex --version` prints `codex-cli 0.146.0` |
| `codex login status` | prints `Logged in using ChatGPT`, exits `0` |
| default model / effort | `gpt-5.6-sol`, `xhigh` (from the user's `~/.codex/config.toml`; Codex prints both in its stderr banner) |
| `codex exec` flags | `-C/--cd`, `-s/--sandbox {read-only,workspace-write,danger-full-access}`, `--add-dir`, `--skip-git-repo-check`, `--ephemeral`, `--output-schema <FILE>`, `--json`, `-o/--output-last-message <FILE>`, `-m/--model`, `-c key=value` all exist |
| Codex banner stream | the `OpenAI Codex v0.146.0 / workdir / model / sandbox` banner goes to **stderr**; `--json` JSONL goes to **stdout** |
| read-only run outside a git work tree | **refused**, instantly, before any model call: exit `1`, stderr exactly `Not inside a trusted directory and --skip-git-repo-check was not specified.` |
| same run with `--skip-git-repo-check` | **succeeds**, exit `0` |
| same run in a freshly `git init`-ed empty directory (no commits) | **succeeds**, exit `0` |
| `-c projects."<dir>".trust_level="trusted"` as a workaround | **does not help**; the same refusal |
| real `turn.completed.usage` | `{"input_tokens":14468,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}` — **no `total_tokens` key**, and a `cache_write_input_tokens` key the parser does not know |
| real JSONL event types (trivial turn) | `thread.started` (with `thread_id`), `turn.started`, `item.completed` (with `item.type`, e.g. `agent_message`, **not** `item.item_type`), `turn.completed` |
| input-token floor | ~14.5k input tokens for a trivial read-only turn — Codex's own instruction preamble, before any Janus context |
| Node | default `v24.5.0`; `nvm` at `~/.nvm/nvm.sh`; `v18.20.8` and `v22.19.0` also installed |
| pnpm under Node 18.20.8 | `10.33.0` via the corepack shim at `~/.nvm/versions/node/v18.20.8/bin/pnpm`; needs `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` on first use |
| bubblewrap | `/usr/bin/bwrap` present; `/proc/sys/kernel/unprivileged_userns_clone` = `1`; `/proc/sys/user/max_user_namespaces` = `236542` |
| Angular apps present | only `~/Documents/kolonihave-arkitekten` (Angular **19**, a real project — off limits). **No Angular 15 app exists; the spike must scaffold one.** |

---

## Decisions this plan locks in

**1. The spike app: `~/janus-spike/ng15-app`, scaffolded under Node 18.20.8.** Angular CLI 15 declares `"node": "^14.20.0 || ^16.14.0 || ^18.10.0"`, so it refuses the default Node 24.5.0. Every Angular command in this plan — `ng new`, `ng version`, `ng update`, `ng build`, `ng test` — runs in a shell that has sourced `~/.nvm/nvm.sh` and run `nvm use 18.20.8`. Janus's own commands (`pnpm test`, `janus agent run`) keep running on the default Node 24.5.0. The spike root `~/janus-spike/` is deliberately **not** a git repository, because probe R2 needs a non-repo directory; the app inside it (`~/janus-spike/ng15-app`) is one, because `ng new` creates it.

**2. The probe vehicle is `tests/integration/codex-smoke.test.ts`, extended — not a new mechanism.** It already has the `describe.skipIf(!ENABLED)` gate, the `JANUS_REAL_CODEX=1` opt-in, the ten-minute per-test timeout, and the `workspacePaths(tempDir(...))` + `buildAgentTask` + `createCodexAgentRunner` shape that makes a probe exercise the *real* T05 code path rather than a hand-rolled `codex exec`. Each probe is one `it(...)`, each writes one record through `recordProbe`, and each asserts only what the plan claims to know. Probes that are expected to fail today are written as `it(...)` with the failing expectation **present**, so the failure is recorded evidence rather than a skipped test.

**3. Probe records are JSONL, written outside the repository.** `tests/helpers/codex-probe.ts` appends one JSON object per probe to the file named by `JANUS_SPIKE_LOG`. It is an env var with no default that points inside the repo: if it is unset, the recorder writes to `<os.tmpdir()>/janus-spike-<pid>.jsonl` and prints the path, so a stray `pnpm test:integration` never dirties the working tree. The runbook in `docs/spikes/prompt-spike.md` sets it explicitly to `~/janus-spike/probe-log.jsonl`. Numbers are transcribed from that log into the report by hand; the log itself is not committed, because it carries absolute home paths and Codex session ids.

**4. The read-only cwd ruling: option (a), narrowed.** The tension is settled by evidence gathered while writing this plan (see the table above): real `codex exec -s read-only -C <non-repo>` refuses with `Not inside a trusted directory and --skip-git-repo-check was not specified.`, and `--skip-git-repo-check` fixes it. Of the three options weighed in `src/agents/sandbox.ts`:

- **(a) exempt read-only roles from the §18.4 flag ban — chosen.** A `-s read-only` run has **zero** `--add-dir` writable roots; it cannot write anything anywhere, so the flag's protective purpose (keep a *write-capable* agent inside a known repository) does not apply to it. It is the only option that leaves §3.3's class table untouched, leaves the §31.29 reflog audit's repository set untouched, and adds no filesystem state.
- **(b) give read-only roles a repo cwd** — rejected. `checkpoint` and `review` are workspace-level roles spanning every repo; there is no single repo to pick, and picking one would make §3.3's "cwd: the workspace root" a lie for the two roles that most need the whole tree.
- **(c) `git init` the workspace root** — rejected, though it was verified to work. It nests `.janus/` (itself a git checkout) and every `repos/<name>` inside a fourth repository, adds a reflog the §31.29 audit does not enumerate, and gives a `danger-full-access` agent an index at the workspace root to dirty. `createWorkspaceDirs`, `ensureEmptyOrMissing` and `removeWorkspaceArtifacts` would all have to learn about it.
- **(d) `-c projects."<dir>".trust_level="trusted"`** — verified not to work on 0.146.0; recorded so nobody tries it again.

Task 3 amends §18.4's sentence to: *"`resume` is never used. `--skip-git-repo-check` is passed only for the `read-only` sandbox class, whose cwd is the workspace root (§3.3) and whose writable-root list is empty; it is never passed for `workspace-write` or `danger-full-access`."* **This is a spec amendment and needs the controller's ratification** — it is flagged in the handback.

**5. `AgentTokenUsage` does not grow a `cache_write` field.** The real stream carries `cache_write_input_tokens`, which §18.6's comparison table does not ask for ("tokens (input, cached, output, reasoning)"). Adding it would widen the telemetry event union, the evidence YAML and T21's comparison table for a billing detail nobody consumes. It is recorded in the spike report and nowhere else. What *is* fixed is `total`: the real stream has no `total_tokens`, so today every real run records `total: 0`. Task 2 derives it as `input_tokens + output_tokens` when the key is absent, and keeps reading `total_tokens` when it is present (some Codex versions, and the existing fixtures, do emit it).

**6. §12 scope defaults are carried by the planning prompt, not by new config keys.** §28's `config.yaml` has no `plan` section and this plan invents none. The measured `ng update` footprint from probe A2 lands in two places: the `planning` role's prompt template in `src/agents/prompts/templates.ts` (so the planning agent proposes an `allowed_scope` wide enough for CLI migrations), and `docs/spikes/prompt-spike.md` (so T11's `plan.yaml` validator has the numbers when it is written). Editing that template bumps `planning`'s version and its fingerprint; Task 7 does both.

**7. `janus doctor` does not lock the workspace.** It calls `findWorkspaceRoot` + `loadConfig` + `loadGoal` directly instead of `openWorkspace`. A diagnostic must work while a `janus run` holds `janus.lock` and while the workspace is mid-reconcile; going through `openWorkspace` would make doctor exit `13 (Locked)` exactly when the operator most needs it. Doctor therefore never reads `state.yaml` and never verifies the state branch — that is `janus status`'s job.

**8. Doctor runs outside a workspace too.** §35 has the operator skill "run `janus init` and `janus doctor`", and the §29.6 first-contact runbook runs doctor on a fresh machine. When `findWorkspaceRoot` throws, doctor still runs the four environment checks that need no config (`codex.binary`, `codex.login`, `git.identity`, `sandbox.user_namespaces`) plus the two scratch probes, and reports every config-dependent check as `skip` with the remediation "run `janus doctor` from inside a janus workspace, or run `janus init` first".

**9. Four statuses, and how they map to an exit code.** `pass | warn | fail | skip`. Exit code is `ExitCode.UnexpectedError` (1) when any check is `fail`, `ExitCode.Ok` (0) otherwise — `warn` and `skip` do not fail the command. §31.33 ("doctor detects a non-working sandbox, a read-only pnpm store, and a missing `janus/*` branch exclusion") is satisfied by `fail`, `fail` and `warn` respectively: the branch-spec item is a `warn` because `tasks.md` T07 calls it a "`janus/*` branch-spec **warning**" and because Janus cannot see TeamCity's VCS root from here to know it is actually missing.

**10. Every check carries a remediation string, and `pass` is the only status allowed to omit it.** `DoctorFinding.remediation: string | null`, and `runDoctor` throws `DoctorContractError` if a non-`pass` finding has `null`. A unit test walks the whole registry and asserts it for every check on its worst-case path, so a fourteenth check cannot land without one.

**11. One process seam for everything doctor shells out to.** `src/doctor/exec.ts` exports `CommandRunner`, a `(request: CommandRequest) => Promise<CommandResult>` function type with the same shape T05's `CodexSpawn` has (`bin`, `args`, `cwd`, `env`, `stdin`, `timeoutMs` in; `exitCode`, `stdout`, `stderr`, `spawnFailed`, `timedOut`, `durationMs` out), plus `runCommand`, the production implementation, which is a thin wrapper over `spawnCodex` from `src/agents/codex/spawn.ts` — the same battle-tested spawn with the same timeout-kill path, renaming `jsonl` to `stdout`. No second child-process implementation enters the codebase.

**12. The three §18.4 probes: two go through Codex, one does not.** §18.4 lists "a read-only `codex exec` echo, a `workspace-write` install in a scratch project, and an `ng update --allow-dirty` dry run when Angular is present". The first two name a Codex sandbox and so run through `buildAgentTask` + `buildCodexArgs` + `runCommand`, which is what makes them *real* probes of the adapter's invocation. The third names no sandbox, and spending a model turn to learn whether the Angular CLI accepts a flag would cost ~15k tokens and a minute for a deterministic answer — so it runs `ng update --allow-dirty --dry-run` directly, in the first workspace repo that has `@angular/cli` in its `package.json`, and reports `skip` when no repo has one. **This is an interpretation of §18.4, not a quotation**, and it is flagged in the handback.

**13. Doctor's scratch directory.** The two Codex probes need a throwaway cwd. Doctor creates it with `mkdtempSync(join(tmpdir(), 'janus-doctor-'))` and removes it in a `finally`, exactly as `createCodexAgentRunner` does for its schema/last-message scratch. The read-only probe's cwd is that directory **without** `git init` — which is precisely the §3.3 read-only shape, so the probe genuinely exercises Task 3's ruling. The workspace-write probe's cwd is a `repos/scratch` subdirectory with a two-dependency `package.json` and `npm_config_store_dir` pointed at a `.pnpm-store` subdirectory, which is precisely the §18.4 `agents.pnpm_store: workspace` shape.

**14. Model probes use the configured profile, one token each.** §18.6: "`janus doctor` verifies each configured model is accepted by Codex with a one-token probe." The check collects the distinct `(model, effort)` pairs reachable from `config.model_profiles[config.workflow_models.profile]` — every role entry, the `*` entry, and every ladder entry — and runs one `codex exec -s read-only --skip-git-repo-check --ephemeral -m <model> -c model_reasoning_effort=<effort> -c model_max_output_tokens=1` per distinct **model** (not per pair; effort does not change whether a model id is accepted). A model that is rejected fails with Codex's own stderr as the detail. Note the floor: even a one-token probe costs ~14.5k input tokens, so this check is the most expensive thing doctor does and its detail line says so.

**15. No new CLI flags beyond `--json`.** `tasks.md` T07 specifies exactly one. Doctor's real probes are the point of the command, not an opt-in; an operator who wants a cheap check runs the checks they care about by reading the `--json` output of the last full run. Adding `--skip-probes` would be the first thing to add if the cost proves annoying in T22's dogfood run, and the registry in `src/doctor/index.ts` is shaped so that adding it later is a filter over `ALL_CHECKS`, not a rewrite.

---

## File Structure

```text
# T06 — the spike
docs/spikes/prompt-spike.md            create: the §29.4 report — runbook, probe results, findings, resulting changes
tests/helpers/codex-probe.ts           create: ProbeRecord, recordProbe, probeLogPath — JSONL recorder for the spike lane
tests/integration/codex-smoke.test.ts  modify: six new probes (R1 R2 A1 A2 S1 S2) alongside T05's two smoke cases
tests/fixtures/codex/real-read-only.jsonl        create: a real captured stream, redacted
tests/fixtures/codex/real-workspace-write.jsonl  create: a real captured stream with tool calls, redacted
src/agents/codex/jsonl.ts              modify: derive `total` when `total_tokens` is absent; document the real shape
tests/agents/codex-jsonl.test.ts       modify: assert against the captured fixtures
tests/fixtures/codex/implementation-success.jsonl  modify: `item_type` -> `type` to match the real stream
tests/fixtures/codex/usage-nested.jsonl            modify: same
src/agents/sandbox.ts                  modify: SandboxPlan.skipGitRepoCheck; the read-only branch sets it
src/agents/types.ts                    modify: AgentTask.skipGitRepoCheck
src/agents/task.ts                     modify: copy the plan's flag onto the task
src/agents/codex/adapter.ts            modify: buildCodexArgs emits --skip-git-repo-check when the task asks for it
src/agents/evidence.ts                 modify: AgentEvidence.skip_git_repo_check
tests/helpers/agent-fixtures.ts        modify: agentTaskFixture default skipGitRepoCheck: false
src/agents/prompts/templates.ts        modify: planning + implementation + debug wording, versions, fingerprints
src/agents/prompts/shared.ts           modify: ANGULAR_GUIDANCE gains the measured migration footprint
angular-ai-development-workflow-v2.md  modify: §18.4 flag sentence, §3.3 read-only note, §12 scope note
tasks.md                               modify: status table rows for T06 and T07

# T07 — janus doctor
src/doctor/types.ts                    DoctorStatus, DoctorFinding, DoctorObservation, DoctorCheck, DoctorCheckContext, DoctorContractError, skipped
src/doctor/exec.ts                     CommandRequest, CommandResult, CommandRunner, runCommand
src/doctor/http.ts                     HttpProbeRequest, HttpProbeResult, HttpProbe, fetchProbe
src/doctor/fs.ts                       DoctorFs, nodeFs
src/doctor/report.ts                   runDoctor, DoctorReport, doctorJson, renderDoctorHuman, doctorExitCode
src/doctor/checks/codex.ts             codexBinaryCheck, codexLoginCheck, codexModelsCheck, distinctModels
src/doctor/checks/sandbox.ts           userNamespacesCheck, codexReadOnlyProbe, codexWorkspaceWriteProbe, ngUpdateProbe
src/doctor/checks/repo.ts              gitIdentityCheck, tokensCheck, branchSpecCheck
src/doctor/checks/pnpm.ts              pnpmStoreCheck
src/doctor/checks/providers.ts         ciReachabilityCheck, scmReachabilityCheck
src/doctor/index.ts                    ALL_CHECKS, buildDoctorContext
src/cli/commands/doctor.ts             modify: the real command, human and --json output
tests/helpers/doctor-fixtures.ts       doctorContext, stubRunner, stubHttp, stubFs, commandResult, FROZEN_NOW
tests/doctor/report.test.ts            tests/doctor/codex.test.ts       tests/doctor/sandbox.test.ts
tests/doctor/repo.test.ts              tests/doctor/pnpm.test.ts        tests/doctor/providers.test.ts
tests/doctor/registry.test.ts          every check has an id, a title and a remediation on every non-pass path
tests/cli/doctor.test.ts               the command end to end, human and --json, inside and outside a workspace
tests/cli/commands.test.ts             modify: `doctor` leaves the stubbed list
tests/integration/doctor.test.ts       harness scenario: doctor against a real fake-provider workspace
README.md                              modify: a `janus doctor` section and the JANUS_SPIKE_LOG note
```

---

# Part A — T06: the manual prompt spike

Time-boxed to one week (`tasks.md` T06). The order below is deliberate: the rig first, then the two probes that answer questions the *code* is currently wrong about (JSONL shape, read-only cwd), then the three first-contact probes, then the fold-in. A doctor check written before its probe would encode an assumption; Part B says for each check whether it waited on a probe or not.

## Task 1: The spike rig — Node 18 via nvm, the Angular 15 app, and the probe recorder

**Files:**
- Create: `tests/helpers/codex-probe.ts`, `tests/helpers/codex-probe.test.ts`, `docs/spikes/prompt-spike.md`
- Outside the repository (not committed): `~/janus-spike/ng15-app`

**Interfaces:**
- Consumes: `tempDir` from `tests/helpers/git-fixtures.ts`.
- Produces:
  - `interface ProbeRecord { probe: string; question: string; outcome: 'pass' | 'fail' | 'observed'; detail: string; data: Record<string, unknown>; recorded_at: string }`
  - `probeLogPath(): string` — `process.env.JANUS_SPIKE_LOG` when set, else `<tmpdir>/janus-spike-<pid>.jsonl`
  - `recordProbe(record: Omit<ProbeRecord, 'recorded_at'>): string` — appends one JSON line, returns the log path
  - `~/janus-spike/ng15-app`, an Angular 15 app that builds
  - `docs/spikes/prompt-spike.md` with its Purpose, Environment and Runbook sections complete

**Why:** Every later probe writes a record; without the recorder, findings survive only as terminal scrollback, which is exactly the "try it and see" failure mode `tasks.md` T06 is meant to avoid. The Angular app is needed by probes A1 and A2 and cannot be borrowed: the only Angular project on this machine is a real Angular 19 project that is off limits.

- [ ] **Step 1: Verify the toolchain before scaffolding anything**

Run, in one shell:

```bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 18.20.8
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
node --version
pnpm --version
codex --version
codex login status
```

Expected, exactly:

```text
Now using node v18.20.8 (npm v10.7.0)
v18.20.8
10.33.0
codex-cli 0.146.0
Logged in using ChatGPT
```

If `nvm use 18.20.8` says "version not installed", run `nvm install 18.20.8` first. If `codex login status` does not say `Logged in`, stop: every probe in Part A needs a working login, and authentication is handled outside Janus (§28).

- [ ] **Step 2: Scaffold the throwaway Angular 15 app**

In the **same shell** (Node 18 is still active):

```bash
mkdir -p ~/janus-spike
cd ~/janus-spike
npx --yes @angular/cli@15 new ng15-app --defaults --routing --style=scss --package-manager=pnpm
```

Expected: `ng new` prints `CREATE ng15-app/...` lines, then `Packages installed successfully.` and `Successfully initialized git.` The whole thing takes two to four minutes.

Confirm the versions and that `~/janus-spike` itself is **not** a git repository (probe R2 depends on that):

```bash
cd ~/janus-spike/ng15-app && npx ng version
git -C ~/janus-spike rev-parse --is-inside-work-tree 2>&1 | head -1
git -C ~/janus-spike/ng15-app rev-parse --is-inside-work-tree
```

Expected: `ng version` reports `Angular CLI: 15.2.x` and `Angular: 15.2.x`; the first `git` call prints `fatal: not a git repository (or any of the parent directories): .git`; the second prints `true`.

- [ ] **Step 3: Establish the app's green baseline and record what its test runner needs**

```bash
cd ~/janus-spike/ng15-app
npx ng build 2>&1 | tail -5
npx ng test --watch=false --browsers=ChromeHeadless 2>&1 | tail -15
```

Expected: `ng build` ends with `Build at: ... - Hash: ... - Time: ...ms` and exits 0.

`ng test` needs a Chrome binary. If it ends with `Cannot start ChromeHeadless` or `No binary for ChromeHeadless browser on your platform`, that is a **finding, not a blocker**: set `export CHROME_BIN=$(which google-chrome || which chromium || which chromium-browser)` and retry once. Whether it then passes or not, write the outcome down — Step 8 has a row for it, and `ng build` is the verification command every later probe uses, precisely so no probe depends on a browser.

- [ ] **Step 4: Write the failing recorder test**

Create `tests/helpers/codex-probe.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeLogPath, recordProbe } from './codex-probe.js';

const KEY = 'JANUS_SPIKE_LOG';
let previous: string | undefined;

beforeEach(() => {
  previous = process.env[KEY];
});

afterEach(() => {
  if (previous === undefined) delete process.env[KEY];
  else process.env[KEY] = previous;
});

describe('recordProbe', () => {
  it('appends one JSON line per probe to the configured log', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'janus-probe-')), 'probe-log.jsonl');
    process.env[KEY] = log;

    const returned = recordProbe({
      probe: 'R1',
      question: 'what does turn.completed.usage really look like?',
      outcome: 'observed',
      detail: 'no total_tokens key',
      data: { input_tokens: 14_468 },
    });
    recordProbe({ probe: 'R2', question: 'does read-only refuse outside a repo?', outcome: 'fail', detail: 'refused', data: {} });

    expect(returned).toBe(log);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(first['probe']).toBe('R1');
    expect(first['outcome']).toBe('observed');
    expect((first['data'] as Record<string, unknown>)['input_tokens']).toBe(14_468);
    expect(typeof first['recorded_at']).toBe('string');
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ probe: 'R2', outcome: 'fail' });
  });

  it('falls back to a temp file, never into the repository, when JANUS_SPIKE_LOG is unset', () => {
    delete process.env[KEY];
    const path = probeLogPath();
    expect(path.startsWith(tmpdir())).toBe(true);
    expect(path).toContain(`janus-spike-${String(process.pid)}`);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/helpers/codex-probe.test.ts`
Expected: FAIL — `Failed to resolve import "./codex-probe.js"`.

- [ ] **Step 6: Write the recorder**

Create `tests/helpers/codex-probe.ts`:

```ts
import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * One line of the T06 spike log (spec §29 item 4). The log is JSONL so a probe's numbers survive a crashed run and
 * can be transcribed into `docs/spikes/prompt-spike.md` without re-reading terminal scrollback.
 *
 * `data` holds only numbers, booleans and short strings the probe measured. It must never hold a token, a Codex
 * session id, or raw stderr that has not been read by a human first (§32 rule 12).
 */
export interface ProbeRecord {
  /** Short probe id, matching the table in `docs/spikes/prompt-spike.md` — `R1`, `R2`, `A1`, `A2`, `S1`, `S2`. */
  probe: string;
  /** The open question this probe answers, in one line. */
  question: string;
  /** `pass`/`fail` when the probe asserted something; `observed` when it only measured. */
  outcome: 'pass' | 'fail' | 'observed';
  detail: string;
  data: Record<string, unknown>;
  recorded_at: string;
}

/**
 * Where probe records go. Deliberately never inside the repository: the log carries absolute home paths and Codex
 * session ids, and a stray `pnpm test:integration` must not dirty the working tree.
 */
export function probeLogPath(): string {
  const configured = process.env['JANUS_SPIKE_LOG'];
  if (configured !== undefined && configured.trim() !== '') return configured;
  return join(tmpdir(), `janus-spike-${String(process.pid)}.jsonl`);
}

export function recordProbe(record: Omit<ProbeRecord, 'recorded_at'>): string {
  const path = probeLogPath();
  mkdirSync(dirname(path), { recursive: true });
  const line: ProbeRecord = { ...record, recorded_at: new Date().toISOString() };
  appendFileSync(path, `${JSON.stringify(line)}\n`);
  return path;
}
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/helpers/codex-probe.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 8: Write the spike report's fixed sections**

Create `docs/spikes/prompt-spike.md`. Fill the two `ng test` cells from what Step 3 actually printed:

```markdown
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
| `ng test` baseline | *(record what Step 3 printed: green, or the exact Chrome error and whether `CHROME_BIN` fixed it)* |
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
```

- [ ] **Step 9: Run the whole unit suite**

Run: `pnpm test:unit`
Expected: PASS, 729 tests (727 + the 2 new ones).

- [ ] **Step 10: Commit**

```bash
git add tests/helpers/codex-probe.ts tests/helpers/codex-probe.test.ts docs/spikes/prompt-spike.md
git commit -m "test(spike): add the T06 probe recorder and the spike report skeleton" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 2: Probe R1 — capture the real JSONL stream, then correct `parseCodexUsage` and the fixtures

**Files:**
- Modify: `tests/helpers/codex-probe.ts` (add `captureFixture`), `tests/integration/codex-smoke.test.ts` (probe R1), `src/agents/codex/jsonl.ts`, `tests/agents/codex-jsonl.test.ts`, `tests/fixtures/codex/implementation-success.jsonl`, `tests/fixtures/codex/usage-nested.jsonl`, `docs/spikes/prompt-spike.md`
- Create: `tests/fixtures/codex/real-workspace-write.jsonl`

**Interfaces:**
- Consumes: `createCodexAgentRunner`, `buildAgentTask`, `promptFixture`, `spawnCodex`, `CodexSpawn`, `workspacePaths`, `tempDir`, `recordProbe`.
- Produces:
  - `captureFixture(name: string, jsonl: string, redact: Record<string, string>): string | null` in `tests/helpers/codex-probe.ts` — writes `tests/fixtures/codex/<name>` when `JANUS_CAPTURE_FIXTURES=1`, returns the path; returns `null` otherwise
  - `parseCodexUsage` unchanged in signature, corrected in behaviour: `total` falls back to `input + output` when `turn.completed.usage.total_tokens` is absent
  - `tests/fixtures/codex/real-workspace-write.jsonl` — a real, redacted stream

**Why (open question 2):** `tests/fixtures/codex/*.jsonl` were written from the *expected* stream and never captured from the binary. The real 0.146.0 `turn.completed.usage` has **no `total_tokens` key**, so `parseCodexUsage` records `total: 0` for every real run — silently, because nothing in the unit lane has ever seen a real stream. §18.6's comparison reports "tokens (input, cached, output, reasoning)" per model and role; a `total` that is always zero corrupts T21's cost table before it is written.

**This probe cannot wait for anything.** It runs a `workspace-write` task in a git repository, which works today — the read-only path (Task 3) is the broken one.

- [ ] **Step 1: Add the fixture-capture helper**

Append to `tests/helpers/codex-probe.ts`:

```ts
/** `tests/fixtures/codex/`, where a captured stream becomes a checked-in fixture. */
export const CODEX_FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'codex');

/**
 * Writes a captured Codex stream into `tests/fixtures/codex/<name>` — but only under `JANUS_CAPTURE_FIXTURES=1`,
 * so the ordinary probe lane never dirties the working tree.
 *
 * Every `from -> to` pair in `redact` is applied, then the home directory and the Codex thread id, which are the
 * two things a real stream always carries that must not reach the repository (§32 rule 12). The result is still
 * reviewed by a human in `git diff` before it is committed; this only removes what is mechanically removable.
 */
export function captureFixture(name: string, jsonl: string, redact: Record<string, string>): string | null {
  if (process.env['JANUS_CAPTURE_FIXTURES'] !== '1') return null;
  let text = jsonl;
  for (const [from, to] of Object.entries(redact)) text = text.split(from).join(to);
  text = text.split(homedir()).join('<home>');
  text = text.replace(/"thread_id":"[^"]*"/gu, '"thread_id":"01JANUS0000000000000000000"');
  const path = join(CODEX_FIXTURES_DIR, name);
  mkdirSync(CODEX_FIXTURES_DIR, { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
  return path;
}
```

and widen the file's imports to `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';` plus `import { homedir, tmpdir } from 'node:os';`.

- [ ] **Step 2: Write probe R1 in the real-Codex lane**

Add to `tests/integration/codex-smoke.test.ts`, inside the existing `describe.skipIf(!ENABLED)` block, and add these imports at the top of the file: `import { spawnCodex } from '../../src/agents/codex/spawn.js';`, `import type { CodexSpawn } from '../../src/agents/codex/spawn.js';`, `import { captureFixture, recordProbe } from '../helpers/codex-probe.js';`.

```ts
  /**
   * T06 probe R1 (open question 2): what does the real `--json` stream look like, and does `parseCodexUsage` read
   * it correctly? Wraps the real `spawnCodex` so the stream can be kept, without adding anything to production.
   */
  it(
    'probe R1: captures a real JSONL stream and reports its turn.completed.usage keys',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-r1-'));
      const repo = paths.repoDir('scratch');
      mkdirSync(repo, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify({ name: 'scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
      );
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', 'package.json']);
      await runGit(repo, ['commit', '-q', '-m', 'scratch']);

      let captured = '';
      const capturing: CodexSpawn = async (request) => {
        const result = await spawnCodex(request);
        if (request.args[0] === 'exec') captured = result.jsonl;
        return result;
      };

      const runner = createCodexAgentRunner({ paths, spawn: capturing });
      const task = buildAgentTask({
        runId: 'probe-r1',
        role: 'implementation',
        repo: 'scratch',
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        },
        guardrails: [],
        budget: '(probe R1)',
      });

      const outcome = await runner.run(task, promptFixture(task));
      expect(captured.length).toBeGreaterThan(0);

      const types: string[] = [];
      let usageKeys: string[] = [];
      let unparseable = 0;
      for (const line of captured.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          unparseable += 1;
          continue;
        }
        types.push(String(event['type']));
        if (event['type'] === 'turn.completed') {
          const usage = event['usage'];
          if (typeof usage === 'object' && usage !== null) usageKeys = Object.keys(usage as Record<string, unknown>);
        }
      }

      const fixture = captureFixture('real-workspace-write.jsonl', captured, { [paths.root]: '<workspace>' });
      recordProbe({
        probe: 'R1',
        question: 'What is the real shape of the codex --json stream and of turn.completed.usage?',
        outcome: 'observed',
        detail: `codex ${outcome.runnerVersion ?? 'unknown'}; ${String(types.length)} events, ${String(unparseable)} unparseable`,
        data: {
          event_types: [...new Set(types)].sort(),
          usage_keys: usageKeys,
          parsed_tokens: outcome.tokens,
          fixture_written: fixture,
        },
      });

      // What this plan was written against; a deviation is a finding, not a test bug — write it down before fixing it.
      expect(types).toContain('thread.started');
      expect(types).toContain('turn.completed');
      expect(usageKeys).toContain('input_tokens');
      expect(usageKeys).toContain('output_tokens');
      expect(outcome.tokens).not.toBeNull();
    },
    TEN_MINUTES,
  );
```

- [ ] **Step 3: Run probe R1 and capture the fixture**

Run:

```bash
cd /path/to/janus
JANUS_REAL_CODEX=1 JANUS_CAPTURE_FIXTURES=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe R1'
```

Expected: PASS. `tests/fixtures/codex/real-workspace-write.jsonl` now exists.

Then **read it** before going further:

```bash
git diff --stat tests/fixtures/codex/real-workspace-write.jsonl
grep -c . tests/fixtures/codex/real-workspace-write.jsonl
grep -F 'turn.completed' tests/fixtures/codex/real-workspace-write.jsonl
grep -oE '"(home|Users)/[^"]*"' tests/fixtures/codex/real-workspace-write.jsonl | head
```

Expected: the `turn.completed` line shows `usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` and **no** `total_tokens`; the last command prints nothing (no home path survived). If a home path did survive, add it to the `redact` map in Step 2 and re-run. If the file is larger than ~200 KB, trim it by hand to `thread.started`, `turn.started`, the first two `item.completed` lines and `turn.completed` — the parser only reads `turn.completed`, and a multi-megabyte fixture is not reviewable.

- [ ] **Step 4: Write the failing unit tests against the captured fixture**

In `tests/agents/codex-jsonl.test.ts`, replace the last test (`'defaults a missing counter to zero and a missing reasoning count to null'`) and add two new ones:

```ts
  it('derives total from input + output when the real stream omits total_tokens (T06 probe R1)', () => {
    const line =
      '{"type":"turn.completed","usage":{"input_tokens":14468,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}}';
    expect(parseCodexUsage(line)).toEqual({
      input: 14_468,
      cached_input: 0,
      output: 19,
      reasoning: 0,
      total: 14_487,
    });
  });

  it('still prefers an explicit total_tokens when the stream carries one', () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":3,"total_tokens":99}}';
    expect(parseCodexUsage(line)?.total).toBe(99);
  });

  it('defaults a missing counter to zero and a missing reasoning count to null', () => {
    expect(parseCodexUsage('{"type":"turn.completed","usage":{"input_tokens":5}}')).toEqual({
      input: 5,
      cached_input: 0,
      output: 0,
      reasoning: null,
      total: 5,
    });
  });

  it('parses the captured real stream and reports a non-zero total (T06 probe R1)', () => {
    const usage = parseCodexUsage(fixture('real-workspace-write.jsonl'));
    expect(usage).not.toBeNull();
    expect(usage?.input).toBeGreaterThan(0);
    expect(usage?.total).toBe((usage?.input ?? 0) + (usage?.output ?? 0));
  });
```

- [ ] **Step 5: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit tests/agents/codex-jsonl.test.ts`
Expected: FAIL — three failures, each reporting `total: 0` where a positive number was expected.

- [ ] **Step 6: Correct `parseCodexUsage`**

In `src/agents/codex/jsonl.ts`, add this helper below `reasoningOf`:

```ts
/**
 * T06 probe R1: codex-cli 0.146.0 emits `turn.completed.usage` **without** a `total_tokens` key —
 * `{"input_tokens":14468,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0}`.
 * Reading a missing key as 0 made every real run record `total: 0`, which would have silently zeroed §18.6's
 * cost comparison. An explicit `total_tokens` still wins when a version emits one.
 *
 * `cached_input_tokens` is a subset of `input_tokens` and `reasoning_output_tokens` a subset of `output_tokens`,
 * so the sum is `input + output` and not a four-way total. `cache_write_input_tokens` is deliberately not
 * modelled: §18.6's comparison names input, cached, output and reasoning, and nothing consumes the fifth.
 */
function totalOf(fields: Record<string, unknown>, input: number, output: number): number {
  const explicit = fields['total_tokens'];
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit;
  return input + output;
}
```

and replace the assignment inside the loop:

```ts
    const input = count(fields['input_tokens']);
    const output = count(fields['output_tokens']);
    usage = {
      input,
      cached_input: count(fields['cached_input_tokens']),
      output,
      reasoning: reasoningOf(fields),
      total: totalOf(fields, input, output),
    };
```

Also update the doc comment on `parseCodexUsage`: replace the last sentence ("Two reasoning-token spellings are accepted because Codex has emitted both; T06's manual spike (§29 item 4) refreshes these fixtures against the real binary.") with:

```ts
 * Two reasoning-token spellings are accepted because Codex has emitted both. The fixtures were refreshed against
 * codex-cli 0.146.0 by T06 probe R1; `tests/fixtures/codex/real-workspace-write.jsonl` is a captured stream.
```

- [ ] **Step 7: Run them to verify they pass**

Run: `pnpm exec vitest run --project unit tests/agents/codex-jsonl.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 8: Correct the hand-written fixtures' item shape**

The real stream spells an item's kind `item.type`, not `item.item_type`, and the hand-written fixtures got it wrong. Nothing parses it today, but a fixture that misdescribes the binary is a trap for T09's digest work. In `tests/fixtures/codex/implementation-success.jsonl` and `tests/fixtures/codex/usage-nested.jsonl`, replace every `"item_type":` with `"type":`:

```bash
sed -i 's/"item_type":/"type":/g' tests/fixtures/codex/implementation-success.jsonl tests/fixtures/codex/usage-nested.jsonl
grep -c '"item_type"' tests/fixtures/codex/implementation-success.jsonl tests/fixtures/codex/usage-nested.jsonl || true
```

Expected: the `grep -c` prints `0` for both files. `tests/fixtures/codex/timeout-partial.jsonl` is left alone: it is a stream cut mid-line on purpose, and its truncation point is inside that very token.

- [ ] **Step 9: Run the adapter and jsonl suites together**

Run: `pnpm exec vitest run --project unit tests/agents`
Expected: PASS. If `tests/agents/codex-adapter.test.ts` asserts on `item_type` anywhere, update that assertion to `type` — it is the same rename.

- [ ] **Step 10: Append probe R1's section to the spike report**

Insert under `## Probe results` in `docs/spikes/prompt-spike.md`, filling the numbers from the probe log:

```markdown
### R1 — the real Codex JSONL event shape (open question 2)

Ran a `workspace-write` implementation task in a scratch repo through `createCodexAgentRunner` with the real
`spawnCodex` wrapped so the stream could be kept. Captured to `tests/fixtures/codex/real-workspace-write.jsonl`.

| Observation | Result |
|---|---|
| Event types seen | *(from `data.event_types`)* |
| Unparseable lines | *(from the probe detail)* |
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
```

- [ ] **Step 11: Run the whole suite and commit**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0.

```bash
git add src/agents/codex/jsonl.ts tests/agents/codex-jsonl.test.ts tests/helpers/codex-probe.ts \
  tests/integration/codex-smoke.test.ts tests/fixtures/codex docs/spikes/prompt-spike.md
git commit -m "fix(agents): derive codex token totals from the real turn.completed.usage shape" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 3: Probe R2 — settle the read-only cwd tension and amend the spec

**Files:**
- Modify: `tests/integration/codex-smoke.test.ts` (probe R2), `src/agents/sandbox.ts`, `src/agents/types.ts`, `src/agents/task.ts`, `src/agents/codex/adapter.ts`, `src/agents/evidence.ts`, `tests/helpers/agent-fixtures.ts`, `tests/agents/sandbox.test.ts`, `tests/agents/task.test.ts`, `tests/agents/codex-adapter.test.ts`, `tests/agents/evidence.test.ts`, `angular-ai-development-workflow-v2.md` (§3.3 and §18.4), `docs/spikes/prompt-spike.md`

**Interfaces:**
- Consumes: `spawnCodex` (`src/agents/codex/spawn.ts`), `planSandbox`, `buildAgentTask`, `buildCodexArgs`, `buildAgentEvidence`, `recordProbe`.
- Produces:
  - `SandboxPlan.skipGitRepoCheck: boolean` — `true` for the read-only class only
  - `AgentTask.skipGitRepoCheck: boolean` — copied from the plan by `buildAgentTask`
  - `buildCodexArgs` emits `--skip-git-repo-check` after the network flag and before the first `--add-dir`, iff `task.skipGitRepoCheck`
  - `AgentEvidence.skip_git_repo_check: boolean`
  - amended §18.4 and §3.3 text in `angular-ai-development-workflow-v2.md`

**Why (open question 1):** `src/agents/sandbox.ts:62-74` implements §3.3 and §18.4 literally and marks the tension in a comment: read-only roles get the workspace root as cwd, that root is never `git init`-ed by `src/workspace/layout.ts`, and §18.4 forbids the one flag that lets `codex exec` run outside a work tree. T05's read-only smoke test (`tests/integration/codex-smoke.test.ts`, "answers a read-only task with a schema-valid result") is therefore **expected to fail today**. That failure is the finding.

**The evidence this plan was written with** (verified on this machine, codex-cli 0.146.0) — probe R2 re-confirms it rather than discovering it:

| Variant | Result |
|---|---|
| `codex exec -C <non-repo> -s read-only --ephemeral -` | exit `1`, stderr `Not inside a trusted directory and --skip-git-repo-check was not specified.`, **no model call** |
| the same plus `--skip-git-repo-check` | exit `0` |
| the same in a freshly `git init`-ed empty directory | exit `0` |
| the same plus `-c projects."<dir>".trust_level="trusted"` | exit `1`, identical refusal |

**The ruling is Decision 4: option (a), narrowed to the read-only class.** Options (b) and (c) and the trust-level workaround are rejected there, with reasons. **The spec amendment in Step 7 needs the controller's ratification** — the executor makes the edit and the handback flags it.

- [ ] **Step 1: Write probe R2**

Add to `tests/integration/codex-smoke.test.ts`, inside the `describe.skipIf(!ENABLED)` block:

```ts
  /**
   * T06 probe R2 (open question 1): does real Codex refuse a read-only run outside a git work tree, and which of
   * the three weighed options fixes it? Raw `spawnCodex` on purpose: this probes the binary, not the adapter, and
   * a refusal happens before any model call so all four variants together cost at most two cheap turns.
   */
  it(
    'probe R2: reports whether codex refuses a read-only run outside a git repository',
    async () => {
      const plain = tempDir('janus-probe-r2-plain-');
      const initialized = tempDir('janus-probe-r2-git-');
      mkdirSync(plain, { recursive: true });
      mkdirSync(initialized, { recursive: true });
      await runGit(initialized, ['init', '-q', '-b', 'main']);

      const readOnly = async (cwd: string, extra: string[]): Promise<{ exitCode: number | null; stderr: string }> => {
        const result = await spawnCodex({
          bin: 'codex',
          args: ['exec', '-C', cwd, '-s', 'read-only', ...extra, '--ephemeral', '-'],
          cwd,
          env: { ...process.env } as Record<string, string>,
          stdin: 'Reply with the single word pong and nothing else.',
          timeoutMs: 120_000,
        });
        return { exitCode: result.exitCode, stderr: result.stderr.trim().split('\n')[0] ?? '' };
      };

      const bare = await readOnly(plain, []);
      const withFlag = await readOnly(plain, ['--skip-git-repo-check']);
      const inRepo = await readOnly(initialized, []);
      const trusted = await readOnly(plain, ['-c', `projects."${plain}".trust_level="trusted"`]);

      recordProbe({
        probe: 'R2',
        question: 'Does codex exec -s read-only refuse outside a git work tree, and what fixes it?',
        outcome: bare.exitCode === 0 ? 'pass' : 'fail',
        detail: `bare exit ${String(bare.exitCode)}: ${bare.stderr}`,
        data: {
          bare_exit: bare.exitCode,
          bare_stderr_first_line: bare.stderr,
          with_skip_flag_exit: withFlag.exitCode,
          in_git_repo_exit: inRepo.exitCode,
          trust_level_override_exit: trusted.exitCode,
        },
      });

      // The state this plan was written against. If any of these now differs, the §18.4 ruling must be revisited
      // before Step 5 — say so in the report and stop.
      expect(bare.exitCode).not.toBe(0);
      expect(bare.stderr).toContain('--skip-git-repo-check');
      expect(withFlag.exitCode).toBe(0);
      expect(inRepo.exitCode).toBe(0);
      expect(trusted.exitCode).not.toBe(0);
    },
    TEN_MINUTES,
  );
```

- [ ] **Step 2: Run probe R2 and confirm the tension is real**

Run:

```bash
JANUS_REAL_CODEX=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe R2'
```

Expected: PASS — which, read correctly, means "Codex does refuse, the flag fixes it, a git repo fixes it, and the trust override does not". If it fails, the binary behaves differently from what this plan assumes: record the actual four exit codes in `docs/spikes/prompt-spike.md`, stop, and hand back — the ruling in Steps 5 to 7 is only valid for the table above.

Also confirm T05's read-only smoke case is red today:

```bash
JANUS_REAL_CODEX=1 pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'answers a read-only task'
```

Expected: FAIL, with the failure message quoting `Not inside a trusted directory`. This is the bug Steps 4 to 6 fix.

- [ ] **Step 3: Write the failing unit tests**

Append to `tests/agents/sandbox.test.ts`, inside `describe('planSandbox', ...)`:

```ts
  it('asks for --skip-git-repo-check for the read-only class only (§18.4 as amended by T06 probe R2)', () => {
    const p = paths();
    const common = { runId: 'run-0009', paths: p, config: config(), globalPnpmStore: null };
    expect(planSandbox({ ...common, role: 'review', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'checkpoint', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'triage', repo: null }).skipGitRepoCheck).toBe(true);
    expect(planSandbox({ ...common, role: 'discovery', repo: null }).skipGitRepoCheck).toBe(false);
    expect(planSandbox({ ...common, role: 'implementation', repo: 'ui-kit' }).skipGitRepoCheck).toBe(false);
  });

  it('keeps the flag for a read-only role even when allow_unsandboxed turns it into danger-full-access', () => {
    const p = paths();
    const plan = planSandbox({
      role: 'review',
      runId: 'run-0010',
      repo: null,
      paths: p,
      config: config({ agents: { allow_unsandboxed: true } }),
      globalPnpmStore: null,
    });
    expect(plan.sandbox).toBe('danger-full-access');
    expect(plan.cwd).toBe(p.root);
    // The cwd is unchanged, so the git-work-tree refusal is unchanged; the flag is about the cwd, not the sandbox.
    expect(plan.skipGitRepoCheck).toBe(true);
  });
```

Append to `tests/agents/codex-adapter.test.ts`, inside `describe('buildCodexArgs', ...)`:

```ts
  it('passes --skip-git-repo-check for a read-only task and never for a write-capable one (§18.4, T06 probe R2)', () => {
    const readOnly = task({
      role: 'review',
      repo: null,
      sandboxClass: 'read-only',
      sandbox: 'read-only',
      network: false,
      writableRoots: [],
      skipGitRepoCheck: true,
    });
    const args = buildCodexArgs(readOnly, { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last.json' });
    expect(args.slice(0, 6)).toEqual(['exec', '-C', readOnly.cwd, '-s', 'read-only', '--skip-git-repo-check']);
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('resume');

    const codeWriting = buildCodexArgs(task(), { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last.json' });
    expect(codeWriting).not.toContain('--skip-git-repo-check');
    expect(codeWriting).not.toContain('resume');
  });
```

Append to `tests/agents/task.test.ts`, inside its top-level `describe`:

```ts
  it('copies the sandbox plan’s skipGitRepoCheck onto the task', () => {
    const p = workspacePaths(tempDir('janus-task-skipflag-'));
    const cfg = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    const common = { attempt: 1, paths: p, config: cfg, profile: 'default', globalPnpmStore: null, guardrails: [], budget: 'n/a' };
    const read = buildAgentTask({ ...common, runId: 'run-a', role: 'review', repo: null, context: contextPackageInputFixture() });
    const write = buildAgentTask({ ...common, runId: 'run-b', role: 'implementation', repo: 'ui-kit', context: contextPackageInputFixture() });
    expect(read.skipGitRepoCheck).toBe(true);
    expect(write.skipGitRepoCheck).toBe(false);
  });
```

If `tests/agents/task.test.ts` does not already import `contextPackageInputFixture`, `configSchema`, `workspacePaths` or `tempDir`, add them; the file's existing tests build tasks the same way, so reuse whatever local helper it already has rather than adding a second one.

Append to `tests/agents/evidence.test.ts`, inside its top-level `describe`:

```ts
  it('records whether the run was allowed outside a git work tree (§18.4, T06 probe R2)', () => {
    const evidence = buildAgentEvidence({
      task: agentTaskFixture({ role: 'review', repo: null, sandboxClass: 'read-only', sandbox: 'read-only', skipGitRepoCheck: true, writableRoots: [] }),
      paths: workspacePaths(tempDir('janus-evidence-skipflag-')),
      runner: 'codex',
      startedAt: '2026-09-20T12:00:00.000Z',
      finishedAt: '2026-09-20T12:00:05.000Z',
      outcome: stubOutcome(agentTaskFixture({ role: 'review' })),
      prompt: promptFixture(agentTaskFixture({ role: 'review' })),
    });
    expect(evidence.skip_git_repo_check).toBe(true);
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit tests/agents`
Expected: FAIL — `skipGitRepoCheck` does not exist on `SandboxPlan`, `AgentTask` or the fixture, and `skip_git_repo_check` does not exist on `AgentEvidence`. TypeScript reports each one.

- [ ] **Step 5: Implement the ruling**

In `src/agents/sandbox.ts`, add the field to `SandboxPlan` after `network`:

```ts
  /**
   * Spec §18.4 as amended by T06 probe R2. Real `codex exec` refuses to start outside a git work tree
   * (`Not inside a trusted directory and --skip-git-repo-check was not specified.`), and §3.3 puts the read-only
   * class's cwd at the workspace root, which `src/workspace/layout.ts` deliberately does not `git init`. A
   * read-only run has an **empty** writable-root list, so it cannot write anything wherever it starts, and the
   * flag's protective purpose — keep a write-capable agent inside a known repository — does not apply to it.
   * True for the read-only class and for nothing else; the code-writing class starts in a repo and the
   * report-writing class starts inside `.janus/`, which is itself a git checkout.
   */
  skipGitRepoCheck: boolean;
```

Replace the read-only branch's comment and return value with:

```ts
  if (cls === 'read-only') {
    // §3.3 gives this class the workspace root as its cwd, and that root is not a git repository. T06 probe R2
    // confirmed that real codex refuses such a run and that `--skip-git-repo-check` is the only one of the four
    // weighed options that works without changing §3.3's table (option b) or nesting a fourth git repository
    // around `.janus/` and every `repos/<name>` (option c); a `projects.<dir>.trust_level` override does not work
    // on 0.146.0. §18.4 was amended to allow the flag for this class alone.
    return {
      sandbox: unsandboxed ? 'danger-full-access' : 'read-only',
      network: false,
      skipGitRepoCheck: true,
      cwd: input.paths.root,
      writableRoots: [],
      env: {},
    };
  }
```

Add `skipGitRepoCheck: false,` to the report-writing return and to all three code-writing returns (the `unsandboxed` early return, the `global` store return, and the final `workspace` store return).

In `src/agents/types.ts`, add to `AgentTask` after `network`:

```ts
  /** §18.4 as amended by T06 probe R2: `--skip-git-repo-check`, for the read-only class only. */
  skipGitRepoCheck: boolean;
```

In `src/agents/task.ts`, add `skipGitRepoCheck: plan.skipGitRepoCheck,` to the returned object, directly after `network: plan.network,`.

In `src/agents/codex/adapter.ts`, update `buildCodexArgs` and its doc comment. The flag goes after the network flag and before the first `--add-dir`, which keeps §18.4's documented order intact for every other argument:

```ts
export function buildCodexArgs(task: AgentTask, files: { schemaPath: string; lastMessagePath: string }): string[] {
  const args = ['exec', '-C', task.cwd, '-s', task.sandbox];
  if (task.sandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(task.network)}`);
  }
  if (task.skipGitRepoCheck) args.push('--skip-git-repo-check');
  for (const root of task.writableRoots) args.push('--add-dir', root);
  args.push('--output-schema', files.schemaPath, '--json', '-o', files.lastMessagePath, '--ephemeral');
  args.push('-m', task.model.model, '-c', `model_reasoning_effort=${task.model.effort}`);
  args.push('-');
  return args;
}
```

and replace the doc comment's last paragraph with:

```ts
 * `resume` is never passed. `--skip-git-repo-check` is passed only when `task.skipGitRepoCheck` is set, which
 * `planSandbox` does for the read-only class alone (§18.4 as amended by T06 probe R2). The network flag is passed
 * only for `workspace-write`, because it configures that sandbox; `read-only` and `danger-full-access` do not
 * take it.
```

In `src/agents/evidence.ts`, add to `AgentEvidence` after `network: boolean;`:

```ts
  /** §18.4: whether this run was allowed to start outside a git work tree. True for the read-only class only. */
  skip_git_repo_check: boolean;
```

and to `buildAgentEvidence`'s returned object, after `network: task.network,`:

```ts
    skip_git_repo_check: task.skipGitRepoCheck,
```

In `tests/helpers/agent-fixtures.ts`, add `skipGitRepoCheck: false,` to `agentTaskFixture`'s returned object, directly after `network: true,`.

- [ ] **Step 6: Run the unit suite**

Run: `pnpm exec vitest run --project unit && pnpm typecheck`
Expected: PASS. If any other construction site of `AgentTask` or `SandboxPlan` fails to compile, add the field there too — `pnpm typecheck` names every one.

- [ ] **Step 7: Amend the spec**

In `angular-ai-development-workflow-v2.md`, §18.4, replace:

```text
The adapter parses `turn.completed.usage`, records duration, exit code, and the validated final message under `evidence/agents/<run-id>.yaml`, and kills the process at timeout. `resume` and `--skip-git-repo-check` are never used.
```

with:

```text
The adapter parses `turn.completed.usage`, records duration, exit code, and the validated final message under `evidence/agents/<run-id>.yaml`, and kills the process at timeout. `resume` is never used. `--skip-git-repo-check` is passed for the **read-only class only**: §3.3 puts that class's cwd at the workspace root, which is deliberately not a git repository, and real `codex exec` refuses to start there (`Not inside a trusted directory and --skip-git-repo-check was not specified.`). A read-only run has an empty writable-root list and so cannot write anything wherever it starts, which is why the flag's purpose — keeping a write-capable agent inside a known repository — does not apply to it. It is never passed for the code-writing or report-writing classes, whose cwd is always inside a git work tree, and it stays set for a read-only role even when `agents.allow_unsandboxed` turns its sandbox into `danger-full-access`, because the cwd is what the check looks at. (T06 probe R2; `docs/spikes/prompt-spike.md`.)
```

In §3.3, append to the paragraph that begins "All classes can read the whole workspace":

```text
The workspace root is not a git repository, and is not made one: `git init`-ing it would nest `.janus/` — itself a git checkout — and every `repos/<name>` inside a fourth repository, and would add a reflog the §31.29 audit does not enumerate. The read-only class therefore starts outside a work tree, which §18.4 permits with `--skip-git-repo-check` for that class alone.
```

- [ ] **Step 8: Re-run the real read-only smoke test, now green**

Run:

```bash
JANUS_REAL_CODEX=1 pnpm test:integration -- tests/integration/codex-smoke.test.ts
```

Expected: PASS for every case, including "answers a read-only task with a schema-valid result", which was red in Step 2. Note the read-only run's token usage from the test output — probe S2 (Task 6) wants it.

- [ ] **Step 9: Append probe R2's section to the spike report**

Insert under `## Probe results` in `docs/spikes/prompt-spike.md`, after R1:

```markdown
### R2 — the read-only cwd tension (open question 1)

| Variant | Exit | Note |
|---|---|---|
| `-s read-only -C <non-repo>` | *(from `data.bare_exit`)* | stderr: `Not inside a trusted directory and --skip-git-repo-check was not specified.` — refused before any model call |
| the same `+ --skip-git-repo-check` | *(from `data.with_skip_flag_exit`)* | runs |
| the same in a `git init`-ed empty dir | *(from `data.in_git_repo_exit`)* | runs |
| the same `+ -c projects."<dir>".trust_level="trusted"` | *(from `data.trust_level_override_exit`)* | still refused |

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
```

- [ ] **Step 10: Run everything and commit**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
Expected: all exit 0.

```bash
git add src/agents tests/agents tests/helpers/agent-fixtures.ts tests/integration/codex-smoke.test.ts \
  angular-ai-development-workflow-v2.md docs/spikes/prompt-spike.md
git commit -m "fix(agents): allow --skip-git-repo-check for the read-only sandbox class" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 4: Probe S1 — report-writing with a report cwd, and the pnpm store as the single writable root

**Files:**
- Modify: `tests/integration/codex-smoke.test.ts` (probes S1a and S1b), `docs/spikes/prompt-spike.md`

**Interfaces:**
- Consumes: `buildAgentTask`, `createCodexAgentRunner`, `promptFixture`, `planSandbox`'s output through the task, `runGit`, `recordProbe`.
- Produces: probe records `S1a` and `S1b`; the spike report's S1 section. **No production change is expected** — this probe either confirms §3.3 and §18.4 or produces a finding that Task 7 folds in.

**Why (open question 3, first two bullets of `tasks.md` T06):** "report-writing under `workspace-write` with a report cwd" and "pnpm store as writable root (`npm_config_store_dir=<workspace>/.pnpm-store`, `agents.pnpm_store: workspace`, no `.npmrc`)". Both are §18.4 claims nothing has yet run against the binary. S1a also checks something Task 3 raises: a report-writing cwd is `<workspace>/.janus/reports/<run-id>/`, and `.janus` is a git checkout in a real workspace (§5) — so this class passes the git-work-tree check *because of* how the workspace is built, not by accident. A probe that forgets to `git init` its temp `.janus` would report a false failure, so S1a builds both shapes and says which is which.

- [ ] **Step 1: Write probe S1a — the report-writing class**

Add to `tests/integration/codex-smoke.test.ts`, inside the `describe.skipIf(!ENABLED)` block:

```ts
  /**
   * T06 probe S1a: a report-writing role (§3.3) under `workspace-write`, network off, cwd
   * `.janus/reports/<run-id>/`, that directory its only writable root. Also records whether that cwd passes
   * Codex's git-work-tree check — it does in production because `.janus` is a single-branch clone (§5), so the
   * probe builds it as one.
   */
  it(
    'probe S1a: a report-writing agent writes into its report directory and nowhere else',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-s1a-'));
      mkdirSync(paths.janusDir, { recursive: true });
      // Mirrors §5: `.janus/` is a git checkout in every real workspace.
      await runGit(paths.janusDir, ['init', '-q', '-b', 'janus/probe']);
      const sibling = paths.repoDir('ui-kit');
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, 'package.json'), `${JSON.stringify({ name: 'ui-kit', version: '1.0.0' }, null, 2)}\n`);

      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'probe-s1a',
        role: 'discovery',
        repo: null,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          goal: 'Survey ui-kit for an Angular major upgrade',
          planSlice:
            'Read ../../repos/ui-kit/package.json, then write a file named deps-and-build.md in your working directory whose first line is "# deps-and-build". Do not create any other file.',
        },
        guardrails: [],
        budget: '(probe S1a)',
      });
      expect(task.cwd).toBe(join(paths.janusDir, 'reports', 'probe-s1a'));
      expect(task.writableRoots).toEqual([task.cwd]);
      expect(task.network).toBe(false);
      expect(task.skipGitRepoCheck).toBe(false);
      mkdirSync(task.cwd, { recursive: true });

      const outcome = await runner.run(task, promptFixture(task));
      const report = join(task.cwd, 'deps-and-build.md');
      const wroteReport = existsSync(report);
      const escaped = existsSync(join(sibling, 'deps-and-build.md'));

      recordProbe({
        probe: 'S1a',
        question: 'Does a report-writing role write into .janus/reports/<run-id>/ under workspace-write with network off?',
        outcome: wroteReport && !escaped && outcome.failure === null ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          wrote_report: wroteReport,
          wrote_outside_report_dir: escaped,
          could_read_sibling_repo: outcome.result?.summary.toLowerCase().includes('ui-kit') ?? false,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(wroteReport).toBe(true);
      expect(escaped).toBe(false);
    },
    TEN_MINUTES,
  );
```

Add `existsSync` to the file's `node:fs` import if it is not already there (T05's smoke test already imports it).

- [ ] **Step 2: Write probe S1b — the pnpm store as the one extra writable root**

Add, directly after S1a:

```ts
  /**
   * T06 probe S1b: §18.4's default — "Janus sets `npm_config_store_dir=<workspace>/.pnpm-store` in every
   * code-writing agent's environment so a single writable root suffices ... No `.npmrc` is written, because pnpm
   * reads `.npmrc` only from a project root."
   */
  it(
    'probe S1b: a code-writing agent installs through the workspace pnpm store and writes no .npmrc',
    async () => {
      const paths = workspacePaths(tempDir('janus-probe-s1b-'));
      const repo = paths.repoDir('scratch');
      mkdirSync(repo, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify(
          { name: 'scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1', 'is-even': '1.0.0' } },
          null,
          2,
        )}\n`,
      );
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', 'package.json']);
      await runGit(repo, ['commit', '-q', '-m', 'scratch']);
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: 'probe-s1b',
        role: 'implementation',
        repo: 'scratch',
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        },
        guardrails: [],
        budget: '(probe S1b)',
      });
      expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);
      expect(task.writableRoots).toEqual([repo, paths.pnpmStoreDir]);

      const outcome = await runner.run(task, promptFixture(task));
      const storeEntries = existsSync(paths.pnpmStoreDir) ? readdirSync(paths.pnpmStoreDir) : [];
      const npmrcInRepo = existsSync(join(repo, '.npmrc'));
      const npmrcInWorkspace = existsSync(join(paths.root, '.npmrc'));

      recordProbe({
        probe: 'S1b',
        question: 'Does npm_config_store_dir alone make the workspace store the single extra writable root, with no .npmrc?',
        outcome: storeEntries.length > 0 && !npmrcInRepo && !npmrcInWorkspace ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          store_entries: storeEntries.length,
          npmrc_in_repo: npmrcInRepo,
          npmrc_in_workspace: npmrcInWorkspace,
          node_modules: existsSync(join(repo, 'node_modules')),
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(existsSync(join(repo, 'node_modules'))).toBe(true);
      expect(storeEntries.length).toBeGreaterThan(0);
      expect(npmrcInRepo).toBe(false);
      expect(npmrcInWorkspace).toBe(false);
      // §32 rule 11 again, on a run that really did install packages.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    },
    TEN_MINUTES,
  );
```

Add `readdirSync` to the file's `node:fs` import.

- [ ] **Step 3: Run both probes**

Run:

```bash
JANUS_REAL_CODEX=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe S1'
```

Expected: PASS, 2 tests. Each takes two to five minutes — S1b really installs two packages.

If S1a fails with `Not inside a trusted directory`, the `git init` of `.janus` in Step 1 was skipped or failed; that is a test bug, not a finding. If it fails because the agent wrote outside its report directory, that **is** a finding: record it, and Task 7 adds the constraint to the `discovery` prompt template.

- [ ] **Step 4: Confirm the default lane is still skipped and still green**

Run: `pnpm test:integration`
Expected: PASS with `tests/integration/codex-smoke.test.ts` reported as skipped — now 6 skipped (T05's 2 plus R1, R2, S1a, S1b).

- [ ] **Step 5: Append probe S1's section to the spike report**

Insert under `## Probe results` in `docs/spikes/prompt-spike.md`, after R2:

```markdown
### S1 — report-writing cwd and the pnpm store (open question 3, bullets 1 and 2)

**S1a — report-writing class.** cwd `.janus/reports/<run-id>/`, `-s workspace-write`,
`-c sandbox_workspace_write.network_access=false`, that directory the only `--add-dir`.

| Observation | Result |
|---|---|
| Wrote its report into the report directory | *(from `data.wrote_report`)* |
| Wrote anything into `repos/ui-kit/` | *(from `data.wrote_outside_report_dir`)* |
| Could read a sibling repo it had no write access to | *(from `data.could_read_sibling_repo`)* |
| Tokens (input / cached / output / reasoning / total) | *(from `data.tokens`)* |
| Wall time | *(from `data.duration_ms`)* |

The report cwd passes Codex's git-work-tree check **because `.janus/` is a single-branch clone** (§5), not because
the check is lenient. Any future test that builds a workspace by hand must `git init` `.janus/` or this class will
fail at spawn for a reason that has nothing to do with the agent.

**S1b — the workspace pnpm store.**

| Observation | Result |
|---|---|
| Entries in `<workspace>/.pnpm-store` after the install | *(from `data.store_entries`)* |
| `.npmrc` created in the repo | *(from `data.npmrc_in_repo`)* |
| `.npmrc` created at the workspace root | *(from `data.npmrc_in_workspace`)* |
| `node_modules` present | *(from `data.node_modules`)* |
| Repo HEAD moved | no (§32 rule 11) |
| Tokens / wall time | *(from `data.tokens`, `data.duration_ms`)* |

**Verdict:** *(one line: confirmed as specified, or the finding)*
```

- [ ] **Step 6: Commit**

```bash
git add tests/integration/codex-smoke.test.ts docs/spikes/prompt-spike.md
git commit -m "test(spike): probe the report-writing cwd and the workspace pnpm store against real codex" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 5: Probes A1 and A2 — `ng update --allow-dirty` and the migration footprint against `allowed_scope`

**Files:**
- Modify: `tests/integration/codex-smoke.test.ts` (probe A2), `docs/spikes/prompt-spike.md`
- Outside the repository: `~/janus-spike/ng15-footprint` (a throwaway copy of the app), `~/janus-spike/ng-update.log`, `~/janus-spike/ng-update-footprint.txt`

**Interfaces:**
- Consumes: `buildAgentTask`, `createCodexAgentRunner`, `promptFixture`, `runGit`, `recordProbe`, `configSchema`.
- Produces: probe records `A1` (measured by hand, transcribed) and `A2`; the measured migration footprint, which Task 7 writes into the `planning` prompt template; the spike report's A section.

**Why (open question 3, bullets 3 and 4):** §18.4's Angular guidance tells every code-writing agent to "run `ng update` with `--allow-dirty` because the tree is intentionally uncommitted" and to "expect CLI migrations to touch files across the repo". §12 requires `allowed_scope` to be "wide enough to include lockfiles and Angular CLI migration targets". Neither claim has a number behind it. A1 measures the footprint with no agent in the loop, so the number is not an artefact of what a model happened to do; A2 then checks that a real code-writing agent, inside the T05 sandbox plan, can perform the same upgrade.

**Node versions:** Angular CLI 15 refuses Node 24.5.0 (`^14.20 || ^16.14 || ^18.10`). A1 runs in a Node 18.20.8 shell. A2 runs inside the vitest integration lane on Node 24, so it **prepends Node 18's bin directory to `PATH` for the duration of the probe** — `createCodexAgentRunner` builds the child's environment from `process.env` at call time, so the spawned `codex` (and every `npx ng` it runs) sees Node 18 first.

- [ ] **Step 1: A1 — measure the migration footprint with no agent involved**

In a Node 18 shell:

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 18.20.8
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

rm -rf ~/janus-spike/ng15-footprint
cp -r ~/janus-spike/ng15-app ~/janus-spike/ng15-footprint
cd ~/janus-spike/ng15-footprint
git add -A && git commit -q -m "spike baseline" || true

# `--allow-dirty` only means anything on a dirty tree, which is exactly the state Janus hands an agent (§18.4).
printf '\n// janus spike: intentionally uncommitted\n' >> src/main.ts
git status --porcelain
```

Expected: `git status --porcelain` prints one line, ` M src/main.ts`.

- [ ] **Step 2: A1 — run the upgrade and capture the footprint**

```bash
cd ~/janus-spike/ng15-footprint
npx ng update @angular/core@16 @angular/cli@16 --allow-dirty 2>&1 | tee ~/janus-spike/ng-update.log | tail -40
echo "ng update exit: ${PIPESTATUS[0]}"
```

Expected: `ng update` proceeds (it does **not** refuse the dirty tree), prints `UPDATE package.json`, `UPDATE ...` lines and `** Executing migrations of package '@angular/core' **`, and exits 0. If it exits non-zero, keep the log: the error is the finding, and the last 40 lines go straight into the report.

Then measure:

```bash
cd ~/janus-spike/ng15-footprint
{
  echo "### ng update exit"; echo "see ng-update.log"
  echo; echo "### changed-file count"; git status --porcelain | wc -l
  echo; echo "### by top-level path"; git status --porcelain | awk '{print $NF}' | cut -d/ -f1 | sort | uniq -c | sort -rn
  echo; echo "### tracked changes (added/removed/path)"; git diff --numstat
  echo; echo "### untracked files"; git ls-files --others --exclude-standard
  echo; echo "### total added/removed"; git diff --numstat | awk '{a+=$1; r+=$2} END {print a, r}'
} > ~/janus-spike/ng-update-footprint.txt
cat ~/janus-spike/ng-update-footprint.txt
```

Expected: a changed-file count in the low tens, dominated by `package.json`, the lockfile, `angular.json`, `tsconfig*.json` and files under `src/`. **Transcribe the numbers into Step 6's table** — they are the §12 evidence.

Finally, check the upgraded app still builds, so the footprint is a *working* upgrade and not a broken one:

```bash
cd ~/janus-spike/ng15-footprint && pnpm install && npx ng build 2>&1 | tail -5
```

Expected: a successful build. If it fails, record the failure — a migration that does not build on its own is exactly what the debug role exists for, and T12's budgets need to know.

- [ ] **Step 3: Write probe A2 — the same upgrade, run by a code-writing agent**

Add to `tests/integration/codex-smoke.test.ts`. Put these three constants next to the existing `TEN_MINUTES`:

```ts
const FORTY_FIVE_MINUTES = 2_700_000;
const SPIKE_APP = process.env['JANUS_SPIKE_APP'] ?? join(homedir(), 'janus-spike', 'ng15-app');
const NODE18_BIN = process.env['JANUS_SPIKE_NODE18_BIN'] ?? join(homedir(), '.nvm', 'versions', 'node', 'v18.20.8', 'bin');

/** A2 runs a real Angular major upgrade; 10 minutes is not enough and the §20 ceiling has to rise with it. */
const angularConfig = configSchema.parse({
  workflow: { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' },
  agents: { roles: { implementation: { timeout_minutes: 45 } } },
  guardrails: { max_agent_runtime_minutes: 60 },
});
```

and add `import { homedir } from 'node:os';` plus `cpSync` to the `node:fs` import.

Then the probe:

```ts
  /**
   * T06 probe A2: can a code-writing agent, inside the T05 sandbox plan, run the Angular 15 -> 16 upgrade on a
   * dirty tree? Uses a copy of the spike app so the pristine one stays reusable, and prepends Node 18 to PATH
   * because Angular CLI 15 refuses Node 24 (`^14.20 || ^16.14 || ^18.10`).
   */
  it(
    'probe A2: a code-writing agent runs ng update --allow-dirty and leaves the tree dirty and uncommitted',
    async () => {
      if (!existsSync(SPIKE_APP) || !existsSync(NODE18_BIN)) {
        recordProbe({
          probe: 'A2',
          question: 'Can a code-writing agent run ng update --allow-dirty inside the sandbox plan?',
          outcome: 'fail',
          detail: `missing prerequisite: app=${SPIKE_APP} exists=${String(existsSync(SPIKE_APP))}, node18=${NODE18_BIN} exists=${String(existsSync(NODE18_BIN))}`,
          data: {},
        });
        throw new Error(`probe A2 needs ${SPIKE_APP} and ${NODE18_BIN}; see docs/spikes/prompt-spike.md runbook`);
      }

      const paths = workspacePaths(tempDir('janus-probe-a2-'));
      const repo = paths.repoDir('ng15-app');
      mkdirSync(paths.reposDir, { recursive: true });
      mkdirSync(paths.pnpmStoreDir, { recursive: true });
      cpSync(SPIKE_APP, repo, {
        recursive: true,
        filter: (src) => !/[/\\](node_modules|\.angular|dist|\.git)([/\\]|$)/u.test(src),
      });
      await runGit(repo, ['init', '-q', '-b', 'main']);
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-q', '-m', 'spike baseline']);
      // §18.4: the tree is intentionally uncommitted when an agent starts.
      writeFileSync(join(repo, 'src', 'main.ts'), `${readFileSync(join(repo, 'src', 'main.ts'), 'utf8')}\n// janus spike: intentionally uncommitted\n`);
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const previousPath = process.env['PATH'] ?? '';
      process.env['PATH'] = `${NODE18_BIN}:${previousPath}`;
      let outcome;
      try {
        const runner = createCodexAgentRunner({ paths });
        const task = buildAgentTask({
          runId: 'probe-a2',
          role: 'implementation',
          repo: 'ng15-app',
          attempt: 1,
          paths,
          config: angularConfig,
          profile: 'default',
          globalPnpmStore: null,
          context: {
            ...CONTEXT,
            goal: 'Upgrade this application from Angular 15 to Angular 16',
            repository: 'ng15-app (application), base branch main, no dependencies',
            planSlice:
              'wp-01-ng15-app-angular16: run `pnpm install`, then `npx ng update @angular/core@16 @angular/cli@16 --allow-dirty`, then `npx ng build`. Report every file the migration changed. Change nothing beyond what the migration changes plus whatever `ng build` needs to pass.',
          },
          guardrails: ['files outside this repository are out of scope'],
          budget: '(probe A2)',
        });
        expect(task.timeoutMinutes).toBe(45);
        outcome = await runner.run(task, promptFixture(task));
      } finally {
        process.env['PATH'] = previousPath;
      }

      const status = await runGit(repo, ['status', '--porcelain']);
      const changedFiles = status.split('\n').filter((line) => line.trim() !== '').length;
      const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
      const core = pkg.dependencies?.['@angular/core'] ?? '(absent)';

      recordProbe({
        probe: 'A2',
        question: 'Can a code-writing agent run ng update --allow-dirty inside the sandbox plan?',
        outcome: outcome.failure === null && core.includes('16') ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          angular_core_after: core,
          changed_files: changedFiles,
          changes_made_reported: outcome.result?.changes_made.length ?? null,
          status_completed: outcome.status,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
          head_moved: (await runGit(repo, ['rev-parse', 'HEAD'])) !== headBefore,
        },
      });

      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(core).toContain('16');
      expect(changedFiles).toBeGreaterThan(1);
      // §32 rule 11, on the most realistic run in the whole spike.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repo, ['reflog', 'show', '--format=%H', 'HEAD'])).toBe(headBefore);
    },
    FORTY_FIVE_MINUTES,
  );
```

Add `readFileSync` to the `node:fs` import.

- [ ] **Step 4: Run probe A2**

Run:

```bash
JANUS_REAL_CODEX=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" JANUS_SPIKE_APP="$HOME/janus-spike/ng15-app" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe A2'
```

Expected: PASS, in fifteen to forty minutes. This is the single most expensive probe in the spike; run it once and read the probe log rather than re-running it.

If it fails with `Unsupported engine` or `Node.js version v24` in the summary, the PATH patch did not reach the child: check that `NODE18_BIN` exists and contains a `node` binary (`ls "$NODE18_BIN"/node`). If it fails with a timeout, raise `implementation.timeout_minutes` in `angularConfig` **and** `guardrails.max_agent_runtime_minutes` together — the config schema rejects a role timeout above the ceiling — and record the real duration as a finding for §28's defaults.

- [ ] **Step 5: Compare the footprint to §12's `allowed_scope`**

With `~/janus-spike/ng-update-footprint.txt` in hand, check each changed path against §12's example scope,
`[package.json, pnpm-lock.yaml, angular.json, tsconfig*.json, src/**, projects/**]`:

```bash
cd ~/janus-spike/ng15-footprint
git status --porcelain | awk '{print $NF}' | while read -r p; do
  case "$p" in
    package.json|pnpm-lock.yaml|angular.json|tsconfig*.json|src/*|projects/*) ;;
    *) echo "OUT OF SCOPE: $p" ;;
  esac
done
```

Expected: either no output (§12's example scope is sufficient) or a short list. **Every line of output is a §12
finding** and goes into the report and into Task 7's `planning` template edit. Likely candidates on an Angular 15
app: `.browserslistrc`, `karma.conf.js`, `.editorconfig`, `README.md`, `e2e/**`, and — on a pnpm repo — the
lockfile itself if a plan ever forgets it, which is the case §12's validator warning already covers.

- [ ] **Step 6: Append the A section to the spike report**

Insert under `## Probe results` in `docs/spikes/prompt-spike.md`, after S1:

```markdown
### A1 / A2 — `ng update --allow-dirty` and the migration footprint (open question 3, bullets 3 and 4)

**A1 — `ng update` run directly, no agent.** `~/janus-spike/ng15-footprint`, Angular 15 -> 16, one file
deliberately uncommitted first.

| Measure | Value |
|---|---|
| `ng update ... --allow-dirty` refused the dirty tree? | *(no / the exact error)* |
| `ng update` exit code | *(from `ng-update.log`)* |
| Changed files | *(from `ng-update-footprint.txt`)* |
| Lines added / removed | *(from the `total added/removed` line)* |
| Top-level paths touched | *(from the `by top-level path` block)* |
| Paths outside §12's example `allowed_scope` | *(from Step 5, or "none")* |
| `pnpm install && ng build` after the migration | *(green / the error)* |

**A2 — the same upgrade, run by a code-writing agent** under `-s workspace-write`,
`network_access=true`, writable roots `[repos/ng15-app, .pnpm-store]`, `npm_config_store_dir` set, Node 18 first on
`PATH`.

| Measure | Value |
|---|---|
| Result status | *(from `data.status_completed`)* |
| `@angular/core` after the run | *(from `data.angular_core_after`)* |
| Changed files it left in the tree | *(from `data.changed_files`)* |
| Files it *reported* in `changes_made` | *(from `data.changes_made_reported`)* |
| HEAD moved / reflog moved | no, no (§32 rule 11) |
| Tokens (input / cached / output / reasoning / total) | *(from `data.tokens`)* |
| Wall time | *(from `data.duration_ms`)* |

**Recommended §12 default `allowed_scope` for an Angular application package**, derived from A1's footprint:

```yaml
allowed_scope:
  - package.json
  - pnpm-lock.yaml
  - angular.json
  - tsconfig*.json
  - src/**
  - projects/**
  # added by T06 probe A1 — paths the CLI migration touched that §12's example scope missed:
  # (list them here, or delete these two lines if Step 5 printed nothing)
```

**Verdict:** *(one line, and whether `changes_made` under-reported the real footprint — if it did, that is a
prompt finding for Task 7)*
```

- [ ] **Step 7: Commit**

```bash
git add tests/integration/codex-smoke.test.ts docs/spikes/prompt-spike.md
git commit -m "test(spike): probe ng update --allow-dirty and measure the migration footprint" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 6: Probe S2 — output-schema compliance and token cost across the four roles

**Files:**
- Modify: `tests/integration/codex-smoke.test.ts` (probe S2), `docs/spikes/prompt-spike.md`

**Interfaces:**
- Consumes: `buildAgentTask`, `createCodexAgentRunner`, `promptFixture`, `isCodeWriting` (`src/agents/roles.ts`), `runGit`, `recordProbe`.
- Produces: one probe record per role (`S2-discovery`, `S2-planning`, `S2-implementation`, `S2-debug`); the spike report's cost table, which is the answer to `tasks.md` T06's "output-schema compliance; token usage per role".

**Why (open question 3, bullets 5 and 6):** §18.3 and §14 require every role's answer to match a strict JSON Schema with every property present and `null` for "not applicable" — thirteen fields for the base shape, more for `fix`, `checkpoint`, `review` and `triage`. Nothing has checked that a real model actually produces all thirteen when asked. §18.6 needs a per-role token baseline before any model comparison means anything, and T06 explicitly requires recording it. The probe uses a **small scratch repository**, not the Angular app: A2 already paid for the heavy case, and this probe is about the contract, not the workload.

- [ ] **Step 1: Write probe S2**

Add to `tests/integration/codex-smoke.test.ts`. First the shared workspace builder, above the `describe`:

```ts
/**
 * A workspace shaped like a real one for the S2 probes: `.janus/` is a git checkout (§5, and probe S1a's finding),
 * `repos/ui-kit` is a tiny TypeScript library with one deliberate defect for the debug role, and `.pnpm-store`
 * exists so the code-writing plan's second writable root is real.
 */
async function spikeWorkspace(prefix: string): Promise<ReturnType<typeof workspacePaths>> {
  const paths = workspacePaths(tempDir(prefix));
  mkdirSync(paths.janusDir, { recursive: true });
  await runGit(paths.janusDir, ['init', '-q', '-b', 'janus/probe']);
  mkdirSync(paths.pnpmStoreDir, { recursive: true });

  const repo = paths.repoDir('ui-kit');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify({ name: 'ui-kit', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  // `sum` is wrong on purpose: the debug role gets a digest naming the failing test and must fix the source.
  writeFileSync(join(repo, 'src', 'sum.js'), 'export function sum(a, b) {\n  return a - b;\n}\n');
  writeFileSync(
    join(repo, 'src', 'sum.test.js'),
    [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { sum } from './sum.js';",
      '',
      "test('sum adds', () => {",
      '  assert.strictEqual(sum(2, 3), 5);',
      '});',
      '',
    ].join('\n'),
  );
  await runGit(repo, ['init', '-q', '-b', 'main']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', 'ui-kit baseline']);
  return paths;
}

/** The four roles `tasks.md` T06 names, with the slice each one is given. */
const S2_ROLES: ReadonlyArray<{ role: AgentRole; planSlice: string; verificationEvidence: string | null }> = [
  {
    role: 'discovery',
    planSlice:
      'Survey ../../repos/ui-kit for an Angular major upgrade. Write one markdown file per area you were asked about into your working directory, naming the files you read.',
    verificationEvidence: null,
  },
  {
    role: 'planning',
    planSlice:
      'Write plan.md and plan.yaml into your working directory for upgrading ../../repos/ui-kit one major version. One work package, with an allowed_scope wide enough for CLI migrations and the lockfile.',
    verificationEvidence: null,
  },
  {
    role: 'implementation',
    planSlice: 'wp-01-ui-kit: add a `product(a, b)` function to src/sum.js and a test for it in src/sum.test.js. Change nothing else.',
    verificationEvidence: null,
  },
  {
    role: 'debug',
    planSlice: 'wp-01-ui-kit: the test below fails. Find the cause and fix the source, not the test.',
    verificationEvidence: [
      'build: ui-kit #41, status FAILURE, classification tests_failed',
      'failed test: src/sum.test.js > sum adds',
      "  AssertionError: Expected values to be strictly equal: -1 !== 5",
      '    at src/sum.test.js:6:10',
    ].join('\n'),
  },
];
```

and add `import { isCodeWriting } from '../../src/agents/roles.js';` plus `import type { AgentRole } from '../../src/config/config-schema.js';` to the imports.

Then the probe itself, inside the `describe.skipIf(!ENABLED)` block:

```ts
  /**
   * T06 probe S2: does each role answer with a result that passes its generated §18.3 schema, and what does a
   * turn cost? Four separate `it`s (via `it.each`) so one role's failure does not hide the other three, and so a
   * single role can be re-run with `-t 'probe S2: debug'`.
   */
  it.each(S2_ROLES)(
    'probe S2: $role answers a schema-valid result and its cost is recorded',
    async ({ role, planSlice, verificationEvidence }) => {
      const paths = await spikeWorkspace(`janus-probe-s2-${role}-`);
      const repo = isCodeWriting(role) ? 'ui-kit' : null;
      const runner = createCodexAgentRunner({ paths });
      const task = buildAgentTask({
        runId: `probe-s2-${role}`,
        role,
        repo,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          goal: 'Upgrade ui-kit one Angular major version',
          repository: repo === null ? null : 'ui-kit (library), base branch main, no dependencies',
          planSlice,
          verificationEvidence,
          changeSummary: role === 'debug' ? [{ path: 'src/sum.js', added: 1, removed: 1, generated: false }] : [],
        },
        guardrails: ['files outside this repository are out of scope'],
        budget: 'ci_fix_attempts: 0 of 5',
      });
      if (task.sandboxClass === 'report-writing') mkdirSync(task.cwd, { recursive: true });
      const prompt = promptFixture(task);

      const outcome = await runner.run(task, prompt);
      const result = outcome.result;

      recordProbe({
        probe: `S2-${role}`,
        question: 'Does this role answer with a schema-valid §18.3 result, and what does one turn cost?',
        outcome: outcome.failure === null && result !== null ? 'pass' : 'fail',
        detail: outcome.failure === null ? outcome.summary : `${outcome.failure.kind}: ${outcome.failure.detail}`,
        data: {
          role,
          sandbox_class: task.sandboxClass,
          sandbox: task.sandbox,
          model: task.model.model,
          effort: task.model.effort,
          prompt_version: task.promptVersion,
          prompt_bytes: prompt.bytes,
          truncations: prompt.truncations,
          schema_valid: outcome.failure?.kind !== 'invalid_output',
          status: outcome.status,
          changes_made: result?.changes_made.length ?? null,
          findings: result?.findings.length ?? null,
          expected_temporary_failure: result?.expected_temporary_failure ?? null,
          handover_present: result?.handover !== undefined,
          tokens: outcome.tokens,
          duration_ms: outcome.durationMs,
        },
      });

      // An `invalid_output` failure is the finding this probe exists to catch: keep the detail, which carries the
      // exact zod messages `validateAgentResult` produced, and let the test fail loudly.
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(result).not.toBeNull();
      expect(result?.handover.next_action.length).toBeGreaterThan(0);
      expect(outcome.tokens?.total).toBeGreaterThan(0);
    },
    FORTY_FIVE_MINUTES,
  );
```

- [ ] **Step 2: Run probe S2**

Run:

```bash
JANUS_REAL_CODEX=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe S2'
```

Expected: PASS, 4 tests, five to twenty minutes in total. `outcome.tokens?.total` being greater than zero is only
possible because Task 2 fixed `parseCodexUsage`; if it is zero, Task 2 did not land.

If one role fails with `invalid_output`, **do not loosen the schema**. Copy the failure detail into the report and
into Task 7: the fix belongs in that role's prompt template (`OUTPUT CONTRACT` is rendered from the schema, so a
model that omits a field was not told clearly enough), not in `src/agents/output-schema.ts`.

- [ ] **Step 3: Append the S2 section to the spike report**

Insert under `## Probe results` in `docs/spikes/prompt-spike.md`, after A1/A2. Fill every cell from the probe log:

```markdown
### S2 — output-schema compliance and token cost per role (open question 3, bullets 5 and 6)

Model `gpt-5.6-sol`, profile `default`, one attempt each, against a small scratch `ui-kit` repository.

| Role | Class | Prompt bytes | Truncations | Schema valid | Status | Input | Cached | Output | Reasoning | Total | Wall time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| discovery | report-writing | | | | | | | | | | |
| planning | report-writing | | | | | | | | | | |
| implementation | code-writing | | | | | | | | | | |
| debug | code-writing | | | | | | | | | | |

**Input-token floor.** Even a trivial read-only turn costs roughly 14.5k input tokens before any Janus context —
that is Codex's own instruction preamble. Every number above includes it, so the marginal cost of a §18.2 context
package is `input - 14500`, not `input`.

**Schema compliance.** *(one line per role that failed validation, quoting the zod message from the probe log, or
"all four roles produced a complete §18.3 result on the first attempt")*

**Prompt findings.** *(anything a role did that its template should have prevented — e.g. under-reporting
`changes_made`, writing outside its report directory, editing a test instead of the source in the debug role)*
```

- [ ] **Step 4: Confirm the default lane is untouched and commit**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0, with the whole real-Codex file skipped (now 11 skipped: T05's 2, plus R1, R2, S1a, S1b, A2, and S2's 4).

```bash
git add tests/integration/codex-smoke.test.ts docs/spikes/prompt-spike.md
git commit -m "test(spike): probe per-role output-schema compliance and token cost" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 7: Fold the spike findings into the prompt templates, §12, and the report

**Files:**
- Modify: `src/agents/prompts/shared.ts`, `src/agents/prompts/templates.ts`, `tests/agents/prompts.test.ts`, `angular-ai-development-workflow-v2.md` (§12), `docs/spikes/prompt-spike.md`

**Interfaces:**
- Consumes: the probe log at `$JANUS_SPIKE_LOG`, the A1 footprint at `~/janus-spike/ng-update-footprint.txt`, and the report sections written by Tasks 2 to 6.
- Produces: `ANGULAR_GUIDANCE` with the measured migration footprint; a `planning` template that states the §12 scope floor; **twelve bumped `ROLE_TEMPLATES[*].version` values and twelve regenerated `PROMPT_FINGERPRINTS` entries**; §12 text carrying the measured evidence; `docs/spikes/prompt-spike.md` complete, which is `tasks.md` T06's done-when.

**Why:** `tasks.md` T06's last bullet is "fold findings into T05 templates, T07 doctor probes, and §12 scope defaults". The doctor probes are Part B; this task does the other two, plus the report. **Editing any shared block changes every role's fingerprint, so all twelve versions bump — that is correct** (§18.6: "a comparison never mixes prompt changes with model changes silently"), and the fingerprint test enforces it.

- [ ] **Step 1: Read the probe log before changing anything**

```bash
python3 -m json.tool --json-lines "$HOME/janus-spike/probe-log.jsonl" 2>/dev/null \
  || cat "$HOME/janus-spike/probe-log.jsonl"
cat ~/janus-spike/ng-update-footprint.txt
```

Every edit below cites a number or a quotation from that output. If a probe did not run, its edit does not happen and the report says why.

- [ ] **Step 2: Put the measured migration footprint into the Angular guidance**

In `src/agents/prompts/shared.ts`, replace `ANGULAR_GUIDANCE` with — substituting the real count and path list from A1's footprint file for `<N>` and the path list:

```ts
/** Spec §18.4: "Angular guidance injected into code-writing prompts", rendered as ANGULAR GUIDANCE (§18.2). */
export const ANGULAR_GUIDANCE = [
  'Use the repository’s own package manager, pnpm. Never switch package managers and never hand-edit a lockfile.',
  'Run `ng update` with `--allow-dirty`: the working tree is intentionally uncommitted, because Janus commits, not you.',
  'Expect CLI migrations to touch files across the whole repository. That is normal and in scope. A major-version `ng update` on a comparable application touched about <N> files — `package.json`, the lockfile, `angular.json`, `tsconfig*.json` and files under `src/`.',
  'Report every file you changed in `changes_made`, including files a CLI migration rewrote for you. A changed file you did not report reads as an unexplained change when the diff is policy-checked.',
  'Never edit CI configuration.',
].join('\n');
```

The existing test `'carries §18.4 Angular guidance including the --allow-dirty reason'` asserts `--allow-dirty`, `pnpm` and `CI configuration` are all still present; they are.

- [ ] **Step 3: Put the §12 scope floor into the planning template**

In `src/agents/prompts/templates.ts`, replace the `planning` entry's `text` array with:

```ts
    text: [
      'You are a planning agent. You turn the goal, the discovery reports, and the baseline into an ordered plan of work packages.',
      'Every work package must name the repository it touches, the files or areas it is allowed to change, and how it will be verified. Order packages so that a package never depends on one that comes later. Write the plan into your working directory.',
      'A package’s `allowed_scope` must be wide enough for the change to actually land. For an Angular major upgrade that means at least `package.json`, the lockfile, `angular.json`, `tsconfig*.json`, `src/**` and `projects/**`, plus any other path the CLI migration rewrites. A scope that lists `package.json` without the lockfile is rejected.',
      'A plan whose packages are "upgrade the app" or "fix the tests" is worthless. Each package must be small enough that one agent can finish it and one build can verify it.',
    ].join('\n\n'),
```

- [ ] **Step 4: Apply any per-role finding S2 or A2 recorded, and nothing else**

Apply **only** the items the probe log actually shows. Each is a one-sentence insert into that role's `text` array, before its final "worthless"/"policy violation" sentence:

- **If A2's `changes_made_reported` was smaller than `changed_files`** (the implementation agent under-reported the migration footprint), add to `implementation`:
  `'List every file you changed in `changes_made`, including the ones a CLI migration rewrote. The orchestrator policy-checks the diff against your list.',`
- **If S2's `debug` probe edited `src/sum.test.js` instead of `src/sum.js`**, add to `debug`:
  `'Fix the source file the failing test exercises. If you believe the test itself is wrong, say so in `findings` and answer `status: blocked`; do not edit it.',`
- **If S2's `discovery` probe wrote outside its report directory**, add to `discovery`:
  `'Write only inside your working directory. It is the only directory you can write to; everything else is read-only.',`
- **If any role failed schema validation**, add to that role: `'Answer with every field of the schema present. Use `null` or an empty list where a field does not apply; never omit one.',`

If the probe log shows none of these, skip this step entirely and say so in the report. Steps 2 and 3 already force the version bump.

- [ ] **Step 5: Run the fingerprint test to learn the new fingerprints**

Run: `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`
Expected: FAIL on `'fingerprints match the checked-in table, so a template edit cannot ship without a version bump'`, with a diff listing all twelve roles (the shared-block edit in Step 2 changes every one).

- [ ] **Step 6: Bump all twelve versions and paste the new fingerprints**

In `src/agents/prompts/templates.ts`, change every `version: '<role>@1'` to `version: '<role>@2'` — all twelve entries — and replace `PROMPT_FINGERPRINTS` with the `Received` object from Step 5's diff, keeping the roles in `AGENT_ROLES` order:

```bash
sed -i "s/version: '\\([a-z_]*\\)@1'/version: '\\1@2'/" src/agents/prompts/templates.ts
grep -c "@2'" src/agents/prompts/templates.ts
```

Expected: `grep -c` prints `12`. Then paste the twelve fingerprints by hand — the file's own comment says `PROMPT_FINGERPRINTS` is "regenerated by pasting the received object from the fingerprint test. Never edited by hand."

- [ ] **Step 7: Run the prompt tests again**

Run: `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`
Expected: PASS. If the fingerprint test still fails, a fingerprint was mistyped — paste the received object again rather than hand-correcting a digit.

- [ ] **Step 8: Amend §12 with the measured evidence**

In `angular-ai-development-workflow-v2.md`, §12, replace:

```text
`allowed_scope` is wide enough to include lockfiles and Angular CLI migration targets (the validator warns when `package.json` is in scope but the lockfile is not).
```

with — substituting A1's measured count and any path it found outside the example scope:

```text
`allowed_scope` is wide enough to include lockfiles and Angular CLI migration targets (the validator warns when `package.json` is in scope but the lockfile is not). T06 measured this on an Angular 15 to 16 application: `ng update @angular/core@16 @angular/cli@16 --allow-dirty` changed about <N> files, spread over `package.json`, the lockfile, `angular.json`, `tsconfig*.json` and `src/**`<, plus: list any path outside that set, or delete this clause>. The example scope above is therefore the floor, not a suggestion. See `docs/spikes/prompt-spike.md`.
```

- [ ] **Step 9: Write the report's findings section**

Replace `## Findings and resulting changes` in `docs/spikes/prompt-spike.md` with the real thing. The two findings below are already known from Tasks 2 and 3 and are written out in full; add one numbered entry per additional finding the probe log shows, in the same shape (finding, evidence, change, file).

```markdown
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

### 3. ... *(one entry per remaining finding: S1a, S1b, A1, A2, S2)*

## Feeds into other tasks

| Finding | Goes to |
|---|---|
| Read-only runs need `--skip-git-repo-check` | T07 `codex.probe.read_only`, which probes exactly that shape |
| `.janus/` must be a git checkout for report-writing to spawn | every future hand-built test workspace; §5 already requires it |
| The workspace pnpm store needs no `.npmrc` | T07 `pnpm.store` |
| Measured `ng update` footprint | §12 `allowed_scope` floor; T11's `plan.yaml` validator; T08's scope check |
| Per-role token baselines | §18.6 comparisons; T21's `janus telemetry compare`; T22's dogfood budget |
| Per-role schema compliance | T05 prompt templates (done here); T12's attempt accounting |
```

- [ ] **Step 10: Run everything and commit**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
Expected: all exit 0.

```bash
git add src/agents/prompts angular-ai-development-workflow-v2.md docs/spikes/prompt-spike.md
git commit -m "docs(spike): fold the T06 findings into the prompt templates and the §12 scope floor" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

# Part B — T07: `janus doctor`

Written after the spike, against what it observed. Thirteen checks, covering every bullet of `tasks.md` T07 (its "three real Codex probes" bullet is three checks, and its "provider reachability" bullet is two). For each check, the heading says whether it waited on a probe: most did not and were independently testable from the start; the two Codex probes, the model probe and the pnpm-store check are shaped by Tasks 3, 4 and 5.

## Task 8: The check contract, the three seams, and the `--json` report

**Files:**
- Create: `src/doctor/types.ts`, `src/doctor/exec.ts`, `src/doctor/http.ts`, `src/doctor/fs.ts`, `src/doctor/report.ts`, `tests/doctor/report.test.ts`, `tests/helpers/doctor-fixtures.ts`

**Interfaces:**
- Consumes: `spawnCodex` (`src/agents/codex/spawn.ts`), `ExitCode` (`src/cli/exit-codes.ts`), `JanusConfig`, `Goal`, `WorkspacePaths`.
- Produces:
  - `DOCTOR_STATUSES`, `type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'`
  - `interface DoctorFinding { id, title, status, detail, remediation: string | null, duration_ms }`
  - `type DoctorObservation = Omit<DoctorFinding, 'duration_ms'>`
  - `interface DoctorCheckContext { config: JanusConfig | null; goal: Goal | null; paths: WorkspacePaths | null; env: Record<string, string | undefined>; run: CommandRunner; http: HttpProbe; fs: DoctorFs; now(): Date }`
  - `interface DoctorCheck { id: string; title: string; run(ctx: DoctorCheckContext): Promise<DoctorObservation[]> }`
  - `class DoctorContractError extends Error`, `skipped(id, title, detail, remediation)`
  - `CommandRequest`, `CommandResult`, `CommandRunner`, `runCommand`, `processEnv`
  - `HttpProbeRequest`, `HttpProbeResult`, `HttpProbe`, `fetchProbe`
  - `DoctorFs` (`readText`, `exists`, `mkdirp`, `probeWritable`), `nodeFs`
  - `interface DoctorReport { version: 1; generated_at: string; workspace: string | null; summary: Record<DoctorStatus, number>; checks: DoctorFinding[] }`
  - `runDoctor(checks, ctx): Promise<DoctorReport>`, `doctorJson(report): string`, `renderDoctorHuman(report): string`, `doctorExitCode(report): ExitCode`
  - test helpers `doctorContext(overrides)`, `stubRunner(handlers)`, `commandResult(overrides)`, `stubHttp(result)`

**Waited on a probe?** No. The contract is independent of what any check observes.

- [ ] **Step 1: Write the failing report test**

Create `tests/doctor/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { DoctorContractError, type DoctorCheck } from '../../src/doctor/types.js';
import { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from '../../src/doctor/report.js';
import { doctorContext } from '../helpers/doctor-fixtures.js';

const check = (id: string, observations: Parameters<DoctorCheck['run']> extends never ? never : ReturnType<DoctorCheck['run']> extends never ? never : Awaited<ReturnType<DoctorCheck['run']>>): DoctorCheck => ({
  id,
  title: `title of ${id}`,
  run: async () => observations,
});

describe('runDoctor', () => {
  it('stamps a duration on every finding and counts the statuses', async () => {
    const report = await runDoctor(
      [
        check('a', [{ id: 'a', title: 'A', status: 'pass', detail: 'fine', remediation: null }]),
        check('b', [
          { id: 'b.one', title: 'B one', status: 'warn', detail: 'hmm', remediation: 'do the thing' },
          { id: 'b.two', title: 'B two', status: 'skip', detail: 'not applicable', remediation: 'configure it first' },
        ]),
        check('c', [{ id: 'c', title: 'C', status: 'fail', detail: 'broken', remediation: 'fix it' }]),
      ],
      doctorContext({ paths: null }),
    );

    expect(report.version).toBe(1);
    expect(report.generated_at).toBe('2026-09-20T12:00:00.000Z');
    expect(report.workspace).toBeNull();
    expect(report.checks.map((f) => f.id)).toEqual(['a', 'b.one', 'b.two', 'c']);
    expect(report.checks.every((f) => typeof f.duration_ms === 'number')).toBe(true);
    expect(report.summary).toEqual({ pass: 1, warn: 1, fail: 1, skip: 1 });
  });

  it('turns a thrown check into a failed finding instead of losing the whole report', async () => {
    const boom: DoctorCheck = {
      id: 'boom',
      title: 'explodes',
      run: async () => {
        throw new Error('ENOENT: no such file');
      },
    };
    const report = await runDoctor([boom], doctorContext());
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('fail');
    expect(report.checks[0]?.detail).toContain('ENOENT');
    expect(report.checks[0]?.remediation).toContain('janus doctor');
  });

  it('refuses a non-pass finding with no remediation (§10 of the plan; every failure tells the operator what to do)', async () => {
    const bad = check('bad', [{ id: 'bad', title: 'Bad', status: 'fail', detail: 'x', remediation: null }]);
    await expect(runDoctor([bad], doctorContext())).rejects.toBeInstanceOf(DoctorContractError);
  });

  it('refuses two findings with the same id, because --json consumers key on it', async () => {
    const one = check('dup', [{ id: 'dup', title: 'One', status: 'pass', detail: 'a', remediation: null }]);
    const two = check('dup2', [{ id: 'dup', title: 'Two', status: 'pass', detail: 'b', remediation: null }]);
    await expect(runDoctor([one, two], doctorContext())).rejects.toBeInstanceOf(DoctorContractError);
  });
});

describe('doctorExitCode', () => {
  it('fails the command only when a check failed', async () => {
    const failing = await runDoctor([check('c', [{ id: 'c', title: 'C', status: 'fail', detail: 'x', remediation: 'y' }])], doctorContext());
    const warning = await runDoctor([check('w', [{ id: 'w', title: 'W', status: 'warn', detail: 'x', remediation: 'y' }])], doctorContext());
    const skipped = await runDoctor([check('s', [{ id: 's', title: 'S', status: 'skip', detail: 'x', remediation: 'y' }])], doctorContext());
    expect(doctorExitCode(failing)).toBe(ExitCode.UnexpectedError);
    expect(doctorExitCode(warning)).toBe(ExitCode.Ok);
    expect(doctorExitCode(skipped)).toBe(ExitCode.Ok);
  });
});

describe('rendering', () => {
  it('prints one line per check, the remediation under a failure, and a summary line', async () => {
    const report = await runDoctor(
      [
        check('codex.binary', [{ id: 'codex.binary', title: 'codex CLI', status: 'pass', detail: 'codex-cli 0.146.0', remediation: null }]),
        check('pnpm.store', [
          { id: 'pnpm.store', title: 'pnpm store is writable', status: 'fail', detail: 'EACCES', remediation: 'chmod u+w the store directory' },
        ]),
      ],
      doctorContext(),
    );
    const text = renderDoctorHuman(report);
    expect(text).toContain('[ok]   codex.binary');
    expect(text).toContain('[fail] pnpm.store');
    expect(text).toContain('-> chmod u+w the store directory');
    expect(text).toContain('2 checks: 1 ok, 0 warnings, 1 failed, 0 skipped');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('emits a parseable, stable --json document', async () => {
    const report = await runDoctor([check('a', [{ id: 'a', title: 'A', status: 'pass', detail: 'fine', remediation: null }])], doctorContext());
    const parsed = JSON.parse(doctorJson(report)) as Record<string, unknown>;
    expect(parsed['version']).toBe(1);
    expect(parsed['generated_at']).toBe('2026-09-20T12:00:00.000Z');
    expect(Object.keys(parsed).sort()).toEqual(['checks', 'generated_at', 'summary', 'version', 'workspace']);
    expect((parsed['checks'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'a',
      title: 'A',
      status: 'pass',
      detail: 'fine',
      remediation: null,
    });
  });
});
```

The `check` helper's type gymnastics above are noise; simplify it in the file to:

```ts
import type { DoctorCheck, DoctorObservation } from '../../src/doctor/types.js';

const check = (id: string, observations: DoctorObservation[]): DoctorCheck => ({
  id,
  title: `title of ${id}`,
  run: async () => observations,
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/report.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/types.js"`.

- [ ] **Step 3: Write the contract**

Create `src/doctor/types.ts`:

```ts
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal } from '../config/goal-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import type { CommandRunner } from './exec.js';
import type { DoctorFs } from './fs.js';
import type { HttpProbe } from './http.js';

/**
 * Spec §31 item 33: "`janus doctor` detects a non-working sandbox, a read-only pnpm store, and a missing
 * `janus/*` branch exclusion." Four statuses, because those three are not the same kind of problem: a dead
 * sandbox is a `fail`, an unwritable store is a `fail`, and a branch spec Janus cannot see from here is a `warn`.
 * `skip` is for a check that does not apply — a fake provider, a workspace-less invocation.
 */
export const DOCTOR_STATUSES = ['pass', 'warn', 'fail', 'skip'] as const;

export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

export interface DoctorFinding {
  /** Stable, machine-readable, dotted. `--json` consumers (and the §35 operator skill) key on it. Unique. */
  id: string;
  /** One short human phrase. Never contains a value that could be a secret (§32 rule 12). */
  title: string;
  status: DoctorStatus;
  /** What was observed. May quote a command's stderr; never a token value. */
  detail: string;
  /** What the operator should do. `null` is allowed only for `pass`; `runDoctor` enforces that. */
  remediation: string | null;
  duration_ms: number;
}

/** What a check returns; `runDoctor` stamps the duration. */
export type DoctorObservation = Omit<DoctorFinding, 'duration_ms'>;

/**
 * Everything a check may touch. Nothing else: no direct `process.env`, `child_process`, `fetch` or `node:fs`.
 * That is what makes every check unit-testable with no `codex`, no `git`, no `pnpm` and no network — which
 * matters more than usual here, because Bitbucket Server and TeamCity are unreachable from the machine Janus is
 * developed on.
 *
 * `config`, `goal` and `paths` are null when doctor runs outside a workspace (§35 runs it before `janus init`).
 */
export interface DoctorCheckContext {
  config: JanusConfig | null;
  goal: Goal | null;
  paths: WorkspacePaths | null;
  env: Record<string, string | undefined>;
  run: CommandRunner;
  http: HttpProbe;
  fs: DoctorFs;
  now(): Date;
}

export interface DoctorCheck {
  /** Prefix of every finding this check produces; a check that fans out suffixes it (`codex.model[gpt-5.6-sol]`). */
  id: string;
  title: string;
  run(ctx: DoctorCheckContext): Promise<DoctorObservation[]>;
}

/** A check violated the contract: a duplicate id, or a non-`pass` finding with no remediation. */
export class DoctorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorContractError';
  }
}

/** The one place a check says "this does not apply here", so the phrasing stays identical across checks. */
export function skipped(id: string, title: string, detail: string, remediation: string): DoctorObservation {
  return { id, title, status: 'skip', detail, remediation };
}
```

- [ ] **Step 4: Write the three seams**

Create `src/doctor/exec.ts`:

```ts
import { spawnCodex } from '../agents/codex/spawn.js';

export interface CommandRequest {
  bin: string;
  args: string[];
  cwd: string;
  /** The complete environment for the child. Omitted means "inherit the current process's". */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when the binary could not be started at all — usually "not on PATH". */
  spawnFailed: boolean;
  durationMs: number;
}

/** The seam every doctor test replaces. Production is {@link runCommand}. */
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

/** `process.env` with every `undefined` dropped, so it satisfies `Record<string, string>`. */
export function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Runs one child process to completion, never rejecting — a missing binary, a non-zero exit and a timeout are all
 * findings, not exceptions.
 *
 * Deliberately a thin rename over `spawnCodex` rather than a second `child_process` implementation: that one
 * already has the SIGTERM-then-SIGKILL timeout path, the output caps and the "never reject" contract, and it is
 * covered by `tests/agents/codex-spawn.test.ts`. Its `jsonl` field is just "everything on stdout".
 */
export const runCommand: CommandRunner = async (request) => {
  const result = await spawnCodex({
    bin: request.bin,
    args: request.args,
    cwd: request.cwd,
    env: request.env ?? processEnv(),
    stdin: request.stdin ?? '',
    timeoutMs: request.timeoutMs,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.jsonl,
    stderr: result.stderr,
    timedOut: result.timedOut,
    spawnFailed: result.spawnFailed,
    durationMs: result.durationMs,
  };
};
```

Create `src/doctor/http.ts`:

```ts
export interface HttpProbeRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface HttpProbeResult {
  ok: boolean;
  /** HTTP status, or null when the request never got one (DNS failure, refused connection, timeout). */
  status: number | null;
  /** Transport-level error message, or null when a response arrived. Never contains a request header value. */
  error: string | null;
}

/**
 * The seam the provider-reachability checks use. **No test in this repository ever supplies `fetchProbe`**:
 * TeamCity and Bitbucket Server are not reachable from the development machine (§33 lists them as work-network
 * systems), so every test injects a stub and the real one is exercised for the first time by the §29.6
 * first-contact runbook.
 */
export type HttpProbe = (request: HttpProbeRequest) => Promise<HttpProbeResult>;

export const fetchProbe: HttpProbe = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);
  try {
    const response = await fetch(request.url, { headers: request.headers, signal: controller.signal, redirect: 'manual' });
    return { ok: response.ok, status: response.status, error: null };
  } catch (error) {
    return { ok: false, status: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};
```

Create `src/doctor/fs.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The filesystem seam. Two checks need it for reasons a stub must be able to reproduce: `sandbox.user_namespaces`
 * reads `/proc` entries that do not exist on every machine, and `pnpm.store` has to actually attempt a write —
 * `access(W_OK)` lies on read-only mounts, on full filesystems and under some container overlays, which is exactly
 * the case §31 item 33 asks doctor to detect.
 */
export interface DoctorFs {
  /** File contents, or null when the file is missing or unreadable. Never throws. */
  readText(path: string): string | null;
  exists(path: string): boolean;
  mkdirp(dir: string): void;
  /** Creates and deletes a probe file in `dir`. Returns null on success, or the error message. Never throws. */
  probeWritable(dir: string): string | null;
}

export const nodeFs: DoctorFs = {
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  exists: (path) => existsSync(path),
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  probeWritable: (dir) => {
    const probe = join(dir, `.janus-doctor-${String(process.pid)}`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(probe, 'janus doctor write probe\n');
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      rmSync(probe, { force: true });
    }
  },
};
```

- [ ] **Step 5: Write the runner and the renderers**

Create `src/doctor/report.ts`:

```ts
import { ExitCode } from '../cli/exit-codes.js';
import { DoctorContractError } from './types.js';
import type { DoctorCheck, DoctorCheckContext, DoctorFinding, DoctorObservation, DoctorStatus } from './types.js';

export interface DoctorReport {
  /** Bumped only when a field is removed or changes meaning; new fields are additive. */
  version: 1;
  generated_at: string;
  /** Absolute workspace root, or null when doctor ran outside one. */
  workspace: string | null;
  summary: Record<DoctorStatus, number>;
  checks: DoctorFinding[];
}

export async function runDoctor(checks: readonly DoctorCheck[], ctx: DoctorCheckContext): Promise<DoctorReport> {
  const findings: DoctorFinding[] = [];
  for (const check of checks) {
    const started = ctx.now().getTime();
    let observations: DoctorObservation[];
    try {
      observations = await check.run(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observations = [
        {
          id: check.id,
          title: check.title,
          status: 'fail' as const,
          detail: `the check itself threw: ${message}`,
          remediation: 'this is a bug in janus doctor, not in your environment; report it with the message above',
        },
      ];
    }
    const durationMs = ctx.now().getTime() - started;
    for (const observation of observations) findings.push({ ...observation, duration_ms: durationMs });
  }

  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) throw new DoctorContractError(`two doctor findings share the id "${finding.id}"; ids are the --json contract's key`);
    seen.add(finding.id);
    if (finding.status !== 'pass' && finding.remediation === null) {
      throw new DoctorContractError(`doctor finding "${finding.id}" is ${finding.status} but carries no remediation`);
    }
  }

  // The literal below carries all four keys, so the summary's key set is exactly `DOCTOR_STATUSES` even when a
  // status never occurred — `--json` consumers can read `summary.fail` without a presence check.
  const summary: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const finding of findings) summary[finding.status] += 1;

  return {
    version: 1,
    generated_at: ctx.now().toISOString(),
    workspace: ctx.paths?.root ?? null,
    summary,
    checks: findings,
  };
}

export function doctorExitCode(report: DoctorReport): ExitCode {
  return report.summary.fail > 0 ? ExitCode.UnexpectedError : ExitCode.Ok;
}

export function doctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const TAGS: Record<DoctorStatus, string> = { pass: '[ok]  ', warn: '[warn]', fail: '[fail]', skip: '[skip]' };

export function renderDoctorHuman(report: DoctorReport): string {
  const width = Math.max(0, ...report.checks.map((finding) => finding.id.length));
  const lines = ['janus doctor', ''];
  for (const finding of report.checks) {
    lines.push(`  ${TAGS[finding.status]} ${finding.id.padEnd(width)}  ${finding.detail}`);
    if (finding.status !== 'pass' && finding.remediation !== null) lines.push(`         -> ${finding.remediation}`);
  }
  const { pass, warn, fail, skip } = report.summary;
  lines.push(
    '',
    `${String(report.checks.length)} checks: ${String(pass)} ok, ${String(warn)} warnings, ${String(fail)} failed, ${String(skip)} skipped`,
  );
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 6: Write the shared test fixtures**

Create `tests/helpers/doctor-fixtures.ts`:

```ts
import { configSchema } from '../../src/config/config-schema.js';
import type { CommandRequest, CommandResult, CommandRunner } from '../../src/doctor/exec.js';
import type { DoctorFs } from '../../src/doctor/fs.js';
import type { HttpProbe, HttpProbeResult } from '../../src/doctor/http.js';
import type { DoctorCheckContext } from '../../src/doctor/types.js';

export const FROZEN_NOW = '2026-09-20T12:00:00.000Z';

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    durationMs: 12,
    ...overrides,
  };
}

/**
 * A `CommandRunner` that answers only the requests a test declared, and throws on anything else. Throwing is the
 * point: a check that silently gained a second subprocess call would otherwise pass its test against a default.
 */
export function stubRunner(handlers: ReadonlyArray<{ match: (request: CommandRequest) => boolean; result: Partial<CommandResult> }>): CommandRunner {
  return async (request) => {
    const handler = handlers.find((candidate) => candidate.match(request));
    if (handler === undefined) throw new Error(`no stub for: ${request.bin} ${request.args.join(' ')}`);
    return commandResult(handler.result);
  };
}

export function stubHttp(result: Partial<HttpProbeResult>): HttpProbe {
  return async () => ({ ok: false, status: null, error: null, ...result });
}

/** A `DoctorFs` backed by a plain map of path to contents. `writableError` makes `probeWritable` report a failure. */
export function stubFs(options: { files?: Record<string, string>; writableError?: string } = {}): DoctorFs {
  const files = options.files ?? {};
  return {
    readText: (path) => files[path] ?? null,
    exists: (path) => path in files,
    mkdirp: () => undefined,
    probeWritable: () => options.writableError ?? null,
  };
}

export function doctorContext(overrides: Partial<DoctorCheckContext> = {}): DoctorCheckContext {
  return {
    config: configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } }),
    goal: null,
    paths: null,
    env: {},
    fs: stubFs(),
    run: async (request) => {
      throw new Error(`unexpected command in this test: ${request.bin} ${request.args.join(' ')}`);
    },
    http: async (request) => {
      throw new Error(`unexpected http probe in this test: ${request.url}`);
    },
    now: () => new Date(FROZEN_NOW),
    ...overrides,
  };
}
```

- [ ] **Step 7: Run the report tests**

Run: `pnpm exec vitest run --project unit tests/doctor/report.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 8: Commit**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

```bash
git add src/doctor tests/doctor tests/helpers/doctor-fixtures.ts
git commit -m "feat(doctor): add the check contract, the process and http seams, and the --json report" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 9: `codex.binary`, `codex.login`, and the per-model one-token probe

**Files:**
- Create: `src/doctor/checks/codex.ts`, `tests/doctor/codex.test.ts`

**Interfaces:**
- Consumes: `DoctorCheck`, `DoctorObservation`, `skipped` (`src/doctor/types.ts`); `CommandRunner`; `parseLadderEntry` (`src/agents/models.ts`); `Effort`, `JanusConfig` (`src/config/config-schema.ts`); `stubRunner`, `doctorContext` (`tests/helpers/doctor-fixtures.ts`).
- Produces:
  - `CODEX_BIN = 'codex'`
  - `lastLine(text: string): string`
  - `distinctModels(config: JanusConfig, profile: string): Array<{ model: string; effort: Effort }>`
  - `codexBinaryCheck: DoctorCheck` (id `codex.binary`)
  - `codexLoginCheck: DoctorCheck` (id `codex.login`)
  - `codexModelsCheck: DoctorCheck` (id prefix `codex.model`, one finding per distinct model, id `codex.model[<model>]`)

**Waited on a probe?** No for `codex.binary` and `codex.login` — they are pure CLI observations. `codex.model` **did** wait on Task 3: its probe runs `-s read-only` in a scratch directory that is not a git repository, and only works because `--skip-git-repo-check` is now allowed for that shape.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/codex.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { codexBinaryCheck, codexLoginCheck, codexModelsCheck, distinctModels } from '../../src/doctor/checks/codex.js';
import { doctorContext, stubRunner } from '../helpers/doctor-fixtures.js';

const isVersion = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === '--version';
const isLogin = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === 'login';
const isExec = (bin: string, args: string[]): boolean => bin === 'codex' && args[0] === 'exec';

describe('codexBinaryCheck', () => {
  it('passes and reports the version', async () => {
    const ctx = doctorContext({ run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { stdout: 'codex-cli 0.146.0\n' } }]) });
    expect(await codexBinaryCheck.run(ctx)).toEqual([
      { id: 'codex.binary', title: codexBinaryCheck.title, status: 'pass', detail: 'codex-cli 0.146.0', remediation: null },
    ]);
  });

  it('fails with an install remediation when the binary is not on PATH', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { spawnFailed: true, exitCode: null, stderr: 'spawn codex ENOENT' } }]),
    });
    const [finding] = await codexBinaryCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOENT');
    expect(finding?.remediation).toContain('PATH');
  });

  it('fails when the binary is there but exits non-zero', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isVersion(r.bin, r.args), result: { exitCode: 127, stderr: 'illegal instruction' } }]),
    });
    const [finding] = await codexBinaryCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('127');
    expect(finding?.remediation).not.toBeNull();
  });
});

describe('codexLoginCheck', () => {
  it('passes when codex reports a login', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { stdout: 'Logged in using ChatGPT\n' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toBe('Logged in using ChatGPT');
  });

  it('fails with a `codex login` remediation when it is not logged in', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => isLogin(r.bin, r.args), result: { exitCode: 1, stdout: 'Not logged in\n', stderr: '' } }]),
    });
    const [finding] = await codexLoginCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('codex login');
    // §28: "Codex authentication is handled outside Janus" — the remediation must not suggest a config change.
    expect(finding?.remediation).not.toContain('config.yaml');
  });
});

describe('distinctModels', () => {
  it('collects every model the active profile can reach, including ladder entries, once each', () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: {
        default: {
          '*': { model: 'gpt-5.6-sol', effort: 'high' },
          implementation: { model: 'gpt-5.6-sol', effort: 'xhigh' },
          debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-sol', 'gpt-5.6-sol:xhigh', 'gpt-5.6-mini'] },
        },
        other: { '*': { model: 'never-probed', effort: 'low' } },
      },
    });
    expect(distinctModels(config, 'default')).toEqual([
      { model: 'gpt-5.6-sol', effort: 'high' },
      { model: 'gpt-5.6-mini', effort: 'high' },
    ]);
    expect(distinctModels(config, 'other')).toEqual([{ model: 'never-probed', effort: 'low' }]);
  });
});

describe('codexModelsCheck', () => {
  it('probes each distinct model once, read-only, outside a repo, and passes when codex accepts it', async () => {
    const seen: string[][] = [];
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => {
            if (!isExec(r.bin, r.args)) return false;
            seen.push(r.args);
            return true;
          },
          result: { exitCode: 0, stdout: 'ok\n', stderr: 'OpenAI Codex v0.146.0\n' },
        },
      ]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('codex.model[gpt-5.6-sol]');
    expect(findings[0]?.status).toBe('pass');
    expect(seen[0]).toContain('--skip-git-repo-check');
    expect(seen[0]).toContain('-s');
    expect(seen[0]).toContain('read-only');
    expect(seen[0]).toContain('-m');
    expect(seen[0]).toContain('gpt-5.6-sol');
    expect(seen[0]).toContain('model_reasoning_effort=high');
    expect(seen[0]).not.toContain('--add-dir');
  });

  it('fails the one model codex rejects and keeps the others passing', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'good-model', effort: 'high' }, debug: { model: 'bad-model', effort: 'high' } } },
    });
    const ctx = doctorContext({
      config,
      run: stubRunner([
        { match: (r) => r.args.includes('good-model'), result: { exitCode: 0 } },
        {
          match: (r) => r.args.includes('bad-model'),
          result: { exitCode: 1, stderr: 'OpenAI Codex v0.146.0\nstream error: model `bad-model` is not supported\n' },
        },
      ]),
    });
    const findings = await codexModelsCheck.run(ctx);
    expect(findings.map((f) => `${f.id}=${f.status}`)).toEqual(['codex.model[good-model]=pass', 'codex.model[bad-model]=fail']);
    const bad = findings[1];
    expect(bad?.detail).toContain('is not supported');
    // The banner line must not be what the operator is shown; the error is the last line.
    expect(bad?.detail).not.toContain('OpenAI Codex v0.146.0');
    expect(bad?.remediation).toContain('model_profiles');
  });

  it('skips when doctor was not run inside a workspace, because there is no config to read models from', async () => {
    const findings = await codexModelsCheck.run(doctorContext({ config: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('skip');
    expect(findings[0]?.remediation).toContain('janus init');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/codex.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/checks/codex.js"`.

- [ ] **Step 3: Write the checks**

Create `src/doctor/checks/codex.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLadderEntry } from '../../agents/models.js';
import type { Effort, JanusConfig } from '../../config/config-schema.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorObservation } from '../types.js';

export const CODEX_BIN = 'codex';

const VERSION_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 30_000;
/** A one-token probe still pays Codex's ~14.5k-token instruction preamble and a full round trip. */
const MODEL_PROBE_TIMEOUT_MS = 180_000;

const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * The operative line of a failed command. Codex prints a multi-line banner (`OpenAI Codex v0.146.0`, `workdir`,
 * `model`, ...) to **stderr** on every run, success or not, so the first line is never the error; the error is at
 * the end. Observed in T06 probe R2.
 */
export function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines[lines.length - 1] ?? '';
}

export const codexBinaryCheck: DoctorCheck = {
  id: 'codex.binary',
  title: 'codex CLI is installed',
  run: async (ctx) => {
    const result = await ctx.run({ bin: CODEX_BIN, args: ['--version'], cwd: tmpdir(), timeoutMs: VERSION_TIMEOUT_MS });
    if (result.spawnFailed) {
      return [
        {
          id: 'codex.binary',
          title: codexBinaryCheck.title,
          status: 'fail',
          detail: `could not start "${CODEX_BIN}": ${lastLine(result.stderr)}`,
          remediation: 'install the Codex CLI and put it on PATH, then re-run janus doctor',
        },
      ];
    }
    if (result.exitCode !== 0) {
      return [
        {
          id: 'codex.binary',
          title: codexBinaryCheck.title,
          status: 'fail',
          detail: `"${CODEX_BIN} --version" exited ${String(result.exitCode)}: ${lastLine(result.stderr)}`,
          remediation: 'reinstall the Codex CLI; the binary on PATH does not run on this machine',
        },
      ];
    }
    return [{ id: 'codex.binary', title: codexBinaryCheck.title, status: 'pass', detail: result.stdout.trim(), remediation: null }];
  },
};

export const codexLoginCheck: DoctorCheck = {
  id: 'codex.login',
  title: 'codex is authenticated',
  run: async (ctx) => {
    const result = await ctx.run({ bin: CODEX_BIN, args: ['login', 'status'], cwd: tmpdir(), timeoutMs: LOGIN_TIMEOUT_MS });
    const output = result.stdout.trim() === '' ? lastLine(result.stderr) : result.stdout.trim();
    if (result.spawnFailed || result.exitCode !== 0 || !output.toLowerCase().includes('logged in')) {
      return [
        {
          id: 'codex.login',
          title: codexLoginCheck.title,
          status: 'fail',
          detail: output === '' ? `"${CODEX_BIN} login status" exited ${String(result.exitCode)}` : output,
          // §28: "Codex authentication is handled outside Janus" — nothing in config.yaml fixes this.
          remediation: 'run `codex login` and complete the sign-in, then re-run janus doctor',
        },
      ];
    }
    return [{ id: 'codex.login', title: codexLoginCheck.title, status: 'pass', detail: output, remediation: null }];
  },
};

/**
 * Every `(model)` the active §18.6 profile can reach: the `*` entry, every explicit role entry, and every ladder
 * entry (efforts encoded in a ladder entry are split off by `parseLadderEntry`). Deduplicated by model, because a
 * model id is either accepted or not — the effort does not change that, and each probe costs a real round trip.
 * Insertion order is kept so the report is stable.
 */
export function distinctModels(config: JanusConfig, profile: string): Array<{ model: string; effort: Effort }> {
  const entries = config.model_profiles[profile];
  if (entries === undefined) return [];
  const seen = new Map<string, Effort>();
  for (const spec of Object.values(entries)) {
    if (!seen.has(spec.model)) seen.set(spec.model, spec.effort);
    for (const rung of spec.ladder ?? []) {
      const parsed = parseLadderEntry(rung, spec.effort);
      if (!seen.has(parsed.model)) seen.set(parsed.model, parsed.effort);
    }
  }
  return [...seen].map(([model, effort]) => ({ model, effort }));
}

/**
 * Spec §18.6: "`janus doctor` verifies each configured model is accepted by Codex with a one-token probe."
 *
 * Read-only, no writable roots, in a scratch directory that is not a git repository — which is exactly the §3.3
 * read-only shape, and works only because §18.4 now allows `--skip-git-repo-check` for that class (T06 probe R2).
 * Note the cost: Codex's own instruction preamble is ~14.5k input tokens per probe, so this check is the most
 * expensive thing doctor does.
 */
export const codexModelsCheck: DoctorCheck = {
  id: 'codex.model',
  title: 'every configured model is accepted by Codex',
  run: async (ctx) => {
    if (ctx.config === null) {
      return [skipped('codex.model', codexModelsCheck.title, 'no config.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const profile = ctx.config.workflow_models.profile;
    const models = distinctModels(ctx.config, profile);
    if (models.length === 0) {
      return [
        skipped(
          'codex.model',
          codexModelsCheck.title,
          `model profile "${profile}" names no models`,
          `define model_profiles.${profile} in .janus/config.yaml (§18.6)`,
        ),
      ];
    }

    const scratch = mkdtempSync(join(tmpdir(), 'janus-doctor-model-'));
    try {
      const findings: DoctorObservation[] = [];
      for (const { model, effort } of models) {
        const id = `codex.model[${model}]`;
        const result = await ctx.run({
          bin: CODEX_BIN,
          args: [
            'exec',
            '-C',
            scratch,
            '-s',
            'read-only',
            '--skip-git-repo-check',
            '--ephemeral',
            '-m',
            model,
            '-c',
            `model_reasoning_effort=${effort}`,
            '-',
          ],
          cwd: scratch,
          stdin: 'Reply with the single word ok and nothing else.',
          timeoutMs: MODEL_PROBE_TIMEOUT_MS,
        });
        if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
          findings.push({
            id,
            title: `model ${model} (effort ${effort}) is accepted`,
            status: 'pass',
            detail: `one-token probe succeeded (profile "${profile}"; ~14.5k input tokens)`,
            remediation: null,
          });
          continue;
        }
        const detail = result.timedOut
          ? `one-token probe timed out after ${String(MODEL_PROBE_TIMEOUT_MS / 1000)}s`
          : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`;
        findings.push({
          id,
          title: `model ${model} (effort ${effort}) is accepted`,
          status: 'fail',
          detail,
          remediation: `Codex would not run "${model}"; correct it in .janus/config.yaml under model_profiles.${profile}, or pick a profile whose models your account can use (§18.6)`,
        });
      }
      return findings;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/doctor/codex.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks/codex.ts tests/doctor/codex.test.ts
git commit -m "feat(doctor): check the codex binary, the login, and every configured model" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 10: The three §18.4 probes and the user-namespace check

**Files:**
- Create: `src/doctor/checks/sandbox.ts`, `tests/doctor/sandbox.test.ts`

**Interfaces:**
- Consumes: `DoctorCheck`, `DoctorObservation`, `skipped`; `CommandRunner`; `DoctorFs`; `lastLine`, `CODEX_BIN` (`src/doctor/checks/codex.ts`); `doctorContext`, `stubRunner`, `stubFs`.
- Produces:
  - `userNamespacesCheck: DoctorCheck` (id `sandbox.user_namespaces`)
  - `codexReadOnlyProbe: DoctorCheck` (id `codex.probe.read_only`)
  - `codexWorkspaceWriteProbe: DoctorCheck` (id `codex.probe.workspace_write`)
  - `ngUpdateProbe: DoctorCheck` (id `codex.probe.ng_update`)
  - `angularRepo(ctx): string | null` — the first goal repo whose `package.json` mentions `@angular/cli`

**Waited on a probe?** Yes, twice. `codex.probe.read_only` is the §3.3 read-only shape and only works because of Task 3's ruling — it is the standing regression test for it. `codex.probe.workspace_write` mirrors probe S1b exactly: `npm_config_store_dir` plus two `--add-dir` roots, and a pass requires `node_modules` to exist. `sandbox.user_namespaces` and `codex.probe.ng_update` waited on nothing.

**Cost:** these two Codex probes are real turns — roughly one and three minutes, ~15k and ~25k input tokens. Per Decision 15 there is no flag to skip them; §18.4 makes them the point of the command.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/sandbox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { angularRepo, codexReadOnlyProbe, codexWorkspaceWriteProbe, ngUpdateProbe, userNamespacesCheck } from '../../src/doctor/checks/sandbox.js';
import { doctorContext, stubFs, stubRunner } from '../helpers/doctor-fixtures.js';
import { validGoal } from '../fixtures/valid-goal.js';

const MAX_NS = '/proc/sys/user/max_user_namespaces';
const CLONE = '/proc/sys/kernel/unprivileged_userns_clone';

describe('userNamespacesCheck', () => {
  it('passes when the kernel allows unprivileged user namespaces', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '236542\n', [CLONE]: '1\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('236542');
  });

  it('fails when max_user_namespaces is zero, and says how to raise it', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '0\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('max_user_namespaces');
    expect(finding?.remediation).toContain('allow_unsandboxed');
  });

  it('fails when unprivileged_userns_clone is disabled', async () => {
    const ctx = doctorContext({ fs: stubFs({ files: { [MAX_NS]: '10000\n', [CLONE]: '0\n' } }) });
    const [finding] = await userNamespacesCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('unprivileged_userns_clone');
  });

  it('skips when the sysctl is not readable at all, rather than claiming a broken sandbox', async () => {
    const [finding] = await userNamespacesCheck.run(doctorContext({ fs: stubFs() }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).not.toBeNull();
  });
});

describe('codexReadOnlyProbe', () => {
  it('passes, and runs read-only with the git-repo check skipped and no writable root (§18.4, T06 probe R2)', async () => {
    let args: string[] = [];
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'codex';
          },
          result: { exitCode: 0, stdout: 'pong\n' },
        },
      ]),
    });
    const [finding] = await codexReadOnlyProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toContain('read-only');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--ephemeral');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('-m');
  });

  it('fails with the sandbox remediation when codex refuses to start', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'codex', result: { exitCode: 1, stderr: 'sandbox error: failed to create user namespace: EPERM' } },
      ]),
    });
    const [finding] = await codexReadOnlyProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('EPERM');
    expect(finding?.remediation).toContain('sandbox.user_namespaces');
  });
});

describe('codexWorkspaceWriteProbe', () => {
  it('passes when the scratch install leaves node_modules behind', async () => {
    let args: string[] = [];
    let env: Record<string, string> | undefined;
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'git', result: { exitCode: 0 } },
        {
          match: (r) => {
            args = r.args;
            env = r.env;
            return r.bin === 'codex';
          },
          result: { exitCode: 0 },
        },
      ]),
      fs: { ...stubFs(), exists: (path) => path.endsWith('node_modules') },
    });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toContain('workspace-write');
    expect(args.join(' ')).toContain('sandbox_workspace_write.network_access=true');
    expect(args.filter((a) => a === '--add-dir')).toHaveLength(2);
    expect(env?.['npm_config_store_dir']).toMatch(/\.pnpm-store$/u);
  });

  it('fails when the run exits 0 but installed nothing, because that is the store being unwritable', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        { match: (r) => r.bin === 'git', result: { exitCode: 0 } },
        { match: (r) => r.bin === 'codex', result: { exitCode: 0 } },
      ]),
      fs: { ...stubFs(), exists: () => false },
    });
    const [finding] = await codexWorkspaceWriteProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('node_modules');
    expect(finding?.remediation).toContain('pnpm.store');
  });
});

describe('ngUpdateProbe', () => {
  const paths = workspacePaths('/tmp/janus-doctor-ng');
  const goal = goalSchema.parse(validGoal);
  const angularPkg = JSON.stringify({ devDependencies: { '@angular/cli': '15.2.11' } });

  it('skips when no repository in the goal has the Angular CLI', async () => {
    const ctx = doctorContext({ paths, goal, fs: stubFs({ files: {} }) });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('Angular');
  });

  it('passes when ng update accepts --allow-dirty in the first Angular repo', async () => {
    const repo = paths.repoDir('ui-kit');
    let args: string[] = [];
    const ctx = doctorContext({
      paths,
      goal,
      fs: stubFs({ files: { [`${repo}/package.json`]: angularPkg } }),
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'pnpm';
          },
          result: { exitCode: 0, stdout: 'We analyzed your package.json\n' },
        },
      ]),
    });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(args).toEqual(['exec', 'ng', 'update', '--allow-dirty', '--dry-run']);
  });

  it('fails with a Node-version remediation when the Angular CLI rejects the running Node', async () => {
    const repo = paths.repoDir('ui-kit');
    const ctx = doctorContext({
      paths,
      goal,
      fs: stubFs({ files: { [`${repo}/package.json`]: angularPkg } }),
      run: stubRunner([
        {
          match: (r) => r.bin === 'pnpm',
          result: { exitCode: 1, stderr: 'Node.js version v24.5.0 detected.\nThe Angular CLI requires a minimum Node.js version of v14.20.' },
        },
      ]),
    });
    const [finding] = await ngUpdateProbe.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('Node');
  });
});
```

`validGoal` (`tests/fixtures/valid-goal.ts`) is the goal object the config tests already parse with `goalSchema.parse`; its first repo is `ui-kit`. Do not add a second goal builder.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/sandbox.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/checks/sandbox.js"`.

- [ ] **Step 3: Write the checks**

Create `src/doctor/checks/sandbox.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processEnv } from '../exec.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorCheckContext } from '../types.js';
import { CODEX_BIN, lastLine } from './codex.js';

const MAX_USER_NAMESPACES = '/proc/sys/user/max_user_namespaces';
const UNPRIVILEGED_USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';

const READ_ONLY_TIMEOUT_MS = 180_000;
const WORKSPACE_WRITE_TIMEOUT_MS = 600_000;
const NG_UPDATE_TIMEOUT_MS = 300_000;

const UNSANDBOXED_ESCAPE =
  'if this machine genuinely cannot provide user namespaces (many containers cannot), set agents.allow_unsandboxed: true in .janus/config.yaml — it is recorded in every checkpoint and leaves the §31 reflog audit as the only guard (§18.4)';

/**
 * Spec §18.4: "Bubblewrap requires user namespaces ... If the sandbox cannot start (containers without user
 * namespaces), doctor reports it." Reads the two sysctls that decide it. A missing sysctl is a `skip`, not a
 * `fail`: on a kernel without `/proc` entries, the Codex probes below are the real evidence.
 */
export const userNamespacesCheck: DoctorCheck = {
  id: 'sandbox.user_namespaces',
  title: 'user namespaces are available for the Codex sandbox',
  run: async (ctx) => {
    const max = ctx.fs.readText(MAX_USER_NAMESPACES);
    if (max === null) {
      return [
        skipped(
          'sandbox.user_namespaces',
          userNamespacesCheck.title,
          `${MAX_USER_NAMESPACES} is not readable; this kernel may not expose it`,
          `rely on the codex.probe.* findings below, which start a real sandbox; ${UNSANDBOXED_ESCAPE}`,
        ),
      ];
    }
    const limit = Number.parseInt(max.trim(), 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      return [
        {
          id: 'sandbox.user_namespaces',
          title: userNamespacesCheck.title,
          status: 'fail',
          detail: `${MAX_USER_NAMESPACES} is ${max.trim()}: unprivileged user namespaces are disabled, so bubblewrap cannot start`,
          remediation: `raise it (sysctl -w user.max_user_namespaces=15000, persisted in /etc/sysctl.d/), or ${UNSANDBOXED_ESCAPE}`,
        },
      ];
    }
    const clone = ctx.fs.readText(UNPRIVILEGED_USERNS_CLONE);
    if (clone !== null && clone.trim() === '0') {
      return [
        {
          id: 'sandbox.user_namespaces',
          title: userNamespacesCheck.title,
          status: 'fail',
          detail: `${UNPRIVILEGED_USERNS_CLONE} is 0: unprivileged user namespaces are disabled, so bubblewrap cannot start`,
          remediation: `enable it (sysctl -w kernel.unprivileged_userns_clone=1), or ${UNSANDBOXED_ESCAPE}`,
        },
      ];
    }
    return [
      {
        id: 'sandbox.user_namespaces',
        title: userNamespacesCheck.title,
        status: 'pass',
        detail: `user.max_user_namespaces=${String(limit)}`,
        remediation: null,
      },
    ];
  },
};

/**
 * Spec §18.4 probe 1: "a read-only `codex exec` echo". Deliberately passes no `-m`: this probes the sandbox, not
 * the model — `codex.model[...]` owns model acceptance. The scratch directory is **not** a git repository on
 * purpose, so this is the exact §3.3 read-only shape and stays the standing regression test for T06's probe R2
 * ruling.
 */
export const codexReadOnlyProbe: DoctorCheck = {
  id: 'codex.probe.read_only',
  title: 'a read-only codex exec starts and answers',
  run: async (ctx) => {
    const scratch = mkdtempSync(join(tmpdir(), 'janus-doctor-ro-'));
    try {
      const result = await ctx.run({
        bin: CODEX_BIN,
        args: ['exec', '-C', scratch, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-'],
        cwd: scratch,
        stdin: 'Reply with the single word pong and nothing else.',
        timeoutMs: READ_ONLY_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
        return [{ id: codexReadOnlyProbe.id, title: codexReadOnlyProbe.title, status: 'pass', detail: 'read-only sandbox started and the turn completed', remediation: null }];
      }
      return [
        {
          id: codexReadOnlyProbe.id,
          title: codexReadOnlyProbe.title,
          status: 'fail',
          detail: result.timedOut ? `no answer within ${String(READ_ONLY_TIMEOUT_MS / 1000)}s` : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`,
          remediation:
            'check the codex.login and sandbox.user_namespaces findings first; if both pass, the Codex sandbox itself will not start on this machine (§18.4)',
        },
      ];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

/**
 * Spec §18.4 probe 2: "a `workspace-write` install in a scratch project". Mirrors the §18.4 default exactly —
 * `npm_config_store_dir=<scratch>/.pnpm-store`, the repo and the store as the two `--add-dir` roots, no `.npmrc`
 * — which is the shape T06 probe S1b validated. A clean exit that left no `node_modules` is a failure: that is
 * what an unwritable store looks like from outside.
 *
 * The scratch tree is built with `node:fs` directly because it is setup, not observation; the **assertion** goes
 * through `ctx.fs.exists` so a unit test can decide the outcome.
 */
export const codexWorkspaceWriteProbe: DoctorCheck = {
  id: 'codex.probe.workspace_write',
  title: 'a workspace-write codex exec installs into the workspace pnpm store',
  run: async (ctx) => {
    const scratch = mkdtempSync(join(tmpdir(), 'janus-doctor-ww-'));
    const repo = join(scratch, 'repos', 'scratch');
    const store = join(scratch, '.pnpm-store');
    try {
      // Real `node:fs`, not `ctx.fs`: this is setup, and a stubbed `mkdirp` would leave `writeFileSync` with no
      // directory to write into. Only the **assertion** below goes through `ctx.fs`, so a unit test can decide it.
      mkdirSync(repo, { recursive: true });
      mkdirSync(store, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        `${JSON.stringify({ name: 'janus-doctor-scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
      );
      // A git work tree, because the code-writing class always has one (§3.3) and gets no `--skip-git-repo-check`.
      for (const args of [['init', '-q', '-b', 'main'], ['add', 'package.json'], ['-c', 'user.name=janus', '-c', 'user.email=janus@localhost', 'commit', '-q', '-m', 'scratch']]) {
        await ctx.run({ bin: 'git', args: ['-C', repo, ...args], cwd: repo, timeoutMs: 30_000 });
      }

      const result = await ctx.run({
        bin: CODEX_BIN,
        args: [
          'exec',
          '-C',
          repo,
          '-s',
          'workspace-write',
          '-c',
          'sandbox_workspace_write.network_access=true',
          '--add-dir',
          repo,
          '--add-dir',
          store,
          '--ephemeral',
          '-',
        ],
        cwd: repo,
        env: { ...processEnv(), npm_config_store_dir: store },
        stdin: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        timeoutMs: WORKSPACE_WRITE_TIMEOUT_MS,
      });

      if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
        return [
          {
            id: codexWorkspaceWriteProbe.id,
            title: codexWorkspaceWriteProbe.title,
            status: 'fail',
            detail: result.timedOut ? `no answer within ${String(WORKSPACE_WRITE_TIMEOUT_MS / 1000)}s` : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`,
            remediation: 'check codex.probe.read_only and sandbox.user_namespaces first; a workspace-write sandbox needs the same namespaces plus network access (§18.4)',
          },
        ];
      }
      if (!ctx.fs.exists(join(repo, 'node_modules'))) {
        return [
          {
            id: codexWorkspaceWriteProbe.id,
            title: codexWorkspaceWriteProbe.title,
            status: 'fail',
            detail: 'the run finished cleanly but left no node_modules, so nothing was installed',
            remediation: 'see the pnpm.store finding: a store that is not writable, or a network the sandbox cannot reach, produces exactly this',
          },
        ];
      }
      return [
        {
          id: codexWorkspaceWriteProbe.id,
          title: codexWorkspaceWriteProbe.title,
          status: 'pass',
          detail: 'workspace-write sandbox installed through npm_config_store_dir with no .npmrc',
          remediation: null,
        },
      ];
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
};

/** The first goal repository whose `package.json` mentions `@angular/cli`, or null. */
export function angularRepo(ctx: DoctorCheckContext): string | null {
  if (ctx.paths === null || ctx.goal === null) return null;
  for (const repo of ctx.goal.repos) {
    const manifest = ctx.fs.readText(join(ctx.paths.repoDir(repo.name), 'package.json'));
    if (manifest !== null && manifest.includes('@angular/cli')) return repo.name;
  }
  return null;
}

/**
 * Spec §18.4 probe 3: "an `ng update --allow-dirty` dry run when Angular is present".
 *
 * Run **directly**, not through Codex. §18.4 names a sandbox for the other two probes and none for this one, and
 * spending a model turn (~15k input tokens and a minute) to learn whether the Angular CLI accepts a flag is not a
 * trade worth making. What this probe actually answers is: the repository is a valid Angular workspace, the CLI
 * runs on the Node that is on PATH, and `--allow-dirty` is accepted. (Interpretation of §18.4, recorded in the
 * plan's Decision 12.)
 */
export const ngUpdateProbe: DoctorCheck = {
  id: 'codex.probe.ng_update',
  title: 'ng update --allow-dirty runs in an Angular repository',
  run: async (ctx) => {
    const name = angularRepo(ctx);
    if (name === null || ctx.paths === null) {
      return [
        skipped(
          ngUpdateProbe.id,
          ngUpdateProbe.title,
          'no repository in this goal has @angular/cli in its package.json, so there is no Angular workspace to probe',
          'nothing to do; this probe applies only once an Angular repository is cloned into the workspace (§18.4)',
        ),
      ];
    }
    const cwd = ctx.paths.repoDir(name);
    const result = await ctx.run({ bin: 'pnpm', args: ['exec', 'ng', 'update', '--allow-dirty', '--dry-run'], cwd, timeoutMs: NG_UPDATE_TIMEOUT_MS });
    if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
      return [{ id: ngUpdateProbe.id, title: ngUpdateProbe.title, status: 'pass', detail: `ng update --allow-dirty --dry-run succeeded in ${name}`, remediation: null }];
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const nodeVersion = /Node\.js version/iu.test(output) || /requires a minimum Node\.js version/iu.test(output);
    return [
      {
        id: ngUpdateProbe.id,
        title: ngUpdateProbe.title,
        status: 'fail',
        detail: result.timedOut ? `ng update did not finish within ${String(NG_UPDATE_TIMEOUT_MS / 1000)}s` : lastLine(output) || `pnpm exec ng update exited ${String(result.exitCode)}`,
        remediation: nodeVersion
          ? `the Angular CLI in ${name} rejects the Node version on PATH; run janus (and its agents) on a Node the repository's Angular major supports`
          : `run \`pnpm exec ng update --allow-dirty --dry-run\` in repos/${name} by hand and fix what it reports; code-writing agents run the same command (§18.4)`,
      },
    ];
  },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/doctor/sandbox.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks/sandbox.ts tests/doctor/sandbox.test.ts
git commit -m "feat(doctor): add the three §18.4 codex probes and the user-namespace check" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 11: `git.identity`, the token env vars, and the `janus/*` branch-spec warning

**Files:**
- Create: `src/doctor/checks/repo.ts`, `tests/doctor/repo.test.ts`

**Interfaces:**
- Consumes: `parseIdent`, `formatIdentity` (`src/git/identity.ts`); `stateRemote`, `stateBranchName` (`src/workspace/remotes.ts`); `ConfigError` (`src/config/errors.ts`); `skipped`; `lastLine`.
- Produces:
  - `gitIdentityCheck: DoctorCheck` (id `git.identity`)
  - `tokensCheck: DoctorCheck` (id prefix `tokens`, one finding per required variable, id `tokens[<VAR>]`)
  - `branchSpecCheck: DoctorCheck` (id `state.branch_spec`)

**Waited on a probe?** No. All three are configuration and local-git observations; none of them touches Codex, and none could have been answered differently by the spike.

**Why the branch-spec check is a `warn` and not a `fail`:** §33 assumes "the VCS root branch spec includes `ai/*` and excludes `janus/*`", and §31 item 33 wants doctor to detect "a missing `janus/*` branch exclusion". Janus cannot read TeamCity's VCS root configuration — TeamCity is unreachable from the development machine and there is no API call in the §3.2 `CiProvider` interface for it. What Janus *can* see is the condition that makes the exclusion necessary: the state branch living in a product repository, which is what `stateRemote` reports. So the check warns on that condition, names the repository, and gives the two ways out. `tasks.md` T07 calls it a "warning" for the same reason.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { branchSpecCheck, gitIdentityCheck, tokensCheck } from '../../src/doctor/checks/repo.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { doctorContext, stubRunner } from '../helpers/doctor-fixtures.js';
import { validGoal } from '../fixtures/valid-goal.js';

const goal = goalSchema.parse(validGoal);
const paths = workspacePaths('/tmp/janus-doctor-repo');

describe('gitIdentityCheck', () => {
  it('passes and reports the identity git resolved', async () => {
    const ctx = doctorContext({
      run: stubRunner([{ match: (r) => r.bin === 'git', result: { stdout: 'Martin <martin@example.com> 1758369600 +0200\n' } }]),
    });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toBe('Martin <martin@example.com>');
  });

  it('fails when git cannot tell who you are, and names both config keys', async () => {
    const ctx = doctorContext({
      run: stubRunner([
        {
          match: (r) => r.bin === 'git',
          result: { exitCode: 128, stderr: 'fatal: unable to auto-detect email address (got 'dev@box.(none)')' },
        },
      ]),
    });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('auto-detect email');
    expect(finding?.remediation).toContain('user.name');
    expect(finding?.remediation).toContain('user.email');
  });

  it('fails when git prints something it cannot parse as an identity', async () => {
    const ctx = doctorContext({ run: stubRunner([{ match: (r) => r.bin === 'git', result: { stdout: 'nonsense\n' } }]) });
    const [finding] = await gitIdentityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).not.toBeNull();
  });
});

describe('tokensCheck', () => {
  const real = configSchema.parse({
    workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
    teamcity: { url: 'https://teamcity.example.internal' },
    bitbucket: { url: 'https://bitbucket.example.internal' },
  });

  it('passes for each set variable and never prints its value (§32 rule 12)', async () => {
    const ctx = doctorContext({
      config: real,
      env: { JANUS_TEAMCITY_TOKEN: 'tc-secret-value', JANUS_BITBUCKET_TOKEN: 'bb-secret-value' },
    });
    const findings = await tokensCheck.run(ctx);
    expect(findings.map((f) => f.id)).toEqual(['tokens[JANUS_TEAMCITY_TOKEN]', 'tokens[JANUS_BITBUCKET_TOKEN]']);
    expect(findings.every((f) => f.status === 'pass')).toBe(true);
    const text = JSON.stringify(findings);
    expect(text).not.toContain('tc-secret-value');
    expect(text).not.toContain('bb-secret-value');
  });

  it('fails the missing one and treats an empty value as missing', async () => {
    const ctx = doctorContext({ config: real, env: { JANUS_TEAMCITY_TOKEN: '   ' } });
    const findings = await tokensCheck.run(ctx);
    expect(findings.map((f) => `${f.id}=${f.status}`)).toEqual(['tokens[JANUS_TEAMCITY_TOKEN]=fail', 'tokens[JANUS_BITBUCKET_TOKEN]=fail']);
    expect(findings[0]?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });

  it('skips entirely when both providers are fakes, because no token is required', async () => {
    const findings = await tokensCheck.run(doctorContext({ env: {} }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('tokens');
    expect(findings[0]?.status).toBe('skip');
  });
});

describe('branchSpecCheck', () => {
  it('passes when a dedicated state repository is configured', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
      state: { repo: { project: 'FE', slug: 'janus-state' } },
    });
    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('janus-state');
  });

  it('warns, names the product repository and the branch, and offers both ways out (§33, §31.33)', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'teamcity', scm_provider: 'fake' },
      teamcity: { url: 'https://teamcity.example.internal' },
      bitbucket: { url: 'https://bitbucket.example.internal' },
    });
    const [finding] = await branchSpecCheck.run(doctorContext({ config, goal, paths }));
    expect(finding?.status).toBe('warn');
    expect(finding?.detail).toContain('ui-kit');
    expect(finding?.detail).toContain('janus/angular-15-to-16');
    expect(finding?.remediation).toContain('janus/*');
    expect(finding?.remediation).toContain('state.repo');
  });

  it('skips outside a workspace', async () => {
    const [finding] = await branchSpecCheck.run(doctorContext({ config: null, goal: null }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/repo.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/checks/repo.js"`.

- [ ] **Step 3: Write the checks**

Create `src/doctor/checks/repo.ts`:

```ts
import { ConfigError } from '../../config/errors.js';
import { formatIdentity, parseIdent } from '../../git/identity.js';
import { stateBranchName, stateRemote } from '../../workspace/remotes.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorObservation } from '../types.js';
import { lastLine } from './codex.js';

const GIT_TIMEOUT_MS = 15_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * Spec §8: approvals are attributed to the git committer identity, and §2 of the checkpoint rule commits on the
 * state branch as that identity. `git var GIT_COMMITTER_IDENT` is what git itself resolves, so it covers
 * `user.name`/`user.email` and the `GIT_COMMITTER_*` environment overrides in one call.
 */
export const gitIdentityCheck: DoctorCheck = {
  id: 'git.identity',
  title: 'git knows who you are',
  run: async (ctx) => {
    const cwd = ctx.paths?.root ?? '.';
    const result = await ctx.run({ bin: 'git', args: ['var', 'GIT_COMMITTER_IDENT'], cwd, timeoutMs: GIT_TIMEOUT_MS });
    const remediation =
      'set both: git config --global user.name "Your Name" && git config --global user.email "you@example.com"';
    if (result.spawnFailed || result.exitCode !== 0) {
      return [
        {
          id: 'git.identity',
          title: gitIdentityCheck.title,
          status: 'fail',
          detail: result.spawnFailed ? 'git is not on PATH' : lastLine(result.stderr) || `git var exited ${String(result.exitCode)}`,
          remediation: result.spawnFailed ? 'install git and put it on PATH' : remediation,
        },
      ];
    }
    const identity = parseIdent(result.stdout.trim());
    if (identity === null) {
      return [
        {
          id: 'git.identity',
          title: gitIdentityCheck.title,
          status: 'fail',
          detail: `git var GIT_COMMITTER_IDENT printed something unparseable: ${result.stdout.trim()}`,
          remediation,
        },
      ];
    }
    return [{ id: 'git.identity', title: gitIdentityCheck.title, status: 'pass', detail: formatIdentity(identity), remediation: null }];
  },
};

/**
 * Spec §28: "Secrets: `JANUS_TEAMCITY_TOKEN`, `JANUS_BITBUCKET_TOKEN`." Only the variables the **configured**
 * providers actually need are checked — a fake-provider workspace needs none, which is how Janus is developed.
 *
 * §32 rule 12: the finding reports the variable **name** and whether it is set. It never reports the value, its
 * length, or any prefix of it.
 */
export const tokensCheck: DoctorCheck = {
  id: 'tokens',
  title: 'the tokens the configured providers need are present',
  run: async (ctx) => {
    if (ctx.config === null) {
      return [skipped('tokens', tokensCheck.title, 'no config.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const required: Array<{ variable: string; why: string }> = [];
    if (ctx.config.workflow.ci_provider === 'teamcity') {
      required.push({ variable: ctx.config.teamcity.token_env, why: 'workflow.ci_provider is "teamcity"' });
    }
    if (ctx.config.workflow.scm_provider === 'bitbucket-server') {
      required.push({ variable: ctx.config.bitbucket.token_env, why: 'workflow.scm_provider is "bitbucket-server"' });
    }
    if (required.length === 0) {
      return [
        skipped(
          'tokens',
          tokensCheck.title,
          `no token is required: ci_provider is "${ctx.config.workflow.ci_provider}" and scm_provider is "${ctx.config.workflow.scm_provider}"`,
          'nothing to do; tokens become required when a real provider is configured (§28)',
        ),
      ];
    }
    const findings: DoctorObservation[] = [];
    for (const { variable, why } of required) {
      const value = ctx.env[variable];
      const present = value !== undefined && value.trim() !== '';
      findings.push({
        id: `tokens[${variable}]`,
        title: `${variable} is set`,
        status: present ? 'pass' : 'fail',
        detail: present ? `set (${why})` : `not set, and it is required because ${why}`,
        remediation: present ? null : `export ${variable}=<your access token> in the shell that runs janus; it is never written to .janus/ (§28, §32 rule 12)`,
      });
    }
    return findings;
  },
};

/**
 * Spec §33: "The VCS root branch spec includes `ai/*` and excludes `janus/*`." §31 item 33: doctor detects "a
 * missing `janus/*` branch exclusion".
 *
 * Janus cannot read a VCS root's branch spec — TeamCity is a work-network system and the §3.2 `CiProvider`
 * interface has no call for it. What it can see is the condition that makes the exclusion necessary: the state
 * branch living inside a product repository, so every checkpoint pushes a `janus/<goal-id>` branch into a
 * repository whose CI watches branches. That is a `warn`, with both remedies named.
 */
export const branchSpecCheck: DoctorCheck = {
  id: 'state.branch_spec',
  title: 'the state branch will not trigger product CI',
  run: async (ctx) => {
    if (ctx.config === null || ctx.goal === null) {
      return [skipped('state.branch_spec', branchSpecCheck.title, 'no config.yaml or goal.yaml: doctor is not running inside a workspace', NO_WORKSPACE)];
    }
    const branch = stateBranchName(ctx.goal.id);
    let remote;
    try {
      remote = stateRemote(ctx.goal, ctx.config);
    } catch (error) {
      const detail = error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error);
      return [
        {
          id: 'state.branch_spec',
          title: branchSpecCheck.title,
          status: 'warn',
          detail: `cannot tell where the state branch lives: ${detail}`,
          remediation: 'set state.clone_url (or state.repo plus bitbucket.url) in .janus/config.yaml so the state remote resolves (§28)',
        },
      ];
    }
    if (remote.remoteName === 'state-repo') {
      return [
        {
          id: 'state.branch_spec',
          title: branchSpecCheck.title,
          status: 'pass',
          detail: `the state branch ${branch} lives in the dedicated state repository ${remote.url}`,
          remediation: null,
        },
      ];
    }
    return [
      {
        id: 'state.branch_spec',
        title: branchSpecCheck.title,
        status: 'warn',
        detail: `the state branch ${branch} lives in the product repository ${remote.remoteName}, whose CI watches branches`,
        remediation: `exclude janus/* from that repository's VCS root branch spec (and keep ai/* included), or give the goal a dedicated state repository with state.repo / state.clone_url in .janus/config.yaml (§33)`,
      },
    ];
  },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/doctor/repo.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks/repo.ts tests/doctor/repo.test.ts
git commit -m "feat(doctor): check git identity, provider tokens, and the janus/* branch spec" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 12: `pnpm.store` — the store path resolves and is writable

**Files:**
- Create: `src/doctor/checks/pnpm.ts`, `tests/doctor/pnpm.test.ts`

**Interfaces:**
- Consumes: `DoctorCheck`, `skipped`, `DoctorFs.probeWritable`, `lastLine`; `WorkspacePaths.pnpmStoreDir`.
- Produces: `pnpmStoreCheck: DoctorCheck` (id `pnpm.store`)

**Waited on a probe?** Partly. Probe S1b settled that `agents.pnpm_store: workspace` needs no `.npmrc` and that `<workspace>/.pnpm-store` is the directory that must be writable; this check asserts exactly that directory for the `workspace` setting, and resolves `pnpm store path` only for the `global` setting — which is the branch `resolveGlobalPnpmStore` in `src/agents/sandbox.ts` already documents as doctor's job.

**Why a write probe and not `access(W_OK)`:** §31 item 33 names "a read-only pnpm store" explicitly. `access(W_OK)` reports the permission bits and is wrong on read-only mounts, full filesystems and several container overlay configurations — the exact environments §18.4 warns about. `DoctorFs.probeWritable` creates and deletes a file.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/pnpm.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { pnpmStoreCheck } from '../../src/doctor/checks/pnpm.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { doctorContext, stubFs, stubRunner } from '../helpers/doctor-fixtures.js';

const paths = workspacePaths('/tmp/janus-doctor-pnpm');
const workspaceStore = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
const globalStore = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' }, agents: { pnpm_store: 'global' } });

describe('pnpmStoreCheck', () => {
  it('passes when the workspace store is writable, and never shells out to pnpm', async () => {
    const ctx = doctorContext({ config: workspaceStore, paths, fs: stubFs() });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain(join(paths.root, '.pnpm-store'));
  });

  it('fails with the exact write error when the workspace store cannot be written', async () => {
    const ctx = doctorContext({ config: workspaceStore, paths, fs: stubFs({ writableError: "EROFS: read-only file system, open '/x'" }) });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('EROFS');
    expect(finding?.remediation).toContain('npm_config_store_dir');
  });

  it('resolves the global store with `pnpm store path` and probes that instead', async () => {
    let args: string[] = [];
    const ctx = doctorContext({
      config: globalStore,
      paths,
      run: stubRunner([
        {
          match: (r) => {
            args = r.args;
            return r.bin === 'pnpm';
          },
          result: { stdout: '/home/dev/.local/share/pnpm/store/v10\n' },
        },
      ]),
      fs: stubFs(),
    });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(args).toEqual(['store', 'path']);
    expect(finding?.status).toBe('pass');
    expect(finding?.detail).toContain('/home/dev/.local/share/pnpm/store/v10');
  });

  it('fails when `pnpm store path` cannot run at all', async () => {
    const ctx = doctorContext({
      config: globalStore,
      paths,
      run: stubRunner([{ match: (r) => r.bin === 'pnpm', result: { spawnFailed: true, exitCode: null, stderr: 'spawn pnpm ENOENT' } }]),
    });
    const [finding] = await pnpmStoreCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('pnpm');
  });

  it('skips outside a workspace, where there is no store to check', async () => {
    const [finding] = await pnpmStoreCheck.run(doctorContext({ config: null, paths: null }));
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('janus init');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/pnpm.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/checks/pnpm.js"`.

- [ ] **Step 3: Write the check**

Create `src/doctor/checks/pnpm.ts`:

```ts
import { skipped } from '../types.js';
import type { DoctorCheck } from '../types.js';
import { lastLine } from './codex.js';

const STORE_PATH_TIMEOUT_MS = 60_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * Spec §31 item 33: doctor detects "a read-only pnpm store". §18.4 gives two shapes:
 *
 * - `agents.pnpm_store: workspace` (the default): the store is `<workspace>/.pnpm-store`, handed to every
 *   code-writing agent as `npm_config_store_dir` and added as its second writable root. No `pnpm` process is
 *   needed to know where it is.
 * - `agents.pnpm_store: global`: the store is wherever `pnpm store path` says, and that path plus `~/.cache`
 *   become the writable roots instead. `src/agents/sandbox.ts` already points here for the check.
 *
 * Either way the test is a real write, not a permission-bit read: read-only mounts, full filesystems and some
 * container overlays all report writable bits and then fail the write, which is precisely the case that makes
 * every code-writing agent fail with an install error nobody can explain.
 */
export const pnpmStoreCheck: DoctorCheck = {
  id: 'pnpm.store',
  title: 'the pnpm store is writable',
  run: async (ctx) => {
    if (ctx.config === null || ctx.paths === null) {
      return [skipped('pnpm.store', pnpmStoreCheck.title, 'no workspace: the store location comes from config.yaml and the workspace layout', NO_WORKSPACE)];
    }

    let store: string;
    if (ctx.config.agents.pnpm_store === 'global') {
      const result = await ctx.run({ bin: 'pnpm', args: ['store', 'path'], cwd: ctx.paths.root, timeoutMs: STORE_PATH_TIMEOUT_MS });
      if (result.spawnFailed || result.exitCode !== 0 || result.stdout.trim() === '') {
        return [
          {
            id: 'pnpm.store',
            title: pnpmStoreCheck.title,
            status: 'fail',
            detail: result.spawnFailed ? 'pnpm is not on PATH' : lastLine(result.stderr) || ``pnpm store path` exited ${String(result.exitCode)} with no path`,
            remediation: 'install pnpm and put it on PATH, or set agents.pnpm_store: workspace in .janus/config.yaml so the store lives inside the workspace (§18.4)',
          },
        ];
      }
      store = result.stdout.trim();
    } else {
      store = ctx.paths.pnpmStoreDir;
    }

    const error = ctx.fs.probeWritable(store);
    if (error !== null) {
      return [
        {
          id: 'pnpm.store',
          title: pnpmStoreCheck.title,
          status: 'fail',
          detail: `${store} is not writable: ${error}`,
          remediation: `make it writable, or move it: with agents.pnpm_store: workspace the store is <workspace>/.pnpm-store and every code-writing agent gets it as npm_config_store_dir and as a writable root (§18.4)`,
        },
      ];
    }
    return [
      {
        id: 'pnpm.store',
        title: pnpmStoreCheck.title,
        status: 'pass',
        detail: `${store} is writable (agents.pnpm_store: ${ctx.config.agents.pnpm_store})`,
        remediation: null,
      },
    ];
  },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/doctor/pnpm.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks/pnpm.ts tests/doctor/pnpm.test.ts
git commit -m "feat(doctor): probe that the configured pnpm store is really writable" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 13: `provider.ci` and `provider.scm` — reachability, skipped for fakes

**Files:**
- Create: `src/doctor/checks/providers.ts`, `tests/doctor/providers.test.ts`

**Interfaces:**
- Consumes: `HttpProbe`, `skipped`, `DoctorCheck`, `DoctorObservation`; `stubHttp`.
- Produces:
  - `reachability(input): Promise<DoctorObservation>` — the shared shape both checks use
  - `ciReachabilityCheck: DoctorCheck` (id `provider.ci`)
  - `scmReachabilityCheck: DoctorCheck` (id `provider.scm`)

**Waited on a probe?** No — and it could not have. **Bitbucket Server and TeamCity are not reachable from this machine** (§33 lists them as work-network systems), so this check is developed entirely against `stubHttp` and runs for real for the first time in T24's §29.6 first-contact runbook. That is precisely why `HttpProbe` is a seam: nothing in this repository's test suite may make a network request.

**Endpoints.** TeamCity: `GET <url>/app/rest/server` with `Authorization: Bearer <token>` — the smallest authenticated read in the REST API, used by T15's fixture capture too. Bitbucket Server: `GET <url>/rest/api/1.0/projects?limit=1`, same header. Both are read-only and idempotent.

- [ ] **Step 1: Write the failing test**

Create `tests/doctor/providers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { ciReachabilityCheck, scmReachabilityCheck } from '../../src/doctor/checks/providers.js';
import type { HttpProbeRequest } from '../../src/doctor/http.js';
import { doctorContext, stubHttp } from '../helpers/doctor-fixtures.js';

const teamcity = configSchema.parse({
  workflow: { ci_provider: 'teamcity', scm_provider: 'bitbucket-server' },
  teamcity: { url: 'https://teamcity.example.internal' },
  bitbucket: { url: 'https://bitbucket.example.internal' },
});

describe('ciReachabilityCheck', () => {
  it('skips for the fake provider', async () => {
    const [finding] = await ciReachabilityCheck.run(doctorContext());
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('fake');
  });

  it('skips for the local provider, which reaches nothing', async () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'local', scm_provider: 'fake' } });
    const [finding] = await ciReachabilityCheck.run(doctorContext({ config }));
    expect(finding?.status).toBe('skip');
    expect(finding?.detail).toContain('local');
  });

  it('passes for a TeamCity that answers, and never puts the token in the finding', async () => {
    let seen: HttpProbeRequest | null = null;
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_TEAMCITY_TOKEN: 'tc-secret-value' },
      http: async (request) => {
        seen = request;
        return { ok: true, status: 200, error: null };
      },
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(seen?.url).toBe('https://teamcity.example.internal/app/rest/server');
    expect(seen?.headers['Authorization']).toBe('Bearer tc-secret-value');
    expect(JSON.stringify(finding)).not.toContain('tc-secret-value');
  });

  it('fails with a token remediation on 401', async () => {
    const ctx = doctorContext({ config: teamcity, env: { JANUS_TEAMCITY_TOKEN: 't' }, http: stubHttp({ ok: false, status: 401 }) });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('401');
    expect(finding?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });

  it('fails with a network remediation when the host never answers', async () => {
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_TEAMCITY_TOKEN: 't' },
      http: stubHttp({ ok: false, status: null, error: 'getaddrinfo ENOTFOUND teamcity.example.internal' }),
    });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.detail).toContain('ENOTFOUND');
    expect(finding?.remediation).toContain('network');
  });

  it('skips when the token is not set, because tokens[...] already reports that', async () => {
    const ctx = doctorContext({ config: teamcity, env: {} });
    const [finding] = await ciReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('skip');
    expect(finding?.remediation).toContain('JANUS_TEAMCITY_TOKEN');
  });
});

describe('scmReachabilityCheck', () => {
  it('skips for the fake provider', async () => {
    const [finding] = await scmReachabilityCheck.run(doctorContext());
    expect(finding?.status).toBe('skip');
  });

  it('passes for a Bitbucket Server that answers', async () => {
    let url = '';
    const ctx = doctorContext({
      config: teamcity,
      env: { JANUS_BITBUCKET_TOKEN: 'bb' },
      http: async (request) => {
        url = request.url;
        return { ok: true, status: 200, error: null };
      },
    });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('pass');
    expect(url).toBe('https://bitbucket.example.internal/rest/api/1.0/projects?limit=1');
  });

  it('fails on 403 and names the token variable', async () => {
    const ctx = doctorContext({ config: teamcity, env: { JANUS_BITBUCKET_TOKEN: 'bb' }, http: stubHttp({ ok: false, status: 403 }) });
    const [finding] = await scmReachabilityCheck.run(ctx);
    expect(finding?.status).toBe('fail');
    expect(finding?.remediation).toContain('JANUS_BITBUCKET_TOKEN');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/doctor/providers.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/doctor/checks/providers.js"`.

- [ ] **Step 3: Write the checks**

Create `src/doctor/checks/providers.ts`:

```ts
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorCheckContext, DoctorObservation } from '../types.js';

const PROBE_TIMEOUT_MS = 15_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

interface ReachabilityInput {
  ctx: DoctorCheckContext;
  id: string;
  title: string;
  /** The human name of the system, for the detail line. */
  system: string;
  url: string;
  tokenEnv: string;
}

/**
 * One authenticated, read-only GET. §32 rule 12: the token reaches the `Authorization` header and nothing else —
 * never the detail, never the remediation, never a log line.
 */
async function reachability(input: ReachabilityInput): Promise<DoctorObservation> {
  const { ctx, id, title, system, url, tokenEnv } = input;
  const token = ctx.env[tokenEnv];
  if (token === undefined || token.trim() === '') {
    return skipped(
      id,
      title,
      `cannot probe ${system}: ${tokenEnv} is not set`,
      `set ${tokenEnv} and re-run janus doctor; the tokens[${tokenEnv}] finding above reports the same thing`,
    );
  }
  const result = await ctx.http({ url, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeoutMs: PROBE_TIMEOUT_MS });
  if (result.ok) {
    return { id, title, status: 'pass', detail: `${system} answered ${String(result.status)} at ${url}`, remediation: null };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      id,
      title,
      status: 'fail',
      detail: `${system} answered ${String(result.status)} at ${url}: the token was rejected`,
      remediation: `check that ${tokenEnv} holds a current HTTP access token with read permission for ${system}`,
    };
  }
  if (result.status === null) {
    return {
      id,
      title,
      status: 'fail',
      detail: `${system} did not answer at ${url}: ${result.error ?? 'no response'}`,
      remediation: `check the URL in .janus/config.yaml and your network: ${system} is reachable only from the work network (§33)`,
    };
  }
  return {
    id,
    title,
    status: 'fail',
    detail: `${system} answered ${String(result.status)} at ${url}`,
    remediation: `check the URL in .janus/config.yaml; ${url} did not answer the way the ${system} REST API should`,
  };
}

export const ciReachabilityCheck: DoctorCheck = {
  id: 'provider.ci',
  title: 'the configured CI provider is reachable',
  run: async (ctx) => {
    if (ctx.config === null) return [skipped('provider.ci', ciReachabilityCheck.title, 'no config.yaml', NO_WORKSPACE)];
    const provider = ctx.config.workflow.ci_provider;
    if (provider !== 'teamcity') {
      return [
        skipped(
          'provider.ci',
          ciReachabilityCheck.title,
          `workflow.ci_provider is "${provider}", which reaches no network service`,
          'nothing to do; this probe applies when workflow.ci_provider is "teamcity"',
        ),
      ];
    }
    const base = (ctx.config.teamcity.url ?? '').replace(/\/+$/u, '');
    return [
      await reachability({
        ctx,
        id: 'provider.ci',
        title: ciReachabilityCheck.title,
        system: 'TeamCity',
        url: `${base}/app/rest/server`,
        tokenEnv: ctx.config.teamcity.token_env,
      }),
    ];
  },
};

export const scmReachabilityCheck: DoctorCheck = {
  id: 'provider.scm',
  title: 'the configured SCM provider is reachable',
  run: async (ctx) => {
    if (ctx.config === null) return [skipped('provider.scm', scmReachabilityCheck.title, 'no config.yaml', NO_WORKSPACE)];
    const provider = ctx.config.workflow.scm_provider;
    if (provider !== 'bitbucket-server') {
      return [
        skipped(
          'provider.scm',
          scmReachabilityCheck.title,
          `workflow.scm_provider is "${provider}", which reaches no network service`,
          'nothing to do; this probe applies when workflow.scm_provider is "bitbucket-server"',
        ),
      ];
    }
    const base = (ctx.config.bitbucket.url ?? '').replace(/\/+$/u, '');
    return [
      await reachability({
        ctx,
        id: 'provider.scm',
        title: scmReachabilityCheck.title,
        system: 'Bitbucket Server',
        url: `${base}/rest/api/1.0/projects?limit=1`,
        tokenEnv: ctx.config.bitbucket.token_env,
      }),
    ];
  },
};
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project unit tests/doctor/providers.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks/providers.ts tests/doctor/providers.test.ts
git commit -m "feat(doctor): probe provider reachability and skip it for fakes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 14: The registry, the `janus doctor` command, and the whole-branch verification

**Files:**
- Create: `src/doctor/index.ts`, `tests/doctor/registry.test.ts`, `tests/cli/doctor.test.ts`
- Modify: `src/cli/commands/doctor.ts`, `src/cli/context.ts`, `tests/cli/commands.test.ts`, `tests/integration/codex-smoke.test.ts` (probe D1), `README.md`, `tasks.md`

**Interfaces:**
- Consumes: every check from Tasks 9 to 13; `runDoctor`, `doctorJson`, `renderDoctorHuman`, `doctorExitCode`; `runCommand`, `fetchProbe`, `nodeFs`; `findWorkspaceRoot`, `workspacePaths`, `loadConfig`, `loadGoal`, `CONFIG_FILE`, `GOAL_FILE`; `createHarness`.
- Produces:
  - `ALL_CHECKS: readonly DoctorCheck[]` — thirteen checks in report order
  - `buildDoctorContext(input: { cwd: string; env: Record<string, string | undefined>; now(): Date }): DoctorCheckContext`
  - `CliOverrides.doctorChecks?: readonly DoctorCheck[]` — the test seam, alongside the existing `steps` and `providers`
  - `janus doctor` and `janus doctor --json`, exiting `0` unless a check failed

- [ ] **Step 1: Write the failing registry test**

Create `tests/doctor/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALL_CHECKS } from '../../src/doctor/index.js';
import { doctorContext, stubFs } from '../helpers/doctor-fixtures.js';

/** Fails every subprocess and every HTTP probe: the worst case each check has to describe. */
const hostile = () =>
  doctorContext({
    run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'simulated failure', timedOut: false, spawnFailed: false, durationMs: 1 }),
    http: async () => ({ ok: false, status: 500, error: null }),
    fs: stubFs({ writableError: 'EROFS: read-only file system' }),
  });

describe('ALL_CHECKS', () => {
  it('covers every check tasks.md T07 names, in report order, with unique ids', () => {
    expect(ALL_CHECKS.map((check) => check.id)).toEqual([
      'codex.binary',
      'codex.login',
      'git.identity',
      'tokens',
      'sandbox.user_namespaces',
      'codex.probe.read_only',
      'codex.probe.workspace_write',
      'codex.probe.ng_update',
      'codex.model',
      'pnpm.store',
      'state.branch_spec',
      'provider.ci',
      'provider.scm',
    ]);
    expect(new Set(ALL_CHECKS.map((check) => check.id)).size).toBe(ALL_CHECKS.length);
    expect(ALL_CHECKS.every((check) => check.title.trim().length > 0)).toBe(true);
  });

  it('gives every non-pass finding a remediation, on the worst-case path, for every check', async () => {
    for (const check of ALL_CHECKS) {
      const findings = await check.run(hostile());
      expect(findings.length, check.id).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.id === check.id || finding.id.startsWith(`${check.id}[`), `${check.id} -> ${finding.id}`).toBe(true);
        expect(finding.title.trim().length, finding.id).toBeGreaterThan(0);
        expect(finding.detail.trim().length, finding.id).toBeGreaterThan(0);
        if (finding.status !== 'pass') {
          expect(finding.remediation, finding.id).not.toBeNull();
          expect((finding.remediation ?? '').trim().length, finding.id).toBeGreaterThan(10);
        }
      }
    }
  });

  it('skips every config-dependent check outside a workspace instead of failing it', async () => {
    const outside = doctorContext({
      config: null,
      goal: null,
      paths: null,
      run: async () => ({ exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, spawnFailed: false, durationMs: 1 }),
      http: async () => ({ ok: true, status: 200, error: null }),
    });
    const configDependent = ['tokens', 'codex.model', 'pnpm.store', 'state.branch_spec', 'provider.ci', 'provider.scm'];
    for (const check of ALL_CHECKS.filter((candidate) => configDependent.includes(candidate.id))) {
      const findings = await check.run(outside);
      expect(findings.map((f) => f.status), check.id).toEqual(['skip']);
    }
  });
});
```

- [ ] **Step 2: Write the failing CLI test**

Create `tests/cli/doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { DoctorCheck } from '../../src/doctor/types.js';
import { runCli } from '../helpers/run-cli.js';

const green: DoctorCheck = {
  id: 'fixture.green',
  title: 'a green fixture check',
  run: async () => [{ id: 'fixture.green', title: 'a green fixture check', status: 'pass', detail: 'all good', remediation: null }],
};

const warn: DoctorCheck = {
  id: 'fixture.warn',
  title: 'a warning fixture check',
  run: async () => [{ id: 'fixture.warn', title: 'a warning fixture check', status: 'warn', detail: 'worth knowing', remediation: 'consider this' }],
};

const red: DoctorCheck = {
  id: 'fixture.red',
  title: 'a failing fixture check',
  run: async () => [{ id: 'fixture.red', title: 'a failing fixture check', status: 'fail', detail: 'it is broken', remediation: 'unbreak it' }],
};

describe('janus doctor', () => {
  it('prints a human report and exits 0 when nothing failed', async () => {
    const result = await runCli(['doctor'], {}, { doctorChecks: [green, warn] });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('[ok]   fixture.green');
    expect(result.stdout).toContain('[warn] fixture.warn');
    expect(result.stdout).toContain('-> consider this');
    expect(result.stdout).toContain('2 checks: 1 ok, 1 warnings, 0 failed, 0 skipped');
    expect(result.stderr).toBe('');
  });

  it('exits 1 when a check failed, and still prints the whole report', async () => {
    const result = await runCli(['doctor'], {}, { doctorChecks: [green, red] });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stdout).toContain('[fail] fixture.red');
    expect(result.stdout).toContain('-> unbreak it');
  });

  it('prints the --json contract and nothing else on stdout', async () => {
    const result = await runCli(['doctor', '--json'], {}, { doctorChecks: [green, red] });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    const report = JSON.parse(result.stdout) as { version: number; summary: Record<string, number>; checks: Array<Record<string, unknown>> };
    expect(report.version).toBe(1);
    expect(report.summary).toEqual({ pass: 1, warn: 0, fail: 1, skip: 0 });
    expect(report.checks.map((check) => check['id'])).toEqual(['fixture.green', 'fixture.red']);
    expect(report.checks[1]).toMatchObject({ status: 'fail', remediation: 'unbreak it' });
  });
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm exec vitest run --project unit tests/doctor/registry.test.ts tests/cli/doctor.test.ts`
Expected: FAIL — `src/doctor/index.js` does not exist, and `doctorChecks` is not a `CliOverrides` field.

- [ ] **Step 4: Write the registry**

Create `src/doctor/index.ts`:

```ts
import { join } from 'node:path';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal } from '../config/goal-schema.js';
import { CONFIG_FILE, GOAL_FILE } from '../state/files.js';
import { workspacePaths } from '../workspace/layout.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { findWorkspaceRoot } from '../workspace/open-workspace.js';
import { codexBinaryCheck, codexLoginCheck, codexModelsCheck } from './checks/codex.js';
import { pnpmStoreCheck } from './checks/pnpm.js';
import { ciReachabilityCheck, scmReachabilityCheck } from './checks/providers.js';
import { branchSpecCheck, gitIdentityCheck, tokensCheck } from './checks/repo.js';
import { codexReadOnlyProbe, codexWorkspaceWriteProbe, ngUpdateProbe, userNamespacesCheck } from './checks/sandbox.js';
import { runCommand } from './exec.js';
import { nodeFs } from './fs.js';
import { fetchProbe } from './http.js';
import type { DoctorCheck, DoctorCheckContext } from './types.js';

/**
 * `tasks.md` T07's list, in the order the report prints them: cheap local observations first, then the sandbox,
 * then the three §18.4 probes and the model probes (the expensive ones), then configuration. An operator reading
 * a red report top to bottom meets the cause before the symptom — a missing login explains a failed probe, and a
 * dead sandbox explains a failed install.
 */
export const ALL_CHECKS: readonly DoctorCheck[] = [
  codexBinaryCheck,
  codexLoginCheck,
  gitIdentityCheck,
  tokensCheck,
  userNamespacesCheck,
  codexReadOnlyProbe,
  codexWorkspaceWriteProbe,
  ngUpdateProbe,
  codexModelsCheck,
  pnpmStoreCheck,
  branchSpecCheck,
  ciReachabilityCheck,
  scmReachabilityCheck,
];

export interface BuildDoctorContextInput {
  cwd: string;
  env: Record<string, string | undefined>;
  now(): Date;
}

/**
 * Builds the real context. Two deliberate choices:
 *
 * 1. **No workspace lock.** Doctor calls `findWorkspaceRoot` + `loadConfig` + `loadGoal` rather than
 *    `openWorkspace`, so it works while a `janus run` holds `janus.lock` and while the workspace is mid-reconcile.
 *    That also means doctor never reads `state.yaml` and never verifies the state branch — `janus status` owns that.
 * 2. **A missing workspace is fine; a broken one is not.** Not being inside a workspace leaves `config`, `goal`
 *    and `paths` null, and the config-dependent checks skip (§35 runs doctor before `janus init`). A workspace
 *    whose `config.yaml` or `goal.yaml` does not parse throws `ConfigError`, which `main` already maps to exit 2
 *    with the offending field named — the same behaviour every other command has.
 */
export function buildDoctorContext(input: BuildDoctorContextInput): DoctorCheckContext {
  let paths: WorkspacePaths | null = null;
  try {
    paths = workspacePaths(findWorkspaceRoot(input.cwd));
  } catch {
    paths = null;
  }
  let config: JanusConfig | null = null;
  let goal: Goal | null = null;
  if (paths !== null) {
    config = loadConfig(join(paths.janusDir, CONFIG_FILE));
    goal = loadGoal(join(paths.janusDir, GOAL_FILE)).goal;
  }
  return { config, goal, paths, env: input.env, run: runCommand, http: fetchProbe, fs: nodeFs, now: input.now };
}

export type { DoctorCheck, DoctorCheckContext, DoctorFinding, DoctorObservation, DoctorStatus } from './types.js';
export { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from './report.js';
export type { DoctorReport } from './report.js';
```

- [ ] **Step 5: Add the CLI test seam and write the command**

In `src/cli/context.ts`, add the import and the field:

```ts
import type { DoctorCheck } from '../doctor/types.js';
```

```ts
/** Test seams. `steps` replaces the production step registry of `janus run`; `providers` replaces the provider bag;
 * `doctorChecks` replaces `janus doctor`'s registry so a CLI test never shells out to codex, git or pnpm. */
export interface CliOverrides {
  steps?: StepRegistry;
  providers?: Providers;
  doctorChecks?: readonly DoctorCheck[];
}
```

Replace `src/cli/commands/doctor.ts` entirely:

```ts
import type { Command } from 'commander';
import { ALL_CHECKS, buildDoctorContext } from '../../doctor/index.js';
import { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from '../../doctor/report.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface DoctorOptions {
  json?: boolean;
}

export function registerDoctor(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check codex, git, tokens, sandbox, and provider reachability')
    .option('--json', 'machine-readable output')
    .action(async (options: DoctorOptions) => {
      ctx.exitCode = await doctorCommand(ctx, options);
    });
}

/**
 * Spec §18.4 (the three real probes), §18.6 (one-token model probe), §31 item 33 (a dead sandbox, a read-only
 * pnpm store, a missing `janus/*` exclusion), `tasks.md` T07.
 *
 * Exit code: 1 when any check failed, 0 otherwise — a `warn` or a `skip` is information, not a failure. The whole
 * report is printed either way, because the operator needs the passing checks to interpret the failing ones.
 */
async function doctorCommand(ctx: CliContext, options: DoctorOptions): Promise<ExitCode> {
  const context = buildDoctorContext({ cwd: ctx.io.cwd, env: ctx.io.env, now: () => new Date() });
  const report = await runDoctor(ctx.doctorChecks ?? ALL_CHECKS, context);
  ctx.io.stdout(options.json === true ? doctorJson(report) : renderDoctorHuman(report));
  return doctorExitCode(report);
}
```

- [ ] **Step 6: Take `doctor` out of the not-implemented list**

In `tests/cli/commands.test.ts`, delete these two entries from the `stubbed` array:

```ts
  ['doctor'],
  ['doctor', '--json'],
```

Leave the `'lists every top-level command in help'` test alone: `doctor` is still a registered command.

- [ ] **Step 7: Run the doctor and CLI tests**

Run: `pnpm exec vitest run --project unit tests/doctor tests/cli`
Expected: PASS. `registry.test.ts`'s worst-case loop really does run `mkdtemp` and `writeFileSync` in a temp directory for the workspace-write probe; that is expected and the probe removes it in its `finally`.

- [ ] **Step 8: Add probe D1 — the real doctor, end to end, in the opt-in lane**

This is the one place the real registry runs against real `codex`, `git` and `pnpm`. It stays behind `JANUS_REAL_CODEX=1` because the two Codex probes cost real turns. Add to `tests/integration/codex-smoke.test.ts`, inside the `describe.skipIf(!ENABLED)` block, and add `import { ALL_CHECKS, buildDoctorContext } from '../../src/doctor/index.js';`, `import { doctorJson, runDoctor } from '../../src/doctor/report.js';` and `import { createHarness } from './harness/harness.js';`:

```ts
  /**
   * T07 probe D1: `janus doctor`'s real registry against a real fake-provider workspace. Everything that can pass
   * on this machine must pass; `state.branch_spec` warns because the harness's state branch lives in a product
   * repository, and the provider and token checks skip because both providers are fakes.
   */
  it(
    'probe D1: janus doctor reports no failure in a fake-provider workspace',
    async () => {
      const harness = await createHarness([{ name: 'ui-kit', kind: 'library' as const }], {});
      const report = await runDoctor(ALL_CHECKS, buildDoctorContext({ cwd: harness.root, env: process.env, now: () => new Date() }));

      const byId = new Map(report.checks.map((finding) => [finding.id, finding]));
      recordProbe({
        probe: 'D1',
        question: 'Does janus doctor pass on this machine against a fake-provider workspace?',
        outcome: report.summary.fail === 0 ? 'pass' : 'fail',
        detail: `${String(report.summary.pass)} ok, ${String(report.summary.warn)} warn, ${String(report.summary.fail)} fail, ${String(report.summary.skip)} skip`,
        data: { statuses: Object.fromEntries([...byId].map(([id, finding]) => [id, finding.status])) },
      });

      expect(byId.get('codex.binary')?.status).toBe('pass');
      expect(byId.get('codex.login')?.status).toBe('pass');
      expect(byId.get('codex.probe.read_only')?.status).toBe('pass');
      expect(byId.get('codex.probe.workspace_write')?.status).toBe('pass');
      expect(byId.get('pnpm.store')?.status).toBe('pass');
      // The harness has no dedicated state repo and no Angular repo.
      expect(byId.get('state.branch_spec')?.status).toBe('warn');
      expect(byId.get('codex.probe.ng_update')?.status).toBe('skip');
      expect(byId.get('provider.ci')?.status).toBe('skip');
      expect(byId.get('provider.scm')?.status).toBe('skip');
      expect(report.summary.fail, doctorJson(report)).toBe(0);
    },
    FORTY_FIVE_MINUTES,
  );
```

Run it:

```bash
JANUS_REAL_CODEX=1 JANUS_SPIKE_LOG="$HOME/janus-spike/probe-log.jsonl" \
  pnpm test:integration -- tests/integration/codex-smoke.test.ts -t 'probe D1'
```

Expected: PASS, in five to ten minutes. If `createHarness`'s option object needs entries this call omits, match whatever T04's own harness test passes.

- [ ] **Step 9: Document the command in the README**

Add to `README.md`, after whatever section describes the CLI:

```markdown
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
```

- [ ] **Step 10: Update the task status table**

In `tasks.md`, replace the last row of the Status table:

```text
| T06 to T24 | pending | | next: T06 (prompt spike); it must also verify the §3.3/§18.4 read-only cwd tension against real Codex |
```

with:

```text
| T06 | done | (pending merge) | prompt spike; §18.4 read-only cwd ruling, real JSONL usage shape, per-role token baselines; `docs/spikes/prompt-spike.md` |
| T07 | done | (pending merge) | `janus doctor`: 13 checks, `--json` contract, every check unit-tested with a simulated failure |
| T08 to T24 | pending | | next: T08 (policy checks and orchestrator commit/push) |
```

Fill the two `(pending merge)` cells with the merge sha when the branch lands, as the table's own instruction says.

- [ ] **Step 11: Verify the whole branch**

Run, in order, and record each result:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
```

Expected: all exit 0. `pnpm test` must report **more than 727** tests passing — record the exact number for the handback. `pnpm test:integration` must report the whole of `tests/integration/codex-smoke.test.ts` as skipped (T05's 2 cases plus R1, R2, S1a, S1b, A2, S2's 4 and D1 = 12 skipped) and must still finish inside T04's <90 s budget; if it does not, say so in the handback rather than absorbing it quietly.

Then confirm the stub really is gone:

```bash
grep -rn "notImplemented" src/cli/commands/doctor.ts || echo "doctor no longer stubbed"
node bin/janus.js doctor --json | head -20
```

Expected: the `grep` prints nothing and the echo fires; `janus doctor --json` prints a valid report (it will run the real probes, so give it a few minutes — this is the command's real cost).

- [ ] **Step 12: Commit**

```bash
git add src/doctor src/cli tests/doctor tests/cli tests/integration/codex-smoke.test.ts README.md tasks.md
git commit -m "feat(cli): implement janus doctor with the thirteen T07 checks and a --json contract" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Self-Review

Run after the plan was complete, against the spec and `tasks.md` with fresh eyes. Issues found were fixed inline above; they are listed here so the executor knows what was already checked.

**1. Spec and `tasks.md` coverage.**

| Requirement | Task |
|---|---|
| §3.3 class table: cwd, writable roots, network per class | 3 (amendment), 4 (S1a, S1b), 10 |
| §3.3 the workspace root is not a git repository, and why | 3 |
| §5 `.pnpm-store/`, `.janus/` is a git checkout, `reports/<run-id>/` | 4, 12 |
| §12 `allowed_scope` wide enough for lockfiles and CLI migration targets | 5 (measured), 7 (spec + planning template) |
| §14 output-schema note: every property present, `null` for N/A | 6 |
| §18.1 `AgentTask` gains `skipGitRepoCheck` | 3 |
| §18.2 context package, byte budgets, truncations recorded per role | 4, 6 |
| §18.3 output contract, per role, against the real model | 6 |
| §18.4 invocation flags, `resume` never used | 3 |
| §18.4 `--skip-git-repo-check` ruling | 3 |
| §18.4 `turn.completed.usage` parsing | 2 |
| §18.4 writable roots, `npm_config_store_dir`, no `.npmrc` | 4, 10, 12 |
| §18.4 Angular guidance (`ng update --allow-dirty`, migrations touch many files) | 5, 7 |
| §18.4 three real doctor probes | 10 |
| §18.4 bubblewrap needs user namespaces; `allow_unsandboxed` escape | 10 |
| §18.6 one-token probe for every configured model | 9 |
| §18.6 prompt templates versioned; a change bumps the version | 7 |
| §28 token env vars, `agents.pnpm_store`, `model_profiles`, `state.repo` | 11, 12, 9 |
| §29 item 4 the manual prompt spike and its report | 1–7 |
| §29 item 6 first-contact runbook | out of scope (T24); Task 13 records why `provider.*` is untested against a real host |
| §31 item 29 no agent git write | 4 (S1b), 5 (A2) |
| §31 item 33 dead sandbox / read-only pnpm store / missing `janus/*` exclusion | 10, 12, 11 |
| §32 rule 11 agents never commit | 4, 5, 7 (guardrail block unchanged) |
| §32 rule 12 no secret in prompts, evidence, findings, probe log | 1, 11, 13 |
| §33 `janus/*` excluded from the VCS root branch spec | 11 |
| §35 the operator skill runs `janus doctor` before `janus init` | 14 (Decision 8: doctor runs workspace-less) |
| `tasks.md` T06: throwaway Angular 15 app | 1 |
| `tasks.md` T06: hand-run the T05 context packages and schemas for discovery, planning, implementation, debug | 6 |
| `tasks.md` T06: report-writing with report cwd; pnpm store; `ng update --allow-dirty`; footprint vs `allowed_scope`; schema compliance; token usage per role | 4, 5, 6 |
| `tasks.md` T06: fold findings into T05 templates, T07 doctor probes, §12 scope defaults | 7 (templates, §12), 10 and 12 (doctor probes) |
| `tasks.md` T06 done-when: `docs/spikes/prompt-spike.md` | 1 (skeleton), 2–6 (sections), 7 (findings) |
| `tasks.md` T07: codex login | 9 |
| `tasks.md` T07: git identity | 11 |
| `tasks.md` T07: tokens present | 11 |
| `tasks.md` T07: every configured model accepted (one-token probe) | 9 |
| `tasks.md` T07: provider reachability, skipped for fakes | 13 |
| `tasks.md` T07: user namespaces for bubblewrap | 10 |
| `tasks.md` T07: the three real §18.4 probes | 10 |
| `tasks.md` T07: pnpm store writability | 12 |
| `tasks.md` T07: `janus/*` branch-spec warning when the state repo is a product repo | 11 |
| `tasks.md` T07: `--json` output contract | 8, 14 |
| `tasks.md` T07 done-when: each check has a unit test with a simulated failure and a clear remediation | 9, 10, 11, 12, 13 individually; 14's registry test proves it for all thirteen at once |

*Gaps found and closed:*

- The spike originally had no way to reach `.janus/reports/<run-id>/` in a hand-built workspace, because a bare temp `.janus` is not a git checkout and Codex would refuse the report-writing cwd for a reason unrelated to the agent. Task 4 Step 1 now `git init`s it and the report records the dependency.
- The probe recorder originally defaulted to a path inside the repository. It now defaults to a temp file, so `pnpm test:integration` cannot dirty the working tree.
- Nothing ran the real doctor end to end. Task 14 Step 8 adds probe D1 to the opt-in lane, which is the only place the real registry meets real `codex`, `git` and `pnpm`.
- `tasks.md` T06 says "hand-run `codex exec`". The probes drive `buildAgentTask` + `createCodexAgentRunner` instead of `janus agent run <role> --task FILE`. That is deliberate: both render the same §18.2 prompt through the same `runAgent`/adapter path, and the programmatic form lets a probe assert the sandbox plan and capture the stream. `janus agent run --dry-run` is still in the report's runbook for inspecting a prompt by hand.

*Deliberately out of scope,* each named where it appears: the §29.6 first-contact runbook and a real `provider.*` probe (T24), the dogfood runbook (T22), the `plan.yaml` validator that consumes the measured scope (T11), the policy scope check that consumes the same numbers (T08), and any `--skip-probes` flag for doctor (Decision 15).

**2. Placeholder scan.** Searched for `TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `Similar to Task`, and trailing `etc.` — none present. Every code step carries the actual code. Six places tell the executor to substitute a value the plan cannot know, each naming exactly where it comes from and each producing a committed artifact: the `ng test` baseline row (Task 1 Step 8, from Step 3's output), the measured migration footprint (Tasks 5, 7, 8, from `~/janus-spike/ng-update-footprint.txt`), the twelve prompt fingerprints (Task 7 Step 6, from the failing test's diff), the per-role cost table (Task 6 Step 3, from the probe log), the conditional per-role template sentences (Task 7 Step 4, each written out in full, applied only when the probe log shows the finding), and the merge sha in `tasks.md` (Task 14 Step 10, filled at merge as that table's own instruction says).

**3. Type consistency.** Checked every name used across task boundaries:

- `ProbeRecord` / `recordProbe` / `probeLogPath` (Task 1) are used under those names by Tasks 2–6 and 14; `captureFixture` and `CODEX_FIXTURES_DIR` are added in Task 2 and used only there.
- `SandboxPlan.skipGitRepoCheck` / `AgentTask.skipGitRepoCheck` / `AgentEvidence.skip_git_repo_check` (Task 3) keep those exact spellings in Tasks 4, 10 and 14 — camelCase in memory, snake_case on disk, which is T05's Decision 2.
- `FORTY_FIVE_MINUTES`, `SPIKE_APP`, `NODE18_BIN` and `angularConfig` are introduced in Task 5 and used again in Tasks 6 and 14; Tasks 5, 6 and 14 run in that order, so the constants exist before their second use.
- `spikeWorkspace` and `S2_ROLES` (Task 6) are used only in Task 6.
- `DoctorFinding` / `DoctorObservation` / `DoctorCheck` / `DoctorCheckContext` / `skipped` (Task 8) are used under those names by Tasks 9–14. `DoctorObservation` is `Omit<DoctorFinding, 'duration_ms'>` throughout; no check ever constructs a `duration_ms`.
- `CommandRunner` / `CommandRequest` / `CommandResult` / `processEnv` (Task 8) are used by Tasks 9, 10, 11, 12, 13, 14. `HttpProbe` by Task 13. `DoctorFs` by Tasks 10, 12.
- `CODEX_BIN` and `lastLine` are defined once, in Task 9's `checks/codex.ts`, and imported by Tasks 10, 11 and 12 — not redefined.
- `doctorContext` / `stubRunner` / `stubHttp` / `stubFs` / `commandResult` / `FROZEN_NOW` (Task 8) are used by every check test.
- `runDoctor({checks, ctx})` is **not** the shape: it is `runDoctor(checks, ctx)` positionally, and Tasks 8 and 14 both call it that way.
- `ALL_CHECKS` and `buildDoctorContext` (Task 14) are used by `src/cli/commands/doctor.ts` and by probe D1, both in Task 14.
- `CliOverrides.doctorChecks` (Task 14) matches `ctx.doctorChecks ?? ALL_CHECKS` in the command and the third argument of `runCli` in the CLI test.
- Every check id in `ALL_CHECKS` (Task 14's registry test) matches the id literal inside its check module: `codex.binary`, `codex.login`, `git.identity`, `tokens`, `sandbox.user_namespaces`, `codex.probe.read_only`, `codex.probe.workspace_write`, `codex.probe.ng_update`, `codex.model`, `pnpm.store`, `state.branch_spec`, `provider.ci`, `provider.scm`.

*Issues found and fixed:* (a) `runDoctor` had a self-assigning loop over `DOCTOR_STATUSES` that `eslint`'s `no-self-assign` would reject — removed, with a comment explaining that the object literal already fixes the key set; (b) `let observations;` relied on evolving-`any` inference — now annotated `DoctorObservation[]`; (c) `codexWorkspaceWriteProbe` cast `process.env` to `Record<string, string>` — `processEnv()` is now exported from `src/doctor/exec.ts` and reused; (d) the same probe built its scratch tree through `ctx.fs.mkdirp`, which a stub makes a no-op, so `writeFileSync` would have failed with `ENOENT` in every unit test — the setup now uses real `node:fs` and only the assertion goes through `ctx.fs.exists`; (e) Task 10's test used a `goalFixture()` from `tests/helpers/workspace-fixtures.ts`, which is async and builds a whole workspace — replaced with `goalSchema.parse(validGoal)`, the shape the config tests already use, whose first repo is `ui-kit`.

---

## Open items for the controller

These need a human decision; the plan states what it does and why, and the executor should not decide differently on their own.

1. **The §18.4 amendment (Task 3 Step 7) needs ratification.** The evidence is unambiguous — real Codex refuses a read-only run outside a git work tree — but narrowing a "never used" rule in the spec is the spec owner's call. The three alternatives and why each was rejected are in Decision 4 and in the report.
2. **The §3.3 addition (Task 3 Step 7)** states that the workspace root is deliberately not a git repository. That is a new commitment, not a restatement; it forecloses option (c) for good.
3. **§18.4's third doctor probe is ambiguous** about whether `ng update --allow-dirty` runs through Codex. Decision 12 runs it directly and says why. If the intent was a Codex turn, Task 10's `ngUpdateProbe` changes shape.
4. **§12's amendment (Task 7 Step 8)** inserts a measured number into the spec. Confirm that measured evidence belongs in the spec rather than only in `docs/spikes/prompt-spike.md`.
5. **`janus doctor` has no cheap mode.** Decision 15 keeps `--json` as the only flag, so every invocation spends two Codex turns plus one per configured model — several minutes and ~45k input tokens on the default profile. If that proves annoying in T22's dogfood run, a `--skip-probes` filter over `ALL_CHECKS` is the smallest change.
6. **The spike's time box.** `tasks.md` gives T06 one week. Probe A2 alone can run forty minutes and probe S2 four more turns. If the box is tight, A2 is the one to cut: A1 already measures the footprint §12 needs, and A2 only adds "an agent can do it too".

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-t06-t07-spike-and-doctor.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
