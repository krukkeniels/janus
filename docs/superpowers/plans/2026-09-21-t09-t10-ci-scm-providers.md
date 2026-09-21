# T09 + T10 CI and SCM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two stub provider interfaces in `src/providers/types.ts` with the full §3.2 `CiProvider` and `ScmProvider` surfaces, build the deterministic machinery they own — outcome classification (§16.1), the bounded redacted failure digest (§16.2), the failure signature (§16.3) and the PR description renderer (§15) — ship the `local` and `fake` CI providers and the `fake` SCM provider, give both families one shared reusable contract test suite, and implement the `janus ci wait|trigger|digest` and `janus fake scm comment|approve|decline|merge` debug commands over them.

**Architecture:** Two sibling packages under `src/providers/`: `ci/` (types, classification, digest, signature) and `scm/` (types, PR description renderer), each exporting its interface, plus `local/` (the real `local` CI provider: a shell command runner, a JUnit XML reader, a Karma/Jest summary reader, and a small persisted build cache) and the two full fakes under `fake/`. `src/providers/types.ts` keeps `AgentRunner` and `Providers` and re-exports the two provider interfaces, so every existing import of `CiProvider`/`ScmProvider` from that path keeps working. A third new package, `src/redact/`, is the single home for the credential redaction that `doctor`, `policy` and now the digest all need — it is *lifted* out of `src/doctor/redact.ts` and `src/policy/checks/secrets.ts` rather than copied. Providers stay pure I/O adapters: they write no telemetry, no evidence and no git.

**Tech Stack:** TypeScript strict ESM (NodeNext), Node 20+, pnpm 10.33.0, zod 3, yaml 2, vitest 5 (`unit` and `integration` projects), `node:crypto` for the signature hash, `node:child_process` for the `local` provider's shell runner. **No new runtime dependency**: the JUnit subset this plan reads is a 70-line tag scanner, and pulling in an XML DOM parser would add a dependency for four element names.

**Spec:** `angular-ai-development-workflow-v2.md` — §3.2 (the two interface sketches, verbatim), §4 (`repos[].ci.*`, `e2e.branch_params`, `suite_repo_map`), §5 (`fake/`, `evidence/digests/`), §6 (`repos.<name>.pr`, `repos.<name>.last_build`, `review_loop`), §8 (CLI surface), §13, §15 (PR model), **§16.1–16.6 in full**, §17 (E2E triage consumes the digest), §24 (activity stream, own-comment skip, NEEDS_WORK, approval reset, DECLINED, MERGED), §27 (event list), §28 (`teamcity`, `bitbucket`, `local_ci`, `digest`, `guardrails`), §29 items 2 and 3, §31, §32 rules 11 and 12, §33. Task definitions: `tasks.md` T09 and T10. Predecessor, assumed landed: `docs/superpowers/plans/2026-09-20-t08-policy-checks.md` (`main` at `c4cd091`).

## Global Constraints

- TypeScript `strict`, Node `>=20` (`package.json` `engines`), ESM (`"type": "module"`). Every relative import ends in `.js`; every type-only import uses `import type` (`verbatimModuleSyntax` is on).
- `strict` here includes `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax` (verified in `tsconfig.json`). **No `!` non-null assertions** — narrow with `if (x === undefined) throw ...`. Never pass `undefined` to an optional property; spread it in conditionally (`...(v === undefined ? {} : { k: v })`). Indexing a `Record` or an array yields `T | undefined` and must be narrowed.
- Package manager is **pnpm**. All schemas are **zod**. All tests are **vitest**.
- Verification commands, exactly as `package.json` defines them:
  - `pnpm lint` → `eslint .`
  - `pnpm typecheck` → `tsc -p tsconfig.json --noEmit`
  - `pnpm build` → `tsc -p tsconfig.build.json`
  - `pnpm test` → `vitest run` (both projects)
  - `pnpm test:unit` → `vitest run --project unit`
  - `pnpm test:integration` → `vitest run --project integration`
  - A single file: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts`
  - A single case: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts -t 'ignores a line number change'`
- **No task is done without `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` all green.**
- **Conventional commits, `type(scope): subject` — always with a scope.** Every commit step below uses the two-`-m` form, which produces exactly the required trailers:

```bash
git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

  Those two trailer lines belong to **this repository's** commits, made by whoever executes this plan. They are **not** part of the commit message Janus writes into a product repository — that convention already exists in `src/policy/commit.ts` and is not touched here.
- TDD throughout: write the failing test, run it and watch it fail for the stated reason, write the minimal implementation, run it and watch it pass, commit.
- **Test count floor: 1022 unit tests in 84 files, plus 28 passing integration tests (12 skipped — the opt-in `JANUS_REAL_CODEX` lane) in 7 files (6 passed, 1 skipped).** Measured on `c4cd091` with `pnpm test:unit` and `pnpm test:integration`. `pnpm lint`, `pnpm typecheck` and `pnpm build` were all green on the same commit. Every task below adds tests; no task may reduce those numbers.
- Exit codes come only from `src/cli/exit-codes.ts`. **This plan adds no exit code.** It adds two CLI surfaces: the three `janus ci` subcommands become real (they already exist as `notImplemented` stubs), and `janus fake scm` is new (Task 13).
- §32 rule 11 — "Agents never commit, push, or otherwise rewrite Git history." **No provider in this plan runs git at all.** The fake SCM's `ensureBranch`, `createPullRequest` and merge detection are bookkeeping in `fake/scm.json`; the `local` CI provider runs only the commands `local_ci` configures, in the repository checkout, and never a git command of its own. Task 14 adds a reflog audit wrapper around *every provider call* so this is enforced, not merely asserted in prose.
- §32 rule 12 — "Secrets never enter `.janus/`, prompts, or evidence; digests are redacted." The digest redaction pass is Task 3 and it is the **only** thing standing between a build log and `evidence/digests/`. Its tests are adversarial by design (see R8).
- §31.29 — no agent process performs a git write. The harness applies this automatically to every scenario; Task 14 does not opt out.

## Facts this plan was verified against

Checked on this machine while the plan was written. A step that depends on one says so.

| Fact | Verified value |
|---|---|
| `main` at plan time | `c4cd091 docs(readme): explain the framework, not just its commands`; working tree clean |
| test counts on `c4cd091` | unit **1022 tests in 84 files**; integration **28 passed, 12 skipped (40)** in 7 files (6 passed, 1 skipped) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` on `c4cd091` | all exit 0 |
| `tsconfig.json` strictness | `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"verbatimModuleSyntax": true`, `"module": "NodeNext"`, `"target": "ES2022"` |
| **vitest** JUnit XML (`vitest run --reporter=junit`, real run) | root `<testsuites>`; `<testsuite name="sample.test.ts">`; `<testcase classname="sample.test.ts" name="AppComponent &gt; should render title">`; failure element `<failure message="expected &apos;a&apos; to be &apos;b&apos; // Object.is equality" type="AssertionError">` **with** a `message` attribute, stack in the element text |
| **jest-junit 17** XML (real run) | root `<testsuites>`; `<testsuite name="AppComponent">`; `<testcase classname="AppComponent should render title" name="AppComponent should render title">` — **`classname` equals `name`**; failure element `<failure>` with **no attributes at all**, message + stack in the element text |
| **karma-junit-reporter 2** XML (real run, Chrome Headless 153) | root is `<testsuite>`, **not** `<testsuites>`; `<testcase name="AppComponent should render title" classname="Chrome_Headless_153_0_0_0_(Linux_0_0_0).AppComponent">` — the **browser name and version are the first dot-separated segment of `classname`**, and `name` already carries the suite; `<failure type="">` with no `message` attribute. The file is written to `<outputDir>/<Browser_Name_Version>/results.xml`, i.e. into a browser-named subdirectory |
| **jest** console output stream | the entire report, including `Tests:       2 failed, 1 passed, 3 total` and the `  ● AppComponent › should render title` headers, goes to **stderr**; stdout is empty |
| **karma** console output stream | goes to **stdout**, wrapped in ANSI SGR codes and `ESC[1A ESC[2K` cursor-up/erase sequences; failure line `Chrome Headless 153.0.0.0 (Linux 0.0.0) AppComponent should render title FAILED`; progress line `Chrome Headless 153.0.0.0 (Linux 0.0.0): Executed 2 of 2 (1 FAILED) (0.004 secs / 0.002 secs)`; final line `TOTAL: 1 FAILED, 1 SUCCESS` |
| `/bin/sh` on this machine | symlink to `dash` |
| `spawn('sh', ['-c', 'sleep 30'])` + `child.kill('SIGTERM')` | dash does **not** exec the command; the shell dies and `sleep` is **orphaned** (verified: the `sleep` process survived with `ppid` reparented to 1) |
| `spawn('sh', ['-c', 'sleep 41'], { detached: true })` + `process.kill(-child.pid, 'SIGTERM')` | the whole process group dies; no orphan survives |
| `spawnCodex` (`src/agents/codex/spawn.ts`) | spawns **without** `detached`, kills with `child.kill()` — so it signals only the direct child. It has the SIGTERM→SIGKILL grace, the output caps and the never-reject contract |
| `src/doctor/exec.ts` `runCommand` | a thin rename over `spawnCodex`: `{ bin, args, cwd, env?, stdin?, timeoutMs }` → `{ exitCode, signal, stdout, stderr, timedOut, spawnFailed, durationMs }`. Its only importer outside `src/doctor/` is `tests/helpers/doctor-fixtures.ts` |
| importers of `src/doctor/redact.js` | `src/doctor/checks/providers.ts:1`, `src/doctor/checks/repo.ts:4`, `src/doctor/report.ts:2`, `tests/doctor/redact.test.ts:2` — four files |
| importers of `SECRET_PATTERNS` | declared in `src/policy/checks/secrets.ts:19`, used there and in `tests/policy/secrets.test.ts:2` — two files |
| out-of-process CLI invocation | `node --import tsx src/cli/entry.ts --version` prints `0.0.1` and exits 0. `bin/janus.js` imports `../dist/cli/entry.js`, so it needs `pnpm build` first; the `tsx` form does not |
| `it.skipIf(cond)` | the established conditional-skip idiom in this repo (`tests/integration/codex-smoke.test.ts:130`, `tests/agents/codex-adapter.test.ts:189`) |
| `config.digest` defaults | `max_tests: 50`, `log_tail_lines: 400`, `max_error_windows: 10`, `max_bytes: 65536`, `redact: true` — **five** fields; Task 3 adds a sixth, `max_test_detail_lines` |
| `config.local_ci` shape today | `repos: Record<string, { install?, build?, test?, lint? }>` and `e2e?`. No timeout, no JUnit location |
| `config.teamcity` polling defaults | `poll_interval_seconds: 30`, `appearance_timeout_minutes: 5`, `build_timeout_minutes: 90`, `e2e_timeout_minutes: 240` |
| `state.repos.<name>.last_build` | `{ id: string|null, status: 'unknown'\|'queued'\|'running'\|'finished', classification: 'success'\|'tests_failed'\|'build_failed'\|'infra'\|null, revision: sha\|null, explicit_trigger: boolean }` — the four classification names already exist in `src/state/state-schema.ts:64` |
| `state.repos.<name>.pr` | `{ id: number\|null, url: string\|null, state: 'OPEN'\|'MERGED'\|'DECLINED'\|null, version: number\|null, approved: boolean }` |
| `tests/integration/harness/git-audit.ts` | `auditAgentRunner(inner, targets, sink)` brackets **only** `AgentRunner.run()` with `captureRefLogs`/`diffRefLogs`. **Provider calls are not audited today.** `captureRefLogs` throws `duplicate audit target label: <label>` on a label collision |
| `createProviders` callers | `src/cli/commands/run.ts:78` and `src/cli/commands/agent.ts:94`, both `ctx.providers ?? createProviders({ config, paths, now })`. Neither passes the goal |
| `WorkspacePaths` | `{ root, janusDir, reposDir, fakeDir, pnpmStoreDir, lockFile, repoDir(name) }`; `createWorkspaceDirs` and `removeWorkspaceArtifacts` both enumerate `root, reposDir, fakeDir, pnpmStoreDir` |
| `src/telemetry/events.ts` | 20 event types; **no `ci.*` and no `pr.*` member exists yet**. `UnlistedEventType` is a compile-time exhaustiveness guard over `EVENT_TYPES` |
| `matchesGlob` (`src/policy/glob.ts`) | supports `**`, `*`, `?` against repo-relative forward-slash paths; no braces, no classes, no negation. Exported and reusable |

---

## Carried-forward rulings this plan honors

These are the controller's rulings for this plan plus the ones carried forward from earlier task reviews. They are constraints, not suggestions.

**R1. Fakes never invoke git.** §32 rule 11, §31.29. The fake SCM's `ensureBranch` records intent only; `createPullRequest`, approval, decline and merge are bookkeeping in `fake/scm.json`; a merge commit sha is a *parameter*, never something the fake computes from a repository. The `local` CI provider runs only `local_ci`-configured commands and never a git command. Task 14 adds `auditCiProvider` / `auditScmProvider` to `tests/integration/harness/git-audit.ts` so every provider call is bracketed by the same reflog snapshot that already brackets agent runs, and the harness asserts zero provider git writes by default.

**R2. Providers are pure I/O adapters: they write no telemetry and no evidence.** This mirrors the `AgentRunner` contract comment already in `src/providers/types.ts` ("a runner executes one task and reports what happened; it writes no telemetry and no evidence — `runAgent` does that around every runner"). **Therefore this plan adds no event type to `src/telemetry/events.ts`.** `ci.build.found`, `ci.build.triggered`, `ci.build.finished`, `ci.build.infra_retry`, `pr.created`, `pr.comment.received`, `pr.comment.answered`, `pr.approved`, `pr.declined` and `pr.merged` belong to the tasks that emit them — T11 (PR creation), T12 (the PR build loop) and T13 (the review loop). An executor who finds themselves opening `src/telemetry/events.ts` has left this plan's scope. The same rule covers `evidence/builds/`, `evidence/digests/` and `evidence/e2e/`: `failureDigest()` **returns** a digest and `renderDigestMarkdown()` renders it; the task that writes it under `.janus/evidence/` is T12.

**R3. `janus ci wait|trigger|digest` are in scope.** `src/cli/commands/ci.ts` names T09 in all three `notImplemented` calls. They are implemented thin, over `createProviders`, against whatever provider `config.yaml` selects — so `local` and `fake` work the day this lands, and T15 inherits all three for free. T15's done-when ("`janus ci wait|trigger|digest` work against fixtures") then reduces to pointing the same commands at the TeamCity adapter.

**R4. `janus fake scm comment|approve|decline|merge` is a new command group.** `tasks.md` T10 asks for it. It is **not** in §8's list because §8 predates it; the plan adds it as a debug/dogfooding group and Task 13 says so in the command's own description text and doc comment. Its done-when is that the hooks drive a PR through comment → approval → merge **across separate processes**: Task 13's test shells out to a real `node` process more than once and asserts the persisted store carried state between them.

**R5. `createProviders` keeps throwing `ProviderNotImplementedError` for `teamcity` and `bitbucket-server`, and stops throwing for `local`.** The task numbers in the messages move to T15 and T16. Every stale "T09 replaces this with…" / "T10 replaces this with…" doc comment in the files this plan touches is rewritten to describe what the code now is, not what it is waiting for.

**R6. The contract suite is reusable by T15 and T16 by construction.** It lives under `tests/providers/contract/`, is a function parameterized by a provider factory plus a capability descriptor, and is *called* — never copied. T15 and T16 each add exactly one call plus one `setup` function. See D6.

**R7. Every commit message has a scope**, and the two trailer lines go in a second `-m` with a blank line before them.

**R8. Adversarial check, from T08's final review.** Three separate bypasses of the same family survived task-level review in T08. For every deterministic thing this plan specifies, the question "what is the cheapest input that defeats this?" is answered with a test:
- a failure signature that changes when only a **line number**, a **timestamp**, a **duration** or an **absolute path prefix** changes is broken → Task 4 Steps 1–8;
- a failure signature that **collides** two genuinely different compile errors is broken (T09's done-when names this explicitly) → Task 4 Step 5;
- a digest that leaks a token because it appeared in a **log line** rather than in a URL is broken → Task 2 Steps 1–3 and Task 3 Step 7;
- a digest that respects `max_bytes` by dropping the *end* and so loses the last error is broken → Task 3 Step 9;
- a test identity that changes when **Chrome upgrades** is broken → Task 8 Steps 5–6;
- a fake whose `merge` silently succeeds on an already-declined PR is broken → Task 11 Step 9.

**R9. Agent self-reports are unreliable in both directions** (carried from T08 R1). Nothing in this plan reads `AgentResult.changes_made`. The CI provider's view of a build comes from the provider's own observation; the SCM provider's view of a PR comes from its own store or API.

**R10. Steps never import `writeState`** (carried from T08 R3). Nothing in this plan imports `src/state/state-store.js`. Providers do not touch `state.yaml` at all.

---

## Decisions this plan locks in

**D1. `src/providers/ci/` and `src/providers/scm/` are sibling packages; `src/providers/types.ts` keeps `AgentRunner` and `Providers` and re-exports both interfaces.** `tasks.md` describes T09 and T10 as replacing stub interfaces "in the same file", and the literal reading — one 400-line `types.ts` holding three provider interfaces, two dozen data types, the classification table and the digest shape — contradicts the convention every other package in this repo follows (`src/doctor/`: `types.ts`, `exec.ts`, `http.ts`, `fs.ts`, `report.ts`, `checks/*`; `src/policy/`: `types.ts`, `diff.ts`, `glob.ts`, `checks/*`). The re-export preserves the property that matters: `import type { CiProvider, ScmProvider } from '../providers/types.js'` — which `tests/integration/harness/harness.ts:11` and `src/cli/context.ts:3` both do today — keeps compiling untouched.

**D2. No telemetry event and no evidence file in this plan.** See R2. The decision is recorded here as well as in the rulings because it is the single easiest boundary for an executor to cross by accident: `failureDigest()` returning a `FailureDigest` *looks* like it wants to write `evidence/digests/<repo>/<build-id>.md`, and `renderDigestMarkdown()` exists precisely so that T12 can do that in one line without the provider having ever touched the filesystem under `.janus/`.

**D3. The redactors are lifted into `src/redact/`, not copied and not imported across package boundaries.** R8's third bullet needs a redactor for *free-form log text*: a build log carries `Authorization: Bearer <pat>` header echoes, `git clone https://user:pat@host/...` lines and bare `ghp_…` tokens in environment dumps — none of which are URLs that `redactUrl` can parse. Two candidates already exist: `redactCredentials` in `src/doctor/redact.ts` (the best-effort free-text pass) and `SECRET_PATTERNS` in `src/policy/checks/secrets.ts` (the shape-based token detector, already reviewed and tested against false positives on Angular `environment.ts`). Writing a third is exactly what R8 forbids, and importing `src/doctor/redact.js` from `src/providers/` would make the CI provider depend on the doctor package. So Task 2 **moves** both into a new `src/redact/` package — `url.ts` (`redactUrl`, `redactCredentials`), `patterns.ts` (`SecretPattern`, `SECRET_PATTERNS`), `text.ts` (the new `redactLogText`), `index.ts` — and updates the six importers. `src/doctor/redact.ts` is deleted, not left as a shim: a shim would let a future file import the old path and quietly reintroduce the split.

**D4. `waitForBuild` never throws on timeout; it returns an `infra` outcome.** §16.1 says "`waitForBuild` until finished or `build_timeout`" and lists "timeout in queue" under `infra`. A provider that throws would force every caller (T12's loop, T17's E2E wait, `janus ci wait`) to write the same try/catch and re-derive the same classification. Instead, a wait that runs out of time returns `{ status: <last observed>, classification: 'infra', rawStatus: 'timeout' }`, and §16.1's "`infra` outcomes re-trigger once then escalate" applies with no special case. `CiProviderError` still exists, with `kind: 'not_found' | 'transport' | 'config'`, for the things that genuinely are errors: a build id the provider has never heard of, an unreachable server (T15), a repo with no `local_ci` entry.

**D5. Classification is a pure function with an explicit raw-status vocabulary, and observed failed tests beat an optimistic raw status.** `classifyBuild({ rawStatus, failedTests, problems })` in `src/providers/ci/classify.ts` maps §16.1's four outcomes from six normalized raw statuses (`success`, `failure`, `unknown`, `cancelled`, `failed_to_start`, `timeout`). Each provider normalizes its own vocabulary into those six — TeamCity's `SUCCESS`/`FAILURE`/`UNKNOWN` plus queue states (T15), the `local` provider's exit codes, the fake's script. Two rulings inside it:
  - `unknown` maps to `infra` **unless** failed tests or build problems exist, which is §16.1's TeamCity sentence generalized to every provider.
  - `success` with a non-empty failed-test list maps to `tests_failed`, and `success` with build problems and no failed tests maps to `build_failed`. These are the cheapest inputs that defeat a naive classifier (a build configuration that reports green while its test step published failures, or while a problem was recorded), and treating the *observation* as authoritative over the *label* is the same principle R9 states for agent self-reports. Confirmed in controller review: §16.1 defines `tests_failed` as "failed test occurrences present", which is an observation and not a label.
  - `cancelled`, `failed_to_start` and `timeout` map to `infra` unconditionally, even with failed tests present: §16.1 lists them under `infra` with no qualifier, and §31.32 ("infrastructure build failures never consume a debug attempt") is the property that must not be weakened.

**D6. One contract scaffold, two suites, capability-gated.** `tests/providers/contract/capability.ts` holds the single shared primitive — `itWhen(enabled, capability, title, fn)`, which is `it` when the provider claims the capability and `it.skipIf` with a title that names the missing capability when it does not. `ci.ts` and `scm.ts` each export a `describe*ProviderContract(options)` function taking `{ name, capabilities, setup }`, where `setup(scenario)` returns a fresh provider plus the fixtures that scenario needs. A provider is wired in with **one call**:

```ts
describeCiProviderContract({ name: 'fake', capabilities: FAKE_CI_CAPABILITIES, setup: fakeSetup });
```

  T15 adds `describeCiProviderContract({ name: 'teamcity', capabilities: TEAMCITY_CI_CAPABILITIES, setup: fixtureSetup })` and T16 the SCM equivalent — no second suite, no copied assertions. The capability descriptor exists because the three CI providers genuinely differ: `local` has no queue and cannot produce `infra` from a cancellation, a Bitbucket HTTP access token cannot merge (§15), and only a real SCM reports `newFailure`-style reviewer metadata. Capabilities are declared per provider, not inferred, so a provider that *loses* a capability fails the review rather than silently skipping tests.

**D7. The `local` provider persists its build records under `<workspace>/.local-ci/`, a new provider-owned directory beside `fake/`.** Three constraints collide: §16.1 wants `findBuild` to be able to answer "this revision already has a build"; R2 forbids the provider from writing under `.janus/evidence/`; and `janus ci digest --build <id>` runs in a *different process* from the `janus ci trigger` that produced it, so an in-memory cache cannot work. `fake/` is wrong — `local` is a real provider and §5 says `fake/` holds "persisted fake provider state (only with fake providers)". So `WorkspacePaths` gains `localCiDir` (`<workspace>/.local-ci`), `createWorkspaceDirs` and `removeWorkspaceArtifacts` gain it, and one JSON file per build lands at `.local-ci/<repo>/<build-id>.json`. It is a cache, not state: deleting it costs a rebuild and nothing else.

  This is a **deviation from §5**, whose layout block lists exactly `.janus/`, `repos/`, `fake/`, `.pnpm-store/` and `janus.lock`. Task 7 Step 6 edits §5 to include it, in its own commit, following the precedent T03 set when it edited §6, §26 and §27 — the code and the spec do not get to disagree.

**D8. The `local` provider needs its own process runner; it does not reuse `src/doctor/exec.ts`.** Verified on this machine: `/bin/sh` is `dash`, `spawn('sh', ['-c', 'sleep 30'])` does not exec the command, and `child.kill('SIGTERM')` — which is what `spawnCodex` and therefore `runCommand` do — kills the shell and **orphans the command**. A timed-out `pnpm build` would keep running in the repository checkout while Janus moved on to reset the tree: a data race with `resetHard`, on a 90-minute default build timeout. `src/providers/local/exec.ts` therefore spawns with `detached: true` and kills with `process.kill(-child.pid, signal)`, which was verified to leave no orphan. It keeps everything else `runCommand` got right — never reject, SIGTERM then SIGKILL after a grace, output caps keeping the tail, `spawnFailed` for a missing binary — and it is injectable as a `LocalCommandRunner` seam so every `local` provider test runs without a shell. Flagged in the handback as a deliberate second subprocess implementation, with the orphan evidence as its justification.

**D9. `local` maps every build type id to the same repo command sequence; E2E routing is T17's.** `local_ci.e2e` exists in the schema and stays unread by this plan. Routing `goal.e2e.build_type_id` to it would require passing the `Goal` into `createProviders`, which neither of its two callers does today, for a stage (§17) that is three tasks away and depends on T15. The `local` provider records the requested `buildTypeId` on the `BuildRef` so nothing is lost, runs `install` → `lint` → `build` → `test` (skipping each key that is absent), and stops at the first non-zero exit.

**D10. JUnit test identity is `suite › name`, with an exact-prefix rule and a configurable browser-segment drop.** Verified on real output from all three reporters, which disagree completely:

| Reporter | `classname` | `name` |
|---|---|---|
| vitest | `sample.test.ts` | `AppComponent > should render title` |
| jest-junit | `AppComponent should render title` | `AppComponent should render title` (identical) |
| karma-junit | `Chrome_Headless_153_0_0_0_(Linux_0_0_0).AppComponent` | `AppComponent should render title` |

  The rule: take `classname`, drop its first `junit_suite_prefix_depth` dot-separated segments (default `0`), call the result `suite`; then `identity = suite === '' || name === suite || name.startsWith(suite) ? name : suite + ' › ' + name`. Every branch is exact string comparison — no fuzzy matching. It yields `sample.test.ts › AppComponent > should render title` for vitest, `AppComponent should render title` for jest-junit, and — with `junit_suite_prefix_depth: 1` — `AppComponent should render title` for Karma. Without the depth setting Karma's identity embeds `Chrome_Headless_153_0_0_0`, so **a Chrome upgrade would change every test identity and therefore every failure signature**, silently defeating no-progress detection (§16.3). That is R8's "cheapest input" for this component, so the knob is a per-repo config field with a doctor check (D12) that warns when a `local` repo configures `junit` without it. Confirmed in controller review: auto-detecting which `classname` segment is a browser name would be exactly the denylist-shaped guess `redactUrl`'s own doc comment argues against.

**D11. `config.local_ci` gains exactly three fields.** (Separately, and for a different reason, `config.digest` gains `max_test_detail_lines` in Task 3 — see the controller rulings.) `timeout_minutes` (positive int, default 30) at the block level, and `junit` (optional glob, repo-relative) plus `junit_suite_prefix_depth` (non-negative int, default 0) per repo. Nothing else: no reporter selector, because the Karma and Jest summary parsers are distinguished by their own marker lines and trying both costs two regex tests; and no per-command timeout, because §28's `local_ci` block is deliberately small and a single ceiling is what `guardrails.max_agent_runtime_minutes` already models for agents.

**D12. `provider.ci` reachability does not change; a new `provider.local_ci` check is added.** The existing check skips whenever `ci_provider !== 'teamcity'` with the detail "which reaches no network service" — that sentence stays true for `local`, which reaches nothing. But making `local` a real provider creates a new class of environment problem doctor exists to catch (§31.33's spirit): a goal repo with no `local_ci.repos.<name>` entry, or one with no `test` command, fails at the first PR build with a message from deep inside the provider. `localCiConfigCheck` is pure config-and-goal, needs no I/O seam, and emits one finding per goal repo: `fail` when the repo has no entry or no `test`, `warn` when `junit` is set without `junit_suite_prefix_depth` and the repo therefore risks D10's browser-version instability, `warn` when `junit` is absent (identities fall back to the coarser summary parser), `pass` otherwise. It skips entirely when `ci_provider !== 'local'`.

**D13. `addComment` returns the new comment id.** §3.2 sketches `addComment(ref, text, replyTo?): Promise<void>`. §24 requires Janus to mark a comment `answered` after posting a `no_change_needed` reply, and `review_loop.open_comments[].comment_id` is how it does that — which needs the id of the reply so a later poll can recognize it as Janus's own without re-deriving it from the activity stream. Returning `Promise<string>` is a strict widening of the sketch: a caller that ignores it behaves exactly as sketched. Flagged in the handback as a deviation from §3.2.

**D14. `findPullRequest(repo, branch)` is added to the interface.** T16's done-when names "find by branch" and §7's resume reconciliation needs to recover a PR reference when `state.repos.<name>.pr.id` is null but a PR exists. It is the SCM twin of `findBuild`.

**D15. The PR description renderer is pure and golden-string tested, not snapshot-file tested.** R-f gives T10 the renderer and T14 the wiring. `renderPrDescription(input): string` reads nothing, writes nothing and takes no clock. Its tests assert against a full expected string written out in the test file (a "golden string"), not `toMatchSnapshot()` — a snapshot file would make the first executor's run *write* the expectation rather than check it, which is the one thing a golden test must not do. The rendered body opens with `PR_DESCRIPTION_MARKER` (`<!-- janus:pr-description -->`) so T14 can tell a Janus-owned description from a human-edited one before overwriting it.

**D16. The fake SCM stores snake_case and the domain types are camelCase, with one mapper.** `fake/scm.json` is a hand-edited dogfooding file (that is the whole point of `janus fake scm`), and every other persisted store in this repo — `FakeCiCall.build_type_id`, `FakeAgentCall.run_id`, every evidence YAML — is snake_case. The domain types crossing the provider interface are camelCase, like every other in-memory type. `src/providers/fake/scm.ts` holds the two `toActivity` / `toPullState` mappers and they are the only place the two spellings meet.

**D17. Activity ids are zero-padded and lexicographically ordered.** `review_loop.activity_cursor` is `Record<string, string>` in `src/state/state-schema.ts:263` — a string cursor. The fake mints `a-000001`, `a-000002`, … so `listActivitySince(ref, cursor)` is a string comparison (`id > cursor`) with no numeric parsing and no ambiguity at the 10th, 100th or 1000th activity. Bitbucket Server's real activity ids are numeric and monotonic (T16), and T16's adapter will zero-pad them the same way so the cursor semantics are provider-independent.

**Two further decisions, D19 and D20, were added while running this plan's Self-Review and are recorded in that section** (a third parameter on `failureDigest` for the baseline exceptions, and moving `src/policy/glob.ts` to `src/glob/` for the same reason D3 moved the redactors). They are binding exactly as the ones above are.

**D18. The fake's hook functions are ordinary exported functions over `fakeDir`, shared by the CLI and the tests.** `fakeScmComment`, `fakeScmApprove`, `fakeScmNeedsWork`, `fakeScmDecline`, `fakeScmMerge` and `fakeScmPushCommit` take `(fakeDir, input)` and mutate `fake/scm.json`. `janus fake scm <verb>` is a thin argument parser over them and the contract suite's `hooks` are the same functions. One implementation, two callers — which is what makes Task 13's cross-process test meaningful: it exercises the same code path a test does, through a real process boundary.

---

## Scope boundaries

**In scope.** `CiProvider` and `ScmProvider` full interfaces and their types; outcome classification (`success | tests_failed | build_failed | infra`); the bounded redacted failure digest (§16.2) with its caps from `config.digest`; the failure signature (§16.3) with normalized error lines; the `local` CI provider (configured commands per repo, JUnit / Karma / Jest summary parsing for failed test identities); the `fake` CI provider (scripted per repo and attempt, supports a missing build and an `infra` outcome, persisted); the `fake` SCM provider persisted at `fake/scm.json` with test hooks **and** CLI hooks; the PR description renderer; two provider contract test suites over one scaffold; `janus ci wait|trigger|digest`; `janus fake scm comment|approve|decline|merge`; the `src/redact/` lift; three `local_ci` config fields; one new doctor check.

**Out of scope, deliberately.** The TeamCity adapter (T15) and the Bitbucket Server adapter (T16) — `createProviders` still throws `ProviderNotImplementedError` for both, with their task numbers corrected. Any engine stage step or run-loop wiring: `src/engine/steps.ts` is not touched, and T11, T12 and T13 are the consumers that will call these providers. The E2E stage and `local_ci.e2e` (T17). Telemetry events and evidence files (T21, T12 — see R2/D2). PR description *updating* at package boundaries (T14 — R-f). `state.yaml` writes of any kind (R10).

---

## File Structure

```text
# Task 1 — the CI interface and the classification table
src/providers/ci/types.ts            BuildStatus, BuildClassification, BUILD_CLASSIFICATIONS, BuildRef,
                                     BuildProblem, FailedTest, BuildOutcome, TriggerBuildInput,
                                     WaitForBuildOptions, CiProvider, CiProviderError
src/providers/ci/classify.ts         RawBuildStatus, RAW_BUILD_STATUSES, ClassifyBuildInput, classifyBuild

# Task 2 — the shared redaction package (lift, not copy)
src/redact/url.ts                    moved from src/doctor/redact.ts: redactUrl, redactCredentials
src/redact/patterns.ts               moved from src/policy/checks/secrets.ts: SecretPattern, SECRET_PATTERNS
src/redact/text.ts                   new: redactLogText, redactLogLines, AUTHORIZATION_HEADER_RE
src/redact/index.ts                  the surface
src/doctor/redact.ts                 DELETED
src/doctor/checks/providers.ts       modify:1   import from ../../redact/index.js
src/doctor/checks/repo.ts            modify:4   import from ../../redact/index.js
src/doctor/report.ts                 modify:2   import from ../redact/index.js
src/policy/checks/secrets.ts         modify:1-46 import SECRET_PATTERNS from ../../redact/index.js; re-export
tests/doctor/redact.test.ts          MOVED to tests/redact/url.test.ts

# Task 3 — the §16.2 digest
src/providers/ci/digest.ts           DigestLimits, digestLimitsFrom, DigestErrorWindow, FailureDigest,
                                     BuildDigestInput, buildFailureDigest, renderDigestMarkdown, isErrorLine,
                                     ERROR_WINDOW_BEFORE, ERROR_WINDOW_AFTER

# Task 4 — the §16.3 signature
src/providers/ci/signature.ts        normalizeErrorLine, SignatureInput, failureSignature,
                                     digestErrorLines, signatureFromDigest

# Task 5 — the full fake CI provider
src/providers/fake/ci.ts             rewrite: FakeCiScriptEntry, FakeCiRecordedBuild, FakeCiCall, FakeCiStore,
                                     buildKey, fakeBuildId, emptyFakeCiStore, normalizeFakeCiStore, readFakeCi,
                                     writeFakeCi, seedFakeCi, seedFakeBuilds, createFakeCiProvider

# Task 6 — the contract scaffold and the CI suite
tests/providers/contract/capability.ts  itWhen, contractTitle
tests/providers/contract/ci.ts          CiCapabilities, CiContractScenario, CiContractSubject,
                                        CiContractOptions, describeCiProviderContract
tests/providers/contract/fake-ci.test.ts  FAKE_CI_CAPABILITIES + the one call

# Tasks 7-8 — the local CI provider (and the glob lift, D20)
src/glob/match.ts                    moved from src/policy/glob.ts: matchesGlob, matchesAnyGlob
src/glob/index.ts                    the surface
src/policy/glob.ts                   DELETED
src/policy/index.ts                  modify:12    re-export from ../glob/index.js
src/policy/checks/lockfile.ts        modify:1     import from ../../glob/index.js
src/policy/checks/scope.ts           modify:2     import from ../../glob/index.js
tests/policy/glob.test.ts            MOVED to tests/glob/match.test.ts
src/providers/local/exec.ts          LocalCommandRequest, LocalCommandResult, LocalCommandRunner,
                                     runLocalCommand, LOCAL_SIGKILL_GRACE_MS, LOCAL_OUTPUT_CAP_BYTES
src/providers/local/store.ts         LocalBuildRecord, localBuildPath, writeLocalBuild, readLocalBuild,
                                     findLocalBuild
src/providers/local/provider.ts      LocalCiProviderInput, createLocalCiProvider, LOCAL_COMMAND_ORDER
src/providers/local/junit.ts         JUnitCase, ParseJUnitOptions, parseJUnitXml, junitIdentity,
                                     collectJUnitFiles, readJUnitCases
src/providers/local/summary.ts       TestSummary, parseKarmaSummary, parseJestSummary, parseTestSummary,
                                     stripAnsi
src/config/config-schema.ts          modify:102-120  local_ci.timeout_minutes, repos.<n>.junit,
                                     repos.<n>.junit_suite_prefix_depth
src/workspace/layout.ts              modify:5-53     localCiDir
tests/providers/contract/local-ci.test.ts  LOCAL_CI_CAPABILITIES + the one call

# Task 9 — wiring and the ci debug commands
src/providers/index.ts               modify: createProviders builds local; T15/T16 in the messages
src/providers/types.ts               modify: AgentRunner + Providers only; re-export ci/ and scm/
src/cli/commands/ci.ts               rewrite: wait, trigger, digest over createProviders
src/doctor/checks/providers.ts       modify: + localCiConfigCheck
src/doctor/index.ts                  modify:26-40 register localCiConfigCheck

# Task 10 — the SCM interface and the PR description renderer
src/providers/scm/types.ts           PullRequestState, PullRef, ReviewerStatus, PullState, InlineAnchor,
                                     ActivityKind, Activity, CreatePullRequestInput, ScmProvider,
                                     ScmProviderError
src/providers/scm/pr-description.ts  PR_DESCRIPTION_MARKER, PrSibling, PrWorkPackage, PrDescriptionInput,
                                     renderPrDescription

# Tasks 11-12 — the full fake SCM provider and its contract suite
src/providers/fake/scm.ts            rewrite: FAKE_SCM_USER, FakeScmPull, FakeScmActivityRecord, FakeScmCall,
                                     FakeScmStore, emptyFakeScmStore, normalizeFakeScmStore, readFakeScm,
                                     writeFakeScm, seedFakeScm, toPullState, toActivity, FakeScmHookError,
                                     fakeScmComment, fakeScmApprove, fakeScmNeedsWork, fakeScmDecline,
                                     fakeScmMerge, fakeScmPushCommit, createFakeScmProvider
tests/providers/contract/scm.ts      ScmCapabilities, ScmContractHooks, ScmContractSubject,
                                     ScmContractOptions, describeScmProviderContract
tests/providers/contract/fake-scm.test.ts  FAKE_SCM_CAPABILITIES + the one call

# Task 13 — the fake scm CLI group
src/cli/commands/fake.ts             registerFake
src/cli/commands/index.ts            modify:1-27 registerFake
tests/helpers/run-cli.ts             modify: runCliProcess (out-of-process, via tsx)
tests/integration/fake-scm-cli.test.ts  the cross-process comment -> approve -> merge test

# Task 14 — harness wiring and integration scenarios
tests/integration/harness/git-audit.ts  modify: ProviderGitWrite, auditCiProvider, auditScmProvider,
                                        formatProviderGitWrites
tests/integration/harness/harness.ts    modify: ci/scm seeds, providerGitWrites, expectNoProviderGitWrites
tests/integration/providers.test.ts     the §16.1 loop, the §24 loop, the local provider, the audit proof

# Tests (unit)
tests/redact/url.test.ts             tests/redact/text.test.ts
tests/providers/ci/classify.test.ts  tests/providers/ci/digest.test.ts   tests/providers/ci/signature.test.ts
tests/providers/fake-ci.test.ts      tests/providers/fake-scm.test.ts
tests/providers/local/exec.test.ts   tests/providers/local/junit.test.ts tests/providers/local/summary.test.ts
tests/providers/local/provider.test.ts  tests/providers/local/store.test.ts
tests/providers/scm/pr-description.test.ts
tests/providers/create-providers.test.ts   modify: local builds, T15/T16
tests/providers/fake-ci-scm.test.ts        DELETED (replaced by fake-ci.test.ts + fake-scm.test.ts)
tests/glob/match.test.ts             moved, content unchanged
tests/cli/ci-command.test.ts         tests/cli/fake-scm-command.test.ts
tests/cli/commands.test.ts           modify:5-18 drop the three ci stub rows; add "fake" to the help list
tests/doctor/local-ci-check.test.ts
tests/doctor/registry.test.ts        modify:15-29 add provider.local_ci to the id list
tests/config/config-schema.test.ts   modify: the three local_ci fields
tests/workspace/layout.test.ts       modify: localCiDir
tests/helpers/workspace-fixtures.ts  modify: createHarnessWorkspace (ciProvider, localCi, scmProvider)

# Task 15
tasks.md                             modify:22 the Status table rows
```

---

## Task 1: The `CiProvider` interface and the §16.1 classification table

**Files:**
- Create: `src/providers/ci/types.ts`
- Create: `src/providers/ci/digest.ts` (type declarations only; Task 3 fills it in)
- Create: `src/providers/ci/classify.ts`
- Test: `tests/providers/ci/classify.test.ts`

**Interfaces:**
- Consumes: nothing. This is the foundation task.
- Produces:
  - `type BuildStatus = 'queued' | 'running' | 'finished'`
  - `type BuildClassification = 'success' | 'tests_failed' | 'build_failed' | 'infra'` and `BUILD_CLASSIFICATIONS: readonly BuildClassification[]`
  - `interface BuildRef { id: string; repo: string; buildTypeId: string; revision: string | null; branch: string | null; url: string | null }`
  - `interface BuildProblem { identity: string; type: string; details: string }`
  - `interface FailedTest { identity: string; name: string; suite: string | null; newFailure: boolean | null; details: string }`
  - `interface BuildOutcome { ref: BuildRef; status: BuildStatus; classification: BuildClassification; rawStatus: string; problems: BuildProblem[]; failedTests: FailedTest[]; startedAt: string | null; finishedAt: string | null }`
  - `interface TriggerBuildInput { repo: string; buildTypeId: string; branch: string; revision: string; params: Record<string, string> }`
  - `interface WaitForBuildOptions { timeoutMs: number; pollIntervalMs: number }`
  - `interface CiProvider` with `name`, `findBuild(repo, revision, buildTypeId)`, `triggerBuild(input)`, `waitForBuild(ref, options)` and **`failureDigest(ref: BuildRef, limits: DigestLimits, exceptions: readonly string[]): Promise<FailureDigest>`** — three parameters, per D19
  - `class CiProviderError extends Error` with `kind: CiProviderErrorKind` and `provider: string`
  - `interface DigestLimits`, `interface DigestErrorWindow`, `interface FailureDigest` (declared here, built in Task 3)
  - `const RAW_BUILD_STATUSES`, `type RawBuildStatus`, `interface ClassifyBuildInput`, `function classifyBuild(input: ClassifyBuildInput): BuildClassification`

**Why:** §3.2 sketches four methods and §16.1 gives them meaning. Everything else in T09 — the digest, the signature, both providers, the contract suite, the three CLI commands — is typed against these names, so they land first and never change afterwards. `CiProvider.failureDigest` returns a `FailureDigest` and takes `DigestLimits`, so those two types are declared in this task (in `digest.ts`, where Task 3 will build them) rather than left dangling: every task's `pnpm typecheck` has to be green on its own.

**`failureDigest` has three parameters, not §3.2's two (D19).** Get this right here: TypeScript will not let an implementation declare *more required parameters* than the interface it satisfies (`Target signature provides too few arguments`), so a two-parameter declaration in this task makes Task 5 — the first implementation — fail to compile, and the mistake surfaces four tasks away from its cause.

- [ ] **Step 1: Write the failing classification test**

Create `tests/providers/ci/classify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { classifyBuild, RAW_BUILD_STATUSES } from '../../../src/providers/ci/classify.js';
import type { RawBuildStatus } from '../../../src/providers/ci/classify.js';

const classify = (rawStatus: RawBuildStatus, failedTests = 0, problems = 0): string =>
  classifyBuild({ rawStatus, failedTests, problems });

describe('classifyBuild', () => {
  it('maps the four §16.1 outcomes from a clean build result', () => {
    expect(classify('success')).toBe('success');
    expect(classify('failure', 3)).toBe('tests_failed');
    expect(classify('failure', 0, 1)).toBe('build_failed');
    expect(classify('failure', 0, 0)).toBe('build_failed');
  });

  it('maps every non-finishing raw status to infra, even when failed tests were reported', () => {
    // §16.1 lists cancelled / failed to start / timeout under `infra` with no qualifier, and §31.32 says
    // infrastructure failures never consume a debug attempt. A cancelled build's partial test results must
    // not be allowed to launch a debug agent.
    for (const raw of ['cancelled', 'failed_to_start', 'timeout'] as const) {
      expect(classify(raw), raw).toBe('infra');
      expect(classify(raw, 5), `${raw} with failed tests`).toBe('infra');
      expect(classify(raw, 0, 5), `${raw} with problems`).toBe('infra');
    }
  });

  it('maps UNKNOWN to infra unless failed tests or problems exist', () => {
    expect(classify('unknown')).toBe('infra');
    expect(classify('unknown', 0, 2)).toBe('build_failed');
    expect(classify('unknown', 1)).toBe('tests_failed');
  });

  it('lets an observed failure beat an optimistic raw status', () => {
    // D5. The cheapest input that defeats a naive classifier: a build configuration that reports green while
    // its test step published failures, or reported a build problem. The observation wins.
    expect(classify('success', 2)).toBe('tests_failed');
    expect(classify('success', 0, 1)).toBe('build_failed');
  });

  it('classifies every raw status in the vocabulary', () => {
    for (const raw of RAW_BUILD_STATUSES) {
      expect(typeof classify(raw), raw).toBe('string');
    }
    expect(RAW_BUILD_STATUSES).toEqual(['success', 'failure', 'unknown', 'cancelled', 'failed_to_start', 'timeout']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit tests/providers/ci/classify.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/providers/ci/classify.js"`.

- [ ] **Step 3: Create `src/providers/ci/types.ts`**

```ts
import type { DigestLimits, FailureDigest } from './digest.js';

/**
 * Spec §3.2's `CiProvider`, in full, replacing the one-method stub T04 left in `src/providers/types.ts`.
 *
 * A CI provider is a **pure I/O adapter**. It observes builds and reports what it saw; it writes no telemetry,
 * no evidence and no git. That mirrors the `AgentRunner` contract next door — the engine writes
 * `evidence/builds/`, `evidence/digests/` and the `ci.build.*` events around every provider call (T12), which is
 * what makes the `fake`, `local` and `teamcity` paths produce an identical audit trail.
 *
 * Implementations: `local` and `fake` (T09), `teamcity` (T15).
 */

/** Where a build is in its lifecycle. Orthogonal to {@link BuildClassification}, which is *how it went*. */
export type BuildStatus = 'queued' | 'running' | 'finished';

/**
 * Spec §16.1's four outcomes. These exact four strings are already the vocabulary of
 * `state.repos.<name>.last_build.classification` in `src/state/state-schema.ts`, and must stay identical to it.
 */
export type BuildClassification = 'success' | 'tests_failed' | 'build_failed' | 'infra';

export const BUILD_CLASSIFICATIONS: readonly BuildClassification[] = ['success', 'tests_failed', 'build_failed', 'infra'];

/**
 * How a build is addressed after it has been found or triggered. `id` is what lands in
 * `state.repos.<name>.last_build.id` and what `janus ci digest --build` takes.
 *
 * `revision`, `branch` and `url` are nullable because not every provider can answer them: the `local` provider
 * has no web UI, and a TeamCity build found by queue id has no revision until it starts.
 */
export interface BuildRef {
  id: string;
  repo: string;
  buildTypeId: string;
  revision: string | null;
  branch: string | null;
  url: string | null;
}

/**
 * One §16.1 "build problem": a compile error, a lint failure, a non-zero script exit, a VCS error.
 *
 * `identity` is the stable string the §16.3 signature hashes and a §11 baseline exception matches on. It must
 * not embed a build id, a timestamp or a line number — two runs of the same broken build must produce the same
 * identity, or no-progress detection is dead.
 */
export interface BuildProblem {
  identity: string;
  /** Provider-specific problem type: TeamCity's `TC_COMPILATION_ERROR`, the local provider's `command_failed`. */
  type: string;
  details: string;
}

/** One failed test occurrence. `identity` carries the same stability contract as {@link BuildProblem.identity}. */
export interface FailedTest {
  identity: string;
  name: string;
  suite: string | null;
  /** §16.2's `newFailure` flag. `null` when the provider cannot tell a new failure from a repeat one. */
  newFailure: boolean | null;
  details: string;
}

/** Everything one observation of a build produced. */
export interface BuildOutcome {
  ref: BuildRef;
  status: BuildStatus;
  classification: BuildClassification;
  /** The provider's own status string, kept verbatim for the evidence trail: `SUCCESS`, `UNKNOWN`, `exit 1`. */
  rawStatus: string;
  problems: BuildProblem[];
  failedTests: FailedTest[];
  startedAt: string | null;
  finishedAt: string | null;
}

/** §16.1 step 2's explicit trigger. `params` carries §4's `branch_params` (T17) and T20's `janus.version`. */
export interface TriggerBuildInput {
  repo: string;
  buildTypeId: string;
  branch: string;
  revision: string;
  params: Record<string, string>;
}

/**
 * `teamcity.build_timeout_minutes` and `teamcity.poll_interval_seconds`, in milliseconds.
 *
 * A wait that runs out of time **returns** an `infra` outcome rather than throwing (D4): §16.1 lists "timeout in
 * queue" under `infra`, and every caller would otherwise re-derive that same mapping from a catch block.
 */
export interface WaitForBuildOptions {
  timeoutMs: number;
  pollIntervalMs: number;
}

export type CiProviderErrorKind = 'not_found' | 'transport' | 'config';

/**
 * The things that genuinely are errors, as opposed to build outcomes: a build id the provider has never heard
 * of (`not_found`), an unreachable server (`transport`, T15), a repository with no `local_ci` entry (`config`).
 * A red build is never one of these.
 */
export class CiProviderError extends Error {
  readonly kind: CiProviderErrorKind;
  readonly provider: string;

  constructor(provider: string, kind: CiProviderErrorKind, message: string) {
    super(`${provider} ci provider: ${message}`);
    this.name = 'CiProviderError';
    this.kind = kind;
    this.provider = provider;
  }
}

export interface CiProvider {
  readonly name: 'teamcity' | 'local' | 'fake';
  /** §16.1 step 1. `null` means "no build exists for this revision yet", which is the explicit-trigger trigger. */
  findBuild(repo: string, revision: string, buildTypeId: string): Promise<BuildRef | null>;
  /** §16.1 step 2. `explicit_trigger: true` is recorded by the caller (T12), never here. */
  triggerBuild(input: TriggerBuildInput): Promise<BuildRef>;
  /** §16.1 step 3. Returns an `infra` outcome on timeout; never throws for a red build (D4). */
  waitForBuild(ref: BuildRef, options: WaitForBuildOptions): Promise<BuildOutcome>;
  /**
   * §16.2, bounded by `limits` and redacted by §32 rule 12. Returns the digest; never writes it.
   *
   * `exceptions` is the approved §11 baseline exception identities in force for this repository. It is a
   * parameter rather than a field on {@link DigestLimits} — and rather than something the provider looks up —
   * because §16.2 lists "baseline-exception matches" as digest *content* while `state.baseline.exceptions` is
   * state, and a provider reads no state at all. The caller (T12, or `janus ci digest`) supplies them; the
   * provider only matches against them.
   */
  failureDigest(ref: BuildRef, limits: DigestLimits, exceptions: readonly string[]): Promise<FailureDigest>;
}

export type { DigestLimits, FailureDigest };
```

- [ ] **Step 4: Create `src/providers/ci/digest.ts` with its three type declarations**

Task 3 fills in the builder and the renderer; this task declares only what `CiProvider` needs to compile:

```ts
import type { BuildClassification, BuildProblem, BuildRef, FailedTest } from './types.js';

/**
 * Spec §16.2's bounded, redacted failure digest.
 *
 * The types live here — and not beside `CiProvider` in `./types.ts` — because the digest is a value a provider
 * *produces*, not part of how a provider is addressed, and because §28's `digest` config block is the sole
 * source of its limits.
 */

/** §28's `digest` block, resolved once per run and handed to `CiProvider.failureDigest`. */
export interface DigestLimits {
  /** `digest.max_tests`: how many failed tests the digest may list. */
  maxTests: number;
  /**
   * `digest.max_test_detail_lines`: how many lines of one failed test's (or one problem's) details survive.
   *
   * Its own cap rather than a reuse of `max_tests`: reading one number as both a test count and a per-test line
   * budget is incoherent — at the defaults that would be 50 tests of 50 lines each — and every other §16.2 cap
   * is configurable. Task 3 adds the field to §28's `digest` block and to the spec.
   */
  maxTestDetailLines: number;
  /** `digest.log_tail_lines`: how many trailing log lines the digest may carry. */
  logTailLines: number;
  /** `digest.max_error_windows`: how many windows around error lines the digest may carry. */
  maxErrorWindows: number;
  /** `digest.max_bytes`: hard ceiling on the rendered digest. */
  maxBytes: number;
  /** `digest.redact`: §32 rule 12's pass. Only false in a test that asserts the pass is what removed a token. */
  redact: boolean;
}

/** One window of log lines around a line that looked like an error (§16.2). */
export interface DigestErrorWindow {
  /** 1-based index of the error line inside the log the window was cut from. */
  line: number;
  /** The error line itself, redacted. §16.3 hashes exactly this, normalized. */
  errorLine: string;
  /** The window: `ERROR_WINDOW_BEFORE` lines of context, the error line, `ERROR_WINDOW_AFTER` lines after. */
  lines: string[];
}

/** The §16.2 digest. Task 3 builds it; a provider returns it; T12 writes it under `evidence/digests/`. */
export interface FailureDigest {
  ref: BuildRef;
  classification: BuildClassification;
  problems: BuildProblem[];
  failedTests: FailedTest[];
  /** Failed tests dropped by `maxTests`, so the digest can say so rather than silently lie. */
  testsOmitted: number;
  logTail: string[];
  errorWindows: DigestErrorWindow[];
  /** §16.2 "links": provider URLs a human can open. Redacted like everything else. */
  links: string[];
  /** §16.2 "baseline-exception matches": identities in this failure an approved §11 exception already covers. */
  matchedExceptions: string[];
  /** True when the `maxBytes` ceiling forced content out of the digest. */
  truncated: boolean;
  /** Byte length of `renderDigestMarkdown(digest)`, so a caller never has to re-render to find out. */
  bytes: number;
}
```

- [ ] **Step 5: Create `src/providers/ci/classify.ts`**

```ts
import type { BuildClassification } from './types.js';

/**
 * Spec §16.1's outcome classification, as one pure function over a normalized vocabulary.
 *
 * Each provider translates its own status words into {@link RawBuildStatus} and the mapping lives here once, so
 * `fake`, `local` and `teamcity` cannot drift apart on the one question §31.32 depends on: is this red a defect,
 * or is it infrastructure?
 */
export const RAW_BUILD_STATUSES = ['success', 'failure', 'unknown', 'cancelled', 'failed_to_start', 'timeout'] as const;

export type RawBuildStatus = (typeof RAW_BUILD_STATUSES)[number];

export interface ClassifyBuildInput {
  rawStatus: RawBuildStatus;
  /** How many failed test occurrences the provider observed. */
  failedTests: number;
  /** How many build problems the provider observed. */
  problems: number;
}

export function classifyBuild(input: ClassifyBuildInput): BuildClassification {
  const { rawStatus, failedTests, problems } = input;
  // §16.1 lists "cancelled, failed to start, agent lost, VCS or artifact problems, timeout in queue" under
  // `infra` with no qualifier. §31.32 — "infrastructure build failures never consume a debug attempt" — is the
  // property that must not be weakened, so a cancelled build's partial test results do not promote it out of
  // `infra`. This branch comes first for exactly that reason.
  if (rawStatus === 'cancelled' || rawStatus === 'failed_to_start' || rawStatus === 'timeout') return 'infra';
  // D5: the observation beats the label. A build configuration that reports green while its test step published
  // failures is the cheapest input that defeats a classifier keyed on `rawStatus` alone.
  if (failedTests > 0) return 'tests_failed';
  if (problems > 0) return 'build_failed';
  if (rawStatus === 'success') return 'success';
  // §16.1: "`UNKNOWN` status maps to `infra` unless failed tests exist" — which the branch above already handled.
  if (rawStatus === 'unknown') return 'infra';
  // `failure` with neither a failed test nor a reported problem: a script exit code, which §16.1 names under
  // `build_failed`.
  return 'build_failed';
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run --project unit tests/providers/ci/classify.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Verify the whole tree still builds**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. Nothing imports the new files yet, so no existing test changes. Unit count 1022 + 5 = 1027.

- [ ] **Step 8: Commit**

```bash
git add src/providers/ci tests/providers/ci
git commit -m "feat(providers): add the CiProvider interface and the §16.1 classification table" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 2: Lift the redactors into `src/redact/` and add the log-text pass

**Files:**
- Create: `src/redact/url.ts` (moved from `src/doctor/redact.ts`)
- Create: `src/redact/patterns.ts` (moved out of `src/policy/checks/secrets.ts:5-46`)
- Create: `src/redact/text.ts`
- Create: `src/redact/index.ts`
- Delete: `src/doctor/redact.ts`
- Modify: `src/doctor/checks/providers.ts:1`, `src/doctor/checks/repo.ts:4`, `src/doctor/report.ts:2`
- Modify: `src/policy/checks/secrets.ts:1-46`
- Move: `tests/doctor/redact.test.ts` → `tests/redact/url.test.ts`
- Test: `tests/redact/text.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, all re-exported from `src/redact/index.ts`:
  - `redactUrl(url: string): string` — unchanged behaviour, moved
  - `redactCredentials(text: string): string` — unchanged behaviour, moved
  - `interface SecretPattern { label: string; re: RegExp }` and `SECRET_PATTERNS: readonly SecretPattern[]` — unchanged, moved
  - `redactLogText(text: string): string`
  - `redactLogLines(lines: readonly string[]): string[]`
  - `AUTHORIZATION_HEADER_RE: RegExp`

**Why:** D3 and R8's third bullet. The digest is the one thing between a CI log and `evidence/digests/`, and a build log carries credentials in shapes `redactUrl` cannot parse: `Authorization: Bearer <pat>` echoes, `git clone https://ci:<pat>@bitbucket…` lines, bare `ghp_…` in an environment dump. Two suitable pieces already exist in two different packages; a third copy is exactly what R8 forbids, and importing `src/doctor/redact.js` from `src/providers/` would make a CI provider depend on the doctor package. `src/doctor/redact.ts` is deleted rather than left as a re-export shim, so no future file can import the old path and quietly restore the split.

- [ ] **Step 1: Write the failing test for the new log pass**

Create `tests/redact/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactLogLines, redactLogText } from '../../src/redact/index.js';

const ESC = String.fromCharCode(27);

describe('redactLogText', () => {
  it('redacts a token that appears in a log line rather than in a URL', () => {
    // R8. A redactor built only from `redactUrl` misses this entirely: there is no URL to parse.
    const line = 'env: JANUS_BITBUCKET_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const redacted = redactLogText(line);
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(redacted).toContain('<redacted:GitHub token>');
    expect(redacted).toContain('JANUS_BITBUCKET_TOKEN=');
  });

  it('redacts an Authorization header echoed into the log', () => {
    const redacted = redactLogText('> Authorization: Bearer eyJhbGciOi.someTokenValue.signature');
    expect(redacted).not.toContain('eyJhbGciOi.someTokenValue.signature');
    expect(redacted).toContain('Authorization: <redacted>');
  });

  it('redacts a credentialed clone URL embedded mid-line', () => {
    const redacted = redactLogText('Cloning into ui-kit... https://ci-user:sw0rdf1sh@bitbucket.example/scm/fe/ui-kit.git');
    expect(redacted).not.toContain('sw0rdf1sh');
    expect(redacted).toContain('https://<redacted>@bitbucket.example/scm/fe/ui-kit.git');
  });

  it('redacts a credential query parameter left on a build URL in the log', () => {
    const redacted = redactLogText('GET /app/rest/builds?locator=id:42&token=abcdef123456 HTTP/1.1');
    expect(redacted).not.toContain('abcdef123456');
    expect(redacted).toContain('&token=<redacted>');
  });

  it('names every pattern it removed so a reader knows what was there', () => {
    const redacted = redactLogText('key AKIA0123456789ABCDEF and -----BEGIN RSA PRIVATE KEY-----');
    expect(redacted).toContain('<redacted:AWS access key id>');
    expect(redacted).toContain('<redacted:private key block>');
  });

  it('leaves ordinary build output completely alone', () => {
    const clean = "src/app/app.component.ts:14:22 - error TS2551: Property 'titel' does not exist on type 'AppComponent'.";
    expect(redactLogText(clean)).toBe(clean);
  });

  it('leaves an ANSI-coloured karma line alone apart from its credentials', () => {
    const line = `${ESC}[31mAppComponent should render title FAILED${ESC}[39m`;
    expect(redactLogText(line)).toBe(line);
  });

  it('is idempotent, so a twice-redacted line is not double-marked', () => {
    const once = redactLogText('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(redactLogText(once)).toBe(once);
  });

  it('maps line by line and preserves the line count', () => {
    const lines = ['clean', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'also clean'];
    const redacted = redactLogLines(lines);
    expect(redacted).toHaveLength(3);
    expect(redacted[0]).toBe('clean');
    expect(redacted[1]).toBe('<redacted:GitHub token>');
    expect(redacted[2]).toBe('also clean');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run --project unit tests/redact/text.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/redact/index.js"`.

- [ ] **Step 3: Move the two existing modules**

```bash
mkdir -p src/redact tests/redact
git mv src/doctor/redact.ts src/redact/url.ts
git mv tests/doctor/redact.test.ts tests/redact/url.test.ts
```

In `src/redact/url.ts`, replace the opening doc comment's first paragraph — which currently reads "§32 rule 12 redaction for doctor findings." — with:

```ts
/**
 * §32 rule 12 redaction, shared by every package that writes externally-derived text where a human will read it:
 * `janus doctor`'s findings, the §14 policy report, and the §16.2 failure digest.
 *
 * Two functions with deliberately distinct roles, kept separate: `redactUrl` is the **structural guarantee** for
 * a string that is known to be a URL, and `redactCredentials` is the **best-effort** pass for free text that
 * cannot be parsed. Every URL that reaches a report field goes through `redactUrl` first; free text that merely
 * *may* embed one goes through `redactCredentials`. They are not interchangeable and must not be merged: merging
 * them would either weaken the structural guarantee to a denylist or apply a parse to text that is not a URL.
 *
 * They live in their own package, rather than in the one check that first needed them, because more than one
 * caller builds output out of a configured URL: `provider.ci`/`provider.scm` probe `teamcity.url`/`bitbucket.url`,
 * `state.branch_spec` reports the state remote resolved from `state.clone_url` — which is an ordinary place for a
 * `https://user:<pat>@host/...` clone URL to be configured, and whose finding is a `pass`, so it prints on every
 * healthy run — and `redactLogText` in `./text.ts` runs both of them over every line of a CI log before it can
 * reach `evidence/digests/`.
 */
```

Everything below that comment stays byte-for-byte as it is.

In `tests/redact/url.test.ts`, change the import on line 2 to `from '../../src/redact/url.js'`.

Fix the three doctor importers:
- `src/doctor/checks/providers.ts:1` → `import { redactCredentials, redactUrl } from '../../redact/index.js';`
- `src/doctor/checks/repo.ts:4` → `import { redactCredentials, redactUrl } from '../../redact/index.js';`
- `src/doctor/report.ts:2` → `import { redactCredentials } from '../redact/index.js';`

- [ ] **Step 4: Move the secret patterns**

Create `src/redact/patterns.ts` holding `SecretPattern` and `SECRET_PATTERNS` **exactly as they are today** in `src/policy/checks/secrets.ts:5-46` — the interface, all six entries, and every doc comment including the long one about `apiKey`. Prepend this module doc comment:

```ts
/**
 * Shape-based secret patterns, shared by the §14 `secrets.detected` policy check (which *detects* them in an
 * added diff line) and by `redactLogText` (which *removes* them from a §16.2 digest).
 *
 * Deliberately shape-based, not entropy-based: an entropy heuristic on an `ng update` diff — or on a webpack
 * build log — flags minified bundles and lockfile integrity hashes by the hundred, and a check whose output is
 * mostly noise is a check whose output gets skipped.
 *
 * One list, two consumers, because the alternative is two lists that drift: a token shape added for the digest
 * that the policy check does not know about is a token shape that can be committed.
 */
```

Rewrite the top of `src/policy/checks/secrets.ts` so it imports the list instead of declaring it, and re-exports it so `tests/policy/secrets.test.ts` keeps compiling unchanged:

```ts
import { SECRET_PATTERNS } from '../../redact/index.js';
import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

export { SECRET_PATTERNS };
export type { SecretPattern } from '../../redact/index.js';
```

Everything from `export const secretsCheck` down stays byte-for-byte as it is.

- [ ] **Step 5: Write the new log pass**

Create `src/redact/text.ts`:

```ts
import { SECRET_PATTERNS } from './patterns.js';
import { redactCredentials } from './url.js';

/**
 * §32 rule 12 for free-form CI log text, on the path to `evidence/digests/` (§16.2: "A redaction pass removes
 * tokens, credentials, and query strings before anything is written under `evidence/`").
 *
 * Three passes, in this order, because each one catches what the others structurally cannot:
 *
 * 1. `Authorization:`-style headers. A build that curls its own REST API echoes the header, and the value after
 *    `Bearer` is an opaque run of characters with no shape of its own — no pattern can recognise it, but the
 *    header name is unambiguous, so the whole value goes.
 * 2. `redactCredentials`, for `scheme://user:pass@host` userinfo and credential-named query parameters. This is
 *    the same best-effort pass doctor's findings already use, so a credential in a log line and the same
 *    credential in a doctor finding are removed by the same code.
 * 3. {@link SECRET_PATTERNS}, for bare tokens with a recognisable shape — `ghp_…`, `AKIA…`, a JWT, a PEM header
 *    — which appear in logs constantly (environment dumps, `--verbose` output) and in no URL at all. Each match
 *    is replaced with `<redacted:<label>>`, naming what was there, because a reader of a digest needs to know
 *    that a credential was printed by the build even though they must not see it.
 *
 * Idempotent: the replacement text matches none of the three passes, so redacting twice is redacting once.
 */
export const AUTHORIZATION_HEADER_RE = /\b(authorization|proxy-authorization|x-api-key|private-token)\s*:\s*\S+/giu;

export function redactLogText(text: string): string {
  let out = text.replace(AUTHORIZATION_HEADER_RE, (_match: string, header: string) => `${header}: <redacted>`);
  out = redactCredentials(out);
  for (const pattern of SECRET_PATTERNS) {
    // `SECRET_PATTERNS` entries carry no `g` flag, because the policy check only needs `test()`. Redaction needs
    // every occurrence on the line, so a global clone is built here rather than adding `g` to the shared list: a
    // `g` regex carries `lastIndex` state between calls, and a shared stateful regex used by two packages is a
    // bug waiting for its second consumer.
    const global = new RegExp(pattern.re.source, `${pattern.re.flags}g`);
    out = out.replace(global, `<redacted:${pattern.label}>`);
  }
  return out;
}

/** {@link redactLogText} per line, preserving the line count so log line numbers stay meaningful. */
export function redactLogLines(lines: readonly string[]): string[] {
  return lines.map((line) => redactLogText(line));
}
```

Create `src/redact/index.ts`:

```ts
/**
 * The one place §32 rule 12 redaction lives. `src/doctor/`, `src/policy/` and `src/providers/` all import from
 * here; none of them owns a redactor of its own, and none imports another's.
 */
export { redactCredentials, redactUrl } from './url.js';
export { SECRET_PATTERNS } from './patterns.js';
export type { SecretPattern } from './patterns.js';
export { AUTHORIZATION_HEADER_RE, redactLogLines, redactLogText } from './text.js';
```

- [ ] **Step 6: Run the new test to verify it passes**

Run: `pnpm vitest run --project unit tests/redact/text.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Run everything the move touched**

Run: `pnpm vitest run --project unit tests/redact tests/doctor tests/policy`
Expected: PASS. `tests/redact/url.test.ts` (content unchanged apart from its import path) and `tests/policy/secrets.test.ts` (entirely unchanged) must both still pass — that is the proof the move changed no behaviour.

- [ ] **Step 8: Confirm the old path is gone**

Run: `grep -rn "doctor/redact" src tests`
Expected: no output, exit 1.

- [ ] **Step 9: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1027 + 9 = 1036.

- [ ] **Step 10: Commit**

```bash
git add -A src/redact src/doctor src/policy tests/redact tests/doctor
git commit -m "refactor(redact): lift url and secret-pattern redaction into one package and add the log pass" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 3: The §16.2 failure digest

**Files:**
- Modify: `src/providers/ci/digest.ts` (Task 1 created it with three type declarations; this task fills it in)
- Modify: `src/config/config-schema.ts` (the `digest` block gains `max_test_detail_lines`)
- Modify: `angular-ai-development-workflow-v2.md` §16.2 and §28 (the spec edit that field requires)
- Modify: `tests/config/config-schema.test.ts`
- Test: `tests/providers/ci/digest.test.ts`

**Interfaces:**
- Consumes: `BuildRef`, `BuildClassification`, `BuildProblem`, `FailedTest` from `src/providers/ci/types.js` (Task 1); `redactLogLines`, `redactLogText` from `src/redact/index.js` (Task 2); `JanusConfig` from `src/config/config-schema.js`.
- Produces:
  - `digestLimitsFrom(config: JanusConfig): DigestLimits` — reads all **six** fields of the `digest` block
  - `interface BuildDigestInput { ref: BuildRef; classification: BuildClassification; problems: readonly BuildProblem[]; failedTests: readonly FailedTest[]; log: string; links: readonly string[]; exceptions: readonly string[] }`
  - `buildFailureDigest(input: BuildDigestInput, limits: DigestLimits): FailureDigest`
  - `renderDigestMarkdown(digest: FailureDigest): string`
  - `isErrorLine(line: string): boolean`
  - `const ERROR_WINDOW_BEFORE = 2`, `const ERROR_WINDOW_AFTER = 5`
  - `config.digest.max_test_detail_lines` (positive int, default 20)
  - `DigestLimits`, `DigestErrorWindow`, `FailureDigest` — declared in Task 1, unchanged here

**Why:** §16.2 in full. This is the bounded, redacted artefact every debug agent (§16.4) and every E2E triage agent (§17) reads, and §32 rule 12's last line of defence. It is also the input to the §16.3 signature (Task 4), which is why the error lines are picked here rather than re-derived there.

**On the per-test detail cap.** §16.2 says "failed tests with `newFailure` flag and the first N lines of details (`digest.max_tests`)", but `digest.max_tests` is plainly the *test-count* cap: it is named for tests and its default of 50 is a count. Reading one number as both a test count and a per-test line budget is incoherent — at the defaults it would mean 50 tests of 50 lines each — and every other §16.2 cap (`log_tail_lines`, `max_error_windows`, `max_bytes`) is configurable. So this task **adds `digest.max_test_detail_lines`** and **edits the spec to match**, rather than hiding the discrepancy in a source constant. The spec edit is its own commit, following the precedent T03 set when it edited §6/§26/§27.

- [ ] **Step 1: Write the failing tests for the content rules**

Create `tests/providers/ci/digest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../../src/config/config-schema.js';
import {
  buildFailureDigest,
  digestLimitsFrom,
  ERROR_WINDOW_AFTER,
  ERROR_WINDOW_BEFORE,
  isErrorLine,
  renderDigestMarkdown,
} from '../../../src/providers/ci/digest.js';
import type { BuildDigestInput, DigestLimits } from '../../../src/providers/ci/digest.js';
import type { BuildRef, FailedTest } from '../../../src/providers/ci/types.js';

const REF: BuildRef = {
  id: 'build-42',
  repo: 'ui-kit',
  buildTypeId: 'Fe_UiKit_Build',
  revision: 'a'.repeat(40),
  branch: 'ai/angular-15-to-16',
  url: 'https://teamcity.example.internal/viewLog.html',
};

const LIMITS: DigestLimits = { maxTests: 3, maxTestDetailLines: 20, logTailLines: 5, maxErrorWindows: 2, maxBytes: 65_536, redact: true };

function failed(identity: string, details = ''): FailedTest {
  return { identity, name: identity, suite: null, newFailure: null, details };
}

function input(overrides: Partial<BuildDigestInput> = {}): BuildDigestInput {
  return {
    ref: REF,
    classification: 'tests_failed',
    problems: [],
    failedTests: [],
    log: '',
    links: [],
    exceptions: [],
    ...overrides,
  };
}

describe('digestLimitsFrom', () => {
  it('reads the §28 digest block', () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    expect(digestLimitsFrom(config)).toEqual({
      maxTests: 50,
      maxTestDetailLines: 20,
      logTailLines: 400,
      maxErrorWindows: 10,
      maxBytes: 65_536,
      redact: true,
    });
  });
});

describe('isErrorLine', () => {
  it('recognises the shapes an Angular build actually produces', () => {
    expect(isErrorLine("src/app/a.ts:4:9 - error TS2551: Property 'titel' does not exist.")).toBe(true);
    expect(isErrorLine('ERROR in ./src/main.ts')).toBe(true);
    expect(isErrorLine('npm ERR! code ELIFECYCLE')).toBe(true);
    expect(isErrorLine('Chrome Headless 153.0.0.0 (Linux 0.0.0) AppComponent should render title FAILED')).toBe(true);
    expect(isErrorLine('  ● AppComponent > should render title')).toBe(true);
    expect(isErrorLine('TypeError: Cannot read properties of undefined')).toBe(true);
    expect(isErrorLine('> ui-kit@1.0.0 build')).toBe(false);
    expect(isErrorLine('Compiling @acme/ui-kit : es2015 as esm2015')).toBe(false);
  });
});

describe('buildFailureDigest', () => {
  it('caps the failed-test list and says how many it dropped', () => {
    const digest = buildFailureDigest(
      input({ failedTests: [failed('e'), failed('d'), failed('c'), failed('b'), failed('a')] }),
      LIMITS,
    );
    expect(digest.failedTests.map((test) => test.identity)).toEqual(['a', 'b', 'c']);
    expect(digest.testsOmitted).toBe(2);
  });

  it('sorts tests and problems by identity so two observations of one failure are byte-identical', () => {
    const first = buildFailureDigest(input({ failedTests: [failed('b'), failed('a')] }), LIMITS);
    const second = buildFailureDigest(input({ failedTests: [failed('a'), failed('b')] }), LIMITS);
    expect(renderDigestMarkdown(first)).toBe(renderDigestMarkdown(second));
  });

  it('keeps the last log_tail_lines lines of the log', () => {
    const digest = buildFailureDigest(input({ log: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n') }), LIMITS);
    expect(digest.logTail).toEqual(['l3', 'l4', 'l5', 'l6', 'l7']);
  });

  it('cuts a window around each error line, earliest first, capped at max_error_windows', () => {
    const lines: string[] = [];
    for (let index = 1; index <= 40; index += 1) {
      lines.push(index % 10 === 0 ? `error TS${String(2000 + index)}: broken at ${String(index)}` : `noise ${String(index)}`);
    }
    const digest = buildFailureDigest(input({ log: lines.join('\n') }), LIMITS);
    expect(digest.errorWindows).toHaveLength(2);
    expect(digest.errorWindows[0]?.line).toBe(10);
    expect(digest.errorWindows[1]?.line).toBe(20);
    expect(digest.errorWindows[0]?.errorLine).toBe('error TS2010: broken at 10');
    expect(digest.errorWindows[0]?.lines).toHaveLength(ERROR_WINDOW_BEFORE + 1 + ERROR_WINDOW_AFTER);
    expect(digest.errorWindows[0]?.lines[ERROR_WINDOW_BEFORE]).toBe('error TS2010: broken at 10');
  });

  it('merges two error lines that fall inside one window instead of emitting overlapping copies', () => {
    const log = ['a', 'b', 'error TS1000: first', 'error TS1001: second', 'c', 'd'].join('\n');
    const digest = buildFailureDigest(input({ log }), LIMITS);
    expect(digest.errorWindows).toHaveLength(1);
    expect(digest.errorWindows[0]?.errorLine).toBe('error TS1000: first');
    expect(digest.errorWindows[0]?.lines).toContain('error TS1001: second');
  });

  it('records which failures an approved baseline exception already covers', () => {
    const digest = buildFailureDigest(
      input({ failedTests: [failed('flaky-a'), failed('real-b')], exceptions: ['flaky-a', 'unrelated'] }),
      LIMITS,
    );
    expect(digest.matchedExceptions).toEqual(['flaky-a']);
    // The exception is *recorded*, not removed: §16.2 lists "baseline-exception matches" as digest content, and
    // §16.3 is where they are excluded — from the signature.
    expect(digest.failedTests.map((test) => test.identity)).toEqual(['flaky-a', 'real-b']);
  });

  it('truncates a long test detail rather than carrying a whole stack', () => {
    const details = Array.from({ length: 40 }, (_value, index) => `frame ${String(index)}`).join('\n');
    const digest = buildFailureDigest(input({ failedTests: [failed('a', details)] }), LIMITS);
    expect(digest.failedTests[0]?.details).toContain('frame 19');
    expect(digest.failedTests[0]?.details).not.toContain('frame 20');
    expect(digest.failedTests[0]?.details).toContain('20 more line(s)');
  });

  it('honours a configured max_test_detail_lines rather than a hard-coded twenty', () => {
    const details = Array.from({ length: 40 }, (_value, index) => `frame ${String(index)}`).join('\n');
    const digest = buildFailureDigest(input({ failedTests: [failed('a', details)] }), { ...LIMITS, maxTestDetailLines: 3 });
    expect(digest.failedTests[0]?.details).toContain('frame 2');
    expect(digest.failedTests[0]?.details).not.toContain('frame 3');
    expect(digest.failedTests[0]?.details).toContain('37 more line(s)');
  });

  it('applies the same cap to a problem\u2019s details', () => {
    const details = Array.from({ length: 10 }, (_value, index) => `note ${String(index)}`).join('\n');
    const digest = buildFailureDigest(input({ problems: [{ identity: 'p', type: 't', details }] }), { ...LIMITS, maxTestDetailLines: 2 });
    expect(digest.problems[0]?.details).toContain('note 1');
    expect(digest.problems[0]?.details).not.toContain('note 2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/ci/digest.test.ts`
Expected: FAIL — `digestLimitsFrom is not a function` (the module exists from Task 1 but exports only types).

- [ ] **Step 3: Add `digest.max_test_detail_lines` to the config schema and to the spec**

In `src/config/config-schema.ts`, add one field to the `digest` block, between `max_tests` and `log_tail_lines`:

```ts
    digest: z
      .object({
        max_tests: positiveInt.default(50),
        max_test_detail_lines: positiveInt.default(20),
        log_tail_lines: positiveInt.default(400),
        max_error_windows: positiveInt.default(10),
        max_bytes: positiveInt.default(65_536),
        redact: z.boolean().default(true),
      })
      .strict()
      .default({}),
```

Add to `tests/config/config-schema.test.ts`:

```ts
  it('gives the digest its own per-test detail line cap', () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    expect(config.digest.max_test_detail_lines).toBe(20);
    const raised = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      digest: { max_test_detail_lines: 5 },
    });
    expect(raised.digest.max_test_detail_lines).toBe(5);
  });
```

Now edit `angular-ai-development-workflow-v2.md`, so the code and the spec do not disagree. Two edits:

1. In §28's `digest` block, add the field:

```yaml
digest:
  max_tests: 50
  max_test_detail_lines: 20
  log_tail_lines: 400
  max_error_windows: 10
  max_bytes: 65536
  redact: true
```

2. In §16.2, replace

> failed tests with `newFailure` flag and the first N lines of details (`digest.max_tests`)

with

> failed tests with `newFailure` flag and the first `digest.max_test_detail_lines` lines of details, capped at `digest.max_tests` tests

Run: `pnpm vitest run --project unit tests/config/config-schema.test.ts`
Expected: PASS, including the new case.

- [ ] **Step 4: Commit the spec edit on its own**

The spec change is a decision about the contract, not an implementation detail, so it lands as its own commit — the precedent T03 set when it edited §6, §26 and §27.

```bash
git add angular-ai-development-workflow-v2.md
git commit -m "docs(spec): give the digest its own per-test detail line cap" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

- [ ] **Step 5: Implement the content rules**

Append to `src/providers/ci/digest.ts`, below the three type declarations, and add the two new imports at the top of the file:

```ts
import type { JanusConfig } from '../../config/config-schema.js';
import { redactLogLines, redactLogText } from '../../redact/index.js';
```

```ts
/** Context lines before an error line in its window. */
export const ERROR_WINDOW_BEFORE = 2;

/** Context lines after an error line in its window. */
export const ERROR_WINDOW_AFTER = 5;

/**
 * What makes a log line worth a window.
 *
 * A deliberately generous list: the cost of a false positive is one extra window inside a budget that
 * `max_error_windows` already bounds, while the cost of a false negative is a debug agent that never sees the
 * compile error. Every shape here was taken from real reporter output rather than from memory — the
 * Angular/webpack `ERROR in`, the TypeScript `error TSxxxx`, the Karma `... FAILED` line, the Jest bullet
 * header, npm's `ERR!`.
 */
const ERROR_LINE_PATTERNS: readonly RegExp[] = [
  /\berror TS\d{3,5}\b/u,
  /^\s*ERROR\b/u,
  /\bERROR\s+in\b/u,
  /^\s*npm ERR!/u,
  /\bFAILED\b/u,
  /^\s*●\s/u,
  /\b(?:Type|Syntax|Reference|Range|Assertion)Error\b/u,
  /^\s*Error:/u,
  /\berror\s*:/iu,
];

export function isErrorLine(line: string): boolean {
  return ERROR_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function digestLimitsFrom(config: JanusConfig): DigestLimits {
  return {
    maxTests: config.digest.max_tests,
    maxTestDetailLines: config.digest.max_test_detail_lines,
    logTailLines: config.digest.log_tail_lines,
    maxErrorWindows: config.digest.max_error_windows,
    maxBytes: config.digest.max_bytes,
    redact: config.digest.redact,
  };
}

/** Everything one provider observed about a red build, before §16.2's caps and redaction are applied. */
export interface BuildDigestInput {
  ref: BuildRef;
  classification: BuildClassification;
  problems: readonly BuildProblem[];
  failedTests: readonly FailedTest[];
  /** The raw build log, newline-separated. May be empty when the provider has none. */
  log: string;
  links: readonly string[];
  /** Approved §11 baseline exception identities, for the "baseline-exception matches" section. */
  exceptions: readonly string[];
}

function firstLines(text: string, count: number): string {
  const lines = text.split('\n');
  if (lines.length <= count) return text;
  return `${lines.slice(0, count).join('\n')}\n... (${String(lines.length - count)} more line(s))`;
}

/**
 * Cuts one window per error line, **earliest first**.
 *
 * Earliest, not latest, because in a TypeScript or webpack build the first error is the root cause and the ones
 * after it are its cascade — and because the *end* of the log is never lost regardless: `logTail` carries the
 * last `logTailLines` lines in full, separately from the windows.
 *
 * Windows that would overlap are merged into the first one, so a burst of adjacent errors costs one window
 * rather than five near-identical copies of the same eight lines.
 */
function cutErrorWindows(lines: readonly string[], max: number): DigestErrorWindow[] {
  const windows: DigestErrorWindow[] = [];
  let coveredThrough = 0; // 1-based index of the last line already inside a window
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    if (text === undefined || !isErrorLine(text)) continue;
    const lineNumber = index + 1;
    if (lineNumber <= coveredThrough) continue;
    if (windows.length >= max) break;
    const from = Math.max(0, index - ERROR_WINDOW_BEFORE);
    const to = Math.min(lines.length, index + ERROR_WINDOW_AFTER + 1);
    windows.push({ line: lineNumber, errorLine: text, lines: lines.slice(from, to) });
    coveredThrough = to;
  }
  return windows;
}

/**
 * Spec §16.2. Builds the bounded digest: build problems; failed tests with their `newFailure` flag and the first
 * `limits.maxTestDetailLines` lines of details, capped at `maxTests`; the log tail plus windows around error
 * lines; links; baseline-exception matches. The §32 rule 12 redaction pass runs over **every** externally-derived
 * string before any of it is measured or returned, and `maxBytes` is enforced last, against the rendered form.
 *
 * Problems and tests are sorted by identity so that two observations of one failure render byte-identically —
 * which is what lets T12 tell "the same failure again" from "a different failure", and what makes the §16.3
 * signature stable without re-sorting.
 */
export function buildFailureDigest(input: BuildDigestInput, limits: DigestLimits): FailureDigest {
  const scrubText = (text: string): string => (limits.redact ? redactLogText(text) : text);
  const scrubLines = (lines: readonly string[]): string[] => (limits.redact ? redactLogLines(lines) : [...lines]);

  const problems = [...input.problems]
    .map((problem) => ({ ...problem, details: scrubText(firstLines(problem.details, limits.maxTestDetailLines)) }))
    .sort((left, right) => left.identity.localeCompare(right.identity));

  const allTests = [...input.failedTests].sort((left, right) => left.identity.localeCompare(right.identity));
  const failedTests = allTests
    .slice(0, limits.maxTests)
    .map((test) => ({ ...test, details: scrubText(firstLines(test.details, limits.maxTestDetailLines)) }));
  const testsOmitted = allTests.length - failedTests.length;

  const logLines = input.log === '' ? [] : scrubLines(input.log.split('\n'));
  const logTail = logLines.slice(Math.max(0, logLines.length - limits.logTailLines));
  const errorWindows = cutErrorWindows(logLines, limits.maxErrorWindows);

  const approved = new Set(input.exceptions);
  const matchedExceptions = [...allTests.map((test) => test.identity), ...problems.map((problem) => problem.identity)]
    .filter((identity) => approved.has(identity))
    .sort();

  const digest: FailureDigest = {
    ref: input.ref,
    classification: input.classification,
    problems,
    failedTests,
    testsOmitted,
    logTail,
    errorWindows,
    links: scrubLines(input.links),
    matchedExceptions,
    truncated: false,
    bytes: 0,
  };
  return enforceByteCap(digest, limits.maxBytes);
}
```

- [ ] **Step 6: Run the content tests**

Run: `pnpm vitest run --project unit tests/providers/ci/digest.test.ts`
Expected: FAIL — `enforceByteCap is not defined` and `renderDigestMarkdown is not a function`. The content rules are in place; Steps 5–7 add the renderer and the cap.

- [ ] **Step 7: Write the failing tests for the renderer and the byte cap**

Append to `tests/providers/ci/digest.test.ts`:

```ts
describe('renderDigestMarkdown', () => {
  it('renders every §16.2 section in a fixed order', () => {
    const digest = buildFailureDigest(
      input({
        problems: [{ identity: 'compile:src/app/a.ts', type: 'TC_COMPILATION_ERROR', details: 'error TS2551' }],
        failedTests: [
          { identity: 'AppComponent > renders', name: 'renders', suite: 'AppComponent', newFailure: true, details: 'expected a to be b' },
        ],
        log: ['warming up', 'error TS2551: nope', 'after'].join('\n'),
        links: ['https://teamcity.example.internal/viewLog.html'],
      }),
      LIMITS,
    );
    const markdown = renderDigestMarkdown(digest);
    expect(markdown.startsWith('# Build failure digest - ui-kit build-42 (tests_failed)\n')).toBe(true);
    const order = ['## Problems', '## Failed tests', '## Error windows', '## Log tail', '## Links'].map((heading) =>
      markdown.indexOf(heading),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order]).toEqual([...order].sort((left, right) => left - right));
    expect(markdown).toContain('- `compile:src/app/a.ts` (TC_COMPILATION_ERROR)');
    expect(markdown).toContain('- `AppComponent > renders` (new failure)');
    expect(digest.bytes).toBe(Buffer.byteLength(markdown, 'utf8'));
  });

  it('names the baseline exceptions it matched', () => {
    const digest = buildFailureDigest(input({ failedTests: [failed('flaky-a')], exceptions: ['flaky-a'] }), LIMITS);
    expect(renderDigestMarkdown(digest)).toContain('## Baseline exceptions matched');
  });

  it('says so when tests were dropped', () => {
    const digest = buildFailureDigest(input({ failedTests: [failed('a'), failed('b'), failed('c'), failed('d')] }), LIMITS);
    expect(renderDigestMarkdown(digest)).toContain('1 further failed test omitted');
  });
});

describe('the max_bytes ceiling', () => {
  const huge = (lines: number): string =>
    Array.from({ length: lines }, (_value, index) => `line ${String(index + 1)} of build output`).join('\n');

  it('keeps the end of the log, not the beginning', () => {
    // R8. The naive implementation -- render, then `slice(0, maxBytes)` -- drops the tail, which is exactly
    // where a build prints why it failed.
    const digest = buildFailureDigest(input({ log: huge(400) }), { ...LIMITS, logTailLines: 400, maxBytes: 900 });
    const markdown = renderDigestMarkdown(digest);
    expect(digest.truncated).toBe(true);
    expect(digest.bytes).toBeLessThanOrEqual(900);
    expect(markdown).toContain('line 400 of build output');
    expect(markdown).not.toContain('line 1 of build output\n');
  });

  it('keeps the earliest error windows, because a cascade is rooted in the first error', () => {
    const lines = Array.from({ length: 60 }, (_value, index) =>
      index % 6 === 0 ? `error TS${String(3000 + index)}: broken` : `padding padding padding ${String(index)}`,
    );
    const digest = buildFailureDigest(input({ log: lines.join('\n') }), {
      ...LIMITS,
      maxErrorWindows: 10,
      logTailLines: 2,
      maxBytes: 800,
    });
    expect(digest.truncated).toBe(true);
    expect(digest.errorWindows.length).toBeLessThan(10);
    expect(digest.errorWindows[0]?.errorLine).toBe('error TS3000: broken');
  });

  it('never returns more bytes than the ceiling, even when the ceiling is absurdly small', () => {
    const digest = buildFailureDigest(input({ log: huge(200), failedTests: [failed('a'), failed('b')] }), {
      ...LIMITS,
      maxBytes: 1,
    });
    expect(digest.truncated).toBe(true);
    expect(digest.logTail).toEqual([]);
    expect(digest.errorWindows).toEqual([]);
    expect(digest.failedTests).toEqual([]);
    expect(digest.testsOmitted).toBe(2);
    // The header is irreducible: a digest that cannot name its build is worse than one over its ceiling.
    expect(renderDigestMarkdown(digest)).toContain('ui-kit build-42');
  });
});

describe('redaction', () => {
  it('removes a token that appeared only in a log line, never in a URL', () => {
    // R8 again, at the seam that matters: this is the last code between a build log and evidence/digests/.
    const digest = buildFailureDigest(
      input({ log: ['starting', 'env JANUS_TEAMCITY_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'error TS1: x'].join('\n') }),
      LIMITS,
    );
    const markdown = renderDigestMarkdown(digest);
    expect(markdown).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(markdown).toContain('<redacted:GitHub token>');
  });

  it('redacts problem details, test details and links, not only the log', () => {
    const secret = 'https://ci:sw0rdf1sh@teamcity.example.internal/viewLog.html';
    const digest = buildFailureDigest(
      input({
        problems: [{ identity: 'p', type: 't', details: `fetch failed: ${secret}` }],
        failedTests: [{ identity: 'x', name: 'x', suite: null, newFailure: null, details: `posted to ${secret}` }],
        links: [secret],
      }),
      LIMITS,
    );
    const markdown = renderDigestMarkdown(digest);
    expect(markdown).not.toContain('sw0rdf1sh');
    expect(markdown.match(/<redacted>/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it('leaves everything alone when digest.redact is false', () => {
    const digest = buildFailureDigest(input({ log: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }), {
      ...LIMITS,
      redact: false,
    });
    expect(digest.logTail[0]).toBe('token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
```

- [ ] **Step 8: Run them to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/ci/digest.test.ts`
Expected: FAIL — `renderDigestMarkdown is not a function`.

- [ ] **Step 9: Implement the renderer and the cap**

Append to `src/providers/ci/digest.ts`:

```ts
/**
 * The §16.2 digest as markdown, in a fixed section order, for `evidence/digests/<repo>/<build-id>.md` (written
 * by T12, never here) and for the §18.2 context package's LATEST VERIFICATION EVIDENCE section.
 *
 * The order is fixed and the content is sorted so that two observations of one failure render byte-identically:
 * a debug agent that receives the same digest twice must be able to tell that nothing changed, and T12 compares
 * rendered digests to decide whether to re-file evidence.
 */
export function renderDigestMarkdown(digest: FailureDigest): string {
  const out: string[] = [];
  out.push(`# Build failure digest - ${digest.ref.repo} ${digest.ref.id} (${digest.classification})`);
  out.push('');
  out.push(`- build type: \`${digest.ref.buildTypeId}\``);
  out.push(`- revision: ${digest.ref.revision ?? '(not reported)'}`);
  out.push(`- branch: ${digest.ref.branch ?? '(not reported)'}`);
  if (digest.truncated) out.push('- **truncated** to fit the digest.max_bytes ceiling');
  out.push('');
  if (digest.problems.length > 0) {
    out.push('## Problems');
    out.push('');
    for (const problem of digest.problems) {
      out.push(`- \`${problem.identity}\` (${problem.type})`);
      if (problem.details !== '') {
        out.push('');
        out.push('```text');
        out.push(problem.details);
        out.push('```');
      }
    }
    out.push('');
  }
  if (digest.failedTests.length > 0 || digest.testsOmitted > 0) {
    out.push('## Failed tests');
    out.push('');
    for (const test of digest.failedTests) {
      const flag = test.newFailure === true ? ' (new failure)' : test.newFailure === false ? ' (repeat failure)' : '';
      out.push(`- \`${test.identity}\`${flag}`);
      if (test.details !== '') {
        out.push('');
        out.push('```text');
        out.push(test.details);
        out.push('```');
      }
    }
    if (digest.testsOmitted > 0) {
      out.push('');
      out.push(`${String(digest.testsOmitted)} further failed test omitted by digest.max_tests or digest.max_bytes.`);
    }
    out.push('');
  }
  if (digest.errorWindows.length > 0) {
    out.push('## Error windows');
    out.push('');
    for (const window of digest.errorWindows) {
      out.push(`### line ${String(window.line)}`);
      out.push('');
      out.push('```text');
      out.push(...window.lines);
      out.push('```');
      out.push('');
    }
  }
  if (digest.logTail.length > 0) {
    out.push('## Log tail');
    out.push('');
    out.push('```text');
    out.push(...digest.logTail);
    out.push('```');
    out.push('');
  }
  if (digest.links.length > 0) {
    out.push('## Links');
    out.push('');
    for (const link of digest.links) out.push(`- ${link}`);
    out.push('');
  }
  if (digest.matchedExceptions.length > 0) {
    out.push('## Baseline exceptions matched');
    out.push('');
    for (const identity of digest.matchedExceptions) out.push(`- \`${identity}\``);
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/u, '')}\n`;
}

function measure(digest: FailureDigest): number {
  return Buffer.byteLength(renderDigestMarkdown(digest), 'utf8');
}

/**
 * §16.2: "Digests are capped at `digest.max_bytes`."
 *
 * Shrunk by removing whole items in a fixed order, never by slicing the rendered string — a digest cut mid-line
 * ends its last error half way through a sentence, and a digest cut from the *end* loses the log tail, which is
 * precisely where a build prints why it failed. The order, and why each is in this position:
 *
 * 1. **error windows, from the last**, because the earliest error is the root cause and the rest are its cascade;
 * 2. **failed tests, from the last**, because they are sorted by identity, so dropping from one end is the only
 *    deterministic choice — and `testsOmitted` keeps counting, so the digest still says how many it did not show;
 * 3. **log-tail lines, from the front**, because the tail's whole value is its end.
 *
 * The header block is irreducible: a digest that cannot even name its build is worse than one over its ceiling,
 * so a `maxBytes` smaller than the header returns the header with `truncated: true`.
 */
function enforceByteCap(digest: FailureDigest, maxBytes: number): FailureDigest {
  let current: FailureDigest = { ...digest, bytes: measure(digest) };
  if (current.bytes <= maxBytes) return current;
  while (current.bytes > maxBytes && current.errorWindows.length > 0) {
    current = { ...current, errorWindows: current.errorWindows.slice(0, -1), truncated: true };
    current = { ...current, bytes: measure(current) };
  }
  while (current.bytes > maxBytes && current.failedTests.length > 0) {
    current = {
      ...current,
      failedTests: current.failedTests.slice(0, -1),
      testsOmitted: current.testsOmitted + 1,
      truncated: true,
    };
    current = { ...current, bytes: measure(current) };
  }
  while (current.bytes > maxBytes && current.logTail.length > 0) {
    current = { ...current, logTail: current.logTail.slice(1), truncated: true };
    current = { ...current, bytes: measure(current) };
  }
  const truncated: FailureDigest = { ...current, truncated: true };
  return { ...truncated, bytes: measure(truncated) };
}
```

- [ ] **Step 10: Run the whole digest suite**

Run: `pnpm vitest run --project unit tests/providers/ci/digest.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 11: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1036 + 19 (digest) + 1 (config schema) = 1056.

- [ ] **Step 12: Commit**

The spec edit already went in on its own in Step 4, so this commit is code and tests only:

```bash
git add src/providers/ci/digest.ts src/config/config-schema.ts tests/providers/ci/digest.test.ts tests/config/config-schema.test.ts
git commit -m "feat(providers): build the bounded redacted §16.2 failure digest" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 4: The §16.3 failure signature

**Files:**
- Create: `src/providers/ci/signature.ts`
- Test: `tests/providers/ci/signature.test.ts`

**Interfaces:**
- Consumes: `FailureDigest` from `src/providers/ci/digest.js` (Tasks 1 and 3).
- Produces:
  - `normalizeErrorLine(line: string, root?: string | null): string`
  - `interface SignatureInput { failedTests: readonly string[]; problems: readonly string[]; errorLines: readonly string[]; exceptions: readonly string[]; root: string | null }`
  - `failureSignature(input: SignatureInput): string` — 64-character lowercase sha256 hex
  - `digestErrorLines(digest: FailureDigest): string[]`
  - `signatureFromDigest(digest: FailureDigest, exceptions: readonly string[], root: string | null): string`

**Why:** §16.3 verbatim, and the single most defeatable component in this plan (R8). `state.execution.work_packages.<id>.repos.<repo>.last_failure_signature` drives `max_no_progress_iterations`: if the signature changes when only a line number moved, every debug attempt looks like progress and the no-progress guardrail never fires; if two genuinely different compile errors collide, a debug agent that fixed one and uncovered another looks stuck and the goal escalates for nothing. T09's done-when names the second case explicitly.

- [ ] **Step 1: Write the failing normalizer tests**

Create `tests/providers/ci/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFailureDigest } from '../../../src/providers/ci/digest.js';
import type { DigestLimits } from '../../../src/providers/ci/digest.js';
import { digestErrorLines, failureSignature, normalizeErrorLine, signatureFromDigest } from '../../../src/providers/ci/signature.js';
import type { SignatureInput } from '../../../src/providers/ci/signature.js';
import type { BuildRef } from '../../../src/providers/ci/types.js';

const ESC = String.fromCharCode(27);
const REF: BuildRef = { id: 'b1', repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', revision: null, branch: null, url: null };
const LIMITS: DigestLimits = { maxTests: 50, maxTestDetailLines: 20, logTailLines: 400, maxErrorWindows: 10, maxBytes: 65_536, redact: true };

function signature(overrides: Partial<SignatureInput> = {}): string {
  return failureSignature({ failedTests: [], problems: [], errorLines: [], exceptions: [], root: null, ...overrides });
}

describe('normalizeErrorLine', () => {
  it('strips a line and column so the same error at a different line normalizes the same', () => {
    expect(normalizeErrorLine("src/app/a.ts:14:22 - error TS2551: Property 'titel' does not exist.")).toBe(
      normalizeErrorLine("src/app/a.ts:87:4 - error TS2551: Property 'titel' does not exist."),
    );
  });

  it('strips the parenthesised line,column form too', () => {
    expect(normalizeErrorLine("src/app/a.ts(14,22): error TS2551: Property 'titel' does not exist.")).toBe(
      normalizeErrorLine("src/app/a.ts(3,1): error TS2551: Property 'titel' does not exist."),
    );
  });

  it('strips timestamps in every shape a reporter actually emits', () => {
    const base = 'ERROR in ./src/main.ts';
    expect(normalizeErrorLine(`2026-09-21T14:30:14.382Z ${base}`)).toBe(normalizeErrorLine(`2026-02-01T00:00:00.000Z ${base}`));
    expect(normalizeErrorLine(`[16:30:42] ${base}`)).toBe(normalizeErrorLine(`[09:01:02] ${base}`));
    expect(normalizeErrorLine(`21 09 2026 16:30:42.025:INFO ${base}`)).toBe(normalizeErrorLine(`01 01 2026 00:00:00.000:INFO ${base}`));
  });

  it('strips durations, which change on every single run', () => {
    expect(normalizeErrorLine('Executed 2 of 2 (1 FAILED) (0.004 secs / 0.002 secs)')).toBe(
      normalizeErrorLine('Executed 2 of 2 (1 FAILED) (1.271 secs / 0.9 secs)'),
    );
    expect(normalizeErrorLine('should render title (2 ms) FAILED')).toBe(normalizeErrorLine('should render title (417 ms) FAILED'));
  });

  it('strips build ids and shas, which change on every single run', () => {
    expect(normalizeErrorLine('build 4f3a2b1c9d8e7f6 failed')).toBe(normalizeErrorLine('build 0123456789abcde failed'));
  });

  it('strips ANSI colour codes, which Karma emits and a file-captured log does not', () => {
    expect(normalizeErrorLine(`${ESC}[31mAppComponent should render title FAILED${ESC}[39m`)).toBe(
      normalizeErrorLine('AppComponent should render title FAILED'),
    );
  });

  it('rewrites an absolute workspace path so a rebuilt workspace hashes the same', () => {
    // §7 rule 5: a workspace can be rebuilt on another machine from the state branch alone. jest-junit embeds
    // absolute paths in every stack frame, so without this the same failure hashes differently per machine.
    expect(normalizeErrorLine('at Object.toBe (/home/a/ws/repos/ui-kit/src/a.spec.ts:3:49)', '/home/a/ws')).toBe(
      normalizeErrorLine('at Object.toBe (/srv/ci/work/repos/ui-kit/src/a.spec.ts:9:1)', '/srv/ci/work'),
    );
  });

  it('keeps hex-looking English words, which contain no digits', () => {
    expect(normalizeErrorLine('the interface was defaced')).toContain('defaced');
  });

  it('keeps every distinguishing part of the message', () => {
    const normalized = normalizeErrorLine("src/app/a.ts:14:22 - error TS2551: Property 'titel' does not exist on type 'AppComponent'.");
    expect(normalized).toContain('src/app/a.ts');
    expect(normalized).toContain('TS2551');
    expect(normalized).toContain('titel');
    expect(normalized).toContain('AppComponent');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/providers/ci/signature.js"`.

- [ ] **Step 3: Implement the normalizer**

Create `src/providers/ci/signature.ts`:

```ts
import { createHash } from 'node:crypto';
import type { FailureDigest } from './digest.js';

/**
 * Spec §16.3:
 *
 * ```text
 * failure_signature = sha256(
 *   sorted(failed test identities)
 *   + sorted(problem identities)
 *   + sorted(normalized error lines)   # file paths, TS error codes, first line of each error window,
 * )                                     # with line numbers and timestamps stripped
 * ```
 *
 * excluding approved baseline exceptions. A debug attempt is a no-progress iteration when its resulting
 * signature equals the previous one, and `max_no_progress_iterations` consecutive no-progress iterations
 * escalate even if attempts remain.
 *
 * That makes this function defeatable in two opposite directions, and both are tested:
 *
 * - **Too sensitive.** If the signature moves when only a line number, a timestamp, a duration, a build id or an
 *   absolute path prefix changed, then every attempt looks like progress and the guardrail never fires. The
 *   stripping list below exists entirely for this, and every entry came from real reporter output.
 * - **Too coarse.** If two genuinely different compile errors hash the same, a debug agent that fixed one and
 *   uncovered another looks stuck and the goal escalates for nothing. So the message text, the file path and the
 *   TS error code are all **kept**, case is **not** folded, and bare integers in prose are **not** stripped —
 *   `expected 3 to be 4` and `expected 5 to be 6` are two different defects.
 */

/** ANSI SGR and cursor-control sequences: Karma writes these to stdout (verified against a real run). */
const ANSI_RE = /\[[0-9;]*[A-Za-z]/gu;

/** `2026-09-21T14:30:14.382Z`, anywhere on the line. */
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu;

/** Karma's leading `21 09 2026 16:30:42.025:` stamp (verified against a real run). */
const KARMA_TIMESTAMP_RE = /^\s*\d{2} \d{2} \d{4} \d{2}:\d{2}:\d{2}\.\d{3}:/u;

/** A bracketed or bare clock: `[16:30:42]`, `16:30:42.025`. */
const CLOCK_RE = /\[?\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]?/gu;

/** `0.004 secs`, `417 ms`, `2 s`, `1.5 seconds`. Runs before CLOCK_RE so `0.9 secs` is a duration, not a clock. */
const DURATION_RE = /\b\d+(?:\.\d+)?\s*(?:ms|millis|milliseconds?|secs?|seconds?|mins?|minutes?)\b/giu;

/** `foo.ts(14,22)` and `foo.ts(14:22)`. */
const PAREN_LINE_COL_RE = /\(\d+[,:]\d+\)/gu;

/** `foo.ts:14:22` and `foo.ts:14` — a colon-number run attached to a non-space token. */
const LINE_COL_SUFFIX_RE = /(?<=\S):\d+(?::\d+)?\b/gu;

/** `line 14`, `Line 14`. */
const LINE_WORD_RE = /\bline \d+\b/giu;

/**
 * A hex run of seven or more characters that contains at least one digit: a sha, a build id, a socket id.
 *
 * The digit requirement is load-bearing. Without it, ordinary English words made only of the letters `a`-`f` —
 * `defaced`, `facaded`, `deafened` — are hex runs of seven or more and would be blanked out of a message,
 * silently merging two different failures into one signature.
 */
const HEX_ID_RE = /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,}\b/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Normalizes one error line for hashing. `root`, when given, is the absolute workspace root: every occurrence is
 * replaced with `<root>` first, so the same failure observed on two machines (§7 rule 5) produces the same line.
 *
 * Order matters and is deliberate: the workspace root goes first (it may itself contain digits that later rules
 * would eat), then timestamps, then durations before clocks (`0.9 secs` is a duration), then positions, then
 * opaque ids.
 */
export function normalizeErrorLine(line: string, root: string | null = null): string {
  let out = line.replace(ANSI_RE, '');
  if (root !== null && root !== '') out = out.replace(new RegExp(escapeRegExp(root), 'gu'), '<root>');
  out = out.replace(KARMA_TIMESTAMP_RE, '');
  out = out.replace(ISO_TIMESTAMP_RE, '<ts>');
  out = out.replace(DURATION_RE, '<dur>');
  out = out.replace(CLOCK_RE, '<ts>');
  out = out.replace(PAREN_LINE_COL_RE, '(<pos>)');
  out = out.replace(LINE_COL_SUFFIX_RE, ':<pos>');
  out = out.replace(LINE_WORD_RE, 'line <pos>');
  out = out.replace(HEX_ID_RE, '<id>');
  return out.replace(/\s+/gu, ' ').trim();
}
```

- [ ] **Step 4: Run the normalizer tests to verify they pass**

Run: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts -t normalizeErrorLine`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing signature tests, including the collision cases**

Append to `tests/providers/ci/signature.test.ts`:

```ts
describe('failureSignature', () => {
  it('is a 64-character lowercase sha256 hex string', () => {
    expect(signature({ failedTests: ['a'] })).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('ignores a line number change, so a moved compile error is not counted as progress', () => {
    expect(signature({ errorLines: ["src/a.ts:14:22 - error TS2551: Property 'titel' does not exist."] })).toBe(
      signature({ errorLines: ["src/a.ts:91:3 - error TS2551: Property 'titel' does not exist."] }),
    );
  });

  it('ignores a timestamp change', () => {
    expect(signature({ errorLines: ['2026-09-21T14:30:14.382Z ERROR in ./src/main.ts'] })).toBe(
      signature({ errorLines: ['2026-09-21T15:59:01.004Z ERROR in ./src/main.ts'] }),
    );
  });

  it('distinguishes two different TypeScript error codes on the same file and line', () => {
    // tasks.md T09's done-when names this case: "signature tests showing distinct compile errors produce
    // distinct signatures".
    expect(signature({ errorLines: ["src/a.ts:14:22 - error TS2551: Property 'titel' does not exist."] })).not.toBe(
      signature({ errorLines: ["src/a.ts:14:22 - error TS2339: Property 'titel' does not exist."] }),
    );
  });

  it('distinguishes the same error code in two different files', () => {
    expect(signature({ errorLines: ['src/a.ts:1:1 - error TS2551: nope'] })).not.toBe(
      signature({ errorLines: ['src/b.ts:1:1 - error TS2551: nope'] }),
    );
  });

  it('distinguishes the same error code and file with a different symbol in the message', () => {
    expect(signature({ errorLines: ["src/a.ts:1:1 - error TS2551: Property 'titel' does not exist."] })).not.toBe(
      signature({ errorLines: ["src/a.ts:1:1 - error TS2551: Property 'naem' does not exist."] }),
    );
  });

  it('distinguishes two assertion failures whose only difference is a bare number', () => {
    // The stripping list must not reach bare integers in prose: these are two different defects.
    expect(signature({ errorLines: ['AssertionError: expected 3 to be 4'] })).not.toBe(
      signature({ errorLines: ['AssertionError: expected 5 to be 6'] }),
    );
  });

  it('ignores the order of failed tests, problems and error lines', () => {
    expect(signature({ failedTests: ['a', 'b'], problems: ['p', 'q'], errorLines: ['x', 'y'] })).toBe(
      signature({ failedTests: ['b', 'a'], problems: ['q', 'p'], errorLines: ['y', 'x'] }),
    );
  });

  it('ignores duplicates, so one error reported twice is one error', () => {
    expect(signature({ failedTests: ['a', 'a'] })).toBe(signature({ failedTests: ['a'] }));
  });

  it('excludes approved baseline exceptions from both identity lists', () => {
    expect(signature({ failedTests: ['flaky', 'real'], problems: ['bad-agent'], exceptions: ['flaky', 'bad-agent'] })).toBe(
      signature({ failedTests: ['real'], problems: [] }),
    );
  });

  it('cannot be defeated by moving a string between the three lists', () => {
    // A signature built by concatenating the three sorted lists without a separator hashes ["ab"],[],[] and
    // ["a"],["b"],[] identically, so a defect that moved from a build problem to a failed test would read as
    // "no progress". The serialisation has to keep the lists apart.
    expect(signature({ failedTests: ['ab'] })).not.toBe(signature({ failedTests: ['a'], problems: ['b'] }));
  });

  it('treats an empty failure as its own stable value, not as a crash', () => {
    expect(signature()).toBe(signature());
    expect(signature()).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('signatureFromDigest', () => {
  it('hashes the first line of each error window plus both identity lists', () => {
    const digest = buildFailureDigest(
      {
        ref: REF,
        classification: 'build_failed',
        problems: [{ identity: 'compile:src/a.ts', type: 'TC_COMPILATION_ERROR', details: '' }],
        failedTests: [],
        log: ['before', "src/a.ts:14:22 - error TS2551: Property 'titel' does not exist.", 'after'].join('\n'),
        links: [],
        exceptions: [],
      },
      LIMITS,
    );
    expect(digestErrorLines(digest)).toEqual(["src/a.ts:14:22 - error TS2551: Property 'titel' does not exist."]);
    expect(signatureFromDigest(digest, [], null)).toBe(
      failureSignature({
        failedTests: [],
        problems: ['compile:src/a.ts'],
        errorLines: ["src/a.ts:14:22 - error TS2551: Property 'titel' does not exist."],
        exceptions: [],
        root: null,
      }),
    );
  });

  it('gives the same signature for the same failure seen at two different line numbers', () => {
    const digestAt = (line: number): ReturnType<typeof buildFailureDigest> =>
      buildFailureDigest(
        {
          ref: REF,
          classification: 'build_failed',
          problems: [],
          failedTests: [],
          log: ['noise', `src/a.ts:${String(line)}:9 - error TS2551: Property 'titel' does not exist.`].join('\n'),
          links: [],
          exceptions: [],
        },
        LIMITS,
      );
    expect(signatureFromDigest(digestAt(14), [], null)).toBe(signatureFromDigest(digestAt(140), [], null));
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts`
Expected: FAIL — `failureSignature is not a function`.

- [ ] **Step 7: Implement the signature**

Append to `src/providers/ci/signature.ts`:

```ts
export interface SignatureInput {
  /** Failed test identities, unsorted and possibly duplicated. */
  failedTests: readonly string[];
  /** Build problem identities, unsorted and possibly duplicated. */
  problems: readonly string[];
  /** The first line of each error window (§16.3), unnormalized. */
  errorLines: readonly string[];
  /** Approved §11 baseline exception identities, excluded from both identity lists. */
  exceptions: readonly string[];
  /** Absolute workspace root, replaced with `<root>` before normalization; null when the caller has none. */
  root: string | null;
}

/**
 * §16.3's hash.
 *
 * The three lists are serialised as a JSON array-of-arrays rather than concatenated, because concatenation is
 * ambiguous: `["ab"] + [] + []` and `["a"] + ["b"] + []` produce the same bytes, so a defect that moved from a
 * build problem to a failed test would hash identically and read as "no progress". JSON keeps the boundaries.
 */
export function failureSignature(input: SignatureInput): string {
  const excluded = new Set(input.exceptions);
  const identities = (values: readonly string[]): string[] =>
    [...new Set(values)].filter((value) => !excluded.has(value)).sort();
  const lines = [...new Set(input.errorLines.map((line) => normalizeErrorLine(line, input.root)))]
    .filter((line) => line !== '')
    .sort();
  const payload = JSON.stringify([identities(input.failedTests), identities(input.problems), lines]);
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** §16.3's "first line of each error window" — which {@link FailureDigest} already carries as `errorLine`. */
export function digestErrorLines(digest: FailureDigest): string[] {
  return digest.errorWindows.map((window) => window.errorLine).filter((line) => line !== '');
}

/**
 * The signature of a §16.2 digest.
 *
 * `exceptions` is passed separately rather than read from `digest.matchedExceptions`, because that field is only
 * the *matched subset* the digest chose to report, while §16.3 excludes every approved exception whether or not
 * it appeared in this particular failure.
 */
export function signatureFromDigest(digest: FailureDigest, exceptions: readonly string[], root: string | null): string {
  return failureSignature({
    failedTests: digest.failedTests.map((test) => test.identity),
    problems: digest.problems.map((problem) => problem.identity),
    errorLines: digestErrorLines(digest),
    exceptions,
    root,
  });
}
```

- [ ] **Step 8: Run the whole signature suite**

Run: `pnpm vitest run --project unit tests/providers/ci/signature.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 9: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1056 + 23 = 1079.

- [ ] **Step 10: Commit**

```bash
git add src/providers/ci/signature.ts tests/providers/ci/signature.test.ts
git commit -m "feat(providers): add the §16.3 failure signature with normalized error lines" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 5: The full `fake` CI provider

**Files:**
- Modify (rewrite): `src/providers/fake/ci.ts`
- Delete: `tests/providers/fake-ci-scm.test.ts` (split into `fake-ci.test.ts` here and `fake-scm.test.ts` in Task 11)
- Test: `tests/providers/fake-ci.test.ts`

**Interfaces:**
- Consumes: `BuildRef`, `BuildOutcome`, `BuildProblem`, `BuildStatus`, `BuildClassification`, `FailedTest`, `TriggerBuildInput`, `WaitForBuildOptions`, `CiProvider`, `CiProviderError` from `src/providers/ci/types.js`; `classifyBuild` from `src/providers/ci/classify.js`; `buildFailureDigest`, `DigestLimits`, `FailureDigest` from `src/providers/ci/digest.js`; `readFakeStore`, `writeFakeStore`, `FAKE_CI_FILE` from `./store.js`.
- Produces:
  - `buildKey(repo: string, revision: string, buildTypeId: string): string` — unchanged from T04
  - `fakeBuildId(repo: string, attempt: number): string`
  - `interface FakeCiScriptEntry { missing?: boolean; status?: BuildStatus; classification: BuildClassification; rawStatus?: string; problems?: BuildProblem[]; failedTests?: FailedTest[]; log?: string; links?: string[]; runningPolls?: number }`
  - `interface FakeCiRecordedBuild { ref: BuildRef; attempt: number; entry: FakeCiScriptEntry; triggered: boolean; polls: number }`
  - `interface FakeCiCall { kind: 'findBuild' | 'triggerBuild' | 'waitForBuild' | 'failureDigest'; repo: string; revision: string | null; build_type_id: string; build_id: string | null; at: string; result: string }`
  - `interface FakeCiStore { script: Record<string, FakeCiScriptEntry[]>; revisions: Record<string, string[]>; builds: Record<string, string>; outcomes: Record<string, FakeCiRecordedBuild>; calls: FakeCiCall[] }`
  - `emptyFakeCiStore()`, `normalizeFakeCiStore(raw: unknown): FakeCiStore`, `readFakeCi(fakeDir)`, `writeFakeCi(fakeDir, store)`, `seedFakeCi(fakeDir, script)`, `seedFakeBuilds(fakeDir, builds)`
  - `interface FakeCiProviderInput { fakeDir: string; now(): Date; sleep?: (ms: number) => Promise<void> }`
  - `createFakeCiProvider(input: FakeCiProviderInput): CiProvider`

**Why:** §3.2 ("Fakes are first-class: they are how Janus is developed and how the full loop is exercised from a network without TeamCity") and §18.5's scripting model, applied to CI. `tasks.md` T09 asks for "scripted per (repo, attempt), supports missing build, infra outcome, persisted". The attempt number is derived from the **revision**, not from a call counter, so a resumed `janus run` that re-finds the same commit gets the same answer — §7's resume semantics would be untestable otherwise.

- [ ] **Step 1: Write the failing tests**

Create `tests/providers/fake-ci.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildKey, createFakeCiProvider, readFakeCi, seedFakeBuilds, seedFakeCi } from '../../src/providers/fake/ci.js';
import type { FakeCiScriptEntry } from '../../src/providers/fake/ci.js';
import { CiProviderError } from '../../src/providers/ci/types.js';
import type { DigestLimits } from '../../src/providers/ci/digest.js';
import { renderDigestMarkdown } from '../../src/providers/ci/digest.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = (): Date => new Date('2026-09-21T11:00:00.000Z');
const LIMITS: DigestLimits = { maxTests: 50, maxTestDetailLines: 20, logTailLines: 400, maxErrorWindows: 10, maxBytes: 65_536, redact: true };
const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);
const BUILD_TYPE = 'Fe_UiKit_Build';

function fakeDir(): string {
  return join(tempDir('janus-fake-ci-'), 'fake');
}

function provider(dir: string, script: Record<string, FakeCiScriptEntry[]> = {}) {
  seedFakeCi(dir, script);
  return createFakeCiProvider({ fakeDir: dir, now: clock, sleep: async () => undefined });
}

describe('createFakeCiProvider', () => {
  it('answers null for a revision it has no script or seed for', async () => {
    const ci = provider(fakeDir());
    expect(await ci.findBuild('ui-kit', REV_A, BUILD_TYPE)).toBeNull();
  });

  it('still honours a seeded build id, the way T04 seeded them', async () => {
    const dir = fakeDir();
    seedFakeBuilds(dir, { [buildKey('ui-kit', REV_A, BUILD_TYPE)]: 'build-17' });
    const ci = createFakeCiProvider({ fakeDir: dir, now: clock, sleep: async () => undefined });
    expect((await ci.findBuild('ui-kit', REV_A, BUILD_TYPE))?.id).toBe('build-17');
    expect(await ci.findBuild('ui-kit', REV_B, BUILD_TYPE)).toBeNull();
  });

  it('scripts by repo and attempt, where attempt is the number of distinct revisions seen', async () => {
    const dir = fakeDir();
    const ci = provider(dir, {
      'ui-kit': [
        { classification: 'tests_failed', failedTests: [{ identity: 'A > one', name: 'one', suite: 'A', newFailure: true, details: '' }] },
        { classification: 'success' },
      ],
    });
    const first = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    const second = await ci.findBuild('ui-kit', REV_B, BUILD_TYPE);
    if (first === null || second === null) throw new Error('expected both builds to be found');
    expect((await ci.waitForBuild(first, { timeoutMs: 1000, pollIntervalMs: 10 })).classification).toBe('tests_failed');
    expect((await ci.waitForBuild(second, { timeoutMs: 1000, pollIntervalMs: 10 })).classification).toBe('success');
  });

  it('gives the same build back for the same revision, so a resumed run is idempotent', async () => {
    const dir = fakeDir();
    const ci = provider(dir, { 'ui-kit': [{ classification: 'success' }, { classification: 'build_failed' }] });
    const first = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    const again = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    expect(again?.id).toBe(first?.id);
    // The second lookup must not have consumed the attempt-2 entry.
    expect((await ci.waitForBuild(again ?? first ?? { id: '', repo: '', buildTypeId: '', revision: null, branch: null, url: null }, { timeoutMs: 1000, pollIntervalMs: 10 })).classification).toBe('success');
  });

  it('supports a missing build, which is the §16.1 explicit-trigger path', async () => {
    const dir = fakeDir();
    const ci = provider(dir, { 'ui-kit': [{ missing: true, classification: 'success' }] });
    expect(await ci.findBuild('ui-kit', REV_A, BUILD_TYPE)).toBeNull();
    const triggered = await ci.triggerBuild({ repo: 'ui-kit', buildTypeId: BUILD_TYPE, branch: 'ai/g', revision: REV_A, params: {} });
    expect(triggered.id).not.toBe('');
    expect(triggered.branch).toBe('ai/g');
    expect((await ci.waitForBuild(triggered, { timeoutMs: 1000, pollIntervalMs: 10 })).classification).toBe('success');
    expect(readFakeCi(dir).outcomes[triggered.id]?.triggered).toBe(true);
  });

  it('produces an infra outcome when the script asks for one', async () => {
    const dir = fakeDir();
    const ci = provider(dir, { 'ui-kit': [{ classification: 'infra', rawStatus: 'CANCELLED' }] });
    const ref = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    if (ref === null) throw new Error('expected a build');
    const outcome = await ci.waitForBuild(ref, { timeoutMs: 1000, pollIntervalMs: 10 });
    expect(outcome.classification).toBe('infra');
    expect(outcome.rawStatus).toBe('CANCELLED');
  });

  it('reports running for the scripted number of polls, and persists the poll count across processes', async () => {
    const dir = fakeDir();
    const script: Record<string, FakeCiScriptEntry[]> = { 'ui-kit': [{ classification: 'success', runningPolls: 3 }] };
    const first = provider(dir, script);
    const ref = await first.findBuild('ui-kit', REV_A, BUILD_TYPE);
    if (ref === null) throw new Error('expected a build');
    // One poll's worth of budget: the wait gives up and reports the §16.1 queue timeout as infra (D4).
    const timedOut = await first.waitForBuild(ref, { timeoutMs: 10, pollIntervalMs: 10 });
    expect(timedOut.classification).toBe('infra');
    expect(timedOut.rawStatus).toBe('timeout');
    expect(timedOut.status).toBe('running');

    const second = createFakeCiProvider({ fakeDir: dir, now: clock, sleep: async () => undefined });
    const finished = await second.waitForBuild(ref, { timeoutMs: 10_000, pollIntervalMs: 10 });
    expect(finished.classification).toBe('success');
    expect(finished.status).toBe('finished');
  });

  it('builds a digest from the scripted log, redacted and bounded', async () => {
    const dir = fakeDir();
    const ci = provider(dir, {
      'ui-kit': [
        {
          classification: 'build_failed',
          problems: [{ identity: 'compile:src/a.ts', type: 'TC_COMPILATION_ERROR', details: 'error TS2551' }],
          log: ['starting', 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', "src/a.ts:4:1 - error TS2551: nope"].join('\n'),
          links: ['https://fake.invalid/build/1'],
        },
      ],
    });
    const ref = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    if (ref === null) throw new Error('expected a build');
    const digest = await ci.failureDigest(ref, LIMITS, []);
    const markdown = renderDigestMarkdown(digest);
    expect(digest.classification).toBe('build_failed');
    expect(digest.problems.map((problem) => problem.identity)).toEqual(['compile:src/a.ts']);
    expect(markdown).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(digest.errorWindows.some((window) => window.errorLine.includes('TS2551'))).toBe(true);
  });

  it('passes the caller’s baseline exceptions through to the digest', async () => {
    const dir = fakeDir();
    const ci = provider(dir, {
      'ui-kit': [
        { classification: 'tests_failed', failedTests: [{ identity: 'flaky', name: 'flaky', suite: null, newFailure: null, details: '' }] },
      ],
    });
    const ref = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    if (ref === null) throw new Error('expected a build');
    expect((await ci.failureDigest(ref, LIMITS, ['flaky'])).matchedExceptions).toEqual(['flaky']);
  });

  it('throws a not_found CiProviderError for a build id it never minted', async () => {
    const ci = provider(fakeDir());
    const ref = { id: 'nope', repo: 'ui-kit', buildTypeId: BUILD_TYPE, revision: REV_A, branch: null, url: null };
    await expect(ci.waitForBuild(ref, { timeoutMs: 10, pollIntervalMs: 10 })).rejects.toBeInstanceOf(CiProviderError);
    await expect(ci.failureDigest(ref, LIMITS, [])).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('records every call, across processes, in fake/ci.json', async () => {
    const dir = fakeDir();
    const ci = provider(dir, { 'ui-kit': [{ classification: 'success' }] });
    const ref = await ci.findBuild('ui-kit', REV_A, BUILD_TYPE);
    if (ref === null) throw new Error('expected a build');
    await ci.waitForBuild(ref, { timeoutMs: 1000, pollIntervalMs: 10 });
    const later = createFakeCiProvider({ fakeDir: dir, now: clock, sleep: async () => undefined });
    await later.findBuild('ui-kit', REV_B, BUILD_TYPE);
    expect(readFakeCi(dir).calls.map((call) => call.kind)).toEqual(['findBuild', 'waitForBuild', 'findBuild']);
    expect(readFakeCi(dir).calls[0]?.at).toBe('2026-09-21T11:00:00.000Z');
  });

  it('falls back to an empty store rather than crashing on a store written by an older Janus', () => {
    const dir = fakeDir();
    seedFakeBuilds(dir, { [buildKey('ui-kit', REV_A, BUILD_TYPE)]: 'build-17' });
    // T04's store had only `builds` and `calls`; the normalizer must supply the new keys.
    const store = readFakeCi(dir);
    expect(store.script).toEqual({});
    expect(store.revisions).toEqual({});
    expect(store.outcomes).toEqual({});
    expect(store.builds[buildKey('ui-kit', REV_A, BUILD_TYPE)]).toBe('build-17');
  });
});
```

- [ ] **Step 2: Delete the superseded test file and run the new one**

```bash
git rm tests/providers/fake-ci-scm.test.ts
```

Run: `pnpm vitest run --project unit tests/providers/fake-ci.test.ts`
Expected: FAIL — `seedFakeCi is not a function` (the module exists, but only with T04's two-key store).

- [ ] **Step 3: Rewrite `src/providers/fake/ci.ts`**

```ts
import { classifyBuild } from '../ci/classify.js';
import type { RawBuildStatus } from '../ci/classify.js';
import { buildFailureDigest } from '../ci/digest.js';
import type { DigestLimits, FailureDigest } from '../ci/digest.js';
import { CiProviderError } from '../ci/types.js';
import type {
  BuildClassification,
  BuildOutcome,
  BuildProblem,
  BuildRef,
  BuildStatus,
  CiProvider,
  FailedTest,
  TriggerBuildInput,
  WaitForBuildOptions,
} from '../ci/types.js';
import { FAKE_CI_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * Spec §3.2's `fake` CI provider, persisted under `<workspace>/fake/ci.json`.
 *
 * Scripted per **repo and attempt**, where the attempt number is the position of the revision in the list of
 * distinct revisions this repo has been asked about — not a call counter. That distinction is what makes §7's
 * resume semantics testable: a `janus run` that dies mid-wait and resumes asks `findBuild` about the *same*
 * commit again, and must get the *same* answer. A call counter would hand it the next scripted attempt and the
 * scenario would silently test something else.
 *
 * Like every fake, it never invokes git (§32 rule 11); the harness enforces that with a reflog audit around
 * every provider call.
 */

/** The key a seeded build is stored under: one build per repo, revision, and build type. */
export function buildKey(repo: string, revision: string, buildTypeId: string): string {
  return `${repo}@${revision}#${buildTypeId}`;
}

/** The id the fake mints when no build id was seeded. Stable for a given repo and attempt. */
export function fakeBuildId(repo: string, attempt: number): string {
  return `fake-${repo}-${String(attempt)}`;
}

/** One scripted answer, indexed by `attempt - 1` under its repo. */
export interface FakeCiScriptEntry {
  /**
   * When true, `findBuild` answers `null` for this attempt, which drives §16.1 step 2's explicit-trigger path.
   * `triggerBuild` ignores it: the point of an explicit trigger is that it produces a build.
   */
  missing?: boolean;
  /** Reported once the scripted `runningPolls` are exhausted. Default `finished`. */
  status?: BuildStatus;
  classification: BuildClassification;
  /** The provider's own status word, for the evidence trail. Default: the classification name, upper-cased. */
  rawStatus?: string;
  problems?: BuildProblem[];
  failedTests?: FailedTest[];
  /** The build log the §16.2 digest is cut from. */
  log?: string;
  links?: string[];
  /** How many `waitForBuild` polls report `running` before the scripted outcome. Default 0. */
  runningPolls?: number;
}

/** What the fake answered about one build, kept so a later process can answer the same way. */
export interface FakeCiRecordedBuild {
  ref: BuildRef;
  attempt: number;
  entry: FakeCiScriptEntry;
  triggered: boolean;
  /** Polls already served. Persisted, so a resumed `janus run` continues its wait rather than restarting it. */
  polls: number;
}

export interface FakeCiCall {
  kind: 'findBuild' | 'triggerBuild' | 'waitForBuild' | 'failureDigest';
  repo: string;
  revision: string | null;
  build_type_id: string;
  build_id: string | null;
  at: string;
  /** `null`, a build id, or a classification — whatever this call answered. */
  result: string;
}

/** The contents of `<workspace>/fake/ci.json`. */
export interface FakeCiStore {
  /** repo -> answers indexed by `attempt - 1`. A repo that runs out of entries falls back to a green build. */
  script: Record<string, FakeCiScriptEntry[]>;
  /** repo -> distinct revisions in first-seen order; the index plus one is the attempt number. */
  revisions: Record<string, string[]>;
  /** `buildKey(...)` -> build id, seeded before a run when a scenario needs a specific id. */
  builds: Record<string, string>;
  /** build id -> what the fake answered about it. */
  outcomes: Record<string, FakeCiRecordedBuild>;
  calls: FakeCiCall[];
}

export function emptyFakeCiStore(): FakeCiStore {
  return { script: {}, revisions: {}, builds: {}, outcomes: {}, calls: [] };
}

/**
 * Supplies any key a store written by an older Janus is missing.
 *
 * `readFakeStore` versions the *wrapper*, not the payload, and T04's `fake/ci.json` had only `builds` and
 * `calls`. Bumping the wrapper version would throw away a dogfooding workspace's seeded builds; filling in the
 * new keys keeps it working. A fake is never allowed to be the reason a run crashes.
 */
export function normalizeFakeCiStore(raw: unknown): FakeCiStore {
  const empty = emptyFakeCiStore();
  if (typeof raw !== 'object' || raw === null) return empty;
  const partial = raw as Partial<FakeCiStore>;
  return {
    script: partial.script ?? empty.script,
    revisions: partial.revisions ?? empty.revisions,
    builds: partial.builds ?? empty.builds,
    outcomes: partial.outcomes ?? empty.outcomes,
    calls: partial.calls ?? empty.calls,
  };
}

export function readFakeCi(fakeDir: string): FakeCiStore {
  return normalizeFakeCiStore(readFakeStore<unknown>(fakeDir, FAKE_CI_FILE, emptyFakeCiStore()));
}

export function writeFakeCi(fakeDir: string, store: FakeCiStore): void {
  writeFakeStore(fakeDir, FAKE_CI_FILE, store);
}

/** Seeds the script before a run, clearing recorded revisions, outcomes and calls. */
export function seedFakeCi(fakeDir: string, script: FakeCiStore['script']): void {
  writeFakeCi(fakeDir, { ...emptyFakeCiStore(), script });
}

/** Seeds the build ids the fake will hand out, clearing everything else. Kept from T04 for existing scenarios. */
export function seedFakeBuilds(fakeDir: string, builds: Record<string, string>): void {
  writeFakeCi(fakeDir, { ...emptyFakeCiStore(), builds });
}

export interface FakeCiProviderInput {
  fakeDir: string;
  now(): Date;
  /** Replaced in tests so a scripted queue costs no wall-clock time. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ENTRY: FakeCiScriptEntry = { classification: 'success' };

/** Maps a scripted classification onto the raw vocabulary `classifyBuild` takes, so the fake goes through §16.1 too. */
const RAW_FOR: Record<BuildClassification, RawBuildStatus> = {
  success: 'success',
  tests_failed: 'failure',
  build_failed: 'failure',
  infra: 'cancelled',
};

function attemptFor(store: FakeCiStore, repo: string, revision: string): number {
  const seen = store.revisions[repo] ?? [];
  const index = seen.indexOf(revision);
  if (index >= 0) return index + 1;
  seen.push(revision);
  store.revisions[repo] = seen;
  return seen.length;
}

function entryFor(store: FakeCiStore, repo: string, attempt: number): FakeCiScriptEntry | undefined {
  return store.script[repo]?.[attempt - 1];
}

function outcomeFrom(record: FakeCiRecordedBuild, now: Date, finished: boolean): BuildOutcome {
  const { entry } = record;
  const failedTests = entry.failedTests ?? [];
  const problems = entry.problems ?? [];
  if (!finished) {
    return {
      ref: record.ref,
      status: 'running',
      classification: 'infra',
      rawStatus: 'timeout',
      problems: [],
      failedTests: [],
      startedAt: now.toISOString(),
      finishedAt: null,
    };
  }
  // The scripted classification is authoritative, but it is produced *through* `classifyBuild` whenever the
  // script gives it something to work with, so the fake exercises the same §16.1 table the real providers do.
  const derived = classifyBuild({
    rawStatus: RAW_FOR[entry.classification],
    failedTests: failedTests.length,
    problems: problems.length,
  });
  return {
    ref: record.ref,
    status: entry.status ?? 'finished',
    classification: derived === entry.classification ? derived : entry.classification,
    rawStatus: entry.rawStatus ?? entry.classification.toUpperCase(),
    problems,
    failedTests,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
  };
}

export function createFakeCiProvider(input: FakeCiProviderInput): CiProvider {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { fakeDir } = input;

  const record = (store: FakeCiStore, call: FakeCiCall): void => {
    store.calls.push(call);
    writeFakeCi(fakeDir, store);
  };

  const ensure = (store: FakeCiStore, ref: BuildRef, attempt: number, entry: FakeCiScriptEntry, triggered: boolean): FakeCiRecordedBuild => {
    const existing = store.outcomes[ref.id];
    if (existing !== undefined) {
      if (triggered) existing.triggered = true;
      return existing;
    }
    const created: FakeCiRecordedBuild = { ref, attempt, entry, triggered, polls: 0 };
    store.outcomes[ref.id] = created;
    return created;
  };

  const lookup = (store: FakeCiStore, ref: BuildRef): FakeCiRecordedBuild => {
    const found = store.outcomes[ref.id];
    if (found === undefined) {
      throw new CiProviderError('fake', 'not_found', `no build ${ref.id} in fake/ci.json`);
    }
    return found;
  };

  return {
    name: 'fake',

    findBuild: async (repo, revision, buildTypeId) => {
      const store = readFakeCi(fakeDir);
      const attempt = attemptFor(store, repo, revision);
      const entry = entryFor(store, repo, attempt);
      const seeded = store.builds[buildKey(repo, revision, buildTypeId)];
      const at = input.now().toISOString();
      if ((entry === undefined && seeded === undefined) || entry?.missing === true) {
        record(store, { kind: 'findBuild', repo, revision, build_type_id: buildTypeId, build_id: null, at, result: 'null' });
        return null;
      }
      const id = seeded ?? fakeBuildId(repo, attempt);
      const ref: BuildRef = { id, repo, buildTypeId, revision, branch: null, url: `https://fake.invalid/build/${id}` };
      ensure(store, ref, attempt, entry ?? DEFAULT_ENTRY, false);
      record(store, { kind: 'findBuild', repo, revision, build_type_id: buildTypeId, build_id: id, at, result: id });
      return ref;
    },

    triggerBuild: async (trigger: TriggerBuildInput) => {
      const store = readFakeCi(fakeDir);
      const attempt = attemptFor(store, trigger.repo, trigger.revision);
      const entry = entryFor(store, trigger.repo, attempt) ?? DEFAULT_ENTRY;
      const seeded = store.builds[buildKey(trigger.repo, trigger.revision, trigger.buildTypeId)];
      const id = seeded ?? fakeBuildId(trigger.repo, attempt);
      const ref: BuildRef = {
        id,
        repo: trigger.repo,
        buildTypeId: trigger.buildTypeId,
        revision: trigger.revision,
        branch: trigger.branch,
        url: `https://fake.invalid/build/${id}`,
      };
      const created = ensure(store, ref, attempt, entry, true);
      created.ref = ref; // a trigger knows the branch a find did not
      record(store, {
        kind: 'triggerBuild',
        repo: trigger.repo,
        revision: trigger.revision,
        build_type_id: trigger.buildTypeId,
        build_id: id,
        at: input.now().toISOString(),
        result: id,
      });
      return ref;
    },

    waitForBuild: async (ref: BuildRef, options: WaitForBuildOptions) => {
      let store = readFakeCi(fakeDir);
      let found = lookup(store, ref);
      const runningPolls = found.entry.runningPolls ?? 0;
      let waited = 0;
      while (found.polls < runningPolls) {
        if (waited + options.pollIntervalMs > options.timeoutMs) {
          const outcome = outcomeFrom(found, input.now(), false);
          record(store, {
            kind: 'waitForBuild',
            repo: ref.repo,
            revision: ref.revision,
            build_type_id: ref.buildTypeId,
            build_id: ref.id,
            at: input.now().toISOString(),
            result: outcome.classification,
          });
          return outcome;
        }
        await sleep(options.pollIntervalMs);
        waited += options.pollIntervalMs;
        // Re-read rather than mutate in place: another process may have polled the same build meanwhile, which
        // is exactly the §7 resume case this counter exists to model.
        store = readFakeCi(fakeDir);
        found = lookup(store, ref);
        found.polls += 1;
        writeFakeCi(fakeDir, store);
      }
      const outcome = outcomeFrom(found, input.now(), true);
      record(store, {
        kind: 'waitForBuild',
        repo: ref.repo,
        revision: ref.revision,
        build_type_id: ref.buildTypeId,
        build_id: ref.id,
        at: input.now().toISOString(),
        result: outcome.classification,
      });
      return outcome;
    },

    failureDigest: async (ref: BuildRef, limits: DigestLimits, exceptions: readonly string[]): Promise<FailureDigest> => {
      const store = readFakeCi(fakeDir);
      const found = lookup(store, ref);
      const digest = buildFailureDigest(
        {
          ref: found.ref,
          classification: outcomeFrom(found, input.now(), true).classification,
          problems: found.entry.problems ?? [],
          failedTests: found.entry.failedTests ?? [],
          log: found.entry.log ?? '',
          links: found.entry.links ?? [],
          exceptions,
        },
        limits,
      );
      record(store, {
        kind: 'failureDigest',
        repo: ref.repo,
        revision: ref.revision,
        build_type_id: ref.buildTypeId,
        build_id: ref.id,
        at: input.now().toISOString(),
        result: digest.classification,
      });
      return digest;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run --project unit tests/providers/fake-ci.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Fix the two files that still import the old fake SCM shape**

`tests/integration/harness/harness.ts:9` imports `createFakeCiProvider` and calls it with `{ fakeDir, now }` — still valid, no change needed. Confirm with:

Run: `pnpm typecheck`
Expected: exit 0. If it reports an error in `harness.ts`, the `FakeCiProviderInput` signature was changed incompatibly; `sleep` must stay optional.

- [ ] **Step 6: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. Unit count 1079 − 2 (the deleted `fake-ci-scm.test.ts` cases; its SCM case returns in Task 11) + 12 = 1089.

- [ ] **Step 7: Commit**

```bash
git add -A src/providers/fake/ci.ts tests/providers
git commit -m "feat(providers): implement the full scripted fake CI provider" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 6: The shared contract scaffold and the CI contract suite

**Files:**
- Create: `tests/providers/contract/capability.ts`
- Create: `tests/providers/contract/ci.ts`
- Create: `tests/providers/contract/fake-ci.test.ts`

**Interfaces:**
- Consumes: `CiProvider`, `CiProviderError`, `BuildRef` from `src/providers/ci/types.js`; `DigestLimits`, `renderDigestMarkdown` from `src/providers/ci/digest.js`; `signatureFromDigest` from `src/providers/ci/signature.js`; `createFakeCiProvider`, `seedFakeCi` from `src/providers/fake/ci.js`.
- Produces:
  - `itWhen(enabled: boolean, capability: string, title: string, fn: () => Promise<void> | void): void`
  - `contractTitle(kind: string, name: string): string`
  - `interface CiCapabilities { reportsMissingBuild: boolean; reportsQueue: boolean; producesInfra: boolean; reportsFailedTests: boolean; reportsNewFailure: boolean; reportsBuildUrl: boolean }`
  - `type CiContractScenario = 'success' | 'tests_failed' | 'build_failed' | 'infra' | 'missing_build' | 'queued_then_success'`
  - `interface CiContractSubject { provider: CiProvider; repo: string; revision: string; branch: string; buildTypeId: string; expectedFailedTests: string[]; seededSecret: string | null; cleanup(): void }`
  - `interface CiContractOptions { name: string; capabilities: CiCapabilities; setup(scenario: CiContractScenario): Promise<CiContractSubject> }`
  - `describeCiProviderContract(options: CiContractOptions): void`
  - `FAKE_CI_CAPABILITIES: CiCapabilities`

**Why:** §29 item 2 — "one suite that `teamcity`, `local`, and `fake` CI providers all pass; likewise for SCM providers" — and R6/D6. This task builds the scaffold **once**, so Task 8 (`local`), T15 (`teamcity`) and T16 (Bitbucket) each add one call rather than a second suite. The capability descriptor exists because the providers genuinely differ: `local` runs synchronously and has no queue, and a Bitbucket HTTP access token cannot merge (§15). Capabilities are declared per provider, never inferred, so a provider that *loses* a capability shows up as a changed declaration in review rather than as silently skipped tests.

- [ ] **Step 1: Write the scaffold's own test by writing the fake's wiring first**

Create `tests/providers/contract/fake-ci.test.ts`:

```ts
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createFakeCiProvider, seedFakeCi } from '../../../src/providers/fake/ci.js';
import type { FakeCiScriptEntry } from '../../../src/providers/fake/ci.js';
import { tempDir } from '../../helpers/git-fixtures.js';
import { describeCiProviderContract } from './ci.js';
import type { CiCapabilities, CiContractScenario, CiContractSubject } from './ci.js';

/** The `fake` provider is scripted, so it can do everything the contract knows how to ask about. */
export const FAKE_CI_CAPABILITIES: CiCapabilities = {
  reportsMissingBuild: true,
  reportsQueue: true,
  producesInfra: true,
  reportsFailedTests: true,
  reportsNewFailure: true,
  reportsBuildUrl: true,
};

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const FAILING_TESTS = ['AppComponent > renders the title', 'AppComponent > reacts to input'];

function scriptFor(scenario: CiContractScenario): FakeCiScriptEntry {
  const log = ['starting build', `TOKEN=${SECRET}`, 'src/app/a.ts:4:1 - error TS2551: nope', 'done'].join('\n');
  switch (scenario) {
    case 'success':
      return { classification: 'success', log: 'starting build\ndone' };
    case 'tests_failed':
      return {
        classification: 'tests_failed',
        log,
        failedTests: FAILING_TESTS.map((identity) => ({ identity, name: identity, suite: 'AppComponent', newFailure: true, details: 'expected a to be b' })),
      };
    case 'build_failed':
      return {
        classification: 'build_failed',
        log,
        problems: [{ identity: 'compile:src/app/a.ts', type: 'TC_COMPILATION_ERROR', details: 'error TS2551' }],
      };
    case 'infra':
      return { classification: 'infra', rawStatus: 'CANCELLED', log: 'agent lost' };
    case 'missing_build':
      return { missing: true, classification: 'success', log: 'done' };
    case 'queued_then_success':
      return { classification: 'success', runningPolls: 2, log: 'done' };
  }
}

async function setup(scenario: CiContractScenario): Promise<CiContractSubject> {
  const root = tempDir('janus-contract-fake-ci-');
  const fakeDir = join(root, 'fake');
  seedFakeCi(fakeDir, { 'ui-kit': [scriptFor(scenario)] });
  return {
    provider: createFakeCiProvider({ fakeDir, now: () => new Date('2026-09-21T11:00:00.000Z'), sleep: async () => undefined }),
    repo: 'ui-kit',
    revision: 'a'.repeat(40),
    branch: 'ai/angular-15-to-16',
    buildTypeId: 'Fe_UiKit_Build',
    expectedFailedTests: FAILING_TESTS,
    seededSecret: SECRET,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describeCiProviderContract({ name: 'fake', capabilities: FAKE_CI_CAPABILITIES, setup });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit tests/providers/contract/fake-ci.test.ts`
Expected: FAIL — `Failed to resolve import "./ci.js"`.

- [ ] **Step 3: Write the shared capability primitive**

Create `tests/providers/contract/capability.ts`:

```ts
import { it } from 'vitest';

/**
 * The one piece both provider contract suites share.
 *
 * A contract test that a provider cannot satisfy is not a failure and must not be silently absent either: it is
 * a test whose *name* says which capability the provider does not claim, so a reader of the run output can see
 * the shape of the gap. `it.skipIf` is the idiom this repository already uses for conditional cases
 * (`tests/integration/codex-smoke.test.ts`, `tests/agents/codex-adapter.test.ts`).
 */
export function itWhen(enabled: boolean, capability: string, title: string, fn: () => Promise<void> | void): void {
  it.skipIf(!enabled)(`${title} [capability: ${capability}]`, fn);
}

/** The `describe` title every provider contract suite uses, so `-t 'provider contract'` selects all of them. */
export function contractTitle(kind: string, name: string): string {
  return `${kind} provider contract: ${name}`;
}
```

- [ ] **Step 4: Write the CI contract suite**

Create `tests/providers/contract/ci.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { renderDigestMarkdown } from '../../../src/providers/ci/digest.js';
import type { DigestLimits } from '../../../src/providers/ci/digest.js';
import { signatureFromDigest } from '../../../src/providers/ci/signature.js';
import { CiProviderError } from '../../../src/providers/ci/types.js';
import type { BuildRef, CiProvider } from '../../../src/providers/ci/types.js';
import { contractTitle, itWhen } from './capability.js';

/**
 * Spec §29 item 2: "one suite that `teamcity`, `local`, and `fake` CI providers all pass".
 *
 * A provider is wired in with exactly one call:
 *
 * ```ts
 * describeCiProviderContract({ name: 'teamcity', capabilities: TEAMCITY_CI_CAPABILITIES, setup });
 * ```
 *
 * so T15 and T16 add a call, never a second suite. What a provider cannot do it declares in
 * {@link CiCapabilities}, and the cases that need that capability skip with the capability named in their title
 * — never inferred from a thrown error, because "this provider cannot do it" and "this provider is broken" must
 * not look the same.
 */

/** What a CI provider claims it can do. Declared per provider; never derived from behaviour. */
export interface CiCapabilities {
  /** `findBuild` can answer `null` — the §16.1 explicit-trigger path. */
  reportsMissingBuild: boolean;
  /** Builds can be observed before they finish (`queued`/`running`). A synchronous provider cannot. */
  reportsQueue: boolean;
  /** The provider can produce an `infra` classification. */
  producesInfra: boolean;
  /** The provider reports individual failed-test identities, not just a count. */
  reportsFailedTests: boolean;
  /** The provider reports §16.2's `newFailure` flag. */
  reportsNewFailure: boolean;
  /** The provider puts a human-openable URL on a `BuildRef`. */
  reportsBuildUrl: boolean;
}

export type CiContractScenario = 'success' | 'tests_failed' | 'build_failed' | 'infra' | 'missing_build' | 'queued_then_success';

/** One provider instance, prepared for one scenario. Built fresh per test case. */
export interface CiContractSubject {
  provider: CiProvider;
  repo: string;
  revision: string;
  branch: string;
  buildTypeId: string;
  /** The identities the `tests_failed` scenario's failures carry, so the suite can assert without guessing. */
  expectedFailedTests: string[];
  /** A credential seeded into the build log, so the suite can prove §32 rule 12. Null when not seedable. */
  seededSecret: string | null;
  cleanup(): void;
}

export interface CiContractOptions {
  name: string;
  capabilities: CiCapabilities;
  setup(scenario: CiContractScenario): Promise<CiContractSubject>;
}

const LIMITS: DigestLimits = { maxTests: 50, maxTestDetailLines: 20, logTailLines: 400, maxErrorWindows: 10, maxBytes: 65_536, redact: true };
const WAIT = { timeoutMs: 30_000, pollIntervalMs: 10 };

export function describeCiProviderContract(options: CiContractOptions): void {
  const { capabilities } = options;
  let open: CiContractSubject | null = null;

  const prepare = async (scenario: CiContractScenario): Promise<CiContractSubject> => {
    const subject = await options.setup(scenario);
    open = subject;
    return subject;
  };

  /** Finds the build, triggering it when the provider reports none — §16.1 steps 1 and 2, in one helper. */
  const obtain = async (subject: CiContractSubject): Promise<BuildRef> => {
    const found = await subject.provider.findBuild(subject.repo, subject.revision, subject.buildTypeId);
    if (found !== null) return found;
    return subject.provider.triggerBuild({
      repo: subject.repo,
      buildTypeId: subject.buildTypeId,
      branch: subject.branch,
      revision: subject.revision,
      params: {},
    });
  };

  describe(contractTitle('ci', options.name), () => {
    afterEach(() => {
      open?.cleanup();
      open = null;
    });

    it('reports the provider name it was built as', async () => {
      const subject = await prepare('success');
      expect(['teamcity', 'local', 'fake']).toContain(subject.provider.name);
    });

    it('classifies a green build as success and echoes the repo and build type onto the ref', async () => {
      const subject = await prepare('success');
      const ref = await obtain(subject);
      expect(ref.repo).toBe(subject.repo);
      expect(ref.buildTypeId).toBe(subject.buildTypeId);
      expect(ref.id).not.toBe('');
      const outcome = await subject.provider.waitForBuild(ref, WAIT);
      expect(outcome.status).toBe('finished');
      expect(outcome.classification).toBe('success');
      expect(outcome.failedTests).toEqual([]);
      expect(outcome.ref.id).toBe(ref.id);
    });

    it('classifies failing tests as tests_failed', async () => {
      const subject = await prepare('tests_failed');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      expect(outcome.classification).toBe('tests_failed');
      expect(outcome.status).toBe('finished');
    });

    itWhen(capabilities.reportsFailedTests, 'reportsFailedTests', 'names every failed test', async () => {
      const subject = await prepare('tests_failed');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      expect(outcome.failedTests.map((test) => test.identity).sort()).toEqual([...subject.expectedFailedTests].sort());
    });

    itWhen(capabilities.reportsNewFailure, 'reportsNewFailure', 'reports the §16.2 newFailure flag', async () => {
      const subject = await prepare('tests_failed');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      expect(outcome.failedTests.every((test) => typeof test.newFailure === 'boolean')).toBe(true);
    });

    it('classifies a broken build with no failed tests as build_failed', async () => {
      const subject = await prepare('build_failed');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      expect(outcome.classification).toBe('build_failed');
      expect(outcome.failedTests).toEqual([]);
      expect(outcome.problems.length).toBeGreaterThan(0);
    });

    itWhen(capabilities.producesInfra, 'producesInfra', 'classifies an infrastructure failure as infra', async () => {
      const subject = await prepare('infra');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      // §31.32: an infra outcome must never consume a debug attempt, which starts with never being mistaken
      // for a defect.
      expect(outcome.classification).toBe('infra');
    });

    itWhen(capabilities.reportsMissingBuild, 'reportsMissingBuild', 'answers null for a build that does not exist, then triggers one', async () => {
      const subject = await prepare('missing_build');
      expect(await subject.provider.findBuild(subject.repo, subject.revision, subject.buildTypeId)).toBeNull();
      const triggered = await subject.provider.triggerBuild({
        repo: subject.repo,
        buildTypeId: subject.buildTypeId,
        branch: subject.branch,
        revision: subject.revision,
        params: {},
      });
      expect(triggered.id).not.toBe('');
      expect(triggered.repo).toBe(subject.repo);
      expect((await subject.provider.waitForBuild(triggered, WAIT)).status).toBe('finished');
    });

    itWhen(capabilities.reportsQueue, 'reportsQueue', 'waits through the queue and still finishes', async () => {
      const subject = await prepare('queued_then_success');
      const outcome = await subject.provider.waitForBuild(await obtain(subject), WAIT);
      expect(outcome.status).toBe('finished');
      expect(outcome.classification).toBe('success');
    });

    itWhen(capabilities.reportsBuildUrl, 'reportsBuildUrl', 'puts an openable URL on the ref', async () => {
      const subject = await prepare('success');
      const ref = await obtain(subject);
      expect(ref.url).not.toBeNull();
      expect(ref.url ?? '').toMatch(/^https?:\/\//u);
    });

    it('produces a digest for a red build and respects digest.max_tests', async () => {
      const subject = await prepare('tests_failed');
      const ref = await obtain(subject);
      await subject.provider.waitForBuild(ref, WAIT);
      const digest = await subject.provider.failureDigest(ref, { ...LIMITS, maxTests: 1 }, []);
      expect(digest.ref.id).toBe(ref.id);
      expect(digest.classification).toBe('tests_failed');
      expect(digest.failedTests.length).toBeLessThanOrEqual(1);
      expect(digest.bytes).toBe(Buffer.byteLength(renderDigestMarkdown(digest), 'utf8'));
    });

    it('never lets the max_bytes ceiling be exceeded', async () => {
      const subject = await prepare('build_failed');
      const ref = await obtain(subject);
      await subject.provider.waitForBuild(ref, WAIT);
      const digest = await subject.provider.failureDigest(ref, { ...LIMITS, maxBytes: 500 }, []);
      expect(digest.bytes).toBeLessThanOrEqual(500);
      expect(Buffer.byteLength(renderDigestMarkdown(digest), 'utf8')).toBeLessThanOrEqual(500);
    });

    it('redacts credentials out of the digest (§32 rule 12)', async () => {
      const subject = await prepare('build_failed');
      if (subject.seededSecret === null) return;
      const ref = await obtain(subject);
      await subject.provider.waitForBuild(ref, WAIT);
      const digest = await subject.provider.failureDigest(ref, LIMITS, []);
      expect(renderDigestMarkdown(digest)).not.toContain(subject.seededSecret);
    });

    it('records the baseline exceptions it was given', async () => {
      const subject = await prepare('tests_failed');
      const ref = await obtain(subject);
      await subject.provider.waitForBuild(ref, WAIT);
      const identity = subject.expectedFailedTests[0];
      if (identity === undefined) throw new Error('the contract subject declared no expected failed tests');
      const digest = await subject.provider.failureDigest(ref, LIMITS, [identity]);
      expect(digest.matchedExceptions).toContain(identity);
    });

    it('gives the same failure signature for two digests of the same build', async () => {
      // §16.3's no-progress detection is only meaningful if a provider is deterministic about one build.
      const subject = await prepare('build_failed');
      const ref = await obtain(subject);
      await subject.provider.waitForBuild(ref, WAIT);
      const first = await subject.provider.failureDigest(ref, LIMITS, []);
      const second = await subject.provider.failureDigest(ref, LIMITS, []);
      expect(signatureFromDigest(first, [], null)).toBe(signatureFromDigest(second, [], null));
    });

    it('throws a not_found CiProviderError for a build id it never produced', async () => {
      const subject = await prepare('success');
      const bogus: BuildRef = {
        id: 'janus-contract-no-such-build',
        repo: subject.repo,
        buildTypeId: subject.buildTypeId,
        revision: subject.revision,
        branch: subject.branch,
        url: null,
      };
      await expect(subject.provider.failureDigest(bogus, LIMITS, [])).rejects.toBeInstanceOf(CiProviderError);
    });
  });
}
```

- [ ] **Step 5: Run the fake through the contract**

Run: `pnpm vitest run --project unit tests/providers/contract/fake-ci.test.ts`
Expected: PASS, 16 tests, none skipped (the fake claims every capability).

- [ ] **Step 6: Prove the capability gate actually gates**

Temporarily change `reportsQueue` to `false` in `tests/providers/contract/fake-ci.test.ts` and run the file again.
Expected: 15 passed, 1 skipped, with the skipped title reading `waits through the queue and still finishes [capability: reportsQueue]`.
Then revert the change and re-run: 16 passed, 0 skipped. Do not commit the temporary edit.

- [ ] **Step 7: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1089 + 16 = 1105.

- [ ] **Step 8: Commit**

```bash
git add tests/providers/contract
git commit -m "test(providers): add the reusable provider contract scaffold and the CI suite" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 7: The `local` CI provider — shell runner, build cache, command sequence

**Files:**
- Create: `src/providers/local/exec.ts`
- Create: `src/providers/local/store.ts`
- Create: `src/providers/local/provider.ts`
- Modify: `src/config/config-schema.ts:102-120` (the `local_ci` block)
- Modify: `src/workspace/layout.ts:5-53` (`localCiDir`)
- Modify: `angular-ai-development-workflow-v2.md` §5 (the workspace layout block gains `.local-ci/`)
- Modify: `tests/config/config-schema.test.ts`, `tests/workspace/layout.test.ts`
- Test: `tests/providers/local/exec.test.ts`, `tests/providers/local/store.test.ts`, `tests/providers/local/provider.test.ts`

**Interfaces:**
- Consumes: `BuildRef`, `BuildOutcome`, `BuildProblem`, `BuildStatus`, `BuildClassification`, `FailedTest`, `CiProvider`, `CiProviderError`, `TriggerBuildInput`, `WaitForBuildOptions` from `src/providers/ci/types.js`; `classifyBuild`, `RawBuildStatus` from `src/providers/ci/classify.js`; `buildFailureDigest`, `DigestLimits`, `FailureDigest` from `src/providers/ci/digest.js`; `JanusConfig` from `src/config/config-schema.js`; `WorkspacePaths` from `src/workspace/layout.js`.
- Produces:
  - `interface LocalCommandRequest { command: string; cwd: string; env: Record<string, string>; timeoutMs: number }`
  - `interface LocalCommandResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; spawnFailed: boolean; outputTruncated: boolean; durationMs: number }`
  - `type LocalCommandRunner = (request: LocalCommandRequest) => Promise<LocalCommandResult>`
  - `const LOCAL_SIGKILL_GRACE_MS = 5_000`, `const LOCAL_OUTPUT_CAP_BYTES = 4 * 1024 * 1024`
  - `runLocalCommand: LocalCommandRunner`
  - `interface LocalBuildRecord { ref: BuildRef; status: BuildStatus; classification: BuildClassification; rawStatus: string; problems: BuildProblem[]; failedTests: FailedTest[]; log: string; startedAt: string; finishedAt: string }`
  - `localBuildPath(localCiDir: string, repo: string, buildId: string): string`
  - `writeLocalBuild(localCiDir: string, record: LocalBuildRecord): void`
  - `readLocalBuild(localCiDir: string, repo: string, buildId: string): LocalBuildRecord | null`
  - `findLocalBuild(localCiDir: string, repo: string, revision: string, buildTypeId: string): LocalBuildRecord | null`
  - `countLocalBuilds(localCiDir: string, repo: string, revision: string, buildTypeId: string): number`
  - `const LOCAL_COMMAND_ORDER = ['install', 'lint', 'build', 'test'] as const`, `type LocalCommandName`
  - `interface LocalCiProviderInput { config: JanusConfig; paths: WorkspacePaths; now(): Date; run?: LocalCommandRunner; env?: Record<string, string> }`
  - `createLocalCiProvider(input: LocalCiProviderInput): CiProvider`
  - `WorkspacePaths.localCiDir: string`
  - `config.local_ci.timeout_minutes`, `config.local_ci.repos.<name>.junit`, `config.local_ci.repos.<name>.junit_suite_prefix_depth`

**Why:** §3.2 — "The `local` CI provider runs configured shell commands (install, build, test, e2e) in the repository checkout and produces the same `BuildOutcome` and `FailureDigest` shapes as TeamCity." It is what makes the T22 dogfood run possible without the work network, and the second provider the contract suite proves itself against. This task builds everything except the test-result parsing, which is Task 8 — the split is where a reviewer could reject one and keep the other.

**On the subprocess runner (D8).** Verified on this machine: `/bin/sh` is `dash`; `spawn('sh', ['-c', 'sleep 30'])` does not exec the command; and `child.kill('SIGTERM')` — which is exactly what `spawnCodex`, and therefore `src/doctor/exec.ts`'s `runCommand`, does — kills the shell and leaves the command running, reparented to init. On a 90-minute default build timeout that means a timed-out `pnpm build` keeps writing into the repository checkout while the orchestrator moves on to `resetHard` it. `runLocalCommand` therefore spawns `detached: true` and signals the whole process group with `process.kill(-child.pid, signal)`, which was verified to leave no orphan. Everything else `runCommand` got right is kept: never reject, SIGTERM then SIGKILL after a grace, output caps that keep the tail, a `spawnFailed` flag.

- [ ] **Step 1: Write the failing exec tests**

Create `tests/providers/local/exec.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_OUTPUT_CAP_BYTES, runLocalCommand } from '../../../src/providers/local/exec.js';
import { tempDir } from '../../helpers/git-fixtures.js';

const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

describe('runLocalCommand', () => {
  it('captures stdout, stderr and a zero exit code', async () => {
    const result = await runLocalCommand({ command: 'echo out; echo err 1>&2', cwd: tempDir('janus-exec-'), env: ENV, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('treats a non-zero exit as a result, not an exception', async () => {
    const result = await runLocalCommand({ command: 'exit 3', cwd: tempDir('janus-exec-'), env: ENV, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('treats an unknown command as exit 127, the way a shell reports it', async () => {
    const result = await runLocalCommand({
      command: 'janus-no-such-binary-9a7f',
      cwd: tempDir('janus-exec-'),
      env: ENV,
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('janus-no-such-binary-9a7f');
  });

  it('runs in the requested directory with only the requested environment', async () => {
    const dir = tempDir('janus-exec-');
    const result = await runLocalCommand({ command: 'pwd; echo "[$JANUS_PROBE]"', cwd: dir, env: { ...ENV, JANUS_PROBE: 'set' }, timeoutMs: 10_000 });
    expect(result.stdout).toContain(dir);
    expect(result.stdout).toContain('[set]');
  });

  it('kills the whole process group at the timeout, leaving no orphan behind', async () => {
    // D8. This is the test the doctor runner would fail: `child.kill()` signals the dash shell only, and the
    // `sleep` survives to touch the marker after the orchestrator has moved on.
    const dir = tempDir('janus-exec-');
    const marker = join(dir, 'orphan-marker');
    const result = await runLocalCommand({
      command: `sleep 2 && touch "${marker}"`,
      cwd: dir,
      env: ENV,
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(1500);
    await new Promise<void>((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);

  it('caps its output and says so, keeping the tail', async () => {
    const result = await runLocalCommand({
      command: `node -e "for (let i = 0; i < 20000; i += 1) console.log('x'.repeat(500) + ' line ' + i)"`,
      cwd: tempDir('janus-exec-'),
      env: ENV,
      timeoutMs: 30_000,
      outputCapBytes: 4096,
    });
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(4096);
    expect(result.stdout).toContain('line 19999');
  }, 30_000);
});
```

Note the last case passes `outputCapBytes`, so `LocalCommandRequest` carries an optional override exactly the way `CodexSpawnRequest.jsonlCapBytes` does — a truncation test must not have to write four megabytes. Add `outputCapBytes?: number` to the request type, and keep `LOCAL_OUTPUT_CAP_BYTES` as its default. Import it in the test to assert the default is what the production path uses:

```ts
it('defaults to the four-megabyte output cap', () => {
  expect(LOCAL_OUTPUT_CAP_BYTES).toBe(4 * 1024 * 1024);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/local/exec.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/providers/local/exec.js"`.

- [ ] **Step 3: Implement the runner**

Create `src/providers/local/exec.ts`:

```ts
import { spawn } from 'node:child_process';

/**
 * The `local` CI provider's subprocess runner.
 *
 * Deliberately **not** `src/doctor/exec.ts`'s `runCommand`, which is a thin rename over `spawnCodex`. Verified on
 * a development machine: `/bin/sh` is `dash`, `spawn('sh', ['-c', cmd])` does not exec `cmd`, and `child.kill()`
 * — what `spawnCodex` does at its timeout — kills the shell and leaves `cmd` running, reparented to init. For
 * `codex exec` that is harmless; for a `pnpm build` on a 90-minute timeout it means a build still writing into a
 * repository checkout that the orchestrator is about to `git reset --hard`.
 *
 * So this one spawns `detached: true` — which puts the shell and everything it forks into a new process group —
 * and signals `-pid`, killing the group. Everything else is the same contract `runCommand` established and is
 * already relied on across this codebase: never reject (a missing command, a non-zero exit and a timeout are all
 * outcomes), SIGTERM first and SIGKILL after a grace, and output capped keeping the **tail**, because the end of
 * a build log is where it says why it failed.
 */

/** How long a timed-out process group gets on SIGTERM before it is SIGKILLed. */
export const LOCAL_SIGKILL_GRACE_MS = 5_000;

/** Ceiling on buffered stdout and on buffered stderr, each. A full `ng build` log fits comfortably. */
export const LOCAL_OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

export interface LocalCommandRequest {
  /** A `local_ci` command line, run through `sh -c`. */
  command: string;
  cwd: string;
  /** The complete environment for the child; nothing is inherited implicitly. */
  env: Record<string, string>;
  timeoutMs: number;
  /** Overrides {@link LOCAL_OUTPUT_CAP_BYTES}. Only ever set by the truncation test. */
  outputCapBytes?: number;
  /** Overrides {@link LOCAL_SIGKILL_GRACE_MS}. Only ever set by a test that needs a short grace. */
  sigkillGraceMs?: number;
}

export interface LocalCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when `sh` itself could not be started. A command `sh` cannot find is exit 127, not this. */
  spawnFailed: boolean;
  /** True when either stream hit its cap and so is missing its earliest output. */
  outputTruncated: boolean;
  durationMs: number;
}

/** The seam every `local` provider test replaces. Production is {@link runLocalCommand}. */
export type LocalCommandRunner = (request: LocalCommandRequest) => Promise<LocalCommandResult>;

function appendCapped(current: string, chunk: string, capBytes: number): { text: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= capBytes) return { text: combined, truncated: false };
  return { text: combined.slice(combined.length - capBytes), truncated: true };
}

export const runLocalCommand: LocalCommandRunner = (request) =>
  new Promise<LocalCommandResult>((resolve) => {
    const started = Date.now();
    const cap = request.outputCapBytes ?? LOCAL_OUTPUT_CAP_BYTES;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const child = spawn('sh', ['-c', request.command], {
      cwd: request.cwd,
      env: request.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The whole point: a new process group, so the timeout can take the build down with the shell.
      detached: true,
    });

    /** Signals the group, falling back to the child alone when the group is already gone. */
    const killGroup = (signal: NodeJS.Signals): void => {
      const { pid } = child;
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // Already dead. Nothing to do, and certainly nothing to throw about.
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
      }, request.sigkillGraceMs ?? LOCAL_SIGKILL_GRACE_MS);
    }, request.timeoutMs);

    const finish = (exitCode: number | null, signal: string | null, spawnFailed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, spawnFailed, outputTruncated: truncated, durationMs: Date.now() - started });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendCapped(stdout, chunk.toString('utf8'), cap);
      stdout = next.text;
      truncated = truncated || next.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendCapped(stderr, chunk.toString('utf8'), cap);
      stderr = next.text;
      truncated = truncated || next.truncated;
    });
    child.on('error', (error: Error) => {
      const next = appendCapped(stderr, error.message, cap);
      stderr = next.text;
      truncated = truncated || next.truncated;
      finish(null, null, true);
    });
    child.on('close', (code, signal) => {
      finish(code, signal, false);
    });
  });
```

- [ ] **Step 4: Run the exec tests to verify they pass**

Run: `pnpm vitest run --project unit tests/providers/local/exec.test.ts`
Expected: PASS, 7 tests. The orphan case takes about 2.7 seconds; the truncation case about 3.

- [ ] **Step 5: Add the three `local_ci` config fields and `localCiDir`**

In `src/config/config-schema.ts`, replace the `local_ci` block (lines 102-120) with:

```ts
    local_ci: z
      .object({
        /** Ceiling on each configured command. One ceiling, not one per command: §28's block is deliberately small. */
        timeout_minutes: positiveInt.default(30),
        repos: z
          .record(
            z.string(),
            z
              .object({
                install: z.string().min(1).optional(),
                build: z.string().min(1).optional(),
                test: z.string().min(1).optional(),
                lint: z.string().min(1).optional(),
                /**
                 * Repo-relative glob for JUnit XML written by the test command, e.g. `reports/junit/**\/*.xml`.
                 * A glob rather than a path because karma-junit-reporter writes into a directory named after
                 * the browser (`junit/Chrome_Headless_153_0_0_0_(Linux_0_0_0)/results.xml`). Absent means the
                 * provider falls back to parsing the Karma or Jest summary line, which yields counts but no
                 * per-test identities.
                 */
                junit: z.string().min(1).optional(),
                /**
                 * Leading dot-separated segments to drop from a JUnit `classname` before it becomes part of a
                 * test identity. Karma puts the **browser name and version** there
                 * (`Chrome_Headless_153_0_0_0_(Linux_0_0_0).AppComponent`), so leaving this at 0 for a Karma
                 * repo makes every test identity — and therefore every §16.3 failure signature — change when
                 * Chrome updates. Set it to 1 for Karma; leave it at 0 for vitest and jest-junit.
                 */
                junit_suite_prefix_depth: nonNegativeInt.default(0),
              })
              .strict(),
          )
          .default({}),
        e2e: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
```

In `src/workspace/layout.ts`, add `localCiDir` to the interface, to `workspacePaths`, to `createWorkspaceDirs`'s list, and to `removeWorkspaceArtifacts`'s list:

```ts
export interface WorkspacePaths {
  root: string;
  janusDir: string;
  reposDir: string;
  fakeDir: string;
  /**
   * `<workspace>/.local-ci/` — the `local` CI provider's build-record cache (§16.1 needs `findBuild` to be able
   * to answer "this revision already has a build", and `janus ci digest --build` runs in a different process
   * from the trigger that produced it). Not `fake/`, because §5 reserves that for fake providers, and not
   * `.janus/evidence/`, because a provider writes no evidence (§3.2's adapter contract). It is a cache: deleting
   * it costs a rebuild and nothing else.
   */
  localCiDir: string;
  pnpmStoreDir: string;
  lockFile: string;
  repoDir(name: string): string;
}
```

with `localCiDir: join(absolute, '.local-ci')` in `workspacePaths`, and `.localCiDir` added to both `for (const dir of [...])` lists.

Extend `tests/workspace/layout.test.ts` with:

```ts
  it('puts the local CI build cache beside fake/, not inside .janus', () => {
    const paths = workspacePaths('/tmp/ws');
    expect(paths.localCiDir).toBe('/tmp/ws/.local-ci');
  });
```

and extend the existing `createWorkspaceDirs` / `removeWorkspaceArtifacts` cases in that file to assert `.local-ci` is created and removed alongside `fake`.

Extend `tests/config/config-schema.test.ts` with:

```ts
  it('defaults the local_ci timeout and the junit prefix depth', () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'local', scm_provider: 'fake' },
      local_ci: { repos: { 'ui-kit': { test: 'pnpm test' } } },
    });
    expect(config.local_ci.timeout_minutes).toBe(30);
    expect(config.local_ci.repos['ui-kit']?.junit_suite_prefix_depth).toBe(0);
    expect(config.local_ci.repos['ui-kit']?.junit).toBeUndefined();
  });

  it('accepts a junit glob and a non-zero prefix depth for a Karma repo', () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'local', scm_provider: 'fake' },
      local_ci: { repos: { shell: { test: 'ng test', junit: 'reports/junit/**/*.xml', junit_suite_prefix_depth: 1 } } },
    });
    expect(config.local_ci.repos['shell']?.junit).toBe('reports/junit/**/*.xml');
    expect(config.local_ci.repos['shell']?.junit_suite_prefix_depth).toBe(1);
  });
```

- [ ] **Step 6: Record `.local-ci/` in the §5 workspace layout, and commit the spec edit**

`<workspace>/.local-ci/` is a **deviation from §5**, whose layout block lists exactly `.janus/`, `repos/`,
`fake/`, `.pnpm-store/` and `janus.lock`. D7 argues the directory is right — a real provider's cache belongs
neither in `fake/` (§5 reserves it for fake providers) nor under `.janus/evidence/` (a provider writes no
evidence) — but this repository's precedent is to make the spec edit rather than let the code and the spec
disagree: T03 edited §6, §26 and §27 and recorded it in its status row.

In `angular-ai-development-workflow-v2.md` §5, add one line to the workspace layout block, between `fake/` and
`.pnpm-store/`:

```text
<workspace>/
  .janus/                 # single-branch clone of the state branch janus/<goal-id>
  repos/
    ui-kit/               # clone, on ai/<goal-id> once created
    shell/
    orders-remote/
  fake/                   # persisted fake provider state (only with fake providers)
  .local-ci/              # local CI provider build cache (only with the local provider)
  .pnpm-store/            # optional workspace-local pnpm store (§18.4)
  janus.lock              # run lock with PID and timestamp
```

Run: `git diff --stat`
Expected: `angular-ai-development-workflow-v2.md` only, one line added.

```bash
git add angular-ai-development-workflow-v2.md
git commit -m "docs(spec): record the local CI build cache directory in the §5 layout" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

- [ ] **Step 7: Write the failing build-cache tests**

Create `tests/providers/local/store.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countLocalBuilds, findLocalBuild, localBuildPath, readLocalBuild, writeLocalBuild } from '../../../src/providers/local/store.js';
import type { LocalBuildRecord } from '../../../src/providers/local/store.js';
import { tempDir } from '../../helpers/git-fixtures.js';

const REV = 'a'.repeat(40);

function record(id: string, revision = REV, finishedAt = '2026-09-21T10:00:00.000Z'): LocalBuildRecord {
  return {
    ref: { id, repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', revision, branch: 'ai/g', url: null },
    status: 'finished',
    classification: 'success',
    rawStatus: 'exit 0',
    problems: [],
    failedTests: [],
    log: 'done',
    startedAt: '2026-09-21T09:00:00.000Z',
    finishedAt,
  };
}

describe('the local build cache', () => {
  it('round-trips a record through .local-ci/<repo>/<build-id>.json', () => {
    const dir = join(tempDir('janus-local-store-'), '.local-ci');
    writeLocalBuild(dir, record('local-1'));
    expect(existsSync(localBuildPath(dir, 'ui-kit', 'local-1'))).toBe(true);
    expect(readLocalBuild(dir, 'ui-kit', 'local-1')?.classification).toBe('success');
  });

  it('answers null for an unknown build rather than throwing', () => {
    const dir = join(tempDir('janus-local-store-'), '.local-ci');
    expect(readLocalBuild(dir, 'ui-kit', 'nope')).toBeNull();
    expect(findLocalBuild(dir, 'ui-kit', REV, 'Fe_UiKit_Build')).toBeNull();
    expect(countLocalBuilds(dir, 'ui-kit', REV, 'Fe_UiKit_Build')).toBe(0);
  });

  it('finds the most recent build for a revision and build type', () => {
    const dir = join(tempDir('janus-local-store-'), '.local-ci');
    writeLocalBuild(dir, record('local-1', REV, '2026-09-21T10:00:00.000Z'));
    writeLocalBuild(dir, record('local-2', REV, '2026-09-21T12:00:00.000Z'));
    writeLocalBuild(dir, record('local-3', 'b'.repeat(40), '2026-09-21T13:00:00.000Z'));
    expect(findLocalBuild(dir, 'ui-kit', REV, 'Fe_UiKit_Build')?.ref.id).toBe('local-2');
    expect(countLocalBuilds(dir, 'ui-kit', REV, 'Fe_UiKit_Build')).toBe(2);
  });

  it('ignores a corrupt record instead of failing the run', () => {
    const dir = join(tempDir('janus-local-store-'), '.local-ci');
    writeLocalBuild(dir, record('local-1'));
    // A half-written file from a killed process must not take the next run down with it.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(localBuildPath(dir, 'ui-kit', 'local-1'), '{ not json');
    expect(readLocalBuild(dir, 'ui-kit', 'local-1')).toBeNull();
    expect(findLocalBuild(dir, 'ui-kit', REV, 'Fe_UiKit_Build')).toBeNull();
  });
});
```

- [ ] **Step 8: Implement the build cache**

Create `src/providers/local/store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildClassification, BuildProblem, BuildRef, BuildStatus, FailedTest } from '../ci/types.js';

/**
 * The `local` provider's build-record cache, one JSON file per build at `<workspace>/.local-ci/<repo>/<id>.json`.
 *
 * It exists because three things collide: §16.1 wants `findBuild` to be able to say "this revision already has a
 * build"; a provider writes no evidence, so `.janus/evidence/builds/` is not available to it (that is T12's
 * file); and `janus ci digest --build <id>` runs in a *different process* from the `janus ci trigger` that
 * produced the build, so an in-memory map cannot serve it.
 *
 * Fields are camelCase, unlike `fake/*.json`: those are hand-edited dogfooding files and follow the repo's
 * snake_case file convention, while this one is a machine cache nobody is expected to open. Deleting it costs a
 * rebuild and nothing else, which is why a corrupt record is skipped rather than raised.
 */
export interface LocalBuildRecord {
  ref: BuildRef;
  status: BuildStatus;
  classification: BuildClassification;
  rawStatus: string;
  problems: BuildProblem[];
  failedTests: FailedTest[];
  log: string;
  startedAt: string;
  finishedAt: string;
}

export function localBuildPath(localCiDir: string, repo: string, buildId: string): string {
  return join(localCiDir, repo, `${buildId}.json`);
}

/** Writes through a temp file and renames, so an interrupted run never leaves half a record behind. */
export function writeLocalBuild(localCiDir: string, record: LocalBuildRecord): void {
  const path = localBuildPath(localCiDir, record.ref.repo, record.ref.id);
  mkdirSync(join(localCiDir, record.ref.repo), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, path);
}

export function readLocalBuild(localCiDir: string, repo: string, buildId: string): LocalBuildRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(localBuildPath(localCiDir, repo, buildId), 'utf8')) as Partial<LocalBuildRecord>;
    if (parsed.ref === undefined || parsed.classification === undefined) return null;
    return parsed as LocalBuildRecord;
  } catch {
    return null;
  }
}

function allRecords(localCiDir: string, repo: string): LocalBuildRecord[] {
  const dir = join(localCiDir, repo);
  if (!existsSync(dir)) return [];
  const records: LocalBuildRecord[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    const record = readLocalBuild(localCiDir, repo, entry.slice(0, -'.json'.length));
    if (record !== null) records.push(record);
  }
  return records;
}

function matching(localCiDir: string, repo: string, revision: string, buildTypeId: string): LocalBuildRecord[] {
  return allRecords(localCiDir, repo).filter((record) => record.ref.revision === revision && record.ref.buildTypeId === buildTypeId);
}

/** The most recently finished build for this revision and build type, or null. Ties break on build id, for determinism. */
export function findLocalBuild(localCiDir: string, repo: string, revision: string, buildTypeId: string): LocalBuildRecord | null {
  const candidates = matching(localCiDir, repo, revision, buildTypeId).sort((left, right) => {
    const byTime = left.finishedAt.localeCompare(right.finishedAt);
    return byTime === 0 ? left.ref.id.localeCompare(right.ref.id) : byTime;
  });
  return candidates[candidates.length - 1] ?? null;
}

/** How many builds already exist for this revision and build type; the `local` build id counter. */
export function countLocalBuilds(localCiDir: string, repo: string, revision: string, buildTypeId: string): number {
  return matching(localCiDir, repo, revision, buildTypeId).length;
}
```

- [ ] **Step 9: Run the cache tests**

Run: `pnpm vitest run --project unit tests/providers/local/store.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 10: Write the failing provider tests**

Create `tests/providers/local/provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../../src/config/config-schema.js';
import type { JanusConfig } from '../../../src/config/config-schema.js';
import { CiProviderError } from '../../../src/providers/ci/types.js';
import type { DigestLimits } from '../../../src/providers/ci/digest.js';
import { createLocalCiProvider, LOCAL_COMMAND_ORDER } from '../../../src/providers/local/provider.js';
import type { LocalCommandRequest, LocalCommandResult } from '../../../src/providers/local/exec.js';
import { workspacePaths } from '../../../src/workspace/layout.js';
import { tempDir } from '../../helpers/git-fixtures.js';

const REV = 'a'.repeat(40);
const LIMITS: DigestLimits = { maxTests: 50, maxTestDetailLines: 20, logTailLines: 400, maxErrorWindows: 10, maxBytes: 65_536, redact: true };
const WAIT = { timeoutMs: 1000, pollIntervalMs: 10 };

function config(repos: Record<string, Record<string, string>>): JanusConfig {
  return configSchema.parse({ workflow: { ci_provider: 'local', scm_provider: 'fake' }, local_ci: { repos } });
}

interface ScriptedRun {
  requests: LocalCommandRequest[];
  run: (request: LocalCommandRequest) => Promise<LocalCommandResult>;
}

function scripted(answers: Record<string, Partial<LocalCommandResult>>): ScriptedRun {
  const requests: LocalCommandRequest[] = [];
  return {
    requests,
    run: async (request) => {
      requests.push(request);
      const answer = answers[request.command] ?? {};
      return {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        spawnFailed: false,
        outputTruncated: false,
        durationMs: 1,
        ...answer,
      };
    },
  };
}

function providerFor(repos: Record<string, Record<string, string>>, script: ScriptedRun) {
  const paths = workspacePaths(tempDir('janus-local-'));
  return {
    paths,
    provider: createLocalCiProvider({
      config: config(repos),
      paths,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
      run: script.run,
      env: { PATH: '/usr/bin:/bin' },
    }),
  };
}

describe('createLocalCiProvider', () => {
  it('runs install, lint, build and test in that order, in the repository checkout', async () => {
    const script = scripted({});
    const { paths, provider } = providerFor(
      { 'ui-kit': { install: 'pnpm install', lint: 'pnpm lint', build: 'pnpm build', test: 'pnpm test' } },
      script,
    );
    await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect(script.requests.map((request) => request.command)).toEqual(['pnpm install', 'pnpm lint', 'pnpm build', 'pnpm test']);
    expect(script.requests.every((request) => request.cwd === paths.repoDir('ui-kit'))).toBe(true);
    expect(LOCAL_COMMAND_ORDER).toEqual(['install', 'lint', 'build', 'test']);
  });

  it('skips a command the repo does not configure', async () => {
    const script = scripted({});
    const { provider } = providerFor({ 'ui-kit': { build: 'pnpm build' } }, script);
    await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect(script.requests.map((request) => request.command)).toEqual(['pnpm build']);
  });

  it('stops at the first failing command and classifies it build_failed', async () => {
    const script = scripted({ 'pnpm build': { exitCode: 1, stdout: 'src/a.ts:1:1 - error TS2551: nope' } });
    const { provider } = providerFor({ 'ui-kit': { build: 'pnpm build', test: 'pnpm test' } }, script);
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect(script.requests.map((request) => request.command)).toEqual(['pnpm build']);
    const outcome = await provider.waitForBuild(ref, WAIT);
    expect(outcome.classification).toBe('build_failed');
    expect(outcome.rawStatus).toBe('exit 1');
    expect(outcome.problems.map((problem) => problem.identity)).toEqual(['command_failed:build']);
  });

  it('classifies a green run as success and caches it so findBuild answers next time', async () => {
    const script = scripted({});
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    expect(await provider.findBuild('ui-kit', REV, 'Fe_UiKit_Build')).toBeNull();
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect((await provider.waitForBuild(ref, WAIT)).classification).toBe('success');
    const found = await provider.findBuild('ui-kit', REV, 'Fe_UiKit_Build');
    expect(found?.id).toBe(ref.id);
    // Finding a cached build must not re-run anything.
    expect(script.requests).toHaveLength(1);
  });

  it('maps a timeout to infra, never to a defect', async () => {
    const script = scripted({ 'pnpm test': { exitCode: null, signal: 'SIGTERM', timedOut: true } });
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    const outcome = await provider.waitForBuild(ref, WAIT);
    // §31.32: an infrastructure failure never consumes a debug attempt.
    expect(outcome.classification).toBe('infra');
    expect(outcome.rawStatus).toBe('timeout');
  });

  it('maps a shell that would not start to infra', async () => {
    const script = scripted({ 'pnpm test': { exitCode: null, spawnFailed: true, stderr: 'spawn sh ENOENT' } });
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect((await provider.waitForBuild(ref, WAIT)).classification).toBe('infra');
  });

  it('hands every command the configured timeout and the workspace pnpm store', async () => {
    const script = scripted({});
    const { paths, provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    expect(script.requests[0]?.timeoutMs).toBe(30 * 60_000);
    expect(script.requests[0]?.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);
    expect(script.requests[0]?.env['CI']).toBe('true');
  });

  it('refuses a repo with no local_ci entry with a config CiProviderError', async () => {
    const script = scripted({});
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    await expect(
      provider.triggerBuild({ repo: 'shell', buildTypeId: 'Fe_Shell_Build', branch: 'ai/g', revision: REV, params: {} }),
    ).rejects.toMatchObject({ kind: 'config' });
  });

  it('refuses a repo whose local_ci entry configures no command at all', async () => {
    const script = scripted({});
    const { provider } = providerFor({ 'ui-kit': {} }, script);
    await expect(
      provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} }),
    ).rejects.toBeInstanceOf(CiProviderError);
  });

  it('builds a digest from the captured command output', async () => {
    const script = scripted({
      'pnpm build': { exitCode: 1, stdout: ['compiling', 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'src/a.ts:1:1 - error TS2551: nope'].join('\n') },
    });
    const { provider } = providerFor({ 'ui-kit': { build: 'pnpm build' } }, script);
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    await provider.waitForBuild(ref, WAIT);
    const digest = await provider.failureDigest(ref, LIMITS, []);
    expect(digest.errorWindows.some((window) => window.errorLine.includes('TS2551'))).toBe(true);
    expect(digest.logTail.join('\n')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(digest.logTail.join('\n')).toContain('$ pnpm build');
  });

  it('throws not_found for a build id that is not in the cache', async () => {
    const script = scripted({});
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    const bogus = { id: 'nope', repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', revision: REV, branch: null, url: null };
    await expect(provider.failureDigest(bogus, LIMITS, [])).rejects.toMatchObject({ kind: 'not_found' });
  });
});
```

- [ ] **Step 11: Implement the provider**

Create `src/providers/local/provider.ts`:

```ts
import type { JanusConfig } from '../../config/config-schema.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import { classifyBuild } from '../ci/classify.js';
import type { RawBuildStatus } from '../ci/classify.js';
import { buildFailureDigest } from '../ci/digest.js';
import type { DigestLimits, FailureDigest } from '../ci/digest.js';
import { CiProviderError } from '../ci/types.js';
import type { BuildOutcome, BuildProblem, BuildRef, CiProvider, FailedTest, TriggerBuildInput, WaitForBuildOptions } from '../ci/types.js';
import { runLocalCommand } from './exec.js';
import type { LocalCommandResult, LocalCommandRunner } from './exec.js';
import { countLocalBuilds, findLocalBuild, readLocalBuild, writeLocalBuild } from './store.js';
import type { LocalBuildRecord } from './store.js';

/**
 * Spec §3.2's `local` CI provider: "runs configured shell commands (install, build, test, e2e) in the repository
 * checkout and produces the same `BuildOutcome` and `FailureDigest` shapes as TeamCity."
 *
 * Two deliberate simplifications, both scoped by this plan:
 *
 * 1. **Every build type id runs the same repo command sequence.** `local_ci.e2e` stays unread here: routing
 *    `goal.e2e.build_type_id` to it needs the `Goal` inside `createProviders`, which neither of its callers
 *    passes today, for a stage (§17) that depends on T15. The requested build type id is recorded on the
 *    `BuildRef`, so nothing is lost when T17 adds the routing.
 * 2. **A local build is synchronous.** `triggerBuild` runs the commands to completion and caches the record;
 *    `waitForBuild` reads the cache. There is no queue, which is why the `local` contract entry declares
 *    `reportsQueue: false`.
 *
 * It never runs git (§32 rule 11) — only the commands `local_ci` names — and it writes nothing under `.janus/`.
 */

/** The order §3.2 names, with `lint` inserted where §28's `local_ci` block already allows it. */
export const LOCAL_COMMAND_ORDER = ['install', 'lint', 'build', 'test'] as const;

export type LocalCommandName = (typeof LOCAL_COMMAND_ORDER)[number];

export interface LocalCiProviderInput {
  config: JanusConfig;
  paths: WorkspacePaths;
  now(): Date;
  /** Replaced in every unit test, so no test in this repository shells out to a real build. */
  run?: LocalCommandRunner;
  /** The base environment handed to every command. Defaults to this process's, minus every `undefined`. */
  env?: Record<string, string>;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function rawStatusFor(result: LocalCommandResult | null): { raw: RawBuildStatus; text: string } {
  if (result === null) return { raw: 'success', text: 'exit 0' };
  if (result.timedOut) return { raw: 'timeout', text: 'timeout' };
  if (result.spawnFailed) return { raw: 'failed_to_start', text: 'failed to start' };
  if (result.exitCode === 0) return { raw: 'success', text: 'exit 0' };
  return { raw: 'failure', text: `exit ${result.exitCode === null ? (result.signal ?? 'signal') : String(result.exitCode)}` };
}

/** The `local` build id: stable for a revision and build type, with a counter so a re-trigger gets its own record. */
function localBuildId(localCiDir: string, repo: string, revision: string, buildTypeId: string): string {
  const attempt = countLocalBuilds(localCiDir, repo, revision, buildTypeId) + 1;
  return `local-${repo}-${revision.slice(0, 12)}-${String(attempt)}`;
}

function outcomeOf(record: LocalBuildRecord): BuildOutcome {
  return {
    ref: record.ref,
    status: record.status,
    classification: record.classification,
    rawStatus: record.rawStatus,
    problems: record.problems,
    failedTests: record.failedTests,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

export function createLocalCiProvider(input: LocalCiProviderInput): CiProvider {
  const run = input.run ?? runLocalCommand;
  const baseEnv = input.env ?? processEnv();
  const { paths, config } = input;
  const timeoutMs = config.local_ci.timeout_minutes * 60_000;

  const commandsFor = (repo: string): { name: LocalCommandName; command: string }[] => {
    const entry = config.local_ci.repos[repo];
    if (entry === undefined) {
      throw new CiProviderError('local', 'config', `no local_ci.repos.${repo} entry in .janus/config.yaml`);
    }
    const commands: { name: LocalCommandName; command: string }[] = [];
    for (const name of LOCAL_COMMAND_ORDER) {
      const command = entry[name];
      if (command !== undefined) commands.push({ name, command });
    }
    if (commands.length === 0) {
      throw new CiProviderError(
        'local',
        'config',
        `local_ci.repos.${repo} configures no command; set at least one of ${LOCAL_COMMAND_ORDER.join(', ')}`,
      );
    }
    return commands;
  };

  const lookup = (repo: string, buildId: string): LocalBuildRecord => {
    const record = readLocalBuild(paths.localCiDir, repo, buildId);
    if (record === null) {
      throw new CiProviderError('local', 'not_found', `no build ${buildId} for ${repo} in ${paths.localCiDir}`);
    }
    return record;
  };

  return {
    name: 'local',

    findBuild: async (repo, revision, buildTypeId) => {
      const record = findLocalBuild(paths.localCiDir, repo, revision, buildTypeId);
      return record === null ? null : record.ref;
    },

    triggerBuild: async (trigger: TriggerBuildInput) => {
      const commands = commandsFor(trigger.repo);
      const startedAt = input.now().toISOString();
      const id = localBuildId(paths.localCiDir, trigger.repo, trigger.revision, trigger.buildTypeId);
      const ref: BuildRef = {
        id,
        repo: trigger.repo,
        buildTypeId: trigger.buildTypeId,
        revision: trigger.revision,
        branch: trigger.branch,
        url: null,
      };
      const env: Record<string, string> = {
        ...baseEnv,
        // §5 and §18.4: the workspace-local pnpm store, handed over the way T02 established.
        npm_config_store_dir: paths.pnpmStoreDir,
        CI: 'true',
        // Fewer ANSI escapes in the captured log means fewer of them in the digest and in the §16.3 signature.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        ...trigger.params,
      };
      const cwd = paths.repoDir(trigger.repo);
      const log: string[] = [];
      let failed: { name: LocalCommandName; result: LocalCommandResult } | null = null;
      for (const { name, command } of commands) {
        log.push(`$ ${command}`);
        const result = await run({ command, cwd, env, timeoutMs });
        if (result.stdout !== '') log.push(result.stdout.replace(/\n$/u, ''));
        if (result.stderr !== '') log.push(result.stderr.replace(/\n$/u, ''));
        if (result.exitCode !== 0 || result.timedOut || result.spawnFailed) {
          failed = { name, result };
          break;
        }
      }
      const { raw, text } = rawStatusFor(failed === null ? null : failed.result);
      // Task 8 replaces this empty list with parsed JUnit / summary results.
      const failedTests: FailedTest[] = [];
      const problems: BuildProblem[] =
        failed !== null && failedTests.length === 0
          ? [
              {
                // No exit code in the identity: §16.3 hashes it, and a command that exits 1 on one run and 2 on
                // the next is the same failure. The code lives in `details`, where it is informative but inert.
                identity: `command_failed:${failed.name}`,
                type: 'command_failed',
                details: `${failed.name} command failed (${text})`,
              },
            ]
          : [];
      const record: LocalBuildRecord = {
        ref,
        status: 'finished',
        classification: classifyBuild({ rawStatus: raw, failedTests: failedTests.length, problems: problems.length }),
        rawStatus: text,
        problems,
        failedTests,
        log: log.join('\n'),
        startedAt,
        finishedAt: input.now().toISOString(),
      };
      writeLocalBuild(paths.localCiDir, record);
      return ref;
    },

    waitForBuild: async (ref: BuildRef, _options: WaitForBuildOptions) => outcomeOf(lookup(ref.repo, ref.id)),

    failureDigest: async (ref: BuildRef, limits: DigestLimits, exceptions: readonly string[]): Promise<FailureDigest> => {
      const record = lookup(ref.repo, ref.id);
      return buildFailureDigest(
        {
          ref: record.ref,
          classification: record.classification,
          problems: record.problems,
          failedTests: record.failedTests,
          log: record.log,
          links: [],
          exceptions,
        },
        limits,
      );
    },
  };
}
```

- [ ] **Step 12: Run the provider tests**

Run: `pnpm vitest run --project unit tests/providers/local/provider.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 13: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1105 + 7 + 4 + 11 + 2 (config) + 1 (layout) = 1130.

- [ ] **Step 14: Commit**

```bash
git add src/providers/local src/config/config-schema.ts src/workspace/layout.ts tests/providers/local tests/config tests/workspace
git commit -m "feat(providers): add the local CI provider, its process-group runner and its build cache" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 8: JUnit and Karma/Jest parsing, and the `local` provider in the contract suite

**Files:**
- Create: `src/glob/match.ts` (moved from `src/policy/glob.ts`), `src/glob/index.ts`
- Delete: `src/policy/glob.ts`
- Modify: `src/policy/index.ts:12`, `src/policy/checks/lockfile.ts:1`, `src/policy/checks/scope.ts:2`
- Move: `tests/policy/glob.test.ts` → `tests/glob/match.test.ts`
- Create: `src/providers/local/junit.ts`, `src/providers/local/summary.ts`
- Modify: `src/providers/local/provider.ts` (the `failedTests` list the previous task left empty)
- Create: `tests/providers/local/junit.test.ts`, `tests/providers/local/summary.test.ts`
- Create: `tests/providers/contract/local-ci.test.ts`

**Interfaces:**
- Consumes: `matchesGlob` from `src/glob/index.js`; `FailedTest` from `src/providers/ci/types.js`; `LocalCommandRunner` and `createLocalCiProvider` from Task 7.
- Produces:
  - `matchesGlob(pattern: string, path: string): boolean`, `matchesAnyGlob(patterns: readonly string[], path: string): boolean` — moved, unchanged
  - `interface JUnitCase { identity: string; name: string; suite: string | null; failed: boolean; details: string }`
  - `interface ParseJUnitOptions { suitePrefixDepth: number }`
  - `parseJUnitXml(xml: string, options: ParseJUnitOptions): JUnitCase[]`
  - `junitIdentity(suite: string, name: string): string`
  - `collectJUnitFiles(repoDir: string, glob: string): string[]`
  - `interface TestSummary { failed: number; passed: number; total: number; failedNames: string[] }`
  - `stripAnsi(text: string): string`
  - `parseKarmaSummary(log: string): TestSummary | null`
  - `parseJestSummary(log: string): TestSummary | null`
  - `parseTestSummary(log: string): TestSummary | null`
  - `LOCAL_CI_CAPABILITIES: CiCapabilities`

**Why:** `tasks.md` T09: "`local` provider: configured commands per repo, JUnit or Karma/Jest summary parsing for failed test identities". Identities are what §16.2 lists, what §16.3 hashes and what §11's baseline exceptions match, so getting them wrong is not cosmetic. The formats in this task were captured from **real runs on this machine** (see the facts table) rather than recalled, because all three reporters disagree about where the suite name lives.

**On the glob move (D20).** `collectJUnitFiles` needs the `**`/`*`/`?` dialect that already exists — once — in `src/policy/glob.ts`. Importing `src/policy/glob.js` from `src/providers/local/` would make a CI provider depend on the policy package, and writing a second glob matcher is the same mistake D3 refused for redaction. So `src/policy/glob.ts` moves to `src/glob/`, with its four importers updated. Its content does not change at all, and `tests/glob/match.test.ts` is the unchanged proof of that.

- [ ] **Step 1: Move the glob module**

```bash
mkdir -p src/glob tests/glob
git mv src/policy/glob.ts src/glob/match.ts
git mv tests/policy/glob.test.ts tests/glob/match.test.ts
```

Create `src/glob/index.ts`:

```ts
/**
 * The one glob dialect in this codebase: `**`, `*` and `?` over repo-relative forward-slash paths.
 *
 * Used by §12's `allowed_scope` and §28's `policy.forbidden_paths` (via `src/policy/`), and by §28's
 * `local_ci.repos.<name>.junit` (via `src/providers/local/`). One implementation, because two would differ on
 * exactly the inputs nobody tests.
 */
export { matchesAnyGlob, matchesGlob } from './match.js';
```

Update the importers:
- `src/policy/index.ts:12` → `export { matchesAnyGlob, matchesGlob } from '../glob/index.js';`
- `src/policy/checks/lockfile.ts:1` → `import { matchesAnyGlob } from '../../glob/index.js';`
- `src/policy/checks/scope.ts:2` → `import { matchesAnyGlob } from '../../glob/index.js';`
- `tests/glob/match.test.ts:2` → `from '../../src/glob/index.js'`

Run: `pnpm vitest run --project unit tests/glob tests/policy && grep -rn "policy/glob" src tests`
Expected: PASS, and the grep prints nothing.

- [ ] **Step 2: Write the failing JUnit tests with the three real fixtures**

Create `tests/providers/local/junit.test.ts`. The three XML documents below are the **verbatim output** of a real `vitest --reporter=junit`, a real `jest --reporters=jest-junit` and a real `karma` + `karma-junit-reporter` run on this machine, trimmed only of absolute paths:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectJUnitFiles, junitIdentity, parseJUnitXml } from '../../../src/providers/local/junit.js';
import { tempDir } from '../../helpers/git-fixtures.js';

const VITEST_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="0.00544058">
    <testsuite name="sample.test.ts" timestamp="2026-09-21T14:29:00.382Z" hostname="host" tests="2" failures="1" errors="0" skipped="0" time="0.005">
        <testcase classname="sample.test.ts" name="AppComponent &gt; should create the app" time="0.001">
        </testcase>
        <testcase classname="sample.test.ts" name="AppComponent &gt; should render title" time="0.003">
            <failure message="expected &apos;a&apos; to be &apos;b&apos; // Object.is equality" type="AssertionError">
AssertionError: expected &apos;a&apos; to be &apos;b&apos; // Object.is equality

Expected: &quot;b&quot;
Received: &quot;a&quot;

 at sample.test.ts:8:17
            </failure>
        </testcase>
    </testsuite>
</testsuites>`;

const JEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="3" failures="2" errors="0" time="0.143">
  <testsuite name="AppComponent" errors="0" failures="2" skipped="0" timestamp="2026-09-21T14:30:14" time="0.119" tests="3">
    <testcase classname="AppComponent should create the app" name="AppComponent should create the app" time="0.001">
    </testcase>
    <testcase classname="AppComponent should render title" name="AppComponent should render title" time="0.002">
      <failure>Error: expect(received).toBe(expected) // Object.is equality

Expected: &quot;b&quot;
Received: &quot;a&quot;
    at Object.toBe (/ws/repos/ui-kit/src/sample.test.js:3:49)</failure>
    </testcase>
    <testcase classname="AppComponent should compile" name="AppComponent should compile" time="0">
      <failure>TypeError: Cannot read properties of undefined (reading &apos;x&apos;)
    at Object.&lt;anonymous&gt; (/ws/repos/ui-kit/src/sample.test.js:4:38)</failure>
    </testcase>
  </testsuite>
</testsuites>`;

const KARMA_XML = `<?xml version="1.0"?>
<testsuite name="Chrome Headless 153.0.0.0 (Linux 0.0.0)" package="" timestamp="2026-09-21T14:30:42" id="0" hostname="host" tests="2" errors="0" failures="1" time="0.002">
  <properties>
    <property name="browser.fullName" value="Mozilla/5.0 HeadlessChrome/153.0.0.0"/>
  </properties>
  <testcase name="AppComponent should render title" time="0.001" classname="Chrome_Headless_153_0_0_0_(Linux_0_0_0).AppComponent">
    <failure type="">Expected 'a' to be 'b'.
    at &lt;Jasmine&gt;
    at UserContext.&lt;anonymous&gt; (spec.js:3:55)
</failure>
  </testcase>
  <testcase name="AppComponent should create the app" time="0.001" classname="Chrome_Headless_153_0_0_0_(Linux_0_0_0).AppComponent"/>
</testsuite>`;

describe('parseJUnitXml', () => {
  it('reads vitest output, where classname is the file and name carries the suite', () => {
    const cases = parseJUnitXml(VITEST_XML, { suitePrefixDepth: 0 });
    expect(cases).toHaveLength(2);
    expect(cases.map((one) => one.identity)).toEqual([
      'sample.test.ts › AppComponent > should create the app',
      'sample.test.ts › AppComponent > should render title',
    ]);
    expect(cases.filter((one) => one.failed).map((one) => one.identity)).toEqual([
      'sample.test.ts › AppComponent > should render title',
    ]);
    // vitest is the only one of the three that supplies a `message` attribute.
    expect(cases[1]?.details).toContain("expected 'a' to be 'b'");
    expect(cases[1]?.details).toContain('Received: "a"');
  });

  it('reads jest-junit output, where classname and name are identical', () => {
    const cases = parseJUnitXml(JEST_XML, { suitePrefixDepth: 0 });
    expect(cases.map((one) => one.identity)).toEqual([
      'AppComponent should create the app',
      'AppComponent should render title',
      'AppComponent should compile',
    ]);
    expect(cases.filter((one) => one.failed)).toHaveLength(2);
    // jest-junit's <failure> has no attributes at all: the message is the element text.
    expect(cases[2]?.details).toContain('Cannot read properties of undefined');
  });

  it('reads karma-junit output, whose root element is testsuite rather than testsuites', () => {
    const cases = parseJUnitXml(KARMA_XML, { suitePrefixDepth: 1 });
    expect(cases.map((one) => one.identity)).toEqual(['AppComponent should render title', 'AppComponent should create the app']);
    expect(cases[0]?.failed).toBe(true);
    expect(cases[1]?.failed).toBe(false);
    expect(cases[0]?.details).toContain("Expected 'a' to be 'b'.");
  });

  it('keeps the browser out of the identity when the prefix depth says to drop it', () => {
    // R8 and D10: the cheapest input that defeats a test identity is a Chrome upgrade. With the browser segment
    // in the identity, every test in the repository gets a new identity and every §16.3 signature changes,
    // silently disabling no-progress detection.
    const upgraded = KARMA_XML.replace(/153_0_0_0/gu, '154_0_0_0').replace(/153\.0\.0\.0/gu, '154.0.0.0');
    const before = parseJUnitXml(KARMA_XML, { suitePrefixDepth: 1 }).map((one) => one.identity);
    const after = parseJUnitXml(upgraded, { suitePrefixDepth: 1 }).map((one) => one.identity);
    expect(after).toEqual(before);
    // And the control: at depth 0 the identity does move, which is why the config field exists and why
    // `provider.local_ci` warns when a repo sets `junit` without it.
    expect(parseJUnitXml(upgraded, { suitePrefixDepth: 0 })[0]?.identity).not.toBe(
      parseJUnitXml(KARMA_XML, { suitePrefixDepth: 0 })[0]?.identity,
    );
  });

  it('decodes the five XML entities a reporter actually emits', () => {
    const xml = `<testsuite><testcase classname="c" name="a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"/></testsuite>`;
    expect(parseJUnitXml(xml, { suitePrefixDepth: 0 })[0]?.name).toBe(`a & b <c> "d" 'e'`);
  });

  it('treats an <error> element as a failure, the way a reporter means it', () => {
    const xml = `<testsuite><testcase classname="c" name="boom"><error message="blew up"/></testcase></testsuite>`;
    const cases = parseJUnitXml(xml, { suitePrefixDepth: 0 });
    expect(cases[0]?.failed).toBe(true);
    expect(cases[0]?.details).toBe('blew up');
  });

  it('returns nothing for a document with no test cases, rather than throwing', () => {
    expect(parseJUnitXml('<testsuites/>', { suitePrefixDepth: 0 })).toEqual([]);
    expect(parseJUnitXml('', { suitePrefixDepth: 0 })).toEqual([]);
    expect(parseJUnitXml('not xml at all', { suitePrefixDepth: 0 })).toEqual([]);
  });
});

describe('junitIdentity', () => {
  it('joins a suite and a name, unless the name already starts with the suite', () => {
    expect(junitIdentity('sample.test.ts', 'AppComponent > renders')).toBe('sample.test.ts › AppComponent > renders');
    expect(junitIdentity('AppComponent renders', 'AppComponent renders')).toBe('AppComponent renders');
    expect(junitIdentity('AppComponent', 'AppComponent renders')).toBe('AppComponent renders');
    expect(junitIdentity('', 'renders')).toBe('renders');
  });
});

describe('collectJUnitFiles', () => {
  it('finds every file matching the glob, in sorted order, ignoring everything else', () => {
    const repo = tempDir('janus-junit-');
    mkdirSync(join(repo, 'reports', 'junit', 'Chrome_Headless'), { recursive: true });
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(repo, 'reports', 'junit', 'Chrome_Headless', 'results.xml'), KARMA_XML);
    writeFileSync(join(repo, 'reports', 'junit', 'top.xml'), VITEST_XML);
    writeFileSync(join(repo, 'reports', 'junit', 'notes.txt'), 'ignore me');
    writeFileSync(join(repo, 'node_modules', 'pkg', 'fixture.xml'), VITEST_XML);
    expect(collectJUnitFiles(repo, 'reports/junit/**/*.xml')).toEqual([
      join(repo, 'reports', 'junit', 'Chrome_Headless', 'results.xml'),
      join(repo, 'reports', 'junit', 'top.xml'),
    ]);
  });

  it('answers with nothing when the directory does not exist', () => {
    expect(collectJUnitFiles(tempDir('janus-junit-'), 'reports/**/*.xml')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/local/junit.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/providers/local/junit.js"`.

- [ ] **Step 4: Implement the JUnit reader**

Create `src/providers/local/junit.ts`:

```ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { matchesGlob } from '../../glob/index.js';

/**
 * A JUnit XML reader covering exactly the subset the three reporters an Angular repository actually uses emit —
 * verified against real output from `vitest --reporter=junit`, `jest --reporters=jest-junit` and
 * `karma` + `karma-junit-reporter`, not from memory. They disagree about nearly everything:
 *
 * | reporter    | root element  | `classname`                                   | `name`                          | failure element        |
 * |-------------|---------------|-----------------------------------------------|---------------------------------|------------------------|
 * | vitest      | `testsuites`  | the file (`sample.test.ts`)                   | `Suite > case`                  | `message` + `type` attrs |
 * | jest-junit  | `testsuites`  | identical to `name`                            | `Suite case`                    | **no attributes**      |
 * | karma-junit | `testsuite`   | `Browser_Name_Version.Suite`                   | `Suite case`                    | `type=""`, no message  |
 *
 * A tag scanner rather than an XML DOM dependency: four element names and five entities is not worth a runtime
 * dependency, and a scanner cannot be surprised by a namespace or a DTD it was never going to honour anyway.
 */

export interface JUnitCase {
  /** The stable identity §16.2 lists, §16.3 hashes and §11's exceptions match on. See {@link junitIdentity}. */
  identity: string;
  name: string;
  suite: string | null;
  failed: boolean;
  /** The failure message plus whatever stack the reporter put in the element body. Empty for a passing case. */
  details: string;
}

export interface ParseJUnitOptions {
  /** `local_ci.repos.<name>.junit_suite_prefix_depth`: leading dot-separated `classname` segments to drop. */
  suitePrefixDepth: number;
}

const TESTCASE_RE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/gu;
const FAILURE_RE = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/u;
const ATTRIBUTE_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/gu;

/** The five predefined entities, plus numeric references. Nothing else appears in reporter output. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/gu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function attributes(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_RE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) found[key] = decodeEntities(value);
  }
  return found;
}

/**
 * D10's identity rule, in exact string comparisons only — no fuzzy matching anywhere.
 *
 * The suite is prefixed to the name **unless the name already begins with it**, which is what makes one rule
 * work for all three reporters: jest-junit repeats the whole identity in both fields, karma repeats the suite,
 * and vitest shares nothing between them.
 */
export function junitIdentity(suite: string, name: string): string {
  if (suite === '' || name === suite || name.startsWith(suite)) return name;
  return `${suite} › ${name}`;
}

function suiteFrom(classname: string, depth: number): string {
  if (depth <= 0) return classname;
  const segments = classname.split('.');
  return segments.length <= depth ? '' : segments.slice(depth).join('.');
}

export function parseJUnitXml(xml: string, options: ParseJUnitOptions): JUnitCase[] {
  const cases: JUnitCase[] = [];
  for (const match of xml.matchAll(TESTCASE_RE)) {
    const attrs = attributes(match[1] ?? '');
    const body = match[2] ?? '';
    const name = attrs['name'] ?? '';
    if (name === '') continue;
    const suite = suiteFrom(attrs['classname'] ?? '', options.suitePrefixDepth);
    const failure = FAILURE_RE.exec(body);
    let details = '';
    if (failure !== null) {
      const failureAttrs = attributes(failure[2] ?? '');
      // vitest supplies `message`; jest-junit supplies nothing; karma supplies `type=""`. Prefer the attribute
      // when it is there and fall back to the element body, which is where the other two put everything.
      const message = failureAttrs['message'] ?? '';
      const text = decodeEntities(failure[3] ?? '').trim();
      details = message === '' ? text : text === '' ? message : `${message}\n${text}`;
    }
    cases.push({ identity: junitIdentity(suite, name), name, suite: suite === '' ? null : suite, failed: failure !== null, details });
  }
  return cases;
}

/**
 * Every file under `repoDir` whose repo-relative path matches `glob`, sorted, so two runs list them in the same
 * order and the resulting identities sort the same way.
 *
 * A glob rather than a path because karma-junit-reporter writes to
 * `<outputDir>/<Browser_Name_Version>/results.xml` — the directory is named after the browser, so it changes
 * whenever Chrome does.
 */
export function collectJUnitFiles(repoDir: string, glob: string): string[] {
  if (!existsSync(repoDir)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (matchesGlob(glob, relative(repoDir, path).split(sep).join('/'))) found.push(path);
    }
  };
  walk(repoDir);
  return found.sort();
}

/** Reads and parses every collected file, in path order. A file that cannot be read is skipped, not raised. */
export function readJUnitCases(repoDir: string, glob: string, options: ParseJUnitOptions): JUnitCase[] {
  const cases: JUnitCase[] = [];
  for (const path of collectJUnitFiles(repoDir, glob)) {
    try {
      cases.push(...parseJUnitXml(readFileSync(path, 'utf8'), options));
    } catch {
      // A reporter that was killed mid-write leaves a truncated file. One unreadable report is not a reason to
      // fail the build observation; the summary parser is still there as a fallback.
    }
  }
  return cases;
}
```

Add `readJUnitCases` to the **Produces** list when reviewing: `readJUnitCases(repoDir: string, glob: string, options: ParseJUnitOptions): JUnitCase[]`.

- [ ] **Step 5: Run the JUnit tests**

Run: `pnpm vitest run --project unit tests/providers/local/junit.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Write the failing summary tests**

Create `tests/providers/local/summary.test.ts`. Both logs below were captured from real runs on this machine:

```ts
import { describe, expect, it } from 'vitest';
import { parseJestSummary, parseKarmaSummary, parseTestSummary, stripAnsi } from '../../../src/providers/local/summary.js';

const ESC = String.fromCharCode(27);

const KARMA_LOG = [
  `${ESC}[32m21 09 2026 16:30:42.025:INFO [karma-server]: ${ESC}[39mKarma v6.4.4 server started at http://localhost:9876/`,
  'Chrome Headless 153.0.0.0 (Linux 0.0.0): Executed 0 of 2 SUCCESS (0 secs / 0 secs)',
  `${ESC}[1A${ESC}[2K${ESC}[31mChrome Headless 153.0.0.0 (Linux 0.0.0) AppComponent should render title FAILED${ESC}[39m`,
  "\tExpected 'a' to be 'b'.",
  `Chrome Headless 153.0.0.0 (Linux 0.0.0): Executed 2 of 2${ESC}[31m (1 FAILED)${ESC}[39m (0.004 secs / 0.002 secs)`,
  `${ESC}[31mTOTAL: 1 FAILED, 1 SUCCESS${ESC}[39m`,
].join('\n');

const JEST_LOG = [
  'FAIL src/sample.test.js',
  '  AppComponent',
  '    ✓ should create the app (1 ms)',
  '    ✕ should render title (2 ms)',
  '',
  '  ● AppComponent › should render title',
  '',
  '    expect(received).toBe(expected) // Object.is equality',
  '',
  '  ● AppComponent › should compile',
  '',
  'Test Suites: 1 failed, 1 total',
  'Tests:       2 failed, 1 passed, 3 total',
  'Snapshots:   0 total',
  'Time:        0.215 s',
].join('\n');

describe('stripAnsi', () => {
  it('removes colour and cursor sequences, which Karma writes and a file log does not', () => {
    expect(stripAnsi(`${ESC}[1A${ESC}[2K${ESC}[31mred${ESC}[39m`)).toBe('red');
  });
});

describe('parseKarmaSummary', () => {
  it('reads the TOTAL line and the FAILED test names', () => {
    const summary = parseKarmaSummary(KARMA_LOG);
    expect(summary).not.toBeNull();
    expect(summary?.failed).toBe(1);
    expect(summary?.passed).toBe(1);
    expect(summary?.total).toBe(2);
    expect(summary?.failedNames).toEqual(['AppComponent should render title']);
  });

  it('drops the browser prefix from the failed name, for the same reason the JUnit path does', () => {
    expect(parseKarmaSummary(KARMA_LOG)?.failedNames[0]).not.toContain('Chrome Headless');
  });

  it('answers null for output that is not Karma', () => {
    expect(parseKarmaSummary(JEST_LOG)).toBeNull();
    expect(parseKarmaSummary('')).toBeNull();
  });
});

describe('parseJestSummary', () => {
  it('reads the Tests: line and the failure headers', () => {
    const summary = parseJestSummary(JEST_LOG);
    expect(summary?.failed).toBe(2);
    expect(summary?.passed).toBe(1);
    expect(summary?.total).toBe(3);
    expect(summary?.failedNames).toEqual(['AppComponent › should render title', 'AppComponent › should compile']);
  });

  it('reads a Tests: line with no failures', () => {
    expect(parseJestSummary('Tests:       3 passed, 3 total')).toEqual({ failed: 0, passed: 3, total: 3, failedNames: [] });
  });

  it('answers null for output that is not Jest', () => {
    expect(parseJestSummary(KARMA_LOG)).toBeNull();
  });
});

describe('parseTestSummary', () => {
  it('recognises either reporter without being told which to expect', () => {
    expect(parseTestSummary(KARMA_LOG)?.failed).toBe(1);
    expect(parseTestSummary(JEST_LOG)?.failed).toBe(2);
    expect(parseTestSummary('> ui-kit@1.0.0 build\nDone.')).toBeNull();
  });
});
```

- [ ] **Step 7: Implement the summary parsers**

Create `src/providers/local/summary.ts`:

```ts
/**
 * The fallback for a repository that does not write JUnit XML: parse the reporter's own summary out of the
 * captured log.
 *
 * Coarser than JUnit on purpose — Karma's console output names the failing tests but not their full suite path,
 * and Jest's names them but not which file they came from — which is exactly why
 * `local_ci.repos.<name>.junit` is worth configuring, and why `provider.local_ci` warns when it is not. It is
 * still much better than nothing: §16.1 needs `tests_failed` distinguished from `build_failed`, and that needs
 * only a count.
 *
 * Both formats below were captured from real runs (karma 6.4.4 with karma-junit-reporter 2, jest 29), including
 * the detail that Karma writes to **stdout** with ANSI colour and cursor-control sequences, while Jest writes
 * its entire report to **stderr**. The `local` provider concatenates both streams into one log, so both are
 * reachable from here.
 */

export interface TestSummary {
  failed: number;
  passed: number;
  total: number;
  /** The failing test names the reporter printed. May be empty even when `failed > 0`. */
  failedNames: string[];
}

/** SGR colours and the cursor-up/erase pair Karma uses to redraw its progress line. */
const ANSI_RE = /\[[0-9;]*[A-Za-z]/gu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** `TOTAL: 1 FAILED, 1 SUCCESS` — or `TOTAL: 2 SUCCESS` when nothing failed. */
const KARMA_TOTAL_RE = /^TOTAL:\s*(?:(\d+)\s+FAILED,\s*)?(\d+)\s+SUCCESS\s*$/mu;

/** `Chrome Headless 153.0.0.0 (Linux 0.0.0) AppComponent should render title FAILED` */
const KARMA_FAILED_RE = /^(.*?)\s+(.+?)\s+FAILED\s*$/u;

/** The browser prefix Karma stamps on every line: `Chrome Headless 153.0.0.0 (Linux 0.0.0)`. */
const KARMA_BROWSER_RE = /^[A-Z][A-Za-z]*(?:\s+[A-Za-z]+)*\s+\d+(?:\.\d+)*\s+\([^)]*\)\s+/u;

export function parseKarmaSummary(log: string): TestSummary | null {
  const text = stripAnsi(log);
  const total = KARMA_TOTAL_RE.exec(text);
  if (total === null) return null;
  const failed = Number.parseInt(total[1] ?? '0', 10);
  const passed = Number.parseInt(total[2] ?? '0', 10);
  const failedNames: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('TOTAL:') || !line.trimEnd().endsWith('FAILED')) continue;
    const withoutBrowser = line.replace(KARMA_BROWSER_RE, '');
    const match = KARMA_FAILED_RE.exec(withoutBrowser.trim() === '' ? line : `x ${withoutBrowser}`);
    if (match === null) continue;
    const name = (match[2] ?? '').trim();
    // `Executed 2 of 2 (1 FAILED)` is a progress line, not a failure name.
    if (name === '' || name.includes('Executed ') || failedNames.includes(name)) continue;
    failedNames.push(name);
  }
  return { failed, passed, total: failed + passed, failedNames };
}

/** `Tests:       2 failed, 1 passed, 3 total` */
const JEST_TESTS_RE = /^Tests:\s+(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?(\d+)\s+total\s*$/mu;

/** `  ● AppComponent › should render title` — Jest's per-failure header. */
const JEST_FAILURE_RE = /^\s*●\s+(.+?)\s*$/u;

export function parseJestSummary(log: string): TestSummary | null {
  const text = stripAnsi(log);
  const tests = JEST_TESTS_RE.exec(text);
  if (tests === null) return null;
  const failed = Number.parseInt(tests[1] ?? '0', 10);
  const passed = Number.parseInt(tests[3] ?? '0', 10);
  const total = Number.parseInt(tests[4] ?? '0', 10);
  const failedNames: string[] = [];
  for (const line of text.split('\n')) {
    const match = JEST_FAILURE_RE.exec(line);
    if (match === null) continue;
    const name = match[1] ?? '';
    // Jest repeats each header once in the run body and once in the failure detail block.
    if (name === '' || failedNames.includes(name)) continue;
    failedNames.push(name);
  }
  return { failed, passed, total, failedNames };
}

/**
 * Tries Karma first and Jest second.
 *
 * No `test_summary` config knob: the two marker lines (`TOTAL: … SUCCESS` and `Tests: … total`) are unambiguous
 * and mutually exclusive, so trying both costs two regex tests and removes a setting an operator could get
 * wrong.
 */
export function parseTestSummary(log: string): TestSummary | null {
  return parseKarmaSummary(log) ?? parseJestSummary(log);
}
```

- [ ] **Step 8: Run the summary tests**

Run: `pnpm vitest run --project unit tests/providers/local/summary.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Feed the parsers into the provider**

In `src/providers/local/provider.ts`, add the imports:

```ts
import { readJUnitCases } from './junit.js';
import { parseTestSummary } from './summary.js';
```

and replace the `const failedTests: FailedTest[] = [];` line (with its "Task 8 replaces this" comment) with:

```ts
      // §16.1's `tests_failed` needs failed *identities*, not a count, because §16.2 lists them and §16.3
      // hashes them. JUnit XML is the good source and the configured one; the reporter summary is the
      // fallback, and yields names without their file, which is why `provider.local_ci` warns about a repo
      // with no `junit` glob.
      const entry = config.local_ci.repos[trigger.repo];
      const junitGlob = entry?.junit;
      const failedTests: FailedTest[] =
        junitGlob === undefined
          ? summaryFailures(log.join('\n'))
          : readJUnitCases(cwd, junitGlob, { suitePrefixDepth: entry?.junit_suite_prefix_depth ?? 0 })
              .filter((one) => one.failed)
              .map((one) => ({ identity: one.identity, name: one.name, suite: one.suite, newFailure: null, details: one.details }));
```

and add the helper above `createLocalCiProvider`:

```ts
/**
 * The summary fallback, as `FailedTest`s.
 *
 * `newFailure` is null for every local test: the `local` provider has no history of previous runs to compare
 * against, and §16.2's flag is explicitly nullable for exactly this reason. When the reporter reported a count
 * but no names — which happens when a suite crashes before naming anything — one synthetic entry stands in, so
 * §16.1 still classifies the build as `tests_failed` rather than `build_failed`.
 */
function summaryFailures(log: string): FailedTest[] {
  const summary = parseTestSummary(log);
  if (summary === null || summary.failed === 0) return [];
  if (summary.failedNames.length === 0) {
    return [
      {
        identity: 'unnamed test failures',
        name: 'unnamed test failures',
        suite: null,
        newFailure: null,
        details: `${String(summary.failed)} of ${String(summary.total)} tests failed; the reporter named none of them`,
      },
    ];
  }
  return summary.failedNames.map((name) => ({ identity: name, name, suite: null, newFailure: null, details: '' }));
}
```

- [ ] **Step 10: Extend the provider tests for the two paths**

Append to `tests/providers/local/provider.test.ts`:

```ts
describe('failed test identities', () => {
  it('reads them from the configured JUnit glob', async () => {
    const script = scripted({ 'pnpm test': { exitCode: 1, stdout: 'tests failed' } });
    const paths = workspacePaths(tempDir('janus-local-'));
    mkdirSync(join(paths.repoDir('ui-kit'), 'reports'), { recursive: true });
    writeFileSync(
      join(paths.repoDir('ui-kit'), 'reports', 'results.xml'),
      `<testsuite><testcase classname="sample.test.ts" name="AppComponent &gt; renders"><failure message="nope"/></testcase></testsuite>`,
    );
    const provider = createLocalCiProvider({
      config: config({ 'ui-kit': { test: 'pnpm test', junit: 'reports/**/*.xml' } }),
      paths,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
      run: script.run,
      env: { PATH: '/usr/bin:/bin' },
    });
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    const outcome = await provider.waitForBuild(ref, WAIT);
    expect(outcome.classification).toBe('tests_failed');
    expect(outcome.failedTests.map((test) => test.identity)).toEqual(['sample.test.ts › AppComponent > renders']);
    // §16.1: when the failure is a test, it is not also reported as a build problem.
    expect(outcome.problems).toEqual([]);
  });

  it('falls back to the reporter summary when no junit glob is configured', async () => {
    const script = scripted({
      'pnpm test': { exitCode: 1, stdout: ['  ● AppComponent › renders', 'Tests:       1 failed, 2 passed, 3 total'].join('\n') },
    });
    const { provider } = providerFor({ 'ui-kit': { test: 'pnpm test' } }, script);
    const ref = await provider.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/g', revision: REV, params: {} });
    const outcome = await provider.waitForBuild(ref, WAIT);
    expect(outcome.classification).toBe('tests_failed');
    expect(outcome.failedTests.map((test) => test.identity)).toEqual(['AppComponent › renders']);
  });
});
```

Add `import { mkdirSync, writeFileSync } from 'node:fs';` and `import { join } from 'node:path';` to the top of that test file.

- [ ] **Step 11: Wire `local` into the contract suite**

Create `tests/providers/contract/local-ci.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema } from '../../../src/config/config-schema.js';
import type { LocalCommandRequest, LocalCommandResult } from '../../../src/providers/local/exec.js';
import { createLocalCiProvider } from '../../../src/providers/local/provider.js';
import { workspacePaths } from '../../../src/workspace/layout.js';
import { tempDir } from '../../helpers/git-fixtures.js';
import { describeCiProviderContract } from './ci.js';
import type { CiCapabilities, CiContractScenario, CiContractSubject } from './ci.js';

/**
 * The `local` provider runs synchronously, so it has no queue; it has no history, so it cannot tell a new
 * failure from a repeat one; and it has no web UI, so a build ref carries no URL. Declared, never inferred.
 */
export const LOCAL_CI_CAPABILITIES: CiCapabilities = {
  reportsMissingBuild: true,
  reportsQueue: false,
  producesInfra: true,
  reportsFailedTests: true,
  reportsNewFailure: false,
  reportsBuildUrl: false,
};

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const FAILING_TESTS = ['sample.test.ts › AppComponent > renders the title', 'sample.test.ts › AppComponent > reacts to input'];

const JUNIT = `<testsuite>
  <testcase classname="sample.test.ts" name="AppComponent &gt; renders the title"><failure message="expected a to be b"/></testcase>
  <testcase classname="sample.test.ts" name="AppComponent &gt; reacts to input"><failure message="expected c to be d"/></testcase>
  <testcase classname="sample.test.ts" name="AppComponent &gt; is created"/>
</testsuite>`;

function answerFor(scenario: CiContractScenario): Partial<LocalCommandResult> {
  const log = ['compiling', `TOKEN=${SECRET}`, 'src/app/a.ts:4:1 - error TS2551: nope'].join('\n');
  switch (scenario) {
    case 'success':
    case 'missing_build':
    case 'queued_then_success':
      return { exitCode: 0, stdout: 'all good' };
    case 'tests_failed':
      return { exitCode: 1, stdout: log };
    case 'build_failed':
      return { exitCode: 1, stdout: log };
    case 'infra':
      return { exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: 'killed' };
  }
}

async function setup(scenario: CiContractScenario): Promise<CiContractSubject> {
  const root = tempDir('janus-contract-local-ci-');
  const paths = workspacePaths(root);
  mkdirSync(join(paths.repoDir('ui-kit'), 'reports'), { recursive: true });
  // Only the tests_failed scenario writes a JUnit report; the others must classify without one.
  if (scenario === 'tests_failed') writeFileSync(join(paths.repoDir('ui-kit'), 'reports', 'results.xml'), JUNIT);
  const answer = answerFor(scenario);
  const run = async (_request: LocalCommandRequest): Promise<LocalCommandResult> => ({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnFailed: false,
    outputTruncated: false,
    durationMs: 1,
    ...answer,
  });
  return {
    provider: createLocalCiProvider({
      config: configSchema.parse({
        workflow: { ci_provider: 'local', scm_provider: 'fake' },
        local_ci: { repos: { 'ui-kit': { test: 'pnpm test', junit: 'reports/**/*.xml' } } },
      }),
      paths,
      now: () => new Date('2026-09-21T10:00:00.000Z'),
      run,
      env: { PATH: '/usr/bin:/bin' },
    }),
    repo: 'ui-kit',
    revision: 'a'.repeat(40),
    branch: 'ai/angular-15-to-16',
    buildTypeId: 'Fe_UiKit_Build',
    expectedFailedTests: FAILING_TESTS,
    seededSecret: SECRET,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describeCiProviderContract({ name: 'local', capabilities: LOCAL_CI_CAPABILITIES, setup });
```

- [ ] **Step 12: Run the local provider through the contract**

Run: `pnpm vitest run --project unit tests/providers/contract`
Expected: PASS. `fake` 16 passed / 0 skipped; `local` 14 passed / 2 skipped, the skipped titles naming `reportsQueue` and `reportsNewFailure`.

- [ ] **Step 13: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1130 + 10 + 8 + 2 + 16 = 1166.

- [ ] **Step 14: Commit**

```bash
git add -A src/glob src/policy src/providers/local tests/glob tests/policy tests/providers
git commit -m "feat(providers): parse JUnit and Karma/Jest summaries for local failed-test identities" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 9: Wire `local` into `createProviders`, implement `janus ci`, add the `local_ci` doctor check

**Files:**
- Modify: `src/providers/types.ts` (whole file)
- Modify: `src/providers/index.ts` (whole file)
- Modify: `src/cli/commands/ci.ts` (whole file)
- Modify: `src/doctor/checks/providers.ts` (append `localCiConfigCheck`)
- Modify: `src/doctor/index.ts:26-40`
- Modify: `tests/providers/create-providers.test.ts`, `tests/cli/commands.test.ts:5-18`, `tests/doctor/registry.test.ts:15-29`
- Test: `tests/cli/ci-command.test.ts`, `tests/doctor/local-ci-check.test.ts`

**Interfaces:**
- Consumes: `createLocalCiProvider` from `src/providers/local/provider.js`; `createFakeCiProvider` from `src/providers/fake/ci.js`; `digestLimitsFrom`, `renderDigestMarkdown` from `src/providers/ci/digest.js`; `openWorkspace`, `findWorkspaceRoot` from `src/workspace/open-workspace.js`; `DoctorCheck`, `skipped` from `src/doctor/types.js`.
- Produces:
  - `src/providers/types.ts` re-exports every CI type alongside `AgentRunner` and `Providers`, so `import type { CiProvider } from '../providers/types.js'` keeps working
  - `createProviders(input: CreateProvidersInput): Providers` — now returns a `local` CI provider for `workflow.ci_provider: local`
  - `ProviderNotImplementedError` messages naming **T15** (teamcity) and **T16** (bitbucket-server)
  - `registerCi(program, ctx)` implementing `wait`, `trigger` and `digest`
  - `localCiConfigCheck: DoctorCheck` with id `provider.local_ci`

**Why:** R3 and R5. `src/cli/commands/ci.ts` names T09 in all three of its `notImplemented` calls, so T09 is not done while they still exit 3. Implementing them over `createProviders` rather than over a specific provider is what makes T15's done-when ("`janus ci wait|trigger|digest` work against fixtures") reduce to writing the TeamCity adapter. D12 explains why the reachability probe is unchanged and why a `local_ci` completeness check is worth adding.

- [ ] **Step 1: Rewrite `src/providers/types.ts`**

```ts
import type { RenderedPrompt } from '../agents/render.js';
import type { AgentOutcome, AgentTask } from '../agents/types.js';
import type { CiProvider } from './ci/types.js';

/**
 * §3.2 `AgentRunner`: `run(task: AgentTask): Promise<AgentResult>`. Implementations: the Codex adapter (§18.4)
 * and the scripted fake (§18.5). A runner executes one task and reports what happened; it writes no telemetry and
 * no evidence — `runAgent` in `src/agents/run.ts` does that around every runner.
 *
 * The §18.2 prompt is rendered by `runAgent` and passed in, not rendered by the runner: that is what makes the
 * context-size limit, the generated-file guard and the recorded `prompt_bytes`/`truncations` identical on the
 * fake path and the Codex path. A runner that does not need the text (the fake) may simply ignore the parameter.
 */
export interface AgentRunner {
  readonly name: 'codex' | 'fake';
  run(task: AgentTask, prompt: RenderedPrompt): Promise<AgentOutcome>;
}

export type { AgentOutcome, AgentTask, RenderedPrompt };

/**
 * §3.2 `CiProvider`, declared in `./ci/types.js` and re-exported here.
 *
 * The interface and its value types live in their own module because they come with the §16.1 classification
 * table, the §16.2 digest and the §16.3 signature beside them; this file stays what it has always been — the
 * place a step or a test reaches for "the three providers". Every existing
 * `import type { CiProvider } from '.../providers/types.js'` keeps working unchanged.
 */
export type {
  BuildClassification,
  BuildOutcome,
  BuildProblem,
  BuildRef,
  BuildStatus,
  CiProvider,
  CiProviderErrorKind,
  DigestLimits,
  FailedTest,
  FailureDigest,
  TriggerBuildInput,
  WaitForBuildOptions,
} from './ci/types.js';
export { BUILD_CLASSIFICATIONS, CiProviderError } from './ci/types.js';

/**
 * §3.2 `ScmProvider`.
 *
 * The next task of this plan replaces this with the full surface — `createPullRequest`, `findPullRequest`,
 * `getPullRequest`, `listActivitySince`, `addComment`, `updateDescription`, and the `PullRef` / `PullState` /
 * `Activity` shapes — declared in `./scm/types.js` and re-exported here exactly as `CiProvider` is above.
 */
export interface ScmProvider {
  readonly name: 'bitbucket-server' | 'fake';
  /** §3.2 `currentUser`: the account Janus posts as, so it can skip its own comments. */
  currentUser(): Promise<string>;
  /** §3.2 `ensureBranch`: makes `name` exist on `repo`, created from `base` when it does not. */
  ensureBranch(repo: string, name: string, base: string): Promise<void>;
}

/**
 * The provider bag a step receives through `StepContext`. Built once per `janus run` by the CLI (or by the
 * integration harness) and injected; never a module singleton, so a test can swap any of the three.
 */
export interface Providers {
  agent: AgentRunner;
  ci: CiProvider;
  scm: ScmProvider;
}
```

- [ ] **Step 2: Write the failing `createProviders` test changes**

Replace the second case in `tests/providers/create-providers.test.ts` and add one:

```ts
  it('builds the local CI provider when config.yaml selects it', () => {
    const providers = createProviders({
      config: config({ agent_runner: 'fake', ci_provider: 'local', scm_provider: 'fake' }),
      paths: paths(),
      now,
    });
    expect(providers.ci.name).toBe('local');
    expect(providers.scm.name).toBe('fake');
  });

  it('names the task that will implement each remaining real provider', () => {
    const attempt = (workflow: Record<string, string>): ProviderNotImplementedError => {
      try {
        createProviders({ config: config(workflow), paths: paths(), now });
      } catch (error) {
        if (error instanceof ProviderNotImplementedError) return error;
        throw error;
      }
      throw new Error('expected createProviders to throw');
    };

    expect(attempt({ agent_runner: 'fake', ci_provider: 'teamcity', scm_provider: 'fake' }).task).toBe('T15');
    expect(attempt({ agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'bitbucket-server' }).task).toBe('T16');
    // The remediation must point at something that now works, not at the fake only.
    expect(attempt({ agent_runner: 'fake', ci_provider: 'teamcity', scm_provider: 'fake' }).message).toContain('local');
  });
```

Run: `pnpm vitest run --project unit tests/providers/create-providers.test.ts`
Expected: FAIL — `expected 'T09' to be 'T15'`, and the `local` case throws.

- [ ] **Step 3: Rewrite `src/providers/index.ts`**

```ts
import { createCodexAgentRunner } from '../agents/codex/adapter.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { createFakeAgentRunner } from './fake/agent-runner.js';
import { createFakeCiProvider } from './fake/ci.js';
import { createFakeScmProvider } from './fake/scm.js';
import { createLocalCiProvider } from './local/provider.js';
import type { CiProvider, Providers, ScmProvider } from './types.js';

/** A provider `config.yaml` selects that no task has implemented yet. Maps to exit 3, like a placeholder step. */
export class ProviderNotImplementedError extends Error {
  /** The task that will implement it, for the operator's message. */
  readonly task: string;

  constructor(what: string, task: string, fallback: string) {
    super(`${what} is not implemented yet (planned in ${task}); set ${fallback} in .janus/config.yaml instead`);
    this.name = 'ProviderNotImplementedError';
    this.task = task;
  }
}

export interface CreateProvidersInput {
  config: JanusConfig;
  paths: WorkspacePaths;
  now(): Date;
}

function createCi(input: CreateProvidersInput): CiProvider {
  const provider = input.config.workflow.ci_provider;
  if (provider === 'teamcity') {
    throw new ProviderNotImplementedError(
      'CI provider "teamcity"',
      'T15',
      'workflow.ci_provider: local (real commands) or workflow.ci_provider: fake (scripted)',
    );
  }
  if (provider === 'local') {
    return createLocalCiProvider({ config: input.config, paths: input.paths, now: input.now });
  }
  return createFakeCiProvider({ fakeDir: input.paths.fakeDir, now: input.now });
}

function createScm(input: CreateProvidersInput): ScmProvider {
  const provider = input.config.workflow.scm_provider;
  if (provider === 'bitbucket-server') {
    throw new ProviderNotImplementedError('SCM provider "bitbucket-server"', 'T16', 'workflow.scm_provider: fake');
  }
  return createFakeScmProvider({ fakeDir: input.paths.fakeDir, now: input.now });
}

/**
 * Spec §3.2: builds the provider bag for one `janus run` from `workflow.*`.
 *
 * Every fake persists under `<workspace>/fake/` (§5); the `local` CI provider caches its build records under
 * `<workspace>/.local-ci/`. The two remaining real adapters arrive with T15 (TeamCity) and T16 (Bitbucket
 * Server), and until then `config.yaml` selecting one is a configuration error with a named alternative rather
 * than a crash somewhere deeper.
 */
export function createProviders(input: CreateProvidersInput): Providers {
  const agent =
    input.config.workflow.agent_runner === 'codex'
      ? createCodexAgentRunner({ paths: input.paths })
      : createFakeAgentRunner({ paths: input.paths, now: input.now });
  return { agent, ci: createCi(input), scm: createScm(input) };
}

export type { AgentOutcome, AgentRunner, AgentTask, CiProvider, Providers, ScmProvider } from './types.js';
```

Run: `pnpm vitest run --project unit tests/providers/create-providers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 4: Write the failing `janus ci` tests**

Create `tests/cli/ci-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { seedFakeCi } from '../../src/providers/fake/ci.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { runCli } from '../helpers/run-cli.js';
import { createHarnessWorkspace } from '../helpers/workspace-fixtures.js';

// `createHarnessWorkspace` is added in this step: a `janus init`-ed workspace with fake providers, without the
// integration lane's reflog audit, so a CLI test can exercise a real command against a real workspace.

describe('janus ci', () => {
  it('triggers a build, waits for it, and prints its digest', async () => {
    const workspace = await createHarnessWorkspace();
    const paths = workspacePaths(workspace.root);
    seedFakeCi(paths.fakeDir, {
      'ui-kit': [
        {
          missing: true,
          classification: 'tests_failed',
          failedTests: [{ identity: 'AppComponent > renders', name: 'renders', suite: 'AppComponent', newFailure: true, details: 'nope' }],
          log: 'src/a.ts:1:1 - error TS2551: nope',
        },
      ],
    });

    const triggered = await runCli(['ci', 'trigger', '--repo', 'ui-kit'], { cwd: workspace.root });
    expect(triggered.code).toBe(ExitCode.Ok);
    const buildId = /build ([^\s]+)/u.exec(triggered.stdout)?.[1];
    expect(buildId).toBeDefined();

    const waited = await runCli(['ci', 'wait', '--repo', 'ui-kit', '--build', buildId ?? ''], { cwd: workspace.root });
    expect(waited.code).toBe(ExitCode.Ok);
    expect(waited.stdout).toContain('classification: tests_failed');

    const digested = await runCli(['ci', 'digest', '--repo', 'ui-kit', '--build', buildId ?? ''], { cwd: workspace.root });
    expect(digested.code).toBe(ExitCode.Ok);
    expect(digested.stdout).toContain('# Build failure digest');
    expect(digested.stdout).toContain('AppComponent > renders');
    workspace.cleanup();
  });

  it('finds an existing build instead of triggering a second one', async () => {
    const workspace = await createHarnessWorkspace();
    seedFakeCi(workspacePaths(workspace.root).fakeDir, { 'ui-kit': [{ classification: 'success' }] });
    const first = await runCli(['ci', 'trigger', '--repo', 'ui-kit'], { cwd: workspace.root });
    const second = await runCli(['ci', 'trigger', '--repo', 'ui-kit'], { cwd: workspace.root });
    expect(first.stdout).toBe(second.stdout);
    workspace.cleanup();
  });

  it('rejects a repo that is not in goal.yaml, naming the field', async () => {
    const workspace = await createHarnessWorkspace();
    const result = await runCli(['ci', 'trigger', '--repo', 'not-a-repo'], { cwd: workspace.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('not-a-repo');
    workspace.cleanup();
  });

  it('reports a build id the provider never minted as an error, not as a crash report', async () => {
    const workspace = await createHarnessWorkspace();
    const result = await runCli(['ci', 'digest', '--repo', 'ui-kit', '--build', 'no-such-build'], { cwd: workspace.root });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stderr).toContain('no build no-such-build');
    workspace.cleanup();
  });

  it('refuses when config.yaml selects a provider no task has implemented', async () => {
    const workspace = await createHarnessWorkspace({ ciProvider: 'teamcity' });
    const result = await runCli(['ci', 'trigger', '--repo', 'ui-kit'], { cwd: workspace.root });
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toContain('T15');
    workspace.cleanup();
  });
});
```

Add to `tests/helpers/workspace-fixtures.ts`:

```ts
export interface HarnessWorkspace {
  root: string;
  goalId: string;
  cleanup(): void;
}

export interface HarnessWorkspaceOptions {
  specs?: RepoGraphSpec[];
  /** Written into `config.yaml` as `workflow.ci_provider`. Defaults to `fake`. */
  ciProvider?: 'teamcity' | 'local' | 'fake';
  /** `local_ci` block, when `ciProvider` is `local`. */
  localCi?: Record<string, unknown>;
}

/**
 * A `janus init`-ed workspace with fake providers, for CLI tests that need a real workspace but not the
 * integration lane's reflog audit. The integration harness (`tests/integration/harness/harness.ts`) is the
 * heavier tool: it adds the §31.29 audit and the scenario helpers.
 */
export async function createHarnessWorkspace(options: HarnessWorkspaceOptions = {}): Promise<HarnessWorkspace> {
  const specs = options.specs ?? [{ name: 'ui-kit', kind: 'library' as const }];
  const fixture = await graphFixture(specs);
  const workspaceParent = tempDir('janus-ws-');
  const root = join(workspaceParent, 'ws');
  const cleanup = (): void => {
    for (const dir of [workspaceParent, ...fixture.tempRoots]) rmSync(dir, { recursive: true, force: true });
  };
  if (options.ciProvider !== undefined || options.localCi !== undefined) {
    writeFileSync(
      fixture.configPath,
      stringify({
        workflow: { agent_runner: 'fake', ci_provider: options.ciProvider ?? 'fake', scm_provider: 'fake' },
        state: { clone_url: fixture.stateBare },
        ...(options.ciProvider === 'teamcity' ? { teamcity: { url: 'https://teamcity.invalid' } } : {}),
        ...(options.localCi === undefined ? {} : { local_ci: options.localCi }),
      }),
    );
  }
  const init = await runCli(['init', '--goal', fixture.goalPath, '--workspace', root]);
  if (init.code !== 0) {
    cleanup();
    throw new Error(`createHarnessWorkspace: janus init failed (${String(init.code)})\n${init.stdout}\n${init.stderr}`);
  }
  return { root, goalId: fixture.goalId, cleanup };
}
```

with `import { rmSync, writeFileSync } from 'node:fs';`, `import { join, dirname } from 'node:path';` and `import { runCli } from './run-cli.js';` added at the top of that file.

Run: `pnpm vitest run --project unit tests/cli/ci-command.test.ts`
Expected: FAIL — the three commands exit 3 with "not implemented yet (planned in T09)".

- [ ] **Step 5: Implement `src/cli/commands/ci.ts`**

```ts
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { digestLimitsFrom, renderDigestMarkdown } from '../../providers/ci/digest.js';
import type { BuildRef } from '../../providers/ci/types.js';
import { createProviders } from '../../providers/index.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { Workspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

/**
 * Spec §8's `janus ci wait|trigger|digest ...` debug helpers.
 *
 * Deliberately thin, and written against `createProviders` rather than against any one provider: whatever
 * `workflow.ci_provider` selects is what these drive. That is why they work for `local` and `fake` the day they
 * land, and why T15's "`janus ci wait|trigger|digest` work against fixtures" reduces to writing the TeamCity
 * adapter — there is nothing provider-specific here to extend.
 *
 * They observe; they never write state, never checkpoint and never emit telemetry. A build these commands
 * trigger is a build `janus run` will find on its next §16.1 poll, which is exactly what makes them useful for
 * debugging a stuck package without taking the run loop apart.
 *
 * Exit code: `Ok` whenever the provider answered, whatever the build's colour. A red build is information, not
 * a failure of the command, and conflating the two would make `janus ci wait` unusable in a script that wants
 * to tell "janus is broken" from "the build is red". The classification is on stdout.
 */

interface CiOptions {
  repo: string;
  build?: string;
  revision?: string;
  buildType?: string;
  param?: string[];
}

/** The goal repo, or a `ConfigError` naming the field — the same shape every other command's bad input produces. */
function goalRepo(workspace: Workspace, name: string) {
  const repo = workspace.goal.repos.find((candidate) => candidate.name === name);
  if (repo === undefined) {
    const known = workspace.goal.repos.map((candidate) => candidate.name).join(', ');
    throw new ConfigError('--repo', [`no repository "${name}" in goal.yaml; known repositories: ${known}`]);
  }
  return repo;
}

function revisionFor(workspace: Workspace, repo: string, override: string | undefined): string {
  if (override !== undefined) return override;
  const head = workspace.state.repos[repo]?.head_commit;
  if (head === null || head === undefined) {
    throw new ConfigError('--revision', [`state.yaml has no head_commit for ${repo} yet; pass --revision <sha> explicitly`]);
  }
  return head;
}

function paramsFrom(values: string[] | undefined): Record<string, string> {
  const params: Record<string, string> = {};
  for (const value of values ?? []) {
    const split = value.indexOf('=');
    if (split <= 0) throw new ConfigError('--param', [`expected key=value, got "${value}"`]);
    params[value.slice(0, split)] = value.slice(split + 1);
  }
  return params;
}

/** The approved §11 baseline exception identities for one repo, which §16.2's digest reports matches against. */
function exceptionsFor(workspace: Workspace, repo: string): string[] {
  return workspace.state.baseline.exceptions.filter((exception) => exception.repo === repo).map((exception) => exception.identity);
}

async function withWorkspace<T>(ctx: CliContext, run: (workspace: Workspace) => Promise<T>): Promise<T> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    return await run(workspace);
  } finally {
    workspace.release();
  }
}

export function registerCi(program: Command, ctx: CliContext): void {
  const ci = program.command('ci').description('Debug helpers for the CI provider');

  ci
    .command('trigger')
    .description('Find, or explicitly trigger, the PR build for a repository (§16.1 steps 1 and 2)')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .option('--revision <sha>', 'revision to build; defaults to the recorded head_commit')
    .option('--build-type <id>', 'build type id; defaults to the repo ci.pr_build_type_id')
    .option('--param <key=value>', 'build parameter; repeatable', (value: string, previous: string[] = []) => [...previous, value])
    .action(async (options: CiOptions) => {
      ctx.exitCode = await withWorkspace(ctx, async (workspace) => {
        const repo = goalRepo(workspace, options.repo);
        const buildTypeId = options.buildType ?? repo.ci.pr_build_type_id;
        const revision = revisionFor(workspace, repo.name, options.revision);
        const providers = ctx.providers ?? createProviders({ config: workspace.config, paths: workspace.paths, now: () => new Date() });
        const found = await providers.ci.findBuild(repo.name, revision, buildTypeId);
        const ref =
          found ??
          (await providers.ci.triggerBuild({
            repo: repo.name,
            buildTypeId,
            branch: workspace.state.repos[repo.name]?.goal_branch ?? repo.base_branch,
            revision,
            params: paramsFrom(options.param),
          }));
        ctx.io.stdout(`${found === null ? 'triggered' : 'found'} build ${ref.id} (${buildTypeId} at ${revision.slice(0, 12)})\n`);
        if (ref.url !== null) ctx.io.stdout(`  url: ${ref.url}\n`);
        return ExitCode.Ok;
      });
    });

  ci
    .command('wait')
    .description('Wait for a build to finish and print its §16.1 classification')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .option('--build-type <id>', 'build type id; defaults to the repo ci.pr_build_type_id')
    .option('--revision <sha>', 'revision the build ran on, when the provider needs it')
    .action(async (options: CiOptions) => {
      ctx.exitCode = await withWorkspace(ctx, async (workspace) => {
        const repo = goalRepo(workspace, options.repo);
        const providers = ctx.providers ?? createProviders({ config: workspace.config, paths: workspace.paths, now: () => new Date() });
        const ref: BuildRef = {
          id: options.build ?? '',
          repo: repo.name,
          buildTypeId: options.buildType ?? repo.ci.pr_build_type_id,
          revision: options.revision ?? workspace.state.repos[repo.name]?.head_commit ?? null,
          branch: workspace.state.repos[repo.name]?.goal_branch ?? null,
          url: null,
        };
        const outcome = await providers.ci.waitForBuild(ref, {
          timeoutMs: workspace.config.teamcity.build_timeout_minutes * 60_000,
          pollIntervalMs: workspace.config.teamcity.poll_interval_seconds * 1000,
        });
        ctx.io.stdout(`build ${ref.id}\n`);
        ctx.io.stdout(`  status: ${outcome.status}\n`);
        ctx.io.stdout(`  classification: ${outcome.classification}\n`);
        ctx.io.stdout(`  raw status: ${outcome.rawStatus}\n`);
        ctx.io.stdout(`  problems: ${String(outcome.problems.length)}, failed tests: ${String(outcome.failedTests.length)}\n`);
        return ExitCode.Ok;
      });
    });

  ci
    .command('digest')
    .description('Print the §16.2 failure digest for a build, redacted and bounded')
    .requiredOption('--repo <name>', 'repository name from goal.yaml')
    .requiredOption('--build <id>', 'build id')
    .option('--build-type <id>', 'build type id; defaults to the repo ci.pr_build_type_id')
    .option('--revision <sha>', 'revision the build ran on, when the provider needs it')
    .action(async (options: CiOptions) => {
      ctx.exitCode = await withWorkspace(ctx, async (workspace) => {
        const repo = goalRepo(workspace, options.repo);
        const providers = ctx.providers ?? createProviders({ config: workspace.config, paths: workspace.paths, now: () => new Date() });
        const ref: BuildRef = {
          id: options.build ?? '',
          repo: repo.name,
          buildTypeId: options.buildType ?? repo.ci.pr_build_type_id,
          revision: options.revision ?? workspace.state.repos[repo.name]?.head_commit ?? null,
          branch: workspace.state.repos[repo.name]?.goal_branch ?? null,
          url: null,
        };
        const digest = await providers.ci.failureDigest(ref, digestLimitsFrom(workspace.config), exceptionsFor(workspace, repo.name));
        // Printed, never written: a provider writes no evidence, and `evidence/digests/` is T12's file (R2).
        ctx.io.stdout(renderDigestMarkdown(digest));
        return ExitCode.Ok;
      });
    });
}
```

- [ ] **Step 6: Drop the three `ci` rows from the stub test**

In `tests/cli/commands.test.ts`, delete lines 12-14 (the three `['ci', ...]` entries) from `stubbed`. The `lists every top-level command in help` case keeps `'ci'` in its list, because the group still exists.

Run: `pnpm vitest run --project unit tests/cli`
Expected: PASS, including the five new `janus ci` cases.

- [ ] **Step 7: Write the failing doctor-check test**

Create `tests/doctor/local-ci-check.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { localCiConfigCheck } from '../../src/doctor/checks/providers.js';
import { doctorContext } from '../helpers/doctor-fixtures.js';
import { goalSchema } from '../../src/config/goal-schema.js';

const goal = goalSchema.parse({
  id: 'angular-15-to-16',
  source_version: '15',
  target_version: '16',
  title: 'Upgrade Angular 15 to 16',
  repos: [
    { name: 'ui-kit', kind: 'library', scm: { project: 'FE', slug: 'ui-kit' }, base_branch: 'main', ci: { pr_build_type_id: 'Fe_UiKit_Build' } },
    { name: 'shell', kind: 'shell', scm: { project: 'FE', slug: 'shell' }, base_branch: 'main', ci: { pr_build_type_id: 'Fe_Shell_Build' } },
  ],
  e2e: { build_type_id: 'Fe_E2E_Full' },
});

function context(localCi: Record<string, unknown>, ciProvider = 'local') {
  return doctorContext({
    config: configSchema.parse({ workflow: { ci_provider: ciProvider, scm_provider: 'fake' }, local_ci: localCi }),
    goal,
  });
}

describe('provider.local_ci', () => {
  it('skips entirely when the CI provider is not local', async () => {
    const findings = await localCiConfigCheck.run(context({}, 'fake'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe('skip');
  });

  it('fails for a goal repo with no local_ci entry, naming the repo and the field', async () => {
    const findings = await localCiConfigCheck.run(context({ repos: { 'ui-kit': { test: 'pnpm test', junit: 'r/**/*.xml' } } }));
    const shell = findings.find((finding) => finding.id.includes('shell'));
    expect(shell?.status).toBe('fail');
    expect(shell?.detail).toContain('shell');
    expect(shell?.remediation).toContain('local_ci.repos.shell');
  });

  it('fails a repo that configures no test command, because a PR build must be able to fail on tests', async () => {
    const findings = await localCiConfigCheck.run(context({ repos: { 'ui-kit': { build: 'pnpm build' }, shell: { test: 'x', junit: 'r/*.xml' } } }));
    expect(findings.find((finding) => finding.id.includes('ui-kit'))?.status).toBe('fail');
  });

  it('warns when a repo has no junit glob, because identities fall back to the coarser summary', async () => {
    const findings = await localCiConfigCheck.run(context({ repos: { 'ui-kit': { test: 'pnpm test' }, shell: { test: 'x', junit: 'r/*.xml' } } }));
    const uiKit = findings.find((finding) => finding.id.includes('ui-kit'));
    expect(uiKit?.status).toBe('warn');
    expect(uiKit?.detail).toContain('junit');
  });

  it('warns when a junit glob looks like Karma but the prefix depth was left at zero', async () => {
    // D10: with the browser segment in the identity, a Chrome upgrade changes every §16.3 signature.
    const findings = await localCiConfigCheck.run(
      context({ repos: { 'ui-kit': { test: 'ng test', junit: 'reports/junit/**/*.xml' }, shell: { test: 'x', junit: 'r/*.xml', junit_suite_prefix_depth: 1 } } }),
    );
    const uiKit = findings.find((finding) => finding.id.includes('ui-kit'));
    expect(uiKit?.status).toBe('warn');
    expect(uiKit?.detail).toContain('junit_suite_prefix_depth');
  });

  it('passes a fully configured repo', async () => {
    const findings = await localCiConfigCheck.run(
      context({
        repos: {
          'ui-kit': { install: 'pnpm i', build: 'pnpm build', test: 'pnpm test', junit: 'reports/junit.xml' },
          shell: { test: 'x', junit: 'r/*.xml' },
        },
      }),
    );
    expect(findings.find((finding) => finding.id.includes('ui-kit'))?.status).toBe('pass');
  });

  it('skips with a remediation when there is no workspace at all', async () => {
    const findings = await localCiConfigCheck.run(doctorContext({}));
    expect(findings[0]?.status).toBe('skip');
    expect(findings[0]?.remediation).not.toBeNull();
  });
});
```

Run: `pnpm vitest run --project unit tests/doctor/local-ci-check.test.ts`
Expected: FAIL — `localCiConfigCheck` is not exported.

- [ ] **Step 8: Implement the check**

Append to `src/doctor/checks/providers.ts`:

```ts
/**
 * §31.33's spirit, applied to the provider T09 made real: a `local` CI setup that will fail on its first PR
 * build, detected before the run rather than from inside the provider.
 *
 * Pure config and goal — no subprocess, no network, no filesystem — so it costs nothing and cannot be the slow
 * check in the report. One finding per goal repository, suffixed the way `codex.model[...]` already is.
 *
 * The `provider.ci` reachability probe above is deliberately **unchanged** by `local` becoming real: its skip
 * message ("which reaches no network service") stays true for `local`, which reaches nothing.
 */
export const localCiConfigCheck: DoctorCheck = {
  id: 'provider.local_ci',
  title: 'every goal repository has a usable local_ci command set',
  run: async (ctx) => {
    const title = localCiConfigCheck.title;
    if (ctx.config === null || ctx.goal === null) {
      return [skipped('provider.local_ci', title, 'no config.yaml or goal.yaml', NO_WORKSPACE)];
    }
    if (ctx.config.workflow.ci_provider !== 'local') {
      return [
        skipped(
          'provider.local_ci',
          title,
          `workflow.ci_provider is "${ctx.config.workflow.ci_provider}", which runs no local commands`,
          'nothing to do; this check applies when workflow.ci_provider is "local"',
        ),
      ];
    }
    return ctx.goal.repos.map((repo) => {
      const id = `provider.local_ci[${repo.name}]`;
      const entry = ctx.config?.local_ci.repos[repo.name];
      if (entry === undefined) {
        return {
          id,
          title,
          status: 'fail' as const,
          detail: `${repo.name} has no local_ci entry, so its PR build would have no commands to run`,
          remediation: `add local_ci.repos.${repo.name} to .janus/config.yaml with at least a "test" command`,
        };
      }
      if (entry.test === undefined) {
        return {
          id,
          title,
          status: 'fail' as const,
          detail: `${repo.name} configures no test command, so its PR build can never report a failed test`,
          remediation: `set local_ci.repos.${repo.name}.test in .janus/config.yaml`,
        };
      }
      if (entry.junit === undefined) {
        return {
          id,
          title,
          status: 'warn' as const,
          detail:
            `${repo.name} sets no junit glob, so failed tests are read from the reporter summary: counts and ` +
            'names, but no file or suite path (§16.2 lists identities, §16.3 hashes them)',
          remediation: `set local_ci.repos.${repo.name}.junit to where the test command writes JUnit XML, e.g. "reports/junit/**/*.xml"`,
        };
      }
      if (entry.junit_suite_prefix_depth === 0 && /junit/iu.test(entry.junit) && entry.junit.includes('**')) {
        return {
          id,
          title,
          status: 'warn' as const,
          detail:
            `${repo.name}'s junit glob spans subdirectories with junit_suite_prefix_depth 0; karma-junit-reporter ` +
            'writes one directory per browser and puts the browser name and version in the classname, so every ' +
            'test identity — and every §16.3 failure signature — would change when the browser updates',
          remediation: `set local_ci.repos.${repo.name}.junit_suite_prefix_depth: 1 if this repo uses Karma; leave it at 0 for vitest or jest-junit`,
        };
      }
      return {
        id,
        title,
        status: 'pass' as const,
        detail: `${repo.name} runs ${entry.test} and reports JUnit at ${entry.junit}`,
        remediation: null,
      };
    });
  },
};
```

Register it in `src/doctor/index.ts`: add `localCiConfigCheck` to the import on line 12 and place it in `ALL_CHECKS` immediately after `ciReachabilityCheck`, so the two CI-provider findings print together.

Update `tests/doctor/registry.test.ts:15-29` to expect `'provider.local_ci'` between `'provider.ci'` and `'provider.scm'`.

- [ ] **Step 9: Run the doctor tests**

Run: `pnpm vitest run --project unit tests/doctor`
Expected: PASS, including the seven new cases and the updated registry list. The `hostile()` worst-case sweep in `registry.test.ts` must pass unchanged: `localCiConfigCheck` returns a `skip` with a remediation when there is no config, which satisfies the "every non-pass finding has a remediation" rule.

- [ ] **Step 10: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. Unit count 1166 + 1 (create-providers) + 5 (ci command) + 7 (doctor) − 3 (the removed `ci` stub rows) = 1176.

- [ ] **Step 11: Commit**

```bash
git add src/providers src/cli src/doctor tests
git commit -m "feat(cli): implement janus ci wait|trigger|digest over the selected CI provider" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 10: The `ScmProvider` interface and the PR description renderer

**Files:**
- Create: `src/providers/scm/types.ts`
- Create: `src/providers/scm/pr-description.ts`
- Modify: `src/providers/types.ts` (replace the `ScmProvider` stub with a re-export)
- Test: `tests/providers/scm/pr-description.test.ts`

**Interfaces:**
- Consumes: nothing beyond `BuildClassification` from `src/providers/ci/types.js`.
- Produces:
  - `type PullRequestState = 'OPEN' | 'MERGED' | 'DECLINED'` and `PULL_REQUEST_STATES`
  - `interface PullRef { repo: string; id: number; url: string | null }`
  - `interface ReviewerStatus { user: string; status: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED'; lastReviewedCommit: string | null }`
  - `interface PullState { ref: PullRef; state: PullRequestState; title: string; description: string; branch: string; base: string; version: number | null; reviewers: ReviewerStatus[]; mergeCommit: string | null; declineReason: string | null; headCommit: string | null }`
  - `interface InlineAnchor { path: string; line: number; lineType: 'ADDED' | 'REMOVED' | 'CONTEXT' }`
  - `type ActivityKind = 'comment' | 'approved' | 'unapproved' | 'needs_work' | 'declined' | 'merged' | 'rescoped'` and `ACTIVITY_KINDS`
  - `interface Activity { id: string; kind: ActivityKind; author: string; createdAt: string; text: string | null; commentId: string | null; parentCommentId: string | null; anchor: InlineAnchor | null; commit: string | null }`
  - `interface CreatePullRequestInput { repo: string; branch: string; base: string; title: string; body: string }`
  - `interface ScmProvider` with `name`, `currentUser`, `ensureBranch`, `createPullRequest`, `findPullRequest`, `getPullRequest`, `listActivitySince`, `addComment`, `updateDescription`
  - `class ScmProviderError extends Error` with `kind: ScmProviderErrorKind` (`'not_found' | 'transport' | 'conflict' | 'config'`)
  - `const PR_DESCRIPTION_MARKER = '<!-- janus:pr-description -->'`
  - `interface PrSibling { repo: string; url: string | null; state: PullRequestState | null }`
  - `interface PrWorkPackage { id: string; status: string }`
  - `interface PrDescriptionInput { goalId: string; goalTitle: string; sourceVersion: string; targetVersion: string; repo: string; stateBranch: string; stateBranchUrl: string | null; planCommit: string | null; workPackages: PrWorkPackage[]; siblings: PrSibling[]; lastBuild: { id: string; classification: BuildClassification | null } | null; escalated: boolean }`
  - `renderPrDescription(input: PrDescriptionInput): string`

**Why:** §3.2's `ScmProvider` sketch plus what §15 and §24 need from it. Three deviations from the sketch, all widenings, all flagged: `addComment` returns the new comment id (D13), `findPullRequest` is added (D14), and `updateDescription` is added so §15's "descriptions … are updated at package boundaries" has a method — T14 owns calling it (R-f); T10 owns only the pure renderer.

- [ ] **Step 1: Write the failing renderer test**

Create `tests/providers/scm/pr-description.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PR_DESCRIPTION_MARKER, renderPrDescription } from '../../../src/providers/scm/pr-description.js';
import type { PrDescriptionInput } from '../../../src/providers/scm/pr-description.js';

function input(overrides: Partial<PrDescriptionInput> = {}): PrDescriptionInput {
  return {
    goalId: 'angular-15-to-16',
    goalTitle: 'Upgrade Angular 15 to 16',
    sourceVersion: '15',
    targetVersion: '16',
    repo: 'ui-kit',
    stateBranch: 'janus/angular-15-to-16',
    stateBranchUrl: 'https://bitbucket.example.internal/projects/FE/repos/janus-state/browse?at=janus/angular-15-to-16',
    planCommit: 'abc1234def5678',
    workPackages: [
      { id: 'wp-01-ui-kit-angular', status: 'green' },
      { id: 'wp-02-ui-kit-tests', status: 'pending' },
    ],
    siblings: [
      { repo: 'shell', url: 'https://bitbucket.example.internal/projects/FE/repos/shell/pull-requests/8', state: 'OPEN' },
      { repo: 'orders-remote', url: null, state: null },
    ],
    lastBuild: { id: 'fake-ui-kit-1', classification: 'tests_failed' },
    escalated: false,
    ...overrides,
  };
}

const EXPECTED = `<!-- janus:pr-description -->
# Angular 15 to 16: ui-kit

Written by Janus and regenerated at every work-package boundary. Edits made here are overwritten; leave review
comments on the diff instead.

- goal: \`angular-15-to-16\` — Upgrade Angular 15 to 16
- repository: \`ui-kit\`
- state branch: [\`janus/angular-15-to-16\`](https://bitbucket.example.internal/projects/FE/repos/janus-state/browse?at=janus/angular-15-to-16)
- approved plan commit: \`abc1234def5678\`

## Work packages

| Package | Status |
| --- | --- |
| \`wp-01-ui-kit-angular\` | green |
| \`wp-02-ui-kit-tests\` | pending |

## Sibling pull requests

- \`shell\` — [pull request](https://bitbucket.example.internal/projects/FE/repos/shell/pull-requests/8) (OPEN)
- \`orders-remote\` — not created yet

## Latest PR build

\`fake-ui-kit-1\` — tests_failed
`;

describe('renderPrDescription', () => {
  it('renders the §15 description exactly', () => {
    expect(renderPrDescription(input())).toBe(EXPECTED);
  });

  it('opens with the marker, so T14 can tell a Janus description from a human-edited one', () => {
    expect(renderPrDescription(input()).startsWith(PR_DESCRIPTION_MARKER)).toBe(true);
  });

  it('is pure: the same input renders the same bytes every time', () => {
    expect(renderPrDescription(input())).toBe(renderPrDescription(input()));
  });

  it('says so when the plan is not approved yet', () => {
    expect(renderPrDescription(input({ planCommit: null }))).toContain('- approved plan commit: not approved yet');
  });

  it('says so when there is no build yet', () => {
    const rendered = renderPrDescription(input({ lastBuild: null }));
    expect(rendered).toContain('## Latest PR build');
    expect(rendered).toContain('no build observed yet');
  });

  it('says so when a build has no classification yet', () => {
    expect(renderPrDescription(input({ lastBuild: { id: 'b-9', classification: null } }))).toContain('`b-9` — not finished');
  });

  it('omits the sibling section entirely for a single-repo goal', () => {
    const rendered = renderPrDescription(input({ siblings: [] }));
    expect(rendered).not.toContain('## Sibling pull requests');
  });

  it('renders the state branch without a link when no URL is known', () => {
    expect(renderPrDescription(input({ stateBranchUrl: null }))).toContain('- state branch: `janus/angular-15-to-16`\n');
  });

  it('leads with an escalation notice when the goal is escalated', () => {
    const rendered = renderPrDescription(input({ escalated: true }));
    const marker = rendered.indexOf(PR_DESCRIPTION_MARKER);
    const notice = rendered.indexOf('> **Escalated.**');
    const heading = rendered.indexOf('# Angular 15 to 16: ui-kit');
    expect(marker).toBeLessThan(heading);
    expect(heading).toBeLessThan(notice);
    expect(rendered).toContain('escalation.md');
  });

  it('handles a goal with no work packages planned yet', () => {
    const rendered = renderPrDescription(input({ workPackages: [] }));
    expect(rendered).toContain('## Work packages');
    expect(rendered).toContain('no work packages planned yet');
    expect(rendered).not.toContain('| Package | Status |');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit tests/providers/scm/pr-description.test.ts`
Expected: FAIL — `Failed to resolve import "../../../src/providers/scm/pr-description.js"`.

- [ ] **Step 3: Write `src/providers/scm/types.ts`**

```ts
/**
 * Spec §3.2's `ScmProvider`, in full, replacing the two-method stub T04 left in `src/providers/types.ts`.
 *
 * Like the CI provider, an SCM provider is a **pure I/O adapter**: it observes and mutates pull requests and
 * reports what happened. It writes no telemetry, no evidence and — critically — **no git**. §32 rule 11 gives
 * every git write to the orchestrator; `ensureBranch` on the fake records intent, and `createPullRequest` and
 * merge detection are bookkeeping. The integration harness enforces this with a reflog audit around every
 * provider call.
 *
 * Three deliberate widenings of the §3.2 sketch, each of which a caller written against the sketch still
 * satisfies:
 *
 * 1. `addComment` returns the new comment id. §24 requires Janus to mark a comment `answered` after posting a
 *    `no_change_needed` reply, and `review_loop.open_comments[].comment_id` is how it does so.
 * 2. `findPullRequest(repo, branch)` is added: T16's done-when names "find by branch", and §7's resume needs to
 *    recover a PR reference when `state.repos.<name>.pr.id` is null but a PR exists.
 * 3. `updateDescription` is added so §15's "PR descriptions … are updated at package boundaries" has a method.
 *    T10 owns the renderer; T14 owns calling this.
 *
 * Implementations: `fake` (T10), `bitbucket-server` (T16).
 */

export const PULL_REQUEST_STATES = ['OPEN', 'MERGED', 'DECLINED'] as const;

/** §6's `repos.<name>.pr.state` vocabulary, unchanged. */
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** How a pull request is addressed. `id` is what lands in `state.repos.<name>.pr.id`. */
export interface PullRef {
  repo: string;
  id: number;
  url: string | null;
}

/**
 * One reviewer's standing. §24: "`APPROVED` on every open PR by the required reviewers moves the goal to
 * `awaiting_merge`" and "new commits reset Bitbucket approvals".
 */
export interface ReviewerStatus {
  user: string;
  status: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED';
  /** The commit this reviewer last looked at, when the provider tracks it; null otherwise. */
  lastReviewedCommit: string | null;
}

export interface PullState {
  ref: PullRef;
  state: PullRequestState;
  title: string;
  description: string;
  branch: string;
  base: string;
  /** Optimistic-concurrency token (Bitbucket's `version`), mirrored into `state.repos.<name>.pr.version`. */
  version: number | null;
  reviewers: ReviewerStatus[];
  /** Set only when `state` is `MERGED`. */
  mergeCommit: string | null;
  /** Set only when `state` is `DECLINED`. §24: a decline escalates the goal with this reason. */
  declineReason: string | null;
  /** Head of the source branch as the SCM sees it, for §24's approval-reset detection. */
  headCommit: string | null;
}

/** §24's inline comment anchor: "Bitbucket Server activities expose inline comment anchors with file and line" (§33). */
export interface InlineAnchor {
  path: string;
  line: number;
  lineType: 'ADDED' | 'REMOVED' | 'CONTEXT';
}

export const ACTIVITY_KINDS = ['comment', 'approved', 'unapproved', 'needs_work', 'declined', 'merged', 'rescoped'] as const;

/**
 * Everything §24's polling loop needs to see. `rescoped` is the one that is not a human action: it is what a
 * new commit on the source branch produces, and it is what resets approvals.
 */
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface Activity {
  /**
   * Provider-scoped, monotonic, and **lexicographically ordered**, because `review_loop.activity_cursor` is
   * `Record<string, string>` in `src/state/state-schema.ts` — a string cursor. Providers zero-pad so that
   * `id > cursor` is a correct comparison at the 10th activity and at the 10000th.
   */
  id: string;
  kind: ActivityKind;
  author: string;
  createdAt: string;
  /** Present for `kind: 'comment'`; null otherwise. */
  text: string | null;
  commentId: string | null;
  /** The comment this one replies to, for §24's `no_change_needed` replies. */
  parentCommentId: string | null;
  anchor: InlineAnchor | null;
  /** For `rescoped`: the new head commit that reset approvals. Null for every other kind. */
  commit: string | null;
}

export interface CreatePullRequestInput {
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

export type ScmProviderErrorKind = 'not_found' | 'transport' | 'conflict' | 'config';

/**
 * The things that genuinely are errors: a PR id the provider has never heard of (`not_found`), an unreachable
 * server (`transport`, T16), a stale `version` on an update (`conflict`), a repo with no `scm` block (`config`).
 * A declined PR is not one of these — it is a `PullState`.
 */
export class ScmProviderError extends Error {
  readonly kind: ScmProviderErrorKind;
  readonly provider: string;

  constructor(provider: string, kind: ScmProviderErrorKind, message: string) {
    super(`${provider} scm provider: ${message}`);
    this.name = 'ScmProviderError';
    this.kind = kind;
    this.provider = provider;
  }
}

export interface ScmProvider {
  readonly name: 'bitbucket-server' | 'fake';
  /** §3.2: the account Janus posts as, so it can skip its own comments (§24). */
  currentUser(): Promise<string>;
  /** §3.2: makes `name` exist on `repo`, created from `base` when it does not. Never runs git (§32 rule 11). */
  ensureBranch(repo: string, name: string, base: string): Promise<void>;
  /** §15. Idempotent: creating a PR for a branch that already has an open one returns the existing ref. */
  createPullRequest(input: CreatePullRequestInput): Promise<PullRef>;
  /** D14. The newest pull request for this source branch, or null. */
  findPullRequest(repo: string, branch: string): Promise<PullRef | null>;
  /** §3.2: state, reviewer statuses and merge commit. */
  getPullRequest(ref: PullRef): Promise<PullState>;
  /** §24's activity stream. `cursor` is the last processed id, or null for "everything". */
  listActivitySince(ref: PullRef, cursor: string | null): Promise<Activity[]>;
  /** §3.2, widened by D13 to return the new comment id. `replyTo` is null for a top-level comment. */
  addComment(ref: PullRef, text: string, replyTo: string | null): Promise<string>;
  /** §15, called by T14 at package boundaries. The body comes from `renderPrDescription`. */
  updateDescription(ref: PullRef, body: string): Promise<void>;
}
```

- [ ] **Step 4: Write `src/providers/scm/pr-description.ts`**

```ts
import type { BuildClassification } from '../ci/types.js';

/**
 * Spec §15: "PR descriptions link to the state branch, the plan commit, and sibling PRs, and are updated at
 * package boundaries."
 *
 * A pure function: it reads nothing, writes nothing, and takes no clock, so its output is a function of its
 * input alone and its tests are exact string comparisons rather than snapshots. That matters more than usual
 * here — a snapshot file would make the first run *write* the expectation instead of checking it, which is
 * exactly what a description nobody has read carefully must not do.
 *
 * T10 owns this renderer. **T14 owns calling it** at package boundaries, through
 * `ScmProvider.updateDescription`; nothing in this plan wires the two together.
 */

/**
 * The first line of every Janus-written description.
 *
 * T14 reads it before overwriting: a description that does not start with this marker was written or rewritten
 * by a human, and silently replacing it would destroy their work.
 */
export const PR_DESCRIPTION_MARKER = '<!-- janus:pr-description -->';

export interface PrSibling {
  repo: string;
  url: string | null;
  /** Null when the sibling PR has not been created yet. */
  state: import('./types.js').PullRequestState | null;
}

export interface PrWorkPackage {
  id: string;
  /** `execution.work_packages.<id>.status`, rendered verbatim. */
  status: string;
}

export interface PrDescriptionInput {
  goalId: string;
  goalTitle: string;
  sourceVersion: string;
  targetVersion: string;
  repo: string;
  stateBranch: string;
  stateBranchUrl: string | null;
  /** `plan.approved_commit`, or null while Gate 1 has not passed. */
  planCommit: string | null;
  workPackages: PrWorkPackage[];
  /** Every other repo in the goal. Empty for a single-repo goal, which then renders no sibling section. */
  siblings: PrSibling[];
  lastBuild: { id: string; classification: BuildClassification | null } | null;
  escalated: boolean;
}

export function renderPrDescription(input: PrDescriptionInput): string {
  const out: string[] = [];
  out.push(PR_DESCRIPTION_MARKER);
  out.push(`# Angular ${input.sourceVersion} to ${input.targetVersion}: ${input.repo}`);
  out.push('');
  out.push('Written by Janus and regenerated at every work-package boundary. Edits made here are overwritten; leave review');
  out.push('comments on the diff instead.');
  out.push('');
  if (input.escalated) {
    out.push('> **Escalated.** Janus has stopped on this goal and is waiting for a human direction; see `escalation.md`');
    out.push('> on the state branch, or run `janus escalation show`.');
    out.push('');
  }
  out.push(`- goal: \`${input.goalId}\` — ${input.goalTitle}`);
  out.push(`- repository: \`${input.repo}\``);
  out.push(
    input.stateBranchUrl === null
      ? `- state branch: \`${input.stateBranch}\``
      : `- state branch: [\`${input.stateBranch}\`](${input.stateBranchUrl})`,
  );
  out.push(`- approved plan commit: ${input.planCommit === null ? 'not approved yet' : `\`${input.planCommit}\``}`);
  out.push('');
  out.push('## Work packages');
  out.push('');
  if (input.workPackages.length === 0) {
    out.push('no work packages planned yet');
  } else {
    out.push('| Package | Status |');
    out.push('| --- | --- |');
    for (const workPackage of input.workPackages) out.push(`| \`${workPackage.id}\` | ${workPackage.status} |`);
  }
  out.push('');
  if (input.siblings.length > 0) {
    out.push('## Sibling pull requests');
    out.push('');
    for (const sibling of input.siblings) {
      out.push(
        sibling.url === null || sibling.state === null
          ? `- \`${sibling.repo}\` — not created yet`
          : `- \`${sibling.repo}\` — [pull request](${sibling.url}) (${sibling.state})`,
      );
    }
    out.push('');
  }
  out.push('## Latest PR build');
  out.push('');
  if (input.lastBuild === null) {
    out.push('no build observed yet');
  } else {
    out.push(`\`${input.lastBuild.id}\` — ${input.lastBuild.classification ?? 'not finished'}`);
  }
  return `${out.join('\n').replace(/\n+$/u, '')}\n`;
}
```

- [ ] **Step 5: Replace the `ScmProvider` stub in `src/providers/types.ts`**

Delete the `export interface ScmProvider { ... }` block and its doc comment, and put in its place:

```ts
/**
 * §3.2 `ScmProvider`, declared in `./scm/types.js` and re-exported here, exactly as `CiProvider` is above.
 *
 * The interface and its value types live in their own module because §15's PR model and §24's review loop come
 * with them; this file stays the place a step or a test reaches for "the three providers".
 */
export type {
  Activity,
  ActivityKind,
  CreatePullRequestInput,
  InlineAnchor,
  PullRef,
  PullRequestState,
  PullState,
  ReviewerStatus,
  ScmProvider,
  ScmProviderErrorKind,
} from './scm/types.js';
export { ACTIVITY_KINDS, PULL_REQUEST_STATES, ScmProviderError } from './scm/types.js';
```

`pnpm typecheck` will now fail in `src/providers/fake/scm.ts`, which still implements the two-method stub. Task 11 is that implementation; to keep this task independently green, add the five missing methods to the fake as **minimal throwing stubs** for the length of one task:

```ts
    createPullRequest: async () => {
      throw new ScmProviderError('fake', 'config', 'createPullRequest lands in the next task of this plan');
    },
    findPullRequest: async () => null,
    getPullRequest: async () => {
      throw new ScmProviderError('fake', 'not_found', 'getPullRequest lands in the next task of this plan');
    },
    listActivitySince: async () => [],
    addComment: async () => {
      throw new ScmProviderError('fake', 'config', 'addComment lands in the next task of this plan');
    },
    updateDescription: async () => {
      throw new ScmProviderError('fake', 'config', 'updateDescription lands in the next task of this plan');
    },
```

- [ ] **Step 6: Run the renderer test and the whole suite**

Run: `pnpm vitest run --project unit tests/providers/scm/pr-description.test.ts`
Expected: PASS, 10 tests.

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1176 + 10 = 1186.

- [ ] **Step 7: Commit**

```bash
git add src/providers/scm src/providers/types.ts src/providers/fake/scm.ts tests/providers/scm
git commit -m "feat(providers): add the full ScmProvider interface and the §15 PR description renderer" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 11: The full `fake` SCM provider and its hooks

**Files:**
- Modify (rewrite): `src/providers/fake/scm.ts`
- Test: `tests/providers/fake-scm.test.ts`

**Interfaces:**
- Consumes: every type from `src/providers/scm/types.js` (Task 10); `readFakeStore`, `writeFakeStore`, `FAKE_SCM_FILE` from `./store.js`.
- Produces:
  - `const FAKE_SCM_USER = 'janus-fake'`
  - `interface FakeScmPull { id: number; repo: string; branch: string; base: string; title: string; description: string; state: PullRequestState; version: number; head_commit: string | null; merge_commit: string | null; decline_reason: string | null; reviewers: Record<string, { status: ReviewerStatus['status']; last_reviewed_commit: string | null }>; url: string }`
  - `interface FakeScmActivityRecord { id: string; repo: string; pull: number; kind: ActivityKind; author: string; created_at: string; text: string | null; comment_id: string | null; parent_comment_id: string | null; anchor: InlineAnchor | null; commit: string | null }`
  - `interface FakeScmCall { kind: string; repo: string | null; pull: number | null; at: string; detail: string }`
  - `interface FakeScmStore { user: string; branches: Record<string, Record<string, string>>; pulls: FakeScmPull[]; activity: FakeScmActivityRecord[]; next_pull_id: number; next_activity_id: number; next_comment_id: number; calls: FakeScmCall[] }`
  - `emptyFakeScmStore()`, `normalizeFakeScmStore(raw: unknown)`, `readFakeScm(fakeDir)`, `writeFakeScm(fakeDir, store)`, `seedFakeScm(fakeDir, store)`
  - `class FakeScmHookError extends Error`
  - `interface FakeScmHookInput { repo: string; pull?: number; now: Date }`
  - `fakeScmComment(fakeDir, input: FakeScmHookInput & { author: string; text: string; anchor?: InlineAnchor; replyTo?: string }): string`
  - `fakeScmApprove(fakeDir, input: FakeScmHookInput & { user: string }): void`
  - `fakeScmNeedsWork(fakeDir, input: FakeScmHookInput & { user: string }): void`
  - `fakeScmDecline(fakeDir, input: FakeScmHookInput & { reason: string }): void`
  - `fakeScmMerge(fakeDir, input: FakeScmHookInput & { commit: string }): void`
  - `fakeScmPushCommit(fakeDir, input: FakeScmHookInput & { commit: string }): void`
  - `createFakeScmProvider(input: { fakeDir: string; now(): Date }): ScmProvider`

**Why:** §3.2, §15 and §24, and `tasks.md` T10's "`fake` provider persisted under `fake/scm.json` with test hooks and CLI hooks … for dogfooding". The hooks are ordinary exported functions over `fakeDir` (D18) so the CLI group in Task 13 and the contract suite in Task 12 drive the *same* code — which is what makes Task 13's cross-process test mean something.

**R1 restated for this task:** none of these functions runs git. A merge commit sha is a **parameter** to `fakeScmMerge`, never something computed from a repository; `ensureBranch` records a name and its base and touches no ref. Task 14's provider audit is what enforces it.

- [ ] **Step 1: Write the failing tests**

Create `tests/providers/fake-scm.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScmProviderError } from '../../src/providers/scm/types.js';
import {
  createFakeScmProvider,
  FAKE_SCM_USER,
  FakeScmHookError,
  fakeScmApprove,
  fakeScmComment,
  fakeScmDecline,
  fakeScmMerge,
  fakeScmNeedsWork,
  fakeScmPushCommit,
  readFakeScm,
} from '../../src/providers/fake/scm.js';
import { tempDir } from '../helpers/git-fixtures.js';

const NOW = new Date('2026-09-21T11:00:00.000Z');
const clock = (): Date => NOW;

function dir(): string {
  return join(tempDir('janus-fake-scm-'), 'fake');
}

async function openPull(fakeDir: string) {
  const scm = createFakeScmProvider({ fakeDir, now: clock });
  const ref = await scm.createPullRequest({
    repo: 'ui-kit',
    branch: 'ai/angular-15-to-16',
    base: 'main',
    title: 'Upgrade ui-kit to Angular 16',
    body: 'body',
  });
  return { scm, ref };
}

describe('createFakeScmProvider', () => {
  it('reports a stable user and remembers branches across processes without touching git', async () => {
    const fakeDir = dir();
    const scm = createFakeScmProvider({ fakeDir, now: clock });
    expect(await scm.currentUser()).toBe(FAKE_SCM_USER);
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'main');
    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'other-base');
    const later = createFakeScmProvider({ fakeDir, now: clock });
    await later.ensureBranch('shell', 'ai/angular-15-to-16', 'main');
    // The first base wins: ensureBranch is "make it exist", not "move it".
    expect(readFakeScm(fakeDir).branches).toEqual({
      'ui-kit': { 'ai/angular-15-to-16': 'main' },
      shell: { 'ai/angular-15-to-16': 'main' },
    });
  });

  it('creates a pull request and reads it back', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    expect(ref.id).toBe(1);
    expect(ref.repo).toBe('ui-kit');
    expect(ref.url).toContain('ui-kit');
    const state = await scm.getPullRequest(ref);
    expect(state.state).toBe('OPEN');
    expect(state.branch).toBe('ai/angular-15-to-16');
    expect(state.base).toBe('main');
    expect(state.title).toBe('Upgrade ui-kit to Angular 16');
    expect(state.mergeCommit).toBeNull();
    expect(state.declineReason).toBeNull();
    expect(state.version).toBe(0);
  });

  it('is idempotent about creating a PR for a branch that already has an open one', async () => {
    // §7: a resumed run re-enters the PR-creation step. A second PR for one branch would be a mess a human
    // has to clean up by hand.
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    const again = await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/angular-15-to-16', base: 'main', title: 'x', body: 'y' });
    expect(again.id).toBe(ref.id);
    expect(readFakeScm(fakeDir).pulls).toHaveLength(1);
  });

  it('finds a pull request by branch, and answers null for an unknown branch', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    expect((await scm.findPullRequest('ui-kit', 'ai/angular-15-to-16'))?.id).toBe(ref.id);
    expect(await scm.findPullRequest('ui-kit', 'ai/other')).toBeNull();
    expect(await scm.findPullRequest('shell', 'ai/angular-15-to-16')).toBeNull();
  });

  it('throws a not_found ScmProviderError for a pull request id it never minted', async () => {
    const fakeDir = dir();
    const scm = createFakeScmProvider({ fakeDir, now: clock });
    await expect(scm.getPullRequest({ repo: 'ui-kit', id: 99, url: null })).rejects.toBeInstanceOf(ScmProviderError);
  });

  it('records its own comments as authored by currentUser, so §24 can skip them', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    const commentId = await scm.addComment(ref, 'triggered a rebuild', null);
    const activity = await scm.listActivitySince(ref, null);
    const comment = activity.find((entry) => entry.commentId === commentId);
    expect(comment?.author).toBe(await scm.currentUser());
    expect(comment?.text).toBe('triggered a rebuild');
    expect(comment?.parentCommentId).toBeNull();
  });

  it('threads a reply under its parent', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    const parent = fakeScmComment(fakeDir, { repo: 'ui-kit', author: 'reviewer', text: 'why this?', now: NOW });
    const reply = await scm.addComment(ref, 'no change needed: the API moved', parent);
    const activity = await scm.listActivitySince(ref, null);
    expect(activity.find((entry) => entry.commentId === reply)?.parentCommentId).toBe(parent);
  });

  it('carries an inline anchor with its file and line', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    fakeScmComment(fakeDir, {
      repo: 'ui-kit',
      author: 'reviewer',
      text: 'this cast is wrong',
      anchor: { path: 'src/app/a.ts', line: 42, lineType: 'ADDED' },
      now: NOW,
    });
    const activity = await scm.listActivitySince(ref, null);
    expect(activity.at(-1)?.anchor).toEqual({ path: 'src/app/a.ts', line: 42, lineType: 'ADDED' });
  });

  it('advances the activity cursor, and its ids sort lexicographically past nine', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    for (let index = 0; index < 12; index += 1) {
      fakeScmComment(fakeDir, { repo: 'ui-kit', author: 'reviewer', text: `note ${String(index)}`, now: NOW });
    }
    const all = await scm.listActivitySince(ref, null);
    const ids = all.map((entry) => entry.id);
    expect([...ids]).toEqual([...ids].sort());
    const cursor = ids[4];
    if (cursor === undefined) throw new Error('expected at least five activities');
    const after = await scm.listActivitySince(ref, cursor);
    expect(after.map((entry) => entry.id)).toEqual(ids.slice(5));
  });

  it('records an approval, and resets it when a new commit lands (§24)', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    fakeScmApprove(fakeDir, { repo: 'ui-kit', user: 'reviewer', now: NOW });
    expect((await scm.getPullRequest(ref)).reviewers).toEqual([{ user: 'reviewer', status: 'APPROVED', lastReviewedCommit: null }]);

    fakeScmPushCommit(fakeDir, { repo: 'ui-kit', commit: 'c'.repeat(40), now: NOW });
    const afterPush = await scm.getPullRequest(ref);
    expect(afterPush.reviewers[0]?.status).toBe('UNAPPROVED');
    expect(afterPush.headCommit).toBe('c'.repeat(40));
    const activity = await scm.listActivitySince(ref, null);
    expect(activity.at(-1)).toMatchObject({ kind: 'rescoped', commit: 'c'.repeat(40) });
  });

  it('records NEEDS_WORK as its own activity kind and reviewer status', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    fakeScmNeedsWork(fakeDir, { repo: 'ui-kit', user: 'reviewer', now: NOW });
    expect((await scm.getPullRequest(ref)).reviewers[0]?.status).toBe('NEEDS_WORK');
    expect((await scm.listActivitySince(ref, null)).at(-1)?.kind).toBe('needs_work');
  });

  it('declines with a reason and merges with a commit, both as bookkeeping only', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    fakeScmMerge(fakeDir, { repo: 'ui-kit', commit: 'd'.repeat(40), now: NOW });
    const merged = await scm.getPullRequest(ref);
    expect(merged.state).toBe('MERGED');
    expect(merged.mergeCommit).toBe('d'.repeat(40));
    expect((await scm.listActivitySince(ref, null)).at(-1)?.kind).toBe('merged');

    const other = dir();
    const second = await openPull(other);
    fakeScmDecline(other, { repo: 'ui-kit', reason: 'superseded by the 17 upgrade', now: NOW });
    const declined = await second.scm.getPullRequest(second.ref);
    expect(declined.state).toBe('DECLINED');
    expect(declined.declineReason).toBe('superseded by the 17 upgrade');
  });

  it('refuses to merge, decline or approve a pull request that is not open', async () => {
    // R8. A fake whose merge silently succeeds on an already-declined PR would let a harness scenario "pass"
    // through a transition Bitbucket would have rejected.
    const fakeDir = dir();
    await openPull(fakeDir);
    fakeScmDecline(fakeDir, { repo: 'ui-kit', reason: 'no', now: NOW });
    expect(() => fakeScmMerge(fakeDir, { repo: 'ui-kit', commit: 'e'.repeat(40), now: NOW })).toThrow(FakeScmHookError);
    expect(() => fakeScmApprove(fakeDir, { repo: 'ui-kit', user: 'reviewer', now: NOW })).toThrow(FakeScmHookError);
    expect(() => fakeScmDecline(fakeDir, { repo: 'ui-kit', reason: 'again', now: NOW })).toThrow(/DECLINED/u);
  });

  it('refuses a hook for a repository with no open pull request, naming what it looked for', () => {
    const fakeDir = dir();
    expect(() => fakeScmApprove(fakeDir, { repo: 'ui-kit', user: 'reviewer', now: NOW })).toThrow(/no open pull request for ui-kit/u);
  });

  it('refuses a hook that is ambiguous between two open pull requests', async () => {
    const fakeDir = dir();
    const scm = createFakeScmProvider({ fakeDir, now: clock });
    await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/one', base: 'main', title: 'a', body: '' });
    await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/two', base: 'main', title: 'b', body: '' });
    expect(() => fakeScmApprove(fakeDir, { repo: 'ui-kit', user: 'reviewer', now: NOW })).toThrow(/--pull/u);
    // Naming one resolves it.
    fakeScmApprove(fakeDir, { repo: 'ui-kit', pull: 2, user: 'reviewer', now: NOW });
    expect(readFakeScm(fakeDir).pulls[1]?.reviewers['reviewer']?.status).toBe('APPROVED');
  });

  it('bumps the version when the description is updated', async () => {
    const fakeDir = dir();
    const { scm, ref } = await openPull(fakeDir);
    await scm.updateDescription(ref, 'new body');
    const state = await scm.getPullRequest(ref);
    expect(state.description).toBe('new body');
    expect(state.version).toBe(1);
  });

  it('survives a store written by an older Janus rather than crashing', () => {
    const fakeDir = dir();
    const { writeFakeStore } = require('../../src/providers/fake/store.js') as typeof import('../../src/providers/fake/store.js');
    writeFakeStore(fakeDir, 'scm.json', { user: 'janus-fake', branches: { 'ui-kit': { 'ai/g': 'main' } }, calls: [] });
    const store = readFakeScm(fakeDir);
    expect(store.pulls).toEqual([]);
    expect(store.activity).toEqual([]);
    expect(store.next_pull_id).toBe(1);
    expect(store.branches).toEqual({ 'ui-kit': { 'ai/g': 'main' } });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run --project unit tests/providers/fake-scm.test.ts`
Expected: FAIL — `fakeScmComment is not a function`.

- [ ] **Step 3: Rewrite `src/providers/fake/scm.ts`**

```ts
import { ScmProviderError } from '../scm/types.js';
import type {
  Activity,
  ActivityKind,
  CreatePullRequestInput,
  InlineAnchor,
  PullRef,
  PullRequestState,
  PullState,
  ReviewerStatus,
  ScmProvider,
} from '../scm/types.js';
import { FAKE_SCM_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * Spec §3.2's `fake` SCM provider, persisted under `<workspace>/fake/scm.json`.
 *
 * It is the whole human side of §24 in a JSON file: pull requests, reviewer statuses, an activity stream with
 * inline anchors, declines and merges. The **hooks** below (`fakeScmComment`, `fakeScmApprove`, …) are what a
 * dogfooding human — or a test — uses to play the reviewer, and `janus fake scm <verb>` is a thin argument
 * parser over exactly these functions, so the CLI and the tests exercise one implementation.
 *
 * **It never runs git** (§32 rule 11, §31.29): `ensureBranch` records a name and the base it should have come
 * from, and a merge commit sha is a *parameter* to `fakeScmMerge`, never something computed from a repository.
 * The integration harness brackets every provider call with a reflog snapshot to keep it that way.
 *
 * Store fields are snake_case, unlike the domain types: `fake/scm.json` is a hand-edited dogfooding file and
 * follows the same convention every other persisted file in this repository does. `toPullState` and `toActivity`
 * are the only two places the two spellings meet.
 */

/** The account the fake reports; §3.2 and §24 use it to skip Janus's own comments. */
export const FAKE_SCM_USER = 'janus-fake';

export interface FakeScmPull {
  id: number;
  repo: string;
  branch: string;
  base: string;
  title: string;
  description: string;
  state: PullRequestState;
  version: number;
  head_commit: string | null;
  merge_commit: string | null;
  decline_reason: string | null;
  reviewers: Record<string, { status: ReviewerStatus['status']; last_reviewed_commit: string | null }>;
  url: string;
}

export interface FakeScmActivityRecord {
  id: string;
  repo: string;
  pull: number;
  kind: ActivityKind;
  author: string;
  created_at: string;
  text: string | null;
  comment_id: string | null;
  parent_comment_id: string | null;
  anchor: InlineAnchor | null;
  commit: string | null;
}

export interface FakeScmCall {
  kind: string;
  repo: string | null;
  pull: number | null;
  at: string;
  detail: string;
}

export interface FakeScmStore {
  user: string;
  /** repo -> branch name -> the base it was created from. Intent only; no ref is ever written. */
  branches: Record<string, Record<string, string>>;
  pulls: FakeScmPull[];
  activity: FakeScmActivityRecord[];
  next_pull_id: number;
  next_activity_id: number;
  next_comment_id: number;
  calls: FakeScmCall[];
}

export function emptyFakeScmStore(): FakeScmStore {
  return { user: FAKE_SCM_USER, branches: {}, pulls: [], activity: [], next_pull_id: 1, next_activity_id: 1, next_comment_id: 1, calls: [] };
}

/** Fills in every key a store written by an older Janus is missing. A fake never crashes a run. */
export function normalizeFakeScmStore(raw: unknown): FakeScmStore {
  const empty = emptyFakeScmStore();
  if (typeof raw !== 'object' || raw === null) return empty;
  const partial = raw as Partial<FakeScmStore>;
  return {
    user: partial.user ?? empty.user,
    branches: partial.branches ?? empty.branches,
    pulls: partial.pulls ?? empty.pulls,
    activity: partial.activity ?? empty.activity,
    next_pull_id: partial.next_pull_id ?? (partial.pulls?.length ?? 0) + 1,
    next_activity_id: partial.next_activity_id ?? (partial.activity?.length ?? 0) + 1,
    next_comment_id: partial.next_comment_id ?? empty.next_comment_id,
    calls: partial.calls ?? empty.calls,
  };
}

export function readFakeScm(fakeDir: string): FakeScmStore {
  return normalizeFakeScmStore(readFakeStore<unknown>(fakeDir, FAKE_SCM_FILE, emptyFakeScmStore()));
}

export function writeFakeScm(fakeDir: string, store: FakeScmStore): void {
  writeFakeStore(fakeDir, FAKE_SCM_FILE, store);
}

/** Seeds the store before a run. Anything not given takes its empty value. */
export function seedFakeScm(fakeDir: string, store: Partial<FakeScmStore>): void {
  writeFakeScm(fakeDir, { ...emptyFakeScmStore(), ...store });
}

/** A hook was asked to do something the SCM would have refused. Distinct from `ScmProviderError`, which is the
 * provider's own error type; this is the *human side* saying no. */
export class FakeScmHookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeScmHookError';
  }
}

/** Zero-padded so `id > cursor` is a correct string comparison at the 10th activity and at the 10000th (D17). */
function activityId(sequence: number): string {
  return `a-${String(sequence).padStart(6, '0')}`;
}

function commentId(sequence: number): string {
  return `c-${String(sequence).padStart(6, '0')}`;
}

function toPullState(pull: FakeScmPull): PullState {
  return {
    ref: { repo: pull.repo, id: pull.id, url: pull.url },
    state: pull.state,
    title: pull.title,
    description: pull.description,
    branch: pull.branch,
    base: pull.base,
    version: pull.version,
    reviewers: Object.entries(pull.reviewers).map(([user, value]) => ({
      user,
      status: value.status,
      lastReviewedCommit: value.last_reviewed_commit,
    })),
    mergeCommit: pull.merge_commit,
    declineReason: pull.decline_reason,
    headCommit: pull.head_commit,
  };
}

function toActivity(record: FakeScmActivityRecord): Activity {
  return {
    id: record.id,
    kind: record.kind,
    author: record.author,
    createdAt: record.created_at,
    text: record.text,
    commentId: record.comment_id,
    parentCommentId: record.parent_comment_id,
    anchor: record.anchor,
    commit: record.commit,
  };
}

interface AppendActivityInput {
  pull: FakeScmPull;
  kind: ActivityKind;
  author: string;
  now: Date;
  text?: string;
  comment?: string;
  parent?: string;
  anchor?: InlineAnchor;
  commit?: string;
}

function appendActivity(store: FakeScmStore, input: AppendActivityInput): FakeScmActivityRecord {
  const record: FakeScmActivityRecord = {
    id: activityId(store.next_activity_id),
    repo: input.pull.repo,
    pull: input.pull.id,
    kind: input.kind,
    author: input.author,
    created_at: input.now.toISOString(),
    text: input.text ?? null,
    comment_id: input.comment ?? null,
    parent_comment_id: input.parent ?? null,
    anchor: input.anchor ?? null,
    commit: input.commit ?? null,
  };
  store.next_activity_id += 1;
  store.activity.push(record);
  return record;
}

/**
 * Resolves the pull request a hook applies to.
 *
 * With no `pull`, the single **open** pull request for the repo. Two open ones is an error naming `--pull`
 * rather than a silent guess: a dogfooding session with a two-repo goal and a reopened PR is exactly where a
 * guess would approve the wrong thing.
 */
function resolvePull(store: FakeScmStore, repo: string, id: number | undefined): FakeScmPull {
  if (id !== undefined) {
    const found = store.pulls.find((pull) => pull.repo === repo && pull.id === id);
    if (found === undefined) throw new FakeScmHookError(`no pull request ${String(id)} for ${repo} in fake/scm.json`);
    return found;
  }
  const open = store.pulls.filter((pull) => pull.repo === repo && pull.state === 'OPEN');
  if (open.length === 0) throw new FakeScmHookError(`no open pull request for ${repo} in fake/scm.json`);
  if (open.length > 1) {
    throw new FakeScmHookError(
      `${repo} has ${String(open.length)} open pull requests (${open.map((pull) => pull.id).join(', ')}); name one with --pull`,
    );
  }
  const only = open[0];
  if (only === undefined) throw new FakeScmHookError(`no open pull request for ${repo} in fake/scm.json`);
  return only;
}

function requireOpen(pull: FakeScmPull, verb: string): void {
  if (pull.state !== 'OPEN') {
    throw new FakeScmHookError(`cannot ${verb} pull request ${String(pull.id)} for ${pull.repo}: it is ${pull.state}`);
  }
}

export interface FakeScmHookInput {
  repo: string;
  /** Required only when the repo has more than one open pull request. */
  pull?: number;
  now: Date;
}

/** Posts a comment as somebody other than Janus. Returns the new comment id. */
export function fakeScmComment(
  fakeDir: string,
  input: FakeScmHookInput & { author: string; text: string; anchor?: InlineAnchor; replyTo?: string },
): string {
  const store = readFakeScm(fakeDir);
  const pull = resolvePull(store, input.repo, input.pull);
  requireOpen(pull, 'comment on');
  const comment = commentId(store.next_comment_id);
  store.next_comment_id += 1;
  appendActivity(store, {
    pull,
    kind: 'comment',
    author: input.author,
    now: input.now,
    text: input.text,
    comment,
    ...(input.replyTo === undefined ? {} : { parent: input.replyTo }),
    ...(input.anchor === undefined ? {} : { anchor: input.anchor }),
  });
  store.calls.push({ kind: 'comment', repo: input.repo, pull: pull.id, at: input.now.toISOString(), detail: comment });
  writeFakeScm(fakeDir, store);
  return comment;
}

function setReviewer(
  fakeDir: string,
  input: FakeScmHookInput & { user: string },
  status: ReviewerStatus['status'],
  kind: ActivityKind,
  verb: string,
): void {
  const store = readFakeScm(fakeDir);
  const pull = resolvePull(store, input.repo, input.pull);
  requireOpen(pull, verb);
  pull.reviewers[input.user] = { status, last_reviewed_commit: pull.head_commit };
  appendActivity(store, { pull, kind, author: input.user, now: input.now });
  store.calls.push({ kind, repo: input.repo, pull: pull.id, at: input.now.toISOString(), detail: input.user });
  writeFakeScm(fakeDir, store);
}

export function fakeScmApprove(fakeDir: string, input: FakeScmHookInput & { user: string }): void {
  setReviewer(fakeDir, input, 'APPROVED', 'approved', 'approve');
}

/** §24: "`NEEDS_WORK` is treated as comments present." */
export function fakeScmNeedsWork(fakeDir: string, input: FakeScmHookInput & { user: string }): void {
  setReviewer(fakeDir, input, 'NEEDS_WORK', 'needs_work', 'request changes on');
}

export function fakeScmDecline(fakeDir: string, input: FakeScmHookInput & { reason: string }): void {
  const store = readFakeScm(fakeDir);
  const pull = resolvePull(store, input.repo, input.pull);
  requireOpen(pull, 'decline');
  pull.state = 'DECLINED';
  pull.decline_reason = input.reason;
  appendActivity(store, { pull, kind: 'declined', author: 'human', now: input.now, text: input.reason });
  store.calls.push({ kind: 'declined', repo: input.repo, pull: pull.id, at: input.now.toISOString(), detail: input.reason });
  writeFakeScm(fakeDir, store);
}

/**
 * §24 step 1: "the human merges a repo's PR; Janus detects `MERGED`".
 *
 * The merge commit is a **parameter**. This function runs no git and computes nothing from a repository — a
 * fake that merged for real would be a git write from inside a provider (§32 rule 11), and the §31.29 audit
 * would see it.
 */
export function fakeScmMerge(fakeDir: string, input: FakeScmHookInput & { commit: string }): void {
  const store = readFakeScm(fakeDir);
  const pull = resolvePull(store, input.repo, input.pull);
  requireOpen(pull, 'merge');
  pull.state = 'MERGED';
  pull.merge_commit = input.commit;
  appendActivity(store, { pull, kind: 'merged', author: 'human', now: input.now, commit: input.commit });
  store.calls.push({ kind: 'merged', repo: input.repo, pull: pull.id, at: input.now.toISOString(), detail: input.commit });
  writeFakeScm(fakeDir, store);
}

/**
 * §24: "new commits reset Bitbucket approvals; Janus records this and re-enters review."
 *
 * Called by a scenario (or by the orchestrator's own push, in T12) to tell the fake that the source branch
 * moved. Every reviewer drops back to `UNAPPROVED` and a `rescoped` activity records the new head.
 */
export function fakeScmPushCommit(fakeDir: string, input: FakeScmHookInput & { commit: string }): void {
  const store = readFakeScm(fakeDir);
  const pull = resolvePull(store, input.repo, input.pull);
  requireOpen(pull, 'push to');
  pull.head_commit = input.commit;
  for (const [user, reviewer] of Object.entries(pull.reviewers)) {
    pull.reviewers[user] = { status: 'UNAPPROVED', last_reviewed_commit: reviewer.last_reviewed_commit };
  }
  appendActivity(store, { pull, kind: 'rescoped', author: 'janus', now: input.now, commit: input.commit });
  store.calls.push({ kind: 'rescoped', repo: input.repo, pull: pull.id, at: input.now.toISOString(), detail: input.commit });
  writeFakeScm(fakeDir, store);
}

export interface FakeScmProviderInput {
  fakeDir: string;
  now(): Date;
}

export function createFakeScmProvider(input: FakeScmProviderInput): ScmProvider {
  const { fakeDir } = input;

  const find = (store: FakeScmStore, ref: PullRef): FakeScmPull => {
    const pull = store.pulls.find((candidate) => candidate.repo === ref.repo && candidate.id === ref.id);
    if (pull === undefined) {
      throw new ScmProviderError('fake', 'not_found', `no pull request ${String(ref.id)} for ${ref.repo} in fake/scm.json`);
    }
    return pull;
  };

  const record = (store: FakeScmStore, call: FakeScmCall): void => {
    store.calls.push(call);
    writeFakeScm(fakeDir, store);
  };

  return {
    name: 'fake',

    currentUser: async () => {
      const store = readFakeScm(fakeDir);
      record(store, { kind: 'currentUser', repo: null, pull: null, at: input.now().toISOString(), detail: store.user });
      return store.user;
    },

    ensureBranch: async (repo, name, base) => {
      const store = readFakeScm(fakeDir);
      const branches = store.branches[repo] ?? {};
      // "Make it exist", not "move it": a second call with a different base is a no-op, the way a real
      // create-if-absent is. And no ref is written anywhere — §32 rule 11.
      if (!(name in branches)) branches[name] = base;
      store.branches[repo] = branches;
      record(store, { kind: 'ensureBranch', repo, pull: null, at: input.now().toISOString(), detail: name });
    },

    createPullRequest: async (create: CreatePullRequestInput) => {
      const store = readFakeScm(fakeDir);
      const existing = store.pulls.find(
        (pull) => pull.repo === create.repo && pull.branch === create.branch && pull.state === 'OPEN',
      );
      if (existing !== undefined) {
        record(store, { kind: 'createPullRequest', repo: create.repo, pull: existing.id, at: input.now().toISOString(), detail: 'existing' });
        return { repo: existing.repo, id: existing.id, url: existing.url };
      }
      const id = store.next_pull_id;
      store.next_pull_id += 1;
      const pull: FakeScmPull = {
        id,
        repo: create.repo,
        branch: create.branch,
        base: create.base,
        title: create.title,
        description: create.body,
        state: 'OPEN',
        version: 0,
        head_commit: null,
        merge_commit: null,
        decline_reason: null,
        reviewers: {},
        url: `https://fake.invalid/projects/FE/repos/${create.repo}/pull-requests/${String(id)}`,
      };
      store.pulls.push(pull);
      record(store, { kind: 'createPullRequest', repo: create.repo, pull: id, at: input.now().toISOString(), detail: create.branch });
      return { repo: pull.repo, id: pull.id, url: pull.url };
    },

    findPullRequest: async (repo, branch) => {
      const store = readFakeScm(fakeDir);
      const matches = store.pulls.filter((pull) => pull.repo === repo && pull.branch === branch);
      const newest = matches[matches.length - 1];
      record(store, {
        kind: 'findPullRequest',
        repo,
        pull: newest?.id ?? null,
        at: input.now().toISOString(),
        detail: branch,
      });
      return newest === undefined ? null : { repo: newest.repo, id: newest.id, url: newest.url };
    },

    getPullRequest: async (ref) => {
      const store = readFakeScm(fakeDir);
      const pull = find(store, ref);
      record(store, { kind: 'getPullRequest', repo: ref.repo, pull: ref.id, at: input.now().toISOString(), detail: pull.state });
      return toPullState(pull);
    },

    listActivitySince: async (ref, cursor) => {
      const store = readFakeScm(fakeDir);
      find(store, ref);
      const since = store.activity
        .filter((entry) => entry.repo === ref.repo && entry.pull === ref.id && (cursor === null || entry.id > cursor))
        .sort((left, right) => left.id.localeCompare(right.id));
      record(store, {
        kind: 'listActivitySince',
        repo: ref.repo,
        pull: ref.id,
        at: input.now().toISOString(),
        detail: `${String(since.length)} since ${cursor ?? 'start'}`,
      });
      return since.map(toActivity);
    },

    addComment: async (ref, text, replyTo) => {
      const store = readFakeScm(fakeDir);
      const pull = find(store, ref);
      const comment = commentId(store.next_comment_id);
      store.next_comment_id += 1;
      // Authored by `store.user`, which is what §24's own-comment skip keys on.
      appendActivity(store, {
        pull,
        kind: 'comment',
        author: store.user,
        now: input.now(),
        text,
        comment,
        ...(replyTo === null ? {} : { parent: replyTo }),
      });
      record(store, { kind: 'addComment', repo: ref.repo, pull: ref.id, at: input.now().toISOString(), detail: comment });
      return comment;
    },

    updateDescription: async (ref, body) => {
      const store = readFakeScm(fakeDir);
      const pull = find(store, ref);
      pull.description = body;
      pull.version += 1;
      record(store, { kind: 'updateDescription', repo: ref.repo, pull: ref.id, at: input.now().toISOString(), detail: String(pull.version) });
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project unit tests/providers/fake-scm.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1186 + 17 = 1203.

- [ ] **Step 6: Commit**

```bash
git add src/providers/fake/scm.ts tests/providers/fake-scm.test.ts
git commit -m "feat(providers): implement the full persisted fake SCM provider and its hooks" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 12: The SCM contract suite on the shared scaffold

**Files:**
- Create: `tests/providers/contract/scm.ts`
- Create: `tests/providers/contract/fake-scm.test.ts`

**Interfaces:**
- Consumes: `itWhen`, `contractTitle` from `./capability.js` (Task 6); every type from `src/providers/scm/types.js`; the six hooks from `src/providers/fake/scm.js`.
- Produces:
  - `interface ScmCapabilities { supportsDecline: boolean; supportsMerge: boolean; supportsInlineAnchors: boolean; reportsReviewerStatuses: boolean; reportsNeedsWork: boolean; resetsApprovalOnNewCommit: boolean; supportsDescriptionUpdate: boolean }`
  - `interface ScmContractHooks { comment(ref: PullRef, author: string, text: string, anchor: InlineAnchor | null): Promise<string>; approve(ref: PullRef, user: string): Promise<void>; needsWork(ref: PullRef, user: string): Promise<void>; decline(ref: PullRef, reason: string): Promise<void>; merge(ref: PullRef, commit: string): Promise<void>; pushCommit(ref: PullRef, commit: string): Promise<void> }`
  - `interface ScmContractSubject { provider: ScmProvider; repo: string; branch: string; base: string; hooks: ScmContractHooks; cleanup(): void }`
  - `interface ScmContractOptions { name: string; capabilities: ScmCapabilities; setup(): Promise<ScmContractSubject> }`
  - `describeScmProviderContract(options: ScmContractOptions): void`
  - `FAKE_SCM_CAPABILITIES: ScmCapabilities`

**Why:** §29 item 2's second half — "likewise for SCM providers" — on the scaffold Task 6 already built (R6, D6). `hooks` is the piece that makes one suite work for two very different providers: the fake plays the human by mutating `fake/scm.json`, and T16's Bitbucket entry will play the human by advancing a recorded HTTP fixture. The suite itself never knows which.

Note for T16: §15 says "Bitbucket Server HTTP access tokens cannot merge, which enforces the human-merge rule", so the Bitbucket entry will declare `supportsMerge: false` and `supportsDecline: false` and those two cases will skip with the capability named — which is the correct, visible outcome, not a gap.

- [ ] **Step 1: Write the fake's wiring, which is the suite's first caller**

Create `tests/providers/contract/fake-scm.test.ts`:

```ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFakeScmProvider,
  fakeScmApprove,
  fakeScmComment,
  fakeScmDecline,
  fakeScmMerge,
  fakeScmNeedsWork,
  fakeScmPushCommit,
} from '../../../src/providers/fake/scm.js';
import { tempDir } from '../../helpers/git-fixtures.js';
import { describeScmProviderContract } from './scm.js';
import type { ScmCapabilities, ScmContractSubject } from './scm.js';

/** The fake plays every part of §24, including the two a Bitbucket HTTP access token cannot (§15). */
export const FAKE_SCM_CAPABILITIES: ScmCapabilities = {
  supportsDecline: true,
  supportsMerge: true,
  supportsInlineAnchors: true,
  reportsReviewerStatuses: true,
  reportsNeedsWork: true,
  resetsApprovalOnNewCommit: true,
  supportsDescriptionUpdate: true,
};

const NOW = new Date('2026-09-21T11:00:00.000Z');

async function setup(): Promise<ScmContractSubject> {
  const root = tempDir('janus-contract-fake-scm-');
  const fakeDir = join(root, 'fake');
  return {
    provider: createFakeScmProvider({ fakeDir, now: () => NOW }),
    repo: 'ui-kit',
    branch: 'ai/angular-15-to-16',
    base: 'main',
    hooks: {
      comment: async (ref, author, text, anchor) =>
        fakeScmComment(fakeDir, {
          repo: ref.repo,
          pull: ref.id,
          author,
          text,
          now: NOW,
          ...(anchor === null ? {} : { anchor }),
        }),
      approve: async (ref, user) => {
        fakeScmApprove(fakeDir, { repo: ref.repo, pull: ref.id, user, now: NOW });
      },
      needsWork: async (ref, user) => {
        fakeScmNeedsWork(fakeDir, { repo: ref.repo, pull: ref.id, user, now: NOW });
      },
      decline: async (ref, reason) => {
        fakeScmDecline(fakeDir, { repo: ref.repo, pull: ref.id, reason, now: NOW });
      },
      merge: async (ref, commit) => {
        fakeScmMerge(fakeDir, { repo: ref.repo, pull: ref.id, commit, now: NOW });
      },
      pushCommit: async (ref, commit) => {
        fakeScmPushCommit(fakeDir, { repo: ref.repo, pull: ref.id, commit, now: NOW });
      },
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describeScmProviderContract({ name: 'fake', capabilities: FAKE_SCM_CAPABILITIES, setup });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run --project unit tests/providers/contract/fake-scm.test.ts`
Expected: FAIL — `Failed to resolve import "./scm.js"`.

- [ ] **Step 3: Write the SCM contract suite**

Create `tests/providers/contract/scm.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { ScmProviderError } from '../../../src/providers/scm/types.js';
import type { InlineAnchor, PullRef, ScmProvider } from '../../../src/providers/scm/types.js';
import { contractTitle, itWhen } from './capability.js';

/**
 * Spec §29 item 2, second half: one suite the `fake` and `bitbucket-server` SCM providers both pass.
 *
 * Built on the same scaffold as the CI suite (`./capability.js`), and wired in the same way — one call:
 *
 * ```ts
 * describeScmProviderContract({ name: 'bitbucket-server', capabilities: BITBUCKET_CAPABILITIES, setup });
 * ```
 *
 * `hooks` is what makes one suite fit two providers that are nothing alike. Everything in §24 that a **human**
 * does — commenting, approving, requesting changes, declining, merging, and pushing a commit that resets
 * approvals — is a hook. The fake implements them by mutating `fake/scm.json`; T16 will implement them by
 * advancing a recorded HTTP fixture. The suite never learns which.
 *
 * §15 notes that Bitbucket Server HTTP access tokens cannot merge, which is the mechanism enforcing the
 * human-merge rule — so T16's entry will declare `supportsMerge: false` and those cases will skip with the
 * capability named in the title. That is the correct visible outcome, not a coverage gap.
 */

/** What an SCM provider claims it can do. Declared per provider; never derived from behaviour. */
export interface ScmCapabilities {
  /** The provider can move a pull request to `DECLINED`. */
  supportsDecline: boolean;
  /** The provider can move a pull request to `MERGED`. A Bitbucket HTTP access token cannot (§15). */
  supportsMerge: boolean;
  /** Inline comments carry a file and a line (§33). */
  supportsInlineAnchors: boolean;
  /** `getPullRequest` reports per-reviewer statuses (§24). */
  reportsReviewerStatuses: boolean;
  /** `NEEDS_WORK` is distinguishable from an ordinary comment (§24). */
  reportsNeedsWork: boolean;
  /** A new commit on the source branch resets approvals (§24). */
  resetsApprovalOnNewCommit: boolean;
  /** `updateDescription` is supported (§15, called by T14). */
  supportsDescriptionUpdate: boolean;
}

/** Everything a *human* does in §24, as functions the contract can call. */
export interface ScmContractHooks {
  comment(ref: PullRef, author: string, text: string, anchor: InlineAnchor | null): Promise<string>;
  approve(ref: PullRef, user: string): Promise<void>;
  needsWork(ref: PullRef, user: string): Promise<void>;
  decline(ref: PullRef, reason: string): Promise<void>;
  merge(ref: PullRef, commit: string): Promise<void>;
  pushCommit(ref: PullRef, commit: string): Promise<void>;
}

export interface ScmContractSubject {
  provider: ScmProvider;
  repo: string;
  branch: string;
  base: string;
  hooks: ScmContractHooks;
  cleanup(): void;
}

export interface ScmContractOptions {
  name: string;
  capabilities: ScmCapabilities;
  /** A fresh provider with an empty store, built per test case. */
  setup(): Promise<ScmContractSubject>;
}

const REVIEWER = 'alex';
const COMMIT = 'c'.repeat(40);
const MERGE_COMMIT = 'd'.repeat(40);

export function describeScmProviderContract(options: ScmContractOptions): void {
  const { capabilities } = options;
  let open: ScmContractSubject | null = null;

  const prepare = async (): Promise<{ subject: ScmContractSubject; ref: PullRef }> => {
    const subject = await options.setup();
    open = subject;
    const ref = await subject.provider.createPullRequest({
      repo: subject.repo,
      branch: subject.branch,
      base: subject.base,
      title: `Upgrade ${subject.repo} to Angular 16`,
      body: 'initial body',
    });
    return { subject, ref };
  };

  describe(contractTitle('scm', options.name), () => {
    afterEach(() => {
      open?.cleanup();
      open = null;
    });

    it('reports the provider name it was built as, and a non-empty current user', async () => {
      const { subject } = await prepare();
      expect(['bitbucket-server', 'fake']).toContain(subject.provider.name);
      expect((await subject.provider.currentUser()).trim()).not.toBe('');
    });

    it('creates an open pull request carrying its branch, base and title', async () => {
      const { subject, ref } = await prepare();
      const state = await subject.provider.getPullRequest(ref);
      expect(state.ref.id).toBe(ref.id);
      expect(state.state).toBe('OPEN');
      expect(state.branch).toBe(subject.branch);
      expect(state.base).toBe(subject.base);
      expect(state.title).toContain(subject.repo);
      expect(state.mergeCommit).toBeNull();
      expect(state.declineReason).toBeNull();
    });

    it('returns the existing pull request rather than opening a second one for the same branch', async () => {
      // §7: a resumed run re-enters the PR-creation step, and two PRs for one branch is a mess a human has to
      // clean up by hand.
      const { subject, ref } = await prepare();
      const again = await subject.provider.createPullRequest({
        repo: subject.repo,
        branch: subject.branch,
        base: subject.base,
        title: 'a different title',
        body: 'a different body',
      });
      expect(again.id).toBe(ref.id);
    });

    it('finds a pull request by its source branch, and answers null for a branch with none', async () => {
      const { subject, ref } = await prepare();
      expect((await subject.provider.findPullRequest(subject.repo, subject.branch))?.id).toBe(ref.id);
      expect(await subject.provider.findPullRequest(subject.repo, 'ai/no-such-branch')).toBeNull();
    });

    it('makes a branch exist without complaining when it already does', async () => {
      const { subject } = await prepare();
      await subject.provider.ensureBranch(subject.repo, subject.branch, subject.base);
      await subject.provider.ensureBranch(subject.repo, subject.branch, subject.base);
      // No assertion on a ref: §32 rule 11 gives every git write to the orchestrator, and the integration
      // harness proves the absence of one from the reflogs. Here the contract is only that it is idempotent.
    });

    it('throws a not_found ScmProviderError for a pull request it never created', async () => {
      const { subject } = await prepare();
      await expect(subject.provider.getPullRequest({ repo: subject.repo, id: 9999, url: null })).rejects.toBeInstanceOf(ScmProviderError);
    });

    it('attributes its own comments to currentUser, so §24 can skip them', async () => {
      const { subject, ref } = await prepare();
      const user = await subject.provider.currentUser();
      const commentId = await subject.provider.addComment(ref, 'triggered a rebuild', null);
      const activity = await subject.provider.listActivitySince(ref, null);
      const mine = activity.find((entry) => entry.commentId === commentId);
      expect(mine?.author).toBe(user);
      expect(mine?.kind).toBe('comment');
      expect(mine?.text).toBe('triggered a rebuild');
    });

    it('shows a foreign comment in the activity stream, authored by somebody else', async () => {
      const { subject, ref } = await prepare();
      const user = await subject.provider.currentUser();
      await subject.hooks.comment(ref, REVIEWER, 'please explain this cast', null);
      const activity = await subject.provider.listActivitySince(ref, null);
      const theirs = activity.filter((entry) => entry.kind === 'comment' && entry.author !== user);
      expect(theirs).toHaveLength(1);
      expect(theirs[0]?.text).toBe('please explain this cast');
    });

    it('threads a reply under the comment it answers', async () => {
      // §24: the fix agent may answer `no_change_needed`, which Janus posts as a reply.
      const { subject, ref } = await prepare();
      const parent = await subject.hooks.comment(ref, REVIEWER, 'why this?', null);
      const reply = await subject.provider.addComment(ref, 'no change needed: the API moved', parent);
      const activity = await subject.provider.listActivitySince(ref, null);
      expect(activity.find((entry) => entry.commentId === reply)?.parentCommentId).toBe(parent);
    });

    itWhen(capabilities.supportsInlineAnchors, 'supportsInlineAnchors', 'carries a file and line on an inline comment', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.comment(ref, REVIEWER, 'wrong cast', { path: 'src/app/a.ts', line: 42, lineType: 'ADDED' });
      const activity = await subject.provider.listActivitySince(ref, null);
      const anchored = activity.find((entry) => entry.anchor !== null);
      expect(anchored?.anchor).toEqual({ path: 'src/app/a.ts', line: 42, lineType: 'ADDED' });
    });

    it('advances the activity cursor monotonically and never replays what it already gave', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.comment(ref, REVIEWER, 'first', null);
      const firstBatch = await subject.provider.listActivitySince(ref, null);
      expect(firstBatch.length).toBeGreaterThan(0);
      const cursor = firstBatch[firstBatch.length - 1]?.id;
      if (cursor === undefined) throw new Error('the provider returned an activity with no id');
      expect(await subject.provider.listActivitySince(ref, cursor)).toEqual([]);
      await subject.hooks.comment(ref, REVIEWER, 'second', null);
      const secondBatch = await subject.provider.listActivitySince(ref, cursor);
      expect(secondBatch.map((entry) => entry.text)).toEqual(['second']);
      expect(secondBatch.every((entry) => entry.id > cursor)).toBe(true);
    });

    it('orders activity ids lexicographically well past nine, because the cursor is a string', async () => {
      const { subject, ref } = await prepare();
      for (let index = 0; index < 12; index += 1) {
        await subject.hooks.comment(ref, REVIEWER, `note ${String(index)}`, null);
      }
      const ids = (await subject.provider.listActivitySince(ref, null)).map((entry) => entry.id);
      expect([...ids]).toEqual([...ids].sort());
    });

    itWhen(capabilities.reportsReviewerStatuses, 'reportsReviewerStatuses', 'reports an approval per reviewer', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.approve(ref, REVIEWER);
      const state = await subject.provider.getPullRequest(ref);
      expect(state.reviewers.find((reviewer) => reviewer.user === REVIEWER)?.status).toBe('APPROVED');
      expect((await subject.provider.listActivitySince(ref, null)).some((entry) => entry.kind === 'approved')).toBe(true);
    });

    itWhen(capabilities.reportsNeedsWork, 'reportsNeedsWork', 'distinguishes NEEDS_WORK from an ordinary comment', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.needsWork(ref, REVIEWER);
      expect((await subject.provider.listActivitySince(ref, null)).some((entry) => entry.kind === 'needs_work')).toBe(true);
    });

    itWhen(capabilities.resetsApprovalOnNewCommit, 'resetsApprovalOnNewCommit', 'resets approvals when a new commit lands', async () => {
      // §24: "new commits reset Bitbucket approvals; Janus records this and re-enters review."
      const { subject, ref } = await prepare();
      await subject.hooks.approve(ref, REVIEWER);
      await subject.hooks.pushCommit(ref, COMMIT);
      const state = await subject.provider.getPullRequest(ref);
      expect(state.reviewers.find((reviewer) => reviewer.user === REVIEWER)?.status).not.toBe('APPROVED');
      expect(state.headCommit).toBe(COMMIT);
      const rescoped = (await subject.provider.listActivitySince(ref, null)).filter((entry) => entry.kind === 'rescoped');
      expect(rescoped).toHaveLength(1);
      expect(rescoped[0]?.commit).toBe(COMMIT);
    });

    itWhen(capabilities.supportsDecline, 'supportsDecline', 'reports a decline with its reason', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.decline(ref, 'superseded by the 17 upgrade');
      const state = await subject.provider.getPullRequest(ref);
      expect(state.state).toBe('DECLINED');
      expect(state.declineReason).toBe('superseded by the 17 upgrade');
      expect((await subject.provider.listActivitySince(ref, null)).some((entry) => entry.kind === 'declined')).toBe(true);
    });

    itWhen(capabilities.supportsMerge, 'supportsMerge', 'reports a merge with its merge commit', async () => {
      const { subject, ref } = await prepare();
      await subject.hooks.merge(ref, MERGE_COMMIT);
      const state = await subject.provider.getPullRequest(ref);
      expect(state.state).toBe('MERGED');
      expect(state.mergeCommit).toBe(MERGE_COMMIT);
      expect((await subject.provider.listActivitySince(ref, null)).some((entry) => entry.kind === 'merged')).toBe(true);
    });

    itWhen(capabilities.supportsDescriptionUpdate, 'supportsDescriptionUpdate', 'updates the description in place', async () => {
      const { subject, ref } = await prepare();
      await subject.provider.updateDescription(ref, '<!-- janus:pr-description -->\n# regenerated');
      expect((await subject.provider.getPullRequest(ref)).description).toContain('# regenerated');
    });
  });
}
```

- [ ] **Step 4: Run the fake through the contract**

Run: `pnpm vitest run --project unit tests/providers/contract/fake-scm.test.ts`
Expected: PASS, 17 tests, none skipped.

- [ ] **Step 5: Confirm both suites are selectable together**

Run: `pnpm vitest run --project unit tests/providers/contract -t 'provider contract'`
Expected: four `describe` blocks run — `ci provider contract: fake`, `ci provider contract: local`, `scm provider contract: fake` — 47 passed, 2 skipped.

- [ ] **Step 6: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1203 + 17 = 1220.

- [ ] **Step 7: Commit**

```bash
git add tests/providers/contract
git commit -m "test(providers): add the SCM contract suite on the shared scaffold" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 13: The `janus fake scm` command group

**Files:**
- Create: `src/cli/commands/fake.ts`
- Modify: `src/cli/commands/index.ts:1-27`
- Modify: `tests/helpers/run-cli.ts` (add `runCliProcess`)
- Modify: `tests/cli/commands.test.ts` (the help list)
- Test: `tests/cli/fake-scm-command.test.ts`, `tests/integration/fake-scm-cli.test.ts`

**Interfaces:**
- Consumes: the six hooks and `readFakeScm` from `src/providers/fake/scm.js`; `openWorkspace`, `findWorkspaceRoot` from `src/workspace/open-workspace.js`; `ConfigError` from `src/config/errors.js`.
- Produces:
  - `registerFake(program: Command, ctx: CliContext): void`
  - `runCliProcess(argv: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliResult>` in `tests/helpers/run-cli.ts`

**Why:** `tasks.md` T10 asks for "CLI hooks (`janus fake scm comment|approve|decline|merge`) for dogfooding", and T10's done-when is that they "drive a PR through comment, approval, and merge **across separate processes**". §8's command list does not mention this group because §8 predates it (R4); the plan adds it as a debug/dogfooding group and says so in its own `--help` description, so nobody reads the divergence from §8 as an accident.

"Across separate processes" is the whole point — §3.2's "fakes persist their state under `<workspace>/fake/` because every `janus run` is a new process" is the property being tested — so the integration test **shells out to a real `node`** rather than calling `main()` in-process. Verified on this machine: `node --import tsx src/cli/entry.ts --version` prints `0.0.1`, so the test needs no `pnpm build` first.

- [ ] **Step 1: Add the out-of-process CLI helper**

Append to `tests/helpers/run-cli.ts`:

```ts
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** `src/cli/entry.ts`, run through `tsx` so no `pnpm build` is needed first. */
const ENTRY = fileURLToPath(new URL('../../src/cli/entry.ts', import.meta.url));

/**
 * Runs the CLI in a **real child process**, unlike {@link runCli}, which calls `main()` in this one.
 *
 * Only for the handful of properties that are only true across a process boundary — §3.2's "fakes persist their
 * state under `<workspace>/fake/` because every `janus run` is a new process", and T10's requirement that the
 * `janus fake scm` hooks drive a PR from comment to merge across separate invocations. Everything else should
 * use `runCli`: it is a hundred times faster and it can inject `CliOverrides`, which a child process cannot.
 */
export async function runCliProcess(argv: string[], options: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', ENTRY, ...argv], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message: string };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
    };
  }
}
```

- [ ] **Step 2: Write the failing in-process tests**

Create `tests/cli/fake-scm-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { createFakeScmProvider, readFakeScm } from '../../src/providers/fake/scm.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { runCli } from '../helpers/run-cli.js';
import { createHarnessWorkspace } from '../helpers/workspace-fixtures.js';

const NOW = new Date('2026-09-21T11:00:00.000Z');

async function workspaceWithPull() {
  const workspace = await createHarnessWorkspace();
  const fakeDir = workspacePaths(workspace.root).fakeDir;
  const scm = createFakeScmProvider({ fakeDir, now: () => NOW });
  const ref = await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/angular-15-to-16', base: 'main', title: 'Upgrade ui-kit', body: 'b' });
  return { workspace, fakeDir, ref };
}

describe('janus fake scm', () => {
  it('posts a comment with an inline anchor', async () => {
    const { workspace, fakeDir } = await workspaceWithPull();
    const result = await runCli(
      ['fake', 'scm', 'comment', '--repo', 'ui-kit', '--author', 'alex', '--text', 'wrong cast', '--path', 'src/a.ts', '--line', '42'],
      { cwd: workspace.root },
    );
    expect(result.code).toBe(ExitCode.Ok);
    const comment = readFakeScm(fakeDir).activity.at(-1);
    expect(comment?.author).toBe('alex');
    expect(comment?.text).toBe('wrong cast');
    expect(comment?.anchor).toEqual({ path: 'src/a.ts', line: 42, lineType: 'ADDED' });
    workspace.cleanup();
  });

  it('approves, requests changes, declines and merges', async () => {
    const { workspace, fakeDir } = await workspaceWithPull();
    expect((await runCli(['fake', 'scm', 'approve', '--repo', 'ui-kit', '--user', 'alex'], { cwd: workspace.root })).code).toBe(ExitCode.Ok);
    expect(readFakeScm(fakeDir).pulls[0]?.reviewers['alex']?.status).toBe('APPROVED');
    expect((await runCli(['fake', 'scm', 'needs-work', '--repo', 'ui-kit', '--user', 'alex'], { cwd: workspace.root })).code).toBe(ExitCode.Ok);
    expect(readFakeScm(fakeDir).pulls[0]?.reviewers['alex']?.status).toBe('NEEDS_WORK');
    expect(
      (await runCli(['fake', 'scm', 'merge', '--repo', 'ui-kit', '--commit', 'd'.repeat(40)], { cwd: workspace.root })).code,
    ).toBe(ExitCode.Ok);
    expect(readFakeScm(fakeDir).pulls[0]?.state).toBe('MERGED');
    workspace.cleanup();
  });

  it('reports a hook the SCM would have refused as a usage error, not a crash', async () => {
    const { workspace } = await workspaceWithPull();
    await runCli(['fake', 'scm', 'decline', '--repo', 'ui-kit', '--reason', 'no'], { cwd: workspace.root });
    const second = await runCli(['fake', 'scm', 'merge', '--repo', 'ui-kit', '--commit', 'd'.repeat(40)], { cwd: workspace.root });
    expect(second.code).toBe(ExitCode.UsageError);
    expect(second.stderr).toContain('DECLINED');
    workspace.cleanup();
  });

  it('refuses when workflow.scm_provider is not fake', async () => {
    const workspace = await createHarnessWorkspace({ scmProvider: 'bitbucket-server' });
    const result = await runCli(['fake', 'scm', 'approve', '--repo', 'ui-kit', '--user', 'alex'], { cwd: workspace.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('workflow.scm_provider');
    workspace.cleanup();
  });

  it('prints the store as JSON on demand', async () => {
    const { workspace } = await workspaceWithPull();
    const result = await runCli(['fake', 'scm', 'show', '--json'], { cwd: workspace.root });
    expect(result.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(result.stdout) as { pulls: { repo: string; state: string }[] };
    expect(parsed.pulls[0]).toMatchObject({ repo: 'ui-kit', state: 'OPEN' });
    workspace.cleanup();
  });

  it('prints a human summary by default', async () => {
    const { workspace } = await workspaceWithPull();
    const result = await runCli(['fake', 'scm', 'show'], { cwd: workspace.root });
    expect(result.stdout).toContain('ui-kit #1 OPEN ai/angular-15-to-16');
    workspace.cleanup();
  });
});
```

`createHarnessWorkspace` gains a `scmProvider` option in this step, mirroring `ciProvider`: add `scmProvider?: 'bitbucket-server' | 'fake'` to `HarnessWorkspaceOptions` and write it into the `workflow` block, adding `bitbucket: { url: 'https://bitbucket.invalid' }` when it is `bitbucket-server` (the §28 schema requires the URL then).

Run: `pnpm vitest run --project unit tests/cli/fake-scm-command.test.ts`
Expected: FAIL — `error: unknown command 'fake'`.

- [ ] **Step 3: Implement the command group**

Create `src/cli/commands/fake.ts`:

```ts
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import {
  FakeScmHookError,
  fakeScmApprove,
  fakeScmComment,
  fakeScmDecline,
  fakeScmMerge,
  fakeScmNeedsWork,
  fakeScmPushCommit,
  readFakeScm,
} from '../../providers/fake/scm.js';
import type { InlineAnchor } from '../../providers/scm/types.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { Workspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

/**
 * `janus fake scm comment|approve|needs-work|decline|merge|push|show` — the human side of §24, by hand.
 *
 * **Not in §8's command list, on purpose:** §8 was written before `tasks.md` T10 asked for these, and they are a
 * debug and dogfooding surface rather than part of the workflow. They exist so the §29 item 5 dogfood run can
 * drive a real goal to completion on a machine with no Bitbucket: the developer plays the reviewer from the
 * shell while `janus run` plays the orchestrator.
 *
 * Every verb is a thin parser over the exported hook of the same name in `src/providers/fake/scm.ts`, which is
 * also what the contract suite calls — one implementation, two callers, so an integration test that shells out
 * to this group is testing the same code a unit test does.
 *
 * Refuses unless `workflow.scm_provider` is `fake`: these write `fake/scm.json`, and running them against a
 * `bitbucket-server` workspace would silently build a parallel fiction next to the real pull requests.
 */

interface FakeScmOptions {
  repo: string;
  pull?: string;
  author?: string;
  user?: string;
  text?: string;
  reason?: string;
  commit?: string;
  replyTo?: string;
  path?: string;
  line?: string;
  lineType?: string;
  json?: boolean;
}

function parsePull(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError('--pull', [`expected a positive integer, got "${value}"`]);
  return parsed;
}

function parseAnchor(options: FakeScmOptions): InlineAnchor | undefined {
  if (options.path === undefined && options.line === undefined) return undefined;
  if (options.path === undefined || options.line === undefined) {
    throw new ConfigError('--path/--line', ['an inline anchor needs both --path and --line']);
  }
  const line = Number.parseInt(options.line, 10);
  if (!Number.isInteger(line) || line <= 0) throw new ConfigError('--line', [`expected a positive integer, got "${options.line}"`]);
  const lineType = options.lineType ?? 'ADDED';
  if (lineType !== 'ADDED' && lineType !== 'REMOVED' && lineType !== 'CONTEXT') {
    throw new ConfigError('--line-type', [`expected ADDED, REMOVED or CONTEXT, got "${lineType}"`]);
  }
  return { path: options.path, line, lineType };
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new ConfigError(flag, [`${flag} is required`]);
  return value;
}

/**
 * Opens the workspace, checks the provider, and turns a `FakeScmHookError` into a usage error.
 *
 * A hook refusal ("that pull request is DECLINED") is the human side saying no, which is exit 2 — the same code
 * every other bad-input path in this CLI uses — not exit 1, which would read as "janus is broken".
 */
async function withFakeScm(ctx: CliContext, run: (workspace: Workspace, fakeDir: string) => void): Promise<ExitCode> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.config.workflow.scm_provider !== 'fake') {
      throw new ConfigError('workflow.scm_provider', [
        `janus fake scm writes fake/scm.json, but workflow.scm_provider is "${workspace.config.workflow.scm_provider}"`,
      ]);
    }
    try {
      run(workspace, workspace.paths.fakeDir);
    } catch (error) {
      if (error instanceof FakeScmHookError) throw new ConfigError('janus fake scm', [error.message]);
      throw error;
    }
    return ExitCode.Ok;
  } finally {
    workspace.release();
  }
}

export function registerFake(program: Command, ctx: CliContext): void {
  const fake = program.command('fake').description('Debug and dogfooding helpers for the fake providers');
  const scm = fake.command('scm').description('Play the human reviewer against the fake SCM provider (§24)');

  const common = (command: Command): Command =>
    command.requiredOption('--repo <name>', 'repository name from goal.yaml').option('--pull <id>', 'pull request id, when the repo has more than one open');

  common(scm.command('comment'))
    .description('Post a comment as somebody other than Janus')
    .requiredOption('--author <user>', 'who is commenting')
    .requiredOption('--text <text>', 'the comment body')
    .option('--path <file>', 'inline anchor path (requires --line)')
    .option('--line <n>', 'inline anchor line (requires --path)')
    .option('--line-type <type>', 'ADDED, REMOVED or CONTEXT (default ADDED)')
    .option('--reply-to <comment-id>', 'thread this under an existing comment')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const anchor = parseAnchor(options);
        const id = fakeScmComment(fakeDir, {
          repo: options.repo,
          author: required(options.author, '--author'),
          text: required(options.text, '--text'),
          now: new Date(),
          ...(parsePull(options.pull) === undefined ? {} : { pull: parsePull(options.pull) as number }),
          ...(anchor === undefined ? {} : { anchor }),
          ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        });
        ctx.io.stdout(`commented ${id} on ${options.repo}\n`);
      });
    });

  common(scm.command('approve'))
    .description('Approve the pull request as a reviewer')
    .requiredOption('--user <user>', 'the reviewer')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const pull = parsePull(options.pull);
        fakeScmApprove(fakeDir, { repo: options.repo, user: required(options.user, '--user'), now: new Date(), ...(pull === undefined ? {} : { pull }) });
        ctx.io.stdout(`approved ${options.repo} as ${options.user ?? ''}\n`);
      });
    });

  common(scm.command('needs-work'))
    .description('Mark the pull request NEEDS_WORK as a reviewer (§24)')
    .requiredOption('--user <user>', 'the reviewer')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const pull = parsePull(options.pull);
        fakeScmNeedsWork(fakeDir, { repo: options.repo, user: required(options.user, '--user'), now: new Date(), ...(pull === undefined ? {} : { pull }) });
        ctx.io.stdout(`marked ${options.repo} NEEDS_WORK as ${options.user ?? ''}\n`);
      });
    });

  common(scm.command('decline'))
    .description('Decline the pull request (§24: this escalates the goal on the next run)')
    .requiredOption('--reason <text>', 'why it was declined')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const pull = parsePull(options.pull);
        fakeScmDecline(fakeDir, { repo: options.repo, reason: required(options.reason, '--reason'), now: new Date(), ...(pull === undefined ? {} : { pull }) });
        ctx.io.stdout(`declined ${options.repo}\n`);
      });
    });

  common(scm.command('merge'))
    .description('Merge the pull request, recording the merge commit (bookkeeping only; no git is run)')
    .requiredOption('--commit <sha>', 'the merge commit to record')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const pull = parsePull(options.pull);
        fakeScmMerge(fakeDir, { repo: options.repo, commit: required(options.commit, '--commit'), now: new Date(), ...(pull === undefined ? {} : { pull }) });
        ctx.io.stdout(`merged ${options.repo} at ${options.commit ?? ''}\n`);
      });
    });

  common(scm.command('push'))
    .description('Record a new commit on the source branch, which resets approvals (§24)')
    .requiredOption('--commit <sha>', 'the new head commit')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const pull = parsePull(options.pull);
        fakeScmPushCommit(fakeDir, { repo: options.repo, commit: required(options.commit, '--commit'), now: new Date(), ...(pull === undefined ? {} : { pull }) });
        ctx.io.stdout(`recorded ${options.commit ?? ''} on ${options.repo}; approvals reset\n`);
      });
    });

  scm
    .command('show')
    .description('Print the fake SCM store')
    .option('--json', 'machine-readable output')
    .action(async (options: FakeScmOptions) => {
      ctx.exitCode = await withFakeScm(ctx, (_workspace, fakeDir) => {
        const store = readFakeScm(fakeDir);
        if (options.json === true) {
          ctx.io.stdout(`${JSON.stringify(store, null, 2)}\n`);
          return;
        }
        if (store.pulls.length === 0) ctx.io.stdout('no pull requests\n');
        for (const pull of store.pulls) {
          const reviewers = Object.entries(pull.reviewers).map(([user, value]) => `${user}=${value.status}`).join(' ');
          ctx.io.stdout(`${pull.repo} #${String(pull.id)} ${pull.state} ${pull.branch} -> ${pull.base}${reviewers === '' ? '' : ` [${reviewers}]`}\n`);
        }
        ctx.io.stdout(`${String(store.activity.length)} activity entries\n`);
      });
    });
}
```

Register it in `src/cli/commands/index.ts`: import `registerFake` and call it after `registerCi(program, ctx)`.

Add `'fake'` to the list in `tests/cli/commands.test.ts`'s `lists every top-level command in help` case.

Run: `pnpm vitest run --project unit tests/cli`
Expected: PASS, including the six new cases.

- [ ] **Step 4: Write the failing cross-process test**

Create `tests/integration/fake-scm-cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createFakeScmProvider, readFakeScm } from '../../src/providers/fake/scm.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { runCliProcess } from '../helpers/run-cli.js';
import { createHarnessWorkspace } from '../helpers/workspace-fixtures.js';

/**
 * `tasks.md` T10's done-when: "hooks drive a PR through comment, approval, and merge **across separate
 * processes**".
 *
 * Every step below is a real `node` child process, because that is the property under test: §3.2 says fakes
 * persist under `<workspace>/fake/` precisely because "every `janus run` is a new process", and an in-process
 * test would pass even if the store were an in-memory map.
 */
describe('janus fake scm across processes', () => {
  it('drives a pull request from comment to approval to merge, one process per step', async () => {
    const workspace = await createHarnessWorkspace();
    const fakeDir = workspacePaths(workspace.root).fakeDir;
    const scm = createFakeScmProvider({ fakeDir, now: () => new Date('2026-09-21T11:00:00.000Z') });
    const ref = await scm.createPullRequest({
      repo: 'ui-kit',
      branch: 'ai/angular-15-to-16',
      base: 'main',
      title: 'Upgrade ui-kit to Angular 16',
      body: 'initial body',
    });

    const commented = await runCliProcess(
      ['fake', 'scm', 'comment', '--repo', 'ui-kit', '--author', 'alex', '--text', 'please explain this cast', '--path', 'src/a.ts', '--line', '42'],
      { cwd: workspace.root },
    );
    expect(commented.code, commented.stderr).toBe(0);

    const approved = await runCliProcess(['fake', 'scm', 'approve', '--repo', 'ui-kit', '--user', 'alex'], { cwd: workspace.root });
    expect(approved.code, approved.stderr).toBe(0);

    // A new commit between approval and merge: §24's approval reset, observed from a third process.
    const pushed = await runCliProcess(['fake', 'scm', 'push', '--repo', 'ui-kit', '--commit', 'c'.repeat(40)], { cwd: workspace.root });
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(readFakeScm(fakeDir).pulls[0]?.reviewers['alex']?.status).toBe('UNAPPROVED');

    const reapproved = await runCliProcess(['fake', 'scm', 'approve', '--repo', 'ui-kit', '--user', 'alex'], { cwd: workspace.root });
    expect(reapproved.code, reapproved.stderr).toBe(0);

    const merged = await runCliProcess(['fake', 'scm', 'merge', '--repo', 'ui-kit', '--commit', 'd'.repeat(40)], { cwd: workspace.root });
    expect(merged.code, merged.stderr).toBe(0);

    // The state every process wrote, read back by a sixth one — and then by this one, through the provider.
    const shown = await runCliProcess(['fake', 'scm', 'show', '--json'], { cwd: workspace.root });
    expect(shown.code, shown.stderr).toBe(0);
    const parsed = JSON.parse(shown.stdout) as { pulls: { state: string; merge_commit: string }[]; activity: { kind: string }[] };
    expect(parsed.pulls[0]?.state).toBe('MERGED');
    expect(parsed.pulls[0]?.merge_commit).toBe('d'.repeat(40));
    expect(parsed.activity.map((entry) => entry.kind)).toEqual(['comment', 'approved', 'rescoped', 'approved', 'merged']);

    const state = await scm.getPullRequest(ref);
    expect(state.state).toBe('MERGED');
    expect(state.mergeCommit).toBe('d'.repeat(40));

    const activity = await scm.listActivitySince(ref, null);
    expect(activity[0]?.anchor).toEqual({ path: 'src/a.ts', line: 42, lineType: 'ADDED' });
    expect(activity.map((entry) => entry.id)).toEqual([...activity.map((entry) => entry.id)].sort());

    workspace.cleanup();
  });

  it('refuses a second merge from a separate process, rather than silently succeeding', async () => {
    // R8: a fake whose merge succeeds twice would let a harness scenario "pass" through a transition Bitbucket
    // would have rejected.
    const workspace = await createHarnessWorkspace();
    const fakeDir = workspacePaths(workspace.root).fakeDir;
    const scm = createFakeScmProvider({ fakeDir, now: () => new Date('2026-09-21T11:00:00.000Z') });
    await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/angular-15-to-16', base: 'main', title: 't', body: 'b' });

    expect((await runCliProcess(['fake', 'scm', 'merge', '--repo', 'ui-kit', '--commit', 'd'.repeat(40)], { cwd: workspace.root })).code).toBe(0);
    const second = await runCliProcess(['fake', 'scm', 'merge', '--repo', 'ui-kit', '--commit', 'e'.repeat(40)], { cwd: workspace.root });
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('MERGED');
    expect(readFakeScm(fakeDir).pulls[0]?.merge_commit).toBe('d'.repeat(40));

    workspace.cleanup();
  });
});
```

- [ ] **Step 5: Run the cross-process test**

Run: `pnpm vitest run --project integration tests/integration/fake-scm-cli.test.ts`
Expected: PASS, 2 tests. The first spawns six `node` processes and takes a few seconds; the integration lane's 120-second `testTimeout` covers it comfortably.

- [ ] **Step 6: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1220 + 6 = 1226, integration 28 + 2 = 30 passed, 12 skipped.

- [ ] **Step 7: Commit**

```bash
git add src/cli tests/cli tests/helpers tests/integration
git commit -m "feat(cli): add the janus fake scm dogfooding command group" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 14: Audit every provider call in the harness, and the integration scenarios

**Files:**
- Modify: `tests/integration/harness/git-audit.ts` (append `ProviderGitWrite`, `auditCiProvider`, `auditScmProvider`)
- Modify: `tests/integration/harness/harness.ts` (seeds, the provider audit, `expectNoProviderGitWrites`)
- Create: `tests/integration/providers.test.ts`

**Interfaces:**
- Consumes: `captureRefLogs`, `diffRefLogs`, `AuditTarget`, `GitWrite` from `./git-audit.js`; `seedFakeCi` from `src/providers/fake/ci.js`; `seedFakeScm`, the six hooks from `src/providers/fake/scm.js`; `signatureFromDigest` from `src/providers/ci/signature.js`.
- Produces:
  - `interface ProviderGitWrite extends GitWrite { provider: string; method: string }`
  - `auditCiProvider(inner: CiProvider, targets: readonly AuditTarget[], sink: ProviderGitWrite[]): CiProvider`
  - `auditScmProvider(inner: ScmProvider, targets: readonly AuditTarget[], sink: ProviderGitWrite[]): ScmProvider`
  - `HarnessOptions.ci?: FakeCiStore['script']`, `HarnessOptions.scm?: Partial<FakeScmStore>`, `HarnessOptions.expectProviderGitWrites?: true`
  - `Harness.providerGitWrites: ProviderGitWrite[]`
  - `expectNoProviderGitWrites(harness: Harness): void`

**Why:** R1 and §32 rule 11. Today `tests/integration/harness/git-audit.ts` brackets **only** `AgentRunner.run()`; a provider that quietly ran `git merge` would sail past every scenario in the repository. The whole reason the fake SCM's merge takes a commit sha as a parameter is that it must not compute one, and prose in a doc comment is not a guarantee. After this task, every CI and SCM call in every harness scenario is bracketed by the same reflog snapshot that already brackets agent runs, and a violation fails the test that caused it — by default, with an opt-out for a test that deliberately wants one.

§29 item 3 then gets its T09/T10 scenarios: the §16.1 find-trigger-wait-classify-digest loop end to end, the §24 comment-approve-reset-approve-merge loop end to end, and the `local` provider against a real repository with a real command and a real JUnit file.

- [ ] **Step 1: Write the failing audit test**

Create `tests/integration/providers.test.ts` with the audit case first:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { signatureFromDigest } from '../../src/providers/ci/signature.js';
import { fakeScmApprove, fakeScmComment, fakeScmMerge, fakeScmPushCommit, readFakeScm } from '../../src/providers/fake/scm.js';
import { runCli } from '../helpers/run-cli.js';
import { createHarnessWorkspace } from '../helpers/workspace-fixtures.js';
import { createHarness, expectNoAgentGitWrites, expectNoProviderGitWrites } from './harness/harness.js';

const SPECS = [{ name: 'ui-kit', kind: 'library' as const }];
const REV_A = 'a'.repeat(40);
const REV_B = 'b'.repeat(40);
const LIMITS = { maxTests: 50, maxTestDetailLines: 20, logTailLines: 400, maxErrorWindows: 10, maxBytes: 65_536, redact: true };
const WAIT = { timeoutMs: 5000, pollIntervalMs: 1 };

describe('provider git audit', () => {
  it('sees no git write from any CI or SCM call in a full §16.1 and §24 sequence', async () => {
    // §32 rule 11 and §31.29. The fake SCM's merge takes its commit as a parameter precisely so that it never
    // computes one from a repository; this is the test that keeps it that way.
    const harness = await createHarness(SPECS, {
      ci: { 'ui-kit': [{ missing: true, classification: 'success' }] },
      scm: {},
    });
    const { ci, scm } = harness.providers;

    expect(await ci.findBuild('ui-kit', REV_A, 'Fe_UiKit_Build')).toBeNull();
    const ref = await ci.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/angular-15-to-16', revision: REV_A, params: {} });
    expect((await ci.waitForBuild(ref, WAIT)).classification).toBe('success');

    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'main');
    const pull = await scm.createPullRequest({ repo: 'ui-kit', branch: 'ai/angular-15-to-16', base: 'main', title: 't', body: 'b' });
    await scm.addComment(pull, 'triggered the PR build', null);
    fakeScmApprove(harness.fakeDir, { repo: 'ui-kit', user: 'alex', now: new Date() });
    fakeScmMerge(harness.fakeDir, { repo: 'ui-kit', commit: 'd'.repeat(40), now: new Date() });
    expect((await scm.getPullRequest(pull)).state).toBe('MERGED');

    expectNoProviderGitWrites(harness);
    expectNoAgentGitWrites(harness);
  });
});
```

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: FAIL — `expectNoProviderGitWrites is not exported by './harness/harness.js'`, and `HarnessOptions` has no `ci`/`scm`.

- [ ] **Step 2: Add the provider audit wrappers**

Append to `tests/integration/harness/git-audit.ts`:

```ts
/** A git write that happened inside a provider call: a §32 rule 11 violation by an adapter rather than an agent. */
export interface ProviderGitWrite extends GitWrite {
  provider: string;
  method: string;
}

/**
 * Brackets one provider call with a reflog snapshot of every git repository the workspace touches, pushing any
 * ref update into `sink`.
 *
 * The same mechanism `auditAgentRunner` applies to `AgentRunner.run()`, for the same reason and with the same
 * `finally`: a provider that writes and then throws must still be caught. §3.2 gives every git write to the
 * orchestrator — a provider that ran `git merge` to compute a merge commit, or `git push` to "ensure" a branch,
 * would be invisible to every scenario in this repository without this.
 */
async function auditCall<T>(
  provider: string,
  method: string,
  targets: readonly AuditTarget[],
  sink: ProviderGitWrite[],
  call: () => Promise<T>,
): Promise<T> {
  const before = await captureRefLogs(targets);
  try {
    return await call();
  } finally {
    for (const write of diffRefLogs(before, await captureRefLogs(targets))) {
      sink.push({ ...write, provider, method });
    }
  }
}

export function auditCiProvider(inner: CiProvider, targets: readonly AuditTarget[], sink: ProviderGitWrite[]): CiProvider {
  const audit = <T>(method: string, call: () => Promise<T>): Promise<T> => auditCall(inner.name, method, targets, sink, call);
  return {
    name: inner.name,
    findBuild: (repo, revision, buildTypeId) => audit('findBuild', () => inner.findBuild(repo, revision, buildTypeId)),
    triggerBuild: (input) => audit('triggerBuild', () => inner.triggerBuild(input)),
    waitForBuild: (ref, options) => audit('waitForBuild', () => inner.waitForBuild(ref, options)),
    failureDigest: (ref, limits, exceptions) => audit('failureDigest', () => inner.failureDigest(ref, limits, exceptions)),
  };
}

export function auditScmProvider(inner: ScmProvider, targets: readonly AuditTarget[], sink: ProviderGitWrite[]): ScmProvider {
  const audit = <T>(method: string, call: () => Promise<T>): Promise<T> => auditCall(inner.name, method, targets, sink, call);
  return {
    name: inner.name,
    currentUser: () => audit('currentUser', () => inner.currentUser()),
    ensureBranch: (repo, name, base) => audit('ensureBranch', () => inner.ensureBranch(repo, name, base)),
    createPullRequest: (input) => audit('createPullRequest', () => inner.createPullRequest(input)),
    findPullRequest: (repo, branch) => audit('findPullRequest', () => inner.findPullRequest(repo, branch)),
    getPullRequest: (ref) => audit('getPullRequest', () => inner.getPullRequest(ref)),
    listActivitySince: (ref, cursor) => audit('listActivitySince', () => inner.listActivitySince(ref, cursor)),
    addComment: (ref, text, replyTo) => audit('addComment', () => inner.addComment(ref, text, replyTo)),
    updateDescription: (ref, body) => audit('updateDescription', () => inner.updateDescription(ref, body)),
  };
}

/** One indented line per violation, for the `expectNoProviderGitWrites` failure message. */
export function formatProviderGitWrites(writes: readonly ProviderGitWrite[]): string {
  return writes
    .map((write) => `  ${write.label} ${write.ref} ${write.sha.slice(0, 7)} "${write.subject}" (during ${write.provider}.${write.method})`)
    .join('\n');
}
```

Add `import type { CiProvider, ScmProvider } from '../../../src/providers/types.js';` to that file's imports.

- [ ] **Step 3: Wire the audit and the seeds into the harness**

In `tests/integration/harness/harness.ts`:

Add to the imports:

```ts
import { createFakeCiProvider, seedFakeCi } from '../../../src/providers/fake/ci.js';
import type { FakeCiStore } from '../../../src/providers/fake/ci.js';
import { createFakeScmProvider, seedFakeScm } from '../../../src/providers/fake/scm.js';
import type { FakeScmStore } from '../../../src/providers/fake/scm.js';
import { auditAgentRunner, auditCiProvider, auditScmProvider, formatGitWrites, formatProviderGitWrites } from './git-audit.js';
import type { AgentGitWrite, AuditTarget, ProviderGitWrite } from './git-audit.js';
```

Add to `HarnessOptions`:

```ts
  /** Seeds `fake/ci.json`'s script (spec §3.2) before the first run. */
  ci?: FakeCiStore['script'];
  /** Seeds `fake/scm.json` before the first run. */
  scm?: Partial<FakeScmStore>;
  /**
   * Opts this harness out of the automatic §32 rule 11 provider check, for a test that deliberately makes a
   * provider write. Everything else gets the check for free, so forgetting it cannot silently drop it.
   */
  expectProviderGitWrites?: true;
```

Add to `Harness`:

```ts
  /** §32 rule 11: git writes observed inside a CI or SCM provider call. Empty on a healthy run. */
  providerGitWrites: ProviderGitWrite[];
```

In `createHarness`, after the `seedFakeAgents` line:

```ts
  if (options.ci !== undefined) seedFakeCi(paths.fakeDir, options.ci);
  if (options.scm !== undefined) seedFakeScm(paths.fakeDir, options.scm);
```

and replace the `providers` construction with:

```ts
  const providerGitWrites: ProviderGitWrite[] = [];
  if (options.expectProviderGitWrites !== true) {
    onTestFinished(() => {
      assertNoProviderGitWrites(providerGitWrites);
    });
  }
  const inner = options.agentRunner ?? createFakeAgentRunner({ paths, now });
  const providers: Providers = {
    agent: auditAgentRunner(inner, auditTargets, agentGitWrites),
    // `sleep` is a no-op here: a scripted queue exists to exercise the §16.1 wait loop, not to spend wall-clock
    // time in the integration lane.
    ci: auditCiProvider(createFakeCiProvider({ fakeDir: paths.fakeDir, now, sleep: async () => undefined }), auditTargets, providerGitWrites),
    scm: auditScmProvider(createFakeScmProvider({ fakeDir: paths.fakeDir, now }), auditTargets, providerGitWrites),
  };
```

Add `providerGitWrites` to the returned `harness` object, and append these two functions beside `assertNoAgentGitWrites`:

```ts
function assertNoProviderGitWrites(writes: readonly ProviderGitWrite[]): void {
  if (writes.length === 0) return;
  throw new Error(
    `spec §32 rule 11 violated: ${writes.length} git ref update(s) happened inside a provider call:\n${formatProviderGitWrites(writes)}`,
  );
}

/**
 * §32 rule 11: fails with every offending reflog entry when a CI or SCM provider performed a git write.
 *
 * `createHarness` already runs this when the test finishes unless `expectProviderGitWrites` opted out; this
 * stays exported so a test can assert the property at a specific point, or name it for the reader.
 */
export function expectNoProviderGitWrites(harness: Harness): void {
  assertNoProviderGitWrites(harness.providerGitWrites);
}
```

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 4: Prove the provider audit actually catches a write**

Add this case to `tests/integration/providers.test.ts`:

```ts
  it('catches a provider that writes a ref, which is what makes the green result above mean something', async () => {
    const harness = await createHarness(SPECS, { expectProviderGitWrites: true });
    const dir = join(harness.root, 'repos', 'ui-kit');
    // A provider that "ensured" a branch by actually creating one — the §32 rule 11 violation this audit exists
    // to catch. Done here through the same seam a misbehaving adapter would use.
    const rogue = {
      ...harness.providers.scm,
      ensureBranch: async (repo: string, name: string, base: string) => {
        await runGit(dir, ['branch', name, 'HEAD']);
        await harness.providers.scm.ensureBranch(repo, name, base);
      },
    };
    const audited = auditScmProvider(rogue, harness.auditTargets, harness.providerGitWrites);
    await audited.ensureBranch('ui-kit', 'rogue-branch', 'main');
    expect(harness.providerGitWrites.length).toBeGreaterThan(0);
    expect(harness.providerGitWrites[0]?.method).toBe('ensureBranch');
    expect(harness.providerGitWrites.map((write) => write.ref).join(' ')).toContain('rogue-branch');
  });
```

with `import { runGit } from '../../src/git/run.js';` and `import { auditScmProvider } from './harness/git-audit.js';` added to the file.

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: PASS, 2 tests. The second uses `expectProviderGitWrites: true`, so the automatic assertion does not fire on its deliberate violation.

- [ ] **Step 5: Add the §16.1 end-to-end scenario**

Append to `tests/integration/providers.test.ts`:

```ts
describe('the §16.1 PR build loop, end to end on the fake provider', () => {
  it('finds nothing, triggers, waits, classifies, digests, and signs the failure stably', async () => {
    const harness = await createHarness(SPECS, {
      ci: {
        'ui-kit': [
          {
            missing: true,
            classification: 'tests_failed',
            runningPolls: 2,
            failedTests: [
              { identity: 'AppComponent > renders the title', name: 'renders the title', suite: 'AppComponent', newFailure: true, details: 'expected a to be b' },
            ],
            log: [
              'compiling ui-kit',
              'JANUS_TEAMCITY_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
              "src/app/a.ts:14:22 - error TS2551: Property 'titel' does not exist.",
              '1 test failed',
            ].join('\n'),
            links: ['https://fake.invalid/build/1'],
          },
          { classification: 'success', log: 'green' },
        ],
      },
    });
    const { ci } = harness.providers;

    // §16.1 step 1: no build appears for this revision.
    expect(await ci.findBuild('ui-kit', REV_A, 'Fe_UiKit_Build')).toBeNull();
    // §16.1 step 2: explicit trigger.
    const ref = await ci.triggerBuild({ repo: 'ui-kit', buildTypeId: 'Fe_UiKit_Build', branch: 'ai/angular-15-to-16', revision: REV_A, params: {} });
    // §16.1 step 3: wait through the queue, then classify.
    const outcome = await ci.waitForBuild(ref, WAIT);
    expect(outcome.status).toBe('finished');
    expect(outcome.classification).toBe('tests_failed');
    expect(outcome.failedTests.map((test) => test.identity)).toEqual(['AppComponent > renders the title']);

    // §16.2: the digest is bounded, redacted, and carries the error window.
    const digest = await ci.failureDigest(ref, LIMITS, []);
    expect(digest.bytes).toBeLessThanOrEqual(LIMITS.maxBytes);
    expect(JSON.stringify(digest)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(digest.errorWindows.some((window) => window.errorLine.includes('TS2551'))).toBe(true);

    // §16.3: the same failure signs the same, which is what no-progress detection rests on.
    const again = await ci.failureDigest(ref, LIMITS, []);
    expect(signatureFromDigest(digest, [], harness.root)).toBe(signatureFromDigest(again, [], harness.root));

    // The next revision is the next scripted attempt, and it is green.
    const second = await ci.findBuild('ui-kit', REV_B, 'Fe_UiKit_Build');
    if (second === null) throw new Error('expected a build for the second revision');
    expect((await ci.waitForBuild(second, WAIT)).classification).toBe('success');

    expectNoProviderGitWrites(harness);
  });

  it('keeps an infra outcome distinguishable from a defect, across a resumed process', async () => {
    // §31.32: an infrastructure failure never consumes a debug attempt, which starts with never looking like
    // one. And §7: a second process reading the same fake/ci.json sees the same answer.
    const harness = await createHarness(SPECS, {
      ci: { 'ui-kit': [{ classification: 'infra', rawStatus: 'CANCELLED', log: 'agent lost' }] },
    });
    const ref = await harness.providers.ci.findBuild('ui-kit', REV_A, 'Fe_UiKit_Build');
    if (ref === null) throw new Error('expected a build');
    expect((await harness.providers.ci.waitForBuild(ref, WAIT)).classification).toBe('infra');

    const { createFakeCiProvider } = await import('../../src/providers/fake/ci.js');
    const second = createFakeCiProvider({ fakeDir: harness.fakeDir, now: () => new Date(), sleep: async () => undefined });
    const outcome = await second.waitForBuild(ref, WAIT);
    expect(outcome.classification).toBe('infra');
    expect(outcome.rawStatus).toBe('CANCELLED');
  });
});
```

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the §24 review-loop scenario**

Append to `tests/integration/providers.test.ts`:

```ts
describe('the §24 review loop, end to end on the fake provider', () => {
  it('walks a pull request from comment through approval reset to merge, cursor by cursor', async () => {
    const harness = await createHarness(SPECS, { scm: {} });
    const { scm } = harness.providers;
    const janus = await scm.currentUser();

    await scm.ensureBranch('ui-kit', 'ai/angular-15-to-16', 'main');
    const pull = await scm.createPullRequest({
      repo: 'ui-kit',
      branch: 'ai/angular-15-to-16',
      base: 'main',
      title: 'Upgrade ui-kit to Angular 16',
      body: '<!-- janus:pr-description -->\n# initial',
    });

    // A reviewer leaves an inline comment; Janus answers it. §24: Janus skips its own comments, so the loop
    // must be able to tell the two apart from the activity stream alone.
    const theirs = fakeScmComment(harness.fakeDir, {
      repo: 'ui-kit',
      author: 'alex',
      text: 'this cast is wrong',
      anchor: { path: 'src/app/a.ts', line: 42, lineType: 'ADDED' },
      now: new Date(),
    });
    const mine = await scm.addComment(pull, 'no change needed: the API moved in 16', theirs);

    let cursor: string | null = null;
    const first = await scm.listActivitySince(pull, cursor);
    const foreign = first.filter((entry) => entry.kind === 'comment' && entry.author !== janus);
    expect(foreign.map((entry) => entry.commentId)).toEqual([theirs]);
    expect(first.find((entry) => entry.commentId === mine)?.parentCommentId).toBe(theirs);
    expect(foreign[0]?.anchor).toEqual({ path: 'src/app/a.ts', line: 42, lineType: 'ADDED' });
    cursor = first[first.length - 1]?.id ?? null;
    expect(await scm.listActivitySince(pull, cursor)).toEqual([]);

    // Approval, then a new commit that resets it (§24), then approval again.
    fakeScmApprove(harness.fakeDir, { repo: 'ui-kit', user: 'alex', now: new Date() });
    expect((await scm.getPullRequest(pull)).reviewers[0]?.status).toBe('APPROVED');
    fakeScmPushCommit(harness.fakeDir, { repo: 'ui-kit', commit: 'c'.repeat(40), now: new Date() });
    const rescoped = await scm.getPullRequest(pull);
    expect(rescoped.reviewers[0]?.status).toBe('UNAPPROVED');
    expect(rescoped.headCommit).toBe('c'.repeat(40));
    fakeScmApprove(harness.fakeDir, { repo: 'ui-kit', user: 'alex', now: new Date() });

    // The description is refreshed at the package boundary (the call T14 will make).
    await scm.updateDescription(pull, '<!-- janus:pr-description -->\n# refreshed');
    expect((await scm.getPullRequest(pull)).description).toContain('# refreshed');

    // And the human merges.
    fakeScmMerge(harness.fakeDir, { repo: 'ui-kit', commit: 'd'.repeat(40), now: new Date() });
    const merged = await scm.getPullRequest(pull);
    expect(merged.state).toBe('MERGED');
    expect(merged.mergeCommit).toBe('d'.repeat(40));

    const everything = await scm.listActivitySince(pull, null);
    expect(everything.map((entry) => entry.kind)).toEqual(['comment', 'comment', 'approved', 'rescoped', 'approved', 'merged']);
    expect(readFakeScm(harness.fakeDir).pulls).toHaveLength(1);

    expectNoProviderGitWrites(harness);
    expectNoAgentGitWrites(harness);
  });
});
```

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Add the `local` provider scenario against a real repository**

Append to `tests/integration/providers.test.ts`:

```ts
describe('the local CI provider against a real repository', () => {
  it('runs a real command, reads the JUnit it wrote, and classifies the build tests_failed', async () => {
    // The only place in this plan where a real shell command runs against a real checkout: everything else
    // injects a `LocalCommandRunner`. Driven through `janus ci`, so the CLI wiring is exercised too.
    const workspace = await createHarnessWorkspace({
      ciProvider: 'local',
      localCi: {
        repos: {
          'ui-kit': {
            test: 'node write-junit.mjs; exit 1',
            junit: 'reports/**/*.xml',
          },
        },
      },
    });
    const repo = join(workspace.root, 'repos', 'ui-kit');
    mkdirSync(join(repo, 'reports'), { recursive: true });
    writeFileSync(
      join(repo, 'write-junit.mjs'),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "mkdirSync('reports', { recursive: true });",
        "writeFileSync('reports/results.xml', `<testsuite>",
        '  <testcase classname="sample.test.ts" name="AppComponent &gt; renders"><failure message="expected a to be b"/></testcase>',
        '  <testcase classname="sample.test.ts" name="AppComponent &gt; is created"/>',
        '</testsuite>`);',
        "console.log('src/app/a.ts:14:22 - error TS2551: nope');",
      ].join('\n'),
    );

    const triggered = await runCli(['ci', 'trigger', '--repo', 'ui-kit', '--revision', REV_A], { cwd: workspace.root });
    expect(triggered.code, triggered.stderr).toBe(ExitCode.Ok);
    const buildId = /build ([^\s]+)/u.exec(triggered.stdout)?.[1];
    if (buildId === undefined) throw new Error(`no build id in: ${triggered.stdout}`);
    expect(existsSync(join(workspace.root, '.local-ci', 'ui-kit', `${buildId}.json`))).toBe(true);

    const waited = await runCli(['ci', 'wait', '--repo', 'ui-kit', '--build', buildId, '--revision', REV_A], { cwd: workspace.root });
    expect(waited.stdout).toContain('classification: tests_failed');
    expect(waited.stdout).toContain('failed tests: 1');

    const digested = await runCli(['ci', 'digest', '--repo', 'ui-kit', '--build', buildId, '--revision', REV_A], { cwd: workspace.root });
    expect(digested.stdout).toContain('sample.test.ts › AppComponent > renders');
    expect(digested.stdout).toContain('TS2551');

    // §16.1 step 1 now finds the cached build instead of running the command again.
    const again = await runCli(['ci', 'trigger', '--repo', 'ui-kit', '--revision', REV_A], { cwd: workspace.root });
    expect(again.stdout).toContain(`found build ${buildId}`);

    workspace.cleanup();
  }, 60_000);
});
```

Run: `pnpm vitest run --project integration tests/integration/providers.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Confirm the existing scenarios still pass with the audit in place**

Run: `pnpm test:integration`
Expected: PASS. Every pre-existing scenario now has its provider calls audited too, and must stay green — if one fails with "spec §32 rule 11 violated", a provider really is writing git and that is the bug this task exists to surface.

- [ ] **Step 9: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; unit count 1226, integration 30 + 6 = 36 passed, 12 skipped.

- [ ] **Step 10: Commit**

```bash
git add tests/integration
git commit -m "test(harness): audit every provider call for git writes and add the T09/T10 scenarios" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 15: Record T09 and T10 in the status table

**Files:**
- Modify: `tasks.md:22`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in code. This task closes the loop `tasks.md` opens for every task.

**Why:** `tasks.md`'s Status section says "Update this table when a task merges to `main`." T08 was recorded in `f78d981`; T09 and T10 get the same treatment, and the "next:" pointer moves on to T11 — which `tasks.md` lists as depending on T05, T08, T09 and T10, all of which are then done.

- [ ] **Step 1: Confirm the numbers before writing them down**

Run: `pnpm test:unit` and `pnpm test:integration`
Record the exact counts each prints. Do not write a number this step did not produce.

- [ ] **Step 2: Replace the pending row**

In `tasks.md`, replace line 22:

```markdown
| T09 to T24 | pending | | next: T09 (CI providers) and T10 (SCM providers), parallel B — bundle them |
```

with three rows, substituting the real merge sha and the counts from Step 1:

```markdown
| T09 | done | <sha> (2026-09-21) | <N> tests; `CiProvider`, §16.1 classification, §16.2 digest, §16.3 signature, `local` and `fake` providers, `janus ci wait\|trigger\|digest`, shared contract scaffold. §16.2/§28 and §5 spec edits: `digest.max_test_detail_lines`, `.local-ci/` |
| T10 | done | <sha> (2026-09-21) | same branch as T09; `ScmProvider`, persisted fake SCM, PR description renderer, `janus fake scm` group, SCM contract suite, provider git audit. §3.2 widened: `failureDigest` exceptions, `addComment` id, `findPullRequest`, `updateDescription` |
| T11 to T24 | pending | | next: T11 (prepare, discovery, baseline, planning, Gate 1) |
```

Note the escaped pipes in `janus ci wait\|trigger\|digest`: an unescaped `|` would end the table cell.

- [ ] **Step 3: Verify nothing else changed**

Run: `git diff --stat`
Expected: `tasks.md` only, three lines added for one removed.

- [ ] **Step 4: Commit**

```bash
git add tasks.md
git commit -m "docs(tasks): record T09 and T10 as done" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Self-Review

Run after the plan was written, against the spec with fresh eyes.

**1. Spec coverage.** Every requirement this plan's scope claims maps to a task:

| Spec / task requirement | Task |
|---|---|
| §3.2 `CiProvider` — `findBuild`, `triggerBuild`, `waitForBuild`, `failureDigest` | 1 |
| §3.2 `ScmProvider` — `ensureBranch`, `createPullRequest`, `getPullRequest`, `listActivitySince`, `addComment`, `currentUser` | 10 |
| §3.2 "the `local` CI provider runs configured shell commands … and produces the same shapes as TeamCity" | 7, 8 |
| §3.2 "fakes persist their state under `<workspace>/fake/` because every `janus run` is a new process" | 5, 11, 13 (the cross-process test) |
| §4 `repos[].ci.pr_build_type_id` | 9 (`janus ci` resolves it), 1 (`BuildRef.buildTypeId`) |
| §4 `publish_build_type_id`, `release_build_type_id`, `e2e.build_type_id`, `branch_params`, `suite_repo_map` | Out of scope, by design: `TriggerBuildInput.params` and `BuildRef.buildTypeId` carry them and T17/T20 supply them. Stated in Scope boundaries and D9. |
| §5 `fake/`, `evidence/digests/` | 5, 11 (`fake/`); 3 (`renderDigestMarkdown`, written by T12 — R2/D2) |
| §6 `repos.<name>.last_build.classification` vocabulary | 1 (`BuildClassification` is the same four strings) |
| §6 `repos.<name>.pr` shape | 10 (`PullState.state`/`version`, `ReviewerStatus`) |
| §6 `review_loop.activity_cursor` as a string cursor | 10 (`Activity.id`), 11 (D17's zero padding), 12 (the ordering case) |
| §8 `janus ci wait\|trigger\|digest` | 9 |
| §8 does not list `janus fake scm` | 13, and R4 says so in the command's own description |
| §13 work packages in the PR description | 10 (`PrWorkPackage`) |
| §15 PR model, description links to state branch, plan commit, sibling PRs | 10 |
| §15 descriptions "updated at package boundaries" | 10 supplies `updateDescription`; T14 calls it (R-f) |
| §16.1 find, trigger, wait | 1, 5, 7, 14 |
| §16.1 classification incl. `UNKNOWN` | 1 |
| §16.1 `infra` retries once then escalates | Out of scope: budgets are T12's. The provider's job is producing `infra`; tasks 1, 5, 7 do. |
| §16.2 digest content, caps, redaction | 2, 3 |
| §16.3 signature with normalized error lines, exceptions excluded | 4 |
| §16.4 debug agent inputs | Out of scope (T12); the digest it reads is task 3 |
| §16.5 coupled red | Out of scope (T12/T19) |
| §16.6 base-branch sync | Out of scope (T18) |
| §17 E2E triage consumes the digest | Out of scope (T17); `FailureDigest` is task 3 and is shaped for it |
| §24 activity stream, own-comment skip, NEEDS_WORK, approval reset, DECLINED, MERGED | 10, 11, 12, 14 |
| §27 event list | **Deliberately untouched** — R2/D2 |
| §28 `digest` block, plus the new `max_test_detail_lines` and its spec edit | 3 (`digestLimitsFrom`, Steps 3 and 4) |
| §28 `local_ci` block, plus three new fields | 7 (D11) |
| §28 `teamcity` polling values | 9 (`janus ci wait` reads them) |
| §28 `guardrails` | Out of scope (T12) |
| §29 item 2, one CI contract suite and one SCM contract suite | 6, 8, 12 |
| §29 item 3, harness scenarios | 14 |
| §31.29, §32 rule 11 | 14 (the provider audit), 11 (merge takes a sha) |
| §32 rule 12 | 2, 3 |
| §33's merge-commit caveat (every push takes the explicit-trigger path) | 1's `findBuild` returning `null`, 5's `missing` entry, 7's `local` cache miss |
| `tasks.md` T09 done-when: contract suite green for `local` and `fake` | 6, 8 |
| `tasks.md` T09 done-when: redaction tests | 2, 3, and the contract suite's redaction case |
| `tasks.md` T09 done-when: distinct compile errors give distinct signatures | 4 Step 5 |
| `tasks.md` T10 done-when: contract suite green | 12 |
| `tasks.md` T10 done-when: hooks drive comment → approval → merge across separate processes | 13 |

Gaps found and closed while reviewing:
- The first draft had `failureDigest(ref, limits)` with no way for a provider to learn the approved §11 baseline exceptions that §16.2 says the digest must report matches against. Adding them to `DigestLimits` would have polluted a pure §28 config type. The signature is now `failureDigest(ref, limits, exceptions)` — a third parameter, D19 below — and `janus ci digest` reads them from `state.baseline.exceptions`. **Controller review then caught that the fix had been applied at every call site but not to the canonical declaration in Task 1**, which would have made Task 5 — the first implementation — fail to typecheck with "Target signature provides too few arguments", four tasks away from the cause. Task 1 Step 3 now declares three parameters and its prose says why getting it right there matters.
- The first draft's `normalizeErrorLine` took only a line, so an absolute workspace path in a jest-junit stack frame made the same failure hash differently on two machines, defeating §7 rule 5. It now takes the workspace root.
- The first draft's `collectJUnitFiles` reached into `src/policy/glob.ts`, making a CI provider depend on the policy package. D20 moves the glob module, exactly as D3 moved the redactors.
- The `local` provider had nowhere to persist a build record that `janus ci digest` (a separate process) could read. D7 adds `WorkspacePaths.localCiDir`.
- Task 10 replacing the `ScmProvider` stub would have left `src/providers/fake/scm.ts` uncompilable until Task 11, breaking the "every task is independently green" rule. Task 10 Step 5 now adds throwing stubs for the length of one task.

**Two decisions added during the review**, recorded here because the Decisions section was already written:

**D19. `failureDigest` takes a third parameter: the approved baseline exception identities.** §3.2 sketches `failureDigest(ref, limits)`, but §16.2 lists "baseline-exception matches" as digest content and a provider has no other way to learn them — they live in `state.baseline.exceptions`, which a provider must not read (it reads no state at all). Putting them on `DigestLimits` would make a type named for §28's `digest` config block carry runtime state. So the method is `failureDigest(ref: BuildRef, limits: DigestLimits, exceptions: readonly string[])`. Confirmed in controller review: §3.2 is a sketch of "small TypeScript interfaces", not a contract, and §16.2 mandates the content — no `DigestRequest` wrapper.

**D20. `src/policy/glob.ts` moves to `src/glob/`.** Same argument as D3: `collectJUnitFiles` needs the `**`/`*`/`?` dialect that already exists once, and either importing the policy package from a provider or writing a second matcher would be worse than a four-import move. The module's content does not change, and `tests/glob/match.test.ts` — unchanged apart from its import path — is the proof.

**2. Placeholder scan.** No "TBD", no "implement later", no "add error handling", no "handle edge cases", no "similar to Task N". Every code step carries the actual code; every test step carries the actual assertions; every run step carries the actual command and the expected output. The one forward reference — Task 7's `const failedTests: FailedTest[] = [];` — is a working empty list with a comment naming the task that replaces it, and Task 8 Step 9 gives the exact replacement text.

Two defects found and fixed during this pass:
- Task 5's `waitForBuild` originally mutated `found.polls` on the store object it had already captured, so a second process's poll would have been lost. It now re-reads the store after each sleep, which is also what makes the "persists the poll count across processes" case meaningful.
- Task 3's `enforceByteCap` originally returned `{ ...current, truncated: true, bytes: measure(current) }`, measuring a digest whose `truncated` flag was still false — so the recorded `bytes` was one line short of the rendered form once the `- **truncated**` header line appeared. It now builds the truncated value first and measures that.

**3. Type consistency.** Checked across tasks:
- `BuildRef` fields — `id`, `repo`, `buildTypeId`, `revision`, `branch`, `url` — are camelCase in Task 1's declaration and in every construction (Tasks 5, 7, 9) and assertion (Tasks 6, 8, 14).
- `BuildClassification`'s four strings are identical to `src/state/state-schema.ts:64`'s enum, asserted in Task 1's test.
- `FailedTest.newFailure` is camelCase everywhere; `FakeScmPull.head_commit` and `FakeCiCall.build_type_id` are snake_case everywhere, because they are persisted-file fields (D16).
- `DigestLimits`'s **six** fields — `maxTests`, `maxTestDetailLines`, `logTailLines`, `maxErrorWindows`, `maxBytes`, `redact` — are camelCase in Task 1's declaration, in `digestLimitsFrom` (Task 3), in every test's `LIMITS` const (Tasks 3, 5, 6, 7, 8 and 14), and in `janus ci digest` (Task 9, through `digestLimitsFrom`). Re-checked after the controller's ruling 5 changed the shape: every `LIMITS` literal in the document carries `maxTestDetailLines`, and no `DIGEST_TEST_DETAIL_LINES` constant survives.
- `failureDigest(ref, limits, exceptions)` — three arguments in Task 1's interface, Task 5's fake, Task 7's `local`, Task 6's contract suite, Task 9's CLI, and Task 14's audit wrapper.
- `signatureFromDigest(digest, exceptions, root)` — three arguments in Task 4's declaration, Task 6's contract case, and Task 14's scenario.
- `junitIdentity(suite, name)` — same argument order in Task 8's declaration, its test, and `parseJUnitXml`.
- `LOCAL_COMMAND_ORDER` is `['install', 'lint', 'build', 'test']` in Task 7's declaration, its test, and Task 7's `commandsFor`.
- `ScmContractHooks`'s six methods are named `comment`, `approve`, `needsWork`, `decline`, `merge`, `pushCommit` in Task 12's declaration and in Task 12's fake wiring; the underlying exported hooks are `fakeScmComment`, `fakeScmApprove`, `fakeScmNeedsWork`, `fakeScmDecline`, `fakeScmMerge`, `fakeScmPushCommit` in Task 11's declaration, Task 12's wiring, Task 13's CLI, and Task 14's scenarios.
- `FakeScmHookInput` is `{ repo, pull?, now }` in Task 11's declaration and at every call site in Tasks 11, 12, 13 and 14.
- `itWhen(enabled, capability, title, fn)` — same four parameters in Task 6's declaration and in every use in Tasks 6 and 12.
- `createHarnessWorkspace(options)` gains `ciProvider` and `localCi` in Task 9 and `scmProvider` in Task 13; every call site passes only fields that exist by then.
- `ProviderGitWrite` extends `GitWrite` with `provider` and `method`, used with those names in Task 14's wrappers, its formatter, and its assertions.

One inconsistency found and fixed: Task 6's contract suite originally called `subject.provider.failureDigest(ref, LIMITS)` with two arguments while Task 1's interface declared three. Every call in the suite now passes the exceptions list, and one case (`records the baseline exceptions it was given`) exists specifically to exercise the third parameter.

---

## Controller rulings — settled, and binding

All six items this plan raised were ruled on in controller review. They are recorded here as settled, not open. An executor who disagrees with one raises it; they do not re-decide it.

1. **D5's "observation beats label" — confirmed.** §16.1 defines `tests_failed` as "failed test occurrences present", which is an observation and not a label. `cancelled` / `failed_to_start` / `timeout` keep mapping to `infra` unconditionally.
2. **D19's third parameter on `failureDigest` — confirmed.** §3.2 is a sketch of "small TypeScript interfaces", not a contract, and §16.2 mandates the content. **No `DigestRequest` wrapper.**
3. **D13's `addComment` returning a comment id and D14's `findPullRequest` — both confirmed.** Required by §24 and §7 respectively; both are strict widenings that a caller written against §3.2's sketch still satisfies.
4. **D10's explicit `junit_suite_prefix_depth` — confirmed; do not auto-detect.** A heuristic that guesses which `classname` segment is a browser name is exactly the denylist-shaped guess `redactUrl`'s own doc comment argues against. The explicit setting plus the `provider.local_ci` warning stands.
5. **The per-test detail cap becomes config — the plan's original constant was overruled.** Every other §16.2 cap is configurable, and reading `max_tests` as both a test count and a per-test line budget is incoherent (50 tests of 50 lines). `digest.max_test_detail_lines` (positive int, default 20) is added in **Task 3 Step 3**, threaded through `DigestLimits`, `digestLimitsFrom` and `buildFailureDigest`, and **the spec is edited to match** in the same step, committed on its own in Task 3 Step 4.
6. **`local_ci.e2e` stays unread — confirmed** (D9). **T17 must choose** between passing the `Goal` into `createProviders` and introducing a separate E2E provider seam; this plan deliberately leaves that open and does not constrain it.

---

## Spec deviations this plan records

Two places where the code this plan produces would otherwise disagree with `angular-ai-development-workflow-v2.md`. In both, the repository's precedent — T03 edited §6, §26 and §27 and recorded it in its status row — is to **edit the spec**, in its own commit, rather than let the two drift.

| Deviation | Spec edit | Task / step |
|---|---|---|
| `digest.max_test_detail_lines` does not exist; §16.2 reads the per-test line budget off `digest.max_tests` | §28's `digest` block gains the field; §16.2's "the first N lines of details (`digest.max_tests`)" becomes "the first `digest.max_test_detail_lines` lines of details, capped at `digest.max_tests` tests" | Task 3, Steps 3 and 4 |
| `<workspace>/.local-ci/` is a new top-level workspace directory; §5's layout block lists only `.janus/`, `repos/`, `fake/`, `.pnpm-store/` and `janus.lock` | §5's layout block gains `.local-ci/  # local CI provider build cache (only with the local provider)` | Task 7, Step 6 |

Three further deviations are **interface widenings of §3.2's sketch**, confirmed in review and needing no spec edit because §3.2 is explicitly a sketch: `failureDigest`'s third parameter (D19), `addComment` returning a comment id (D13), and `findPullRequest` (D14). `updateDescription` is likewise an addition §15 requires.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-21-t09-t10-ci-scm-providers.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, reviewed between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
