# T08 Policy Checks and Orchestrator Commit/Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the §14 commit model: derive a repository's change set from the git tree alone, run ten deterministic policy checks over it, write `evidence/policy/<attempt-id>.yaml`, commit and fast-forward-push through the git module on a pass, and on a violation run exactly one fresh in-place `fix` agent before resetting the tree, exporting the diff as a patch, and charging the `policy_violations` counter.

**Architecture:** A new `src/policy/` package of small single-responsibility modules: `diff.ts` turns `workingTreeDiff`'s output into per-file hunks with added and removed lines; ten `checks/*` modules each answer one row of §14's table and return `PolicyFinding`s split into violations and warnings; `report.ts` runs the registry and serialises a `PolicyReport`; `commit.ts` owns the conventional message and the push; `flow.ts` orchestrates pass / fix-in-place / reset. Nothing in `src/policy/` reads an agent's self-reported `changes_made` — the change set comes from `git diff HEAD --name-status -z -M`, which Task 1 fixes first because T08 is the consumer T03 deferred that fix for. T08 wires **no stage step**: `src/engine/steps.ts` keeps its T11 and T12 placeholders, and `src/policy/index.ts` is the surface those tasks will call.

**Tech Stack:** TypeScript strict ESM (NodeNext), Node 20+, pnpm 10.33.0, zod 3, yaml 2, vitest 5 (`unit` and `integration` projects), the system `git` binary through `src/git/run.ts`. No new runtime dependency: the glob dialect §12 and §28 need is 40 lines of `RegExp` compilation, and pulling in `minimatch` would add a dependency for a feature set the spec never uses.

**Spec:** `angular-ai-development-workflow-v2.md` — **§14 in full** (the commit model and the policy-check table; this is the core), §12 (`allowed_scope`, the lockfile warning, the measured `ng update` footprint), §13 (work packages), §15 (PR model), §16.6 (base-branch sync, which owns the rejected-push case T08 hands back), §18.1 / §18.2 / §18.3 (agent task, context package, output contract — the `fix` role's inputs), §19 (the "may not" list), §20 (`policy_violations` per package, `max_policy_violations_per_package`, `max_changed_files`, `max_diff_lines`), §21 (the AI checkpoint owns the judgment calls the deterministic checks deliberately do not make), §27 (telemetry: `policy.checked`, `commit.created`, `push.completed`), §28 (`policy`, `guardrails` and `digest` config blocks), §29 item 1 and item 3 (unit tests for policy checks; harness scenarios), §31 items 25 and 29, §32 rules 11 and 12. Task definition: `tasks.md` T08. Predecessors, assumed landed: `docs/superpowers/plans/2026-09-20-t05-agent-runner.md` and `docs/superpowers/plans/2026-09-20-t06-t07-spike-and-doctor.md` (`main` at `cf5eb68`).

## Global Constraints

- TypeScript `strict`, Node `>=20` (`package.json` `engines`), ESM (`"type": "module"`). Every relative import ends in `.js`; every type-only import uses `import type` (`verbatimModuleSyntax` is on).
- `strict` here includes `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. **No `!` non-null assertions** — narrow with `if (x === undefined) throw ...`. Never pass `undefined` to an optional property; spread it in conditionally (`...(v === undefined ? {} : { k: v })`).
- Package manager is **pnpm**. All schemas are **zod**. All tests are **vitest**.
- Verification commands, exactly as `package.json` defines them:
  - `pnpm lint` → `eslint .`
  - `pnpm typecheck` → `tsc -p tsconfig.json --noEmit`
  - `pnpm build` → `tsc -p tsconfig.build.json`
  - `pnpm test` → `vitest run` (both projects)
  - `pnpm test:unit` → `vitest run --project unit`
  - `pnpm test:integration` → `vitest run --project integration`
  - A single file: `pnpm vitest run --project unit tests/policy/glob.test.ts`
  - A single case: `pnpm vitest run --project unit tests/policy/glob.test.ts -t 'matches a trailing double star'`
- **No task is done without `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` all green.**
- **Conventional commits, `type(scope): subject` — always with a scope.** Every commit step below uses the two-`-m` form, which produces exactly the required trailers:

```bash
git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

  Those two trailer lines belong to **this repository's** commits, made by whoever executes this plan. They are **not** part of the commit message Janus writes into a product repository — that convention is designed in Task 9 and carries `Work-Package`, `Run-Id`, `Goal` and `Janus-Policy` trailers instead.
- TDD throughout: write the failing test, run it and watch it fail for the stated reason, write the minimal implementation, run it and watch it pass, commit.
- **Test count floor: 816 unit tests in 69 files, plus 24 passing integration tests (12 skipped — the opt-in `JANUS_REAL_CODEX` lane).** Measured on `cf5eb68` with `pnpm test:unit` and `pnpm test:integration`. Every task below adds tests; no task may reduce those numbers.
- Exit codes come only from `src/cli/exit-codes.ts`. **This plan adds no exit code and no CLI command.**
- §32 rule 11 — "Agents never commit, push, or otherwise rewrite Git history." Every `git commit`, `git push` and `git reset` in this task runs in the orchestrator process, through `src/git/ops.ts` and `src/git/tree.ts`. Nothing in `src/policy/` is reachable from an agent process, and Task 11's harness scenarios assert it from the reflogs.
- §32 rule 12 — "Secrets never enter `.janus/`, prompts, or evidence." The secrets check names the **pattern and the location** and never records the matched text. Task 7 has a test that asserts the finding does not contain the secret.
- §31.29 — no agent process performs a git write. The harness applies this automatically to every scenario unless the test opts out; Task 11 does not opt out.

## Facts this plan was verified against

Checked on this machine while the plan was written. A step that depends on one says so.

| Fact | Verified value |
|---|---|
| `git diff HEAD --name-status -z -M` record format | NUL-separated. A rename emits **three** records: `R100`, old path, new path. Every other status emits two: `A`/`M`/`D`/`T`, then the path. The stream ends with a NUL, so splitting on `\0` yields one trailing empty record. |
| non-ASCII path, **without** `-z` | C-quoted and escaped: `A\t"\303\246\303\270\303\245.txt"` |
| non-ASCII path, **with** `-z` | raw UTF-8 bytes, unquoted: `A\0æøå.txt\0` |
| path with a space, without `-z` | **not** quoted (`R100\told name.txt\tnew name.txt`), so the current tab split survives this one case — the non-ASCII case and an embedded newline are what break it |
| patch section order vs `--name-status` order | identical; both come from the same diff queue. Verified with a four-file diff mixing a delete, a rename of a spaced path, an add and a non-ASCII add. |
| a newly added **empty** file | still emits a full `diff --git a/x b/x` section (header, no hunks) — so sections and name-status records stay one-to-one |
| a mode-only change | reported as `M` and emits a section with mode lines and no hunks — again one-to-one |
| `git diff HEAD -M` header for a quoted path | `diff --git "a/\303\246\303\270\303\245.txt" "b/\303\246\303\270\303\245.txt"` — the header paths are quoted even under no `-z`, which is why Task 3 associates sections to files **by order**, never by parsing the header |
| `renderContextPackage` | throws `ContextPackageError` when the INLINE DIFF contains a lockfile or other generated path (`assertNoGeneratedFilesInDiff` in `src/agents/render.ts`) |
| `incrementPolicyViolations` / `checkPolicyGuardrail` | already exist in `src/engine/budgets.ts` and read `execution.work_packages.<id>.repos.<repo>.policy_violations`; they throw `work package <id> has no repo <repo>` when the block is absent |
| `config.policy` defaults | `forbidden_test_patterns: ["xit(", "xdescribe(", "fit(", "fdescribe(", ".skip(", ".only("]`, `forbidden_paths: [".teamcity/**", ".github/**"]`, `max_test_count_decrease_percent: 0`, `allow_test_file_deletion: false` |
| `config.guardrails` caps | `max_policy_violations_per_package: 2`, `max_changed_files: null`, `max_diff_lines: null` |
| test counts on `cf5eb68` | unit 816 in 69 files; integration 24 passed, 12 skipped |

---

## Carried-forward rulings this plan honors

These came from earlier task reviews and exist nowhere in the repository. They are constraints, not suggestions.

**R1. Agent self-reports are unreliable in both directions.** During the T06 prompt spike one agent reported 2 changed files when the tree had 3; another reported 2 when the tree had 1. **Every** file in a `PolicyReport` is derived from `workingTreeDiff` — that is, from `git diff HEAD --name-status -z -M` over a tree with untracked files registered as intent-to-add. `AgentResult.changes_made` is never read by anything under `src/policy/`. Task 11 proves it with a scripted fake agent whose `changes_made` names one file while its patch touches two, one of them a forbidden path; the policy check still sees both.

**R2. `workingTreeDiff` switches to `-z` parsing, first.** `src/git/tree.ts:39` currently runs `git diff HEAD --name-status -M` and splits on `\n` and `\t`. T03 deferred the fix "until its consumer arrives". T08 is that consumer, and Task 1 is that fix.

**R3. Steps never import `writeState`.** Nothing in this plan imports `src/state/state-store.js`. Progress that must survive a crash goes through `engine.markInFlight(patch)` — which, for an agent run, `runAgent` already does.

**R4. Providers come from the `providers` bag on `StepContext`.** `runPolicyFlow` takes a `Providers` value and uses `providers.agent`; it never imports `createProviders` or any fake directly.

**R5. Agents never commit; the orchestrator does.** §32 rule 11 and §31.29. Task 11's harness scenarios use `tests/integration/harness/git-audit.ts`, and one scenario asserts explicitly that the only ref updates in the whole run happened outside every agent window.

**R6. Every commit message has a scope.** Both this plan's own commits and the message convention Task 9 builds for Janus's product-repo commits.

---

## Decisions this plan locks in

**D1. `src/policy/` with one file per concern.** The repo's convention (see `src/doctor/`: `types.ts`, `exec.ts`, `http.ts`, `fs.ts`, `report.ts`, `checks/*.ts`, `index.ts`) is small single-responsibility files with a doc comment citing the spec section they implement. T08 mirrors it exactly. The check families are grouped by what they read, not by table row: `scope.ts` (path globs and size caps — three checks that need only the file list), `tests.ts` (three checks that need test-file knowledge), `runner-config.ts`, `versions.ts`, `secrets.ts`, `lockfile.ts`.

**D2. Violations and warnings are the same shape with a `severity` discriminator; the report keeps them in two arrays.** §14's table is all violations, but `tasks.md` T08 names a *lockfile-in-scope **warning***, and a report type that cannot express "this is worth saying but does not block the commit" would force that warning to be either a spurious violation or invisible. `PolicyFinding.severity` is `'violation' | 'warning'`; `PolicyReport.violations` and `PolicyReport.warnings` are the partition, and `PolicyReport.passed` is `violations.length === 0`. A warning never blocks a commit and never charges a budget — it is rendered into the commit-time log and into the fix agent's context.

**D3. Check ids are stable, machine-readable, and exhaustively registered.** `POLICY_CHECK_IDS` is a `readonly` tuple in `src/policy/types.ts`; `src/policy/registry.ts` carries an `UnregisteredPolicyCheck` compile-time assertion copied from the pattern `src/telemetry/events.ts` already uses for `EVENT_TYPES`, so a check added without being registered fails to compile. The ten ids:

| Id | §14 row | Severity |
|---|---|---|
| `tests.forbidden_pattern_added` | forbidden test patterns added | violation |
| `tests.file_removed` | deleted or renamed test files | violation |
| `tests.count_decreased` | net decrease in test count | violation |
| `paths.forbidden` | forbidden paths | violation |
| `runner_config.weakened` | runner configs may change, but lowering thresholds or excluding tests is a violation | violation |
| `angular.version_beyond_target` | Angular version beyond target | violation |
| `scope.outside_allowed` | scope | violation |
| `size.limits` | diff size | violation |
| `secrets.detected` | secrets | violation |
| `lockfile.scope` | §12's lockfile warning, applied at diff time | warning |

**D4. Sections are associated to files by order, never by parsing the `diff --git` header.** Git quotes header paths for any non-ASCII byte even when `-z` is in effect for `--name-status`, and a rename header (`diff --git a/old name.txt b/new name.txt`) is genuinely ambiguous when paths contain spaces. Both listings come from the same diff queue in the same order, which the facts table above verifies. When the counts disagree, `buildDiffAnalysis` **throws** `DiffAnalysisError` rather than guessing: a check that reads the wrong file's added lines is exactly the failure this whole task exists to prevent, so a loud crash is the correct behavior. An unmerged (`U`) record throws for the same reason — the policy flow never runs mid-merge.

**D5. The INLINE DIFF the fix agent receives excludes generated files; the exported patch includes them.** `src/agents/render.ts` throws `ContextPackageError` when the inline diff contains a lockfile or a path under `dist/`, `coverage/`, `.angular/` and friends (§18.2: "lockfiles and generated files listed but never inlined"). An `ng update` diff always contains a lockfile, so a flow that handed the raw patch to `buildAgentTask` would crash on the very first real violation. `inlineDiffFrom(analysis)` therefore joins only the non-generated sections, while CHANGE SUMMARY still lists every file with its counts and a `generated` marker. The patch written on reset is the **whole** `analysis.patch`, because that file is for a human to re-apply, not for a prompt.

**D6. The policy report reaches the fix agent through LATEST VERIFICATION EVIDENCE.** `SECTION_ORDER` in `src/agents/context.ts` is §18.2 verbatim and T08 does not add a fourteenth section. Of the thirteen, LATEST VERIFICATION EVIDENCE ("digest or build refs") is the one whose job is "what the last check said about this diff" — a policy report is exactly that. PREVIOUS ATTEMPTS is the wrong home: §18.2 restricts it to one-paragraph summaries. This is an interpretation of §18.2, flagged in the handback.

**D7. The fix attempt is skipped when the counter is already at its limit.** §20 says `policy_violations` increments "when policy check fails **after** the in-place fix attempt". §14 says the tree is reset "if the re-check still fails, **or** `max_policy_violations_per_package` is reached". Read together: the ordinary path is violation → one fix agent → re-check → (on failure) increment and reset. But if the counter is *already* at the limit when the violation is found, a fix attempt cannot buy anything — whatever it produces, T12 must escalate — so the flow resets immediately without spending an agent run and without a second increment. This is an interpretation, flagged in the handback.

**D8. The flow mutates no state except the `policy_violations` counter.** It returns the commit sha and the report; **T12** records `state.repos.<repo>.head_commit`, appends to `execution.work_packages.<id>.repos.<repo>.commits`, and checkpoints. The one exception is `incrementPolicyViolations`, which by §20 must move a counter, and which goes through `src/engine/budgets.ts` — the established seam — never through `writeState` (R3). §7's resume reconciliation re-reads repository heads, so a crash between the push and T12's checkpoint is recovered rather than lost.

**D9. A rejected push is an outcome, not an error.** `push` throws `PushRejectedError` when the goal branch moved on the remote. That is §16.6's base-branch-sync situation and T12/T18 own it. `runPolicyFlow` catches only that class, returns `{ kind: 'push_rejected', commit, ... }`, and leaves the commit in place — the work is not lost and must not be reset.

**D10. The test-count denominator is the files this diff touches.** §14 wants "net decrease in test count — threshold per repo, default 0 percent", which needs a denominator the diff alone does not carry. `testCountCheck` reads each changed test file at `HEAD` and in the working tree through two seams on `PolicyCheckContext`, sums the declarations on each side, and compares. At the default threshold of `0` this is identical to a repository-wide count (any decrease at all is a violation); at a configured non-zero threshold it is deliberately stricter than a repo-wide percentage, because one test removed from a two-test file is a real regression that a repo-wide denominator would round to nothing. Flagged in the handback.

**D11. `src/policy/index.ts` is the whole public surface.** T11 and T12 import from `../policy/index.js` and nothing deeper. `src/engine/steps.ts` is **not** touched by this task: its `executing` entry stays `placeholderStep('execute-work-packages', 'T12')`.

**D12. Three new telemetry events, added the way `src/telemetry/events.ts` documents.** `policy.checked`, `commit.created`, `push.completed` — exactly the three §27 lists for this area. Each takes three edits in that one file (interface, union member, `EVENT_TYPES` literal), and `UnlistedEventType` enforces the third. `PolicyCheckedEvent.violated_checks` is typed `PolicyCheckId[]` through a **type-only** import from `src/policy/types.js`, which `verbatimModuleSyntax` erases, so no runtime cycle is created.

---

## File Structure

```text
# Task 1 — the deferred git fix
src/git/tree.ts                      modify: workingTreeDiff uses `--name-status -z -M`; parseNameStatusZ exported
tests/git/tree.test.ts               modify: spaced path, rename of a spaced path, non-ASCII path

# Tasks 2-3 — the foundations
src/policy/types.ts                  PolicyCheckId, POLICY_CHECK_IDS, PolicySeverity, PolicyFinding, PolicyReport,
                                     PolicyReportFile, PolicyCheck, PolicyCheckContext, violation(), warning()
src/policy/glob.ts                   matchesGlob, matchesAnyGlob — the `**` / `*` / `?` dialect §12 and §28 use
src/policy/diff.ts                   DiffLine, DiffHunk, DiffFile, DiffAnalysis, DiffAnalysisError, analyzeDiff,
                                     buildDiffAnalysis, splitPatchSections, parseHunks, addedLines, removedLines,
                                     changeSummaryFrom, inlineDiffFrom
src/policy/context.ts                buildPolicyContext — readHead via `git show HEAD:<path>`, readWorking via fs

# Tasks 4-7 — one file per check family
src/policy/checks/scope.ts           forbiddenPathsCheck, allowedScopeCheck, diffSizeCheck
src/policy/checks/tests.ts           forbiddenTestPatternsCheck, testFileRemovalCheck, testCountCheck,
                                     isTestFile, countTestDeclarations, isTautologicalExpectation
src/policy/checks/runner-config.ts   runnerConfigCheck, isRunnerConfig
src/policy/checks/versions.ts        angularVersionCheck
src/policy/checks/secrets.ts         secretsCheck, SECRET_PATTERNS
src/policy/checks/lockfile.ts        lockfileScopeCheck, LOCKFILE_NAMES

# Tasks 8-10 — registry, report, commit, flow
src/policy/registry.ts               ALL_POLICY_CHECKS, UnregisteredPolicyCheck
src/policy/report.ts                 runPolicyChecks, policyAttemptId, policyEvidencePath, policyPatchPath,
                                     writePolicyEvidence, writePolicyPatch, renderPolicyReportForAgent
src/policy/commit.ts                 buildCommitMessage, commitAndPush
src/policy/flow.ts                   runPolicyFlow, PolicyFlowInput, PolicyFlowOutcome, PolicyFixContext
src/telemetry/events.ts              modify: PolicyCheckedEvent, CommitCreatedEvent, PushCompletedEvent
src/state/files.ts                   modify: POLICY_EVIDENCE_DIR
src/agents/output-schema.ts          modify: FixAgentResult, asFixResult

# Task 11 — the surface and the scenarios
src/policy/index.ts                  the public API T11/T12 import
tests/integration/policy.test.ts     harness scenarios: pass, fix-in-place success, reset after limit,
                                     under-reporting agent, git-audit assertion

# Tests
tests/helpers/policy-fixtures.ts     diffFile, fixtureAnalysis, policyContext, policyReportFixture
tests/policy/glob.test.ts            tests/policy/diff.test.ts          tests/policy/context.test.ts
tests/policy/scope.test.ts           tests/policy/tests-checks.test.ts  tests/policy/runner-config.test.ts
tests/policy/versions.test.ts        tests/policy/secrets.test.ts       tests/policy/lockfile.test.ts
tests/policy/registry.test.ts        tests/policy/report.test.ts        tests/policy/commit.test.ts
tests/policy/flow.test.ts
tests/telemetry/events.test.ts       modify: the three new event types round-trip
tests/agents/output-schema.test.ts   modify: asFixResult

# Task 12
tasks.md                             modify: the Status table row for T08
```

---

## Task 1: `workingTreeDiff` parses `-z`

**Files:**
- Modify: `src/git/tree.ts:37-55`
- Test: `tests/git/tree.test.ts`

**Interfaces:**
- Consumes: `runGit` from `src/git/run.ts`.
- Produces:
  - `workingTreeDiff(cwd: string): Promise<WorkingTreeDiff>` — unchanged signature, unchanged `{ files: ChangedFile[]; patch: string }` return shape.
  - `parseNameStatusZ(output: string): ChangedFile[]` — newly exported, so the record grammar is unit-testable without a git repository.
  - `ChangedFile` keeps `{ status: ChangeStatus; path: string; previousPath?: string }`.

**Why:** R2. T03 wrote the tab-splitting parser and deliberately deferred the `-z` switch "until its consumer arrives". T08 is that consumer: every policy check matches a path against a glob, and a path that arrives as `"\303\246\303\270\303\245.txt"` — quoted, escaped, with literal quote characters — misses every glob it should have hit, silently. A file whose name contains a newline is worse: it splits into two bogus records and shifts every record after it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/git/tree.test.ts`, inside the existing `describe('workingTreeDiff and resetHard', ...)` block:

```ts
  it('parses paths with spaces and non-ASCII characters without quoting', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'with space.txt'), 'spaced\n');
    writeFileSync(join(dir, 'æøå.txt'), 'nordic\n');
    const diff = await workingTreeDiff(dir);
    const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file.status]));
    expect(byPath['with space.txt']).toBe('A');
    expect(byPath['æøå.txt']).toBe('A');
    expect(Object.keys(byPath)).not.toContain('"\\303\\246\\303\\270\\303\\245.txt"');
  });

  it('attributes a rename of a path with a space to the right old and new names', async () => {
    const dir = await repoWithFile();
    writeFileSync(join(dir, 'old name.txt'), 'a\nb\nc\nd\ne\n');
    await commitAll(dir, 'feat(r): add a spaced path');
    await runGit(dir, ['mv', 'old name.txt', 'new name.txt']);
    const diff = await workingTreeDiff(dir);
    expect(diff.files).toEqual([{ status: 'R', path: 'new name.txt', previousPath: 'old name.txt' }]);
  });
```

And a new top-level block, for the grammar itself:

```ts
describe('parseNameStatusZ', () => {
  it('reads two records for an ordinary change and three for a rename', () => {
    expect(parseNameStatusZ('D\0keep.txt\0R100\0old name.txt\0new name.txt\0A\0un tracked.txt\0')).toEqual([
      { status: 'D', path: 'keep.txt' },
      { status: 'R', path: 'new name.txt', previousPath: 'old name.txt' },
      { status: 'A', path: 'un tracked.txt' },
    ]);
  });

  it('returns nothing for an empty stream', () => {
    expect(parseNameStatusZ('')).toEqual([]);
  });

  it('treats a copy as a rename, because both carry an old and a new path', () => {
    expect(parseNameStatusZ('C90\0src/a.ts\0src/b.ts\0')).toEqual([
      { status: 'R', path: 'src/b.ts', previousPath: 'src/a.ts' },
    ]);
  });

  it('throws when a rename record is missing its second path', () => {
    expect(() => parseNameStatusZ('R100\0only-one.txt\0')).toThrow('incomplete rename record');
  });

  it('throws when a status record has no path at all', () => {
    expect(() => parseNameStatusZ('M\0')).toThrow('status "M" with no path');
  });

  it('throws on an unmerged path, which no caller may policy-check', () => {
    expect(() => parseNameStatusZ('U\0src/conflict.ts\0')).toThrow('unmerged path src/conflict.ts');
  });
});
```

Add `parseNameStatusZ` to the existing `src/git/tree.js` import at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm vitest run --project unit tests/git/tree.test.ts`
Expected: FAIL. The `parseNameStatusZ` cases fail with `parseNameStatusZ is not a function` (it is not exported yet); `parses paths with spaces and non-ASCII characters` fails because the non-ASCII path arrives as the quoted literal.

- [ ] **Step 3: Replace the parser**

In `src/git/tree.ts`, replace `workingTreeDiff` and `parseNameStatus` (lines 37-55) with:

```ts
/**
 * Diff of the working tree against HEAD, including untracked files (registered as intent-to-add). Ignored files
 * are excluded.
 *
 * `--name-status -z` rather than the newline-and-tab form: with `-z` git emits NUL-separated records and never
 * quotes a path, while the default form C-quotes any path containing a non-ASCII byte
 * (`A\t"\303\246\303\270\303\245.txt"`) and cannot represent a path containing a newline at all. T08's policy
 * checks match these paths against `allowed_scope` and `forbidden_paths` globs (§12, §14, §28), so a quoted path
 * would silently miss every glob it should have hit — and a mis-split record would attribute a rename's old path
 * to the wrong file. T03 deferred this until a consumer arrived; T08 is that consumer.
 */
export async function workingTreeDiff(cwd: string): Promise<WorkingTreeDiff> {
  await runGit(cwd, ['add', '--intent-to-add', '.']);
  const nameStatus = await runGit(cwd, ['diff', 'HEAD', '--name-status', '-z', '-M']);
  const patch = await runGit(cwd, ['diff', 'HEAD', '-M']);
  return { files: parseNameStatusZ(nameStatus), patch };
}

/**
 * The `-z` record grammar: one status record (`A`, `M`, `D`, `T`, or `R<score>` / `C<score>`), then one path
 * record — or two, old then new, when the status is a rename or a copy. The stream ends with a NUL, so splitting
 * on `\0` yields a trailing empty record that is dropped.
 *
 * A copy is recorded as `R`: `ChangeStatus` has no `C` member, `-M` alone never enables copy detection (that is
 * `-C`), and for every policy check "this path came from that path" is the only thing that matters.
 *
 * An unmerged path (`U`) throws. Policy checks run on a diff a code-writing agent produced, never mid-merge — the
 * sync-conflict role leaves conflicts for the orchestrator to finish (§18.2, §19) — so a `U` here means the caller
 * is looking at a tree it has no business committing, and guessing would hide that.
 */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const records = output.split('\0').filter((record) => record !== '');
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < records.length) {
    const raw = records[index];
    if (raw === undefined) break;
    const status = raw.charAt(0);
    if (status === 'U') {
      throw new Error(`git diff --name-status -z: unmerged path ${records[index + 1] ?? '(unnamed)'}`);
    }
    if (status === 'R' || status === 'C') {
      const previousPath = records[index + 1];
      const path = records[index + 2];
      if (previousPath === undefined || path === undefined) {
        throw new Error(`git diff --name-status -z: incomplete rename record "${raw}"`);
      }
      files.push({ status: 'R', path, previousPath });
      index += 3;
      continue;
    }
    const path = records[index + 1];
    if (path === undefined) {
      throw new Error(`git diff --name-status -z: status "${raw}" with no path`);
    }
    files.push({ status: status as ChangeStatus, path });
    index += 2;
  }
  return files;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run --project unit tests/git/tree.test.ts`
Expected: PASS, including the pre-existing cases (`includes modified, added, and deleted files with a patch`, `returns no files for a clean tree`).

- [ ] **Step 5: Run everything that consumes the diff**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. `src/engine/recover.ts` and `tests/engine/recover.test.ts` are the existing consumers; neither touches the file list, only `diff.patch`.

- [ ] **Step 6: Commit**

```bash
git add src/git/tree.ts tests/git/tree.test.ts
git commit -m "fix(git): parse the working-tree diff with -z so odd paths survive" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 2: Policy types and the glob dialect

**Files:**
- Create: `src/policy/types.ts`, `src/policy/glob.ts`, `tests/policy/glob.test.ts`
- Test: `tests/policy/glob.test.ts`

**Interfaces:**
- Consumes: `JanusConfig` from `src/config/config-schema.js`; `ChangeStatus` from `src/git/tree.js`; `DiffAnalysis` from `src/policy/diff.js` (declared in Task 3 — this task declares only the `import type` and the field, and Task 3 lands the module; do Task 3 before typechecking is expected to pass, or see Step 3 below).
- Produces:
  - `type PolicyCheckId` and `const POLICY_CHECK_IDS: readonly PolicyCheckId[]`
  - `type PolicySeverity = 'violation' | 'warning'`
  - `interface PolicyFinding { check: PolicyCheckId; severity: PolicySeverity; path: string | null; line: number | null; detail: string; evidence: string | null }`
  - `violation(check, detail, extra?): PolicyFinding` and `warning(check, detail, extra?): PolicyFinding`
  - `interface PolicyReportFile { path: string; status: ChangeStatus; previous_path: string | null; added: number; removed: number; binary: boolean; generated: boolean }`
  - `interface PolicyReport { ... }` (fields below)
  - `interface PolicyCheckContext { ... }` and `interface PolicyCheck { id; title; run(ctx): Promise<PolicyFinding[]> }`
  - `matchesGlob(pattern: string, path: string): boolean`, `matchesAnyGlob(patterns: readonly string[], path: string): boolean`

**Why:** Every later task depends on these names. The glob matcher is the single place path-pattern semantics are decided, so `allowed_scope`, `forbidden_paths` and the lockfile warning cannot drift apart.

- [ ] **Step 1: Write the failing glob test**

Create `tests/policy/glob.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob } from '../../src/policy/glob.js';

describe('matchesGlob', () => {
  it('matches an exact path', () => {
    expect(matchesGlob('package.json', 'package.json')).toBe(true);
    expect(matchesGlob('package.json', 'projects/lib/package.json')).toBe(false);
  });

  it('treats a trailing double star as everything underneath', () => {
    expect(matchesGlob('.teamcity/**', '.teamcity/settings.kts')).toBe(true);
    expect(matchesGlob('.teamcity/**', '.teamcity/a/b/c.kts')).toBe(true);
    expect(matchesGlob('.teamcity/**', '.teamcityrc')).toBe(false);
    expect(matchesGlob('src/**', 'src/app/app.component.ts')).toBe(true);
  });

  it('lets a leading double star stand in for zero or more leading segments', () => {
    expect(matchesGlob('**/*.spec.ts', 'a.spec.ts')).toBe(true);
    expect(matchesGlob('**/*.spec.ts', 'src/app/a.spec.ts')).toBe(true);
    expect(matchesGlob('**/*.spec.ts', 'src/app/a.ts')).toBe(false);
  });

  it('keeps a single star inside one path segment', () => {
    expect(matchesGlob('tsconfig*.json', 'tsconfig.app.json')).toBe(true);
    expect(matchesGlob('tsconfig*.json', 'tsconfig.json')).toBe(true);
    expect(matchesGlob('*.json', 'src/a.json')).toBe(false);
  });

  it('matches exactly one character for a question mark', () => {
    expect(matchesGlob('jest.config.?s', 'jest.config.js')).toBe(true);
    expect(matchesGlob('jest.config.?s', 'jest.config.mjs')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    expect(matchesGlob('a+b.txt', 'a+b.txt')).toBe(true);
    expect(matchesGlob('a+b.txt', 'aab.txt')).toBe(false);
    expect(matchesGlob('a.txt', 'axtxt')).toBe(false);
  });

  it('matches paths with spaces and non-ASCII characters', () => {
    expect(matchesGlob('src/**', 'src/with space.ts')).toBe(true);
    expect(matchesGlob('src/**', 'src/æøå.ts')).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is false for an empty pattern list', () => {
    expect(matchesAnyGlob([], 'src/a.ts')).toBe(false);
  });

  it('is true when any pattern matches', () => {
    expect(matchesAnyGlob(['package.json', 'src/**'], 'src/a.ts')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit tests/policy/glob.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/glob.js'`.

- [ ] **Step 3: Write `src/policy/types.ts`**

This file has no runtime behavior beyond the two finding constructors, so it needs no test of its own; every later task's tests exercise it. It declares `import type { DiffAnalysis } from './diff.js'`, which lands in Task 3 — so `pnpm typecheck` does not pass until Task 3's Step 3. Write both files in this task and typecheck at the end of Task 3; that is why Tasks 2 and 3 share a commit boundary only in the sense that Task 2 commits `glob.ts` and its test, and `types.ts` is committed with Task 3.

```ts
import type { JanusConfig } from '../config/config-schema.js';
import type { ChangeStatus } from '../git/tree.js';
import type { DiffAnalysis } from './diff.js';

/**
 * Spec §14's policy-check table, one stable id per row, plus the §12 lockfile warning `tasks.md` T08 asks for.
 *
 * The ids are machine-readable and permanent: they land in `evidence/policy/<attempt-id>.yaml`, in the
 * `policy.checked` telemetry event, and in the report a fix agent reads, so `janus telemetry` (T21) can count
 * "how often did scope violations cost us an attempt" across goals. Renaming one is a breaking change to the
 * evidence trail.
 */
export const POLICY_CHECK_IDS = [
  'tests.forbidden_pattern_added',
  'tests.file_removed',
  'tests.count_decreased',
  'paths.forbidden',
  'runner_config.weakened',
  'angular.version_beyond_target',
  'scope.outside_allowed',
  'size.limits',
  'secrets.detected',
  'lockfile.scope',
] as const;

export type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

/**
 * A violation blocks the commit and, once the in-place fix attempt has failed, charges `policy_violations`
 * (§20). A warning does neither: it is recorded on the report, printed at commit time, and shown to the fix
 * agent, because §12's lockfile note is worth saying and is not grounds to refuse a diff.
 */
export type PolicySeverity = 'violation' | 'warning';

export interface PolicyFinding {
  check: PolicyCheckId;
  severity: PolicySeverity;
  /** The repo-relative path the finding is about, or null for a whole-diff finding such as `size.limits`. */
  path: string | null;
  /** Line number in the **new** file for an added-line finding, in the old file for a removed-line one; else null. */
  line: number | null;
  detail: string;
  /**
   * The offending source line, when quoting it helps a fix agent. **Always null for `secrets.detected`**
   * (§32 rule 12: secrets never enter evidence) — that finding names the pattern and the location instead.
   */
  evidence: string | null;
}

interface FindingExtras {
  path?: string;
  line?: number;
  evidence?: string;
}

function finding(check: PolicyCheckId, severity: PolicySeverity, detail: string, extras: FindingExtras): PolicyFinding {
  return {
    check,
    severity,
    path: extras.path ?? null,
    line: extras.line ?? null,
    detail,
    evidence: extras.evidence ?? null,
  };
}

export function violation(check: PolicyCheckId, detail: string, extras: FindingExtras = {}): PolicyFinding {
  return finding(check, 'violation', detail, extras);
}

export function warning(check: PolicyCheckId, detail: string, extras: FindingExtras = {}): PolicyFinding {
  return finding(check, 'warning', detail, extras);
}

/** One row of the report's file table; snake_case because it is serialised straight to YAML evidence. */
export interface PolicyReportFile {
  path: string;
  status: ChangeStatus;
  previous_path: string | null;
  added: number;
  removed: number;
  binary: boolean;
  /** §18.2: lockfiles and build output. Listed in CHANGE SUMMARY, never inlined into a prompt. */
  generated: boolean;
}

/**
 * Spec §14 step 4: "writes `evidence/policy/<attempt-id>.yaml`". Written for **every** check run, pass or fail —
 * §31.25 requires that "every diff is policy-checked before commit; violations are evidenced", and a passing
 * report is the only durable proof the check ran at all.
 *
 * snake_case throughout, matching `AgentEvidence` in `src/agents/evidence.ts`, because this shape *is* the YAML.
 */
export interface PolicyReport {
  attempt_id: string;
  work_package: string;
  repo: string;
  /** The code-writing agent run whose diff this is, or null when the orchestrator checked a tree it did not ask for. */
  run_id: string | null;
  /** `initial` is the check after the code-writing agent; `recheck` is the one after the in-place fix agent (§14). */
  phase: 'initial' | 'recheck';
  checked_at: string;
  files: PolicyReportFile[];
  totals: { changed_files: number; added_lines: number; removed_lines: number };
  /** The check ids that actually ran. A check whose inputs were absent (no `allowed_scope` yet) is not listed. */
  checks_run: PolicyCheckId[];
  violations: PolicyFinding[];
  warnings: PolicyFinding[];
  /** `violations.length === 0`. Stored rather than derived so a reader of the YAML does not have to compute it. */
  passed: boolean;
}

/**
 * What one check is allowed to look at.
 *
 * `analysis` is derived from the git tree, never from an agent's `changes_made` — during the T06 prompt spike an
 * agent reported two changed files when the tree had three, and another reported two when the tree had one. A
 * check that trusted a self-report would pass a diff that touches `.github/` because the agent forgot to mention
 * it.
 *
 * `readHead` and `readWorking` are seams so `tests/policy/*.test.ts` can supply fixture file contents without a
 * git repository, the same way `DoctorCheckContext` seams out every process, filesystem and network call.
 */
export interface PolicyCheckContext {
  analysis: DiffAnalysis;
  config: JanusConfig;
  /** `goal.target_version` parsed as a number (§14 "Angular version beyond target"). */
  targetVersion: number;
  /** The work package's `allowed_scope` from `plan.yaml` (§12), or null before a plan is approved. */
  allowedScope: readonly string[] | null;
  /** §14: deleting a test file is a violation "unless the package allows it". Defaults to `policy.allow_test_file_deletion`. */
  allowTestFileDeletion: boolean;
  /** Contents of `path` at HEAD, or null when the file did not exist there. */
  readHead(path: string): Promise<string | null>;
  /** Contents of `path` in the working tree, or null when it was deleted. */
  readWorking(path: string): Promise<string | null>;
}

export interface PolicyCheck {
  id: PolicyCheckId;
  /** One short human-readable line, printed in the report rendering a fix agent reads. */
  title: string;
  /**
   * Returns every finding this check makes, or an empty array. A check that cannot run because its inputs are
   * absent returns `null` so `runPolicyChecks` can leave it out of `checks_run` — "did not run" and "found
   * nothing" are different facts, and an evidence file that conflates them is misleading.
   */
  run(ctx: PolicyCheckContext): Promise<PolicyFinding[] | null>;
}
```

- [ ] **Step 4: Write `src/policy/glob.ts`**

```ts
/**
 * The glob dialect `allowed_scope` (§12) and `policy.forbidden_paths` (§28) are written in — and no more than
 * that.
 *
 * Supported: `**` for any number of path segments, `*` for any run of characters inside one segment, `?` for one
 * such character. Not supported, deliberately: brace expansion, character classes, negation, `!`-prefixes.
 * Nothing in the spec's examples (`.teamcity/**`, `.github/**`, `src/**`, `projects/**`, `tsconfig*.json`,
 * `pnpm-lock.yaml`) needs them, and a half-implemented dialect is worse than a documented one: a plan author who
 * writes `src/**{,/}*.ts` and gets silent non-matching has manufactured a policy violation out of a typo.
 *
 * Patterns are always matched against a **repo-relative, forward-slash** path, exactly as git reports it.
 */
const CACHE = new Map<string, RegExp>();

const REGEX_METACHARACTERS = /[.+^${}()|[\]\\]/gu;

function compile(pattern: string): RegExp {
  const cached = CACHE.get(pattern);
  if (cached !== undefined) return cached;
  let source = '^';
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 2;
        if (pattern[index] === '/') {
          // `**/` — zero or more whole leading segments, so `**/*.spec.ts` matches `a.spec.ts` too.
          index += 1;
          source += '(?:[^/]+/)*';
        } else {
          // Trailing `**` — everything underneath, which is what `.teamcity/**` means.
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }
    source += char.replace(REGEX_METACHARACTERS, '\\$&');
    index += 1;
  }
  const compiled = new RegExp(`${source}$`, 'u');
  CACHE.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(pattern: string, path: string): boolean {
  return compile(pattern).test(path);
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, path));
}
```

- [ ] **Step 5: Run the glob test and watch it pass**

Run: `pnpm vitest run --project unit tests/policy/glob.test.ts`
Expected: PASS, 8 cases.

- [ ] **Step 6: Commit the glob matcher**

`src/policy/types.ts` is committed in Task 3, because it imports `./diff.js` and would not typecheck alone.

```bash
git add src/policy/glob.ts tests/policy/glob.test.ts
git commit -m "feat(policy): add the glob dialect allowed_scope and forbidden_paths use" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 3: Diff analysis — per-file hunks from the git tree

**Files:**
- Create: `src/policy/diff.ts`, `src/policy/context.ts`, `tests/policy/diff.test.ts`, `tests/policy/context.test.ts`, `tests/helpers/policy-fixtures.ts`
- Commit alongside: `src/policy/types.ts` (written in Task 2)
- Test: `tests/policy/diff.test.ts`, `tests/policy/context.test.ts`

**Interfaces:**
- Consumes: `workingTreeDiff`, `ChangedFile`, `ChangeStatus` from `src/git/tree.js`; `isGeneratedPath`, `ChangeSummaryEntry` from `src/agents/context.js`; `runGit`, `GitError` from `src/git/run.js`; `PolicyCheckContext` from `./types.js`.
- Produces:
  - `interface DiffLine { text: string; line: number }`
  - `interface DiffHunk { oldStart: number; newStart: number; added: DiffLine[]; removed: DiffLine[] }`
  - `interface DiffFile { status: ChangeStatus; path: string; previousPath: string | null; binary: boolean; generated: boolean; hunks: DiffHunk[]; added: number; removed: number; section: string }`
  - `interface DiffAnalysis { files: DiffFile[]; patch: string; totals: { changedFiles: number; addedLines: number; removedLines: number } }`
  - `class DiffAnalysisError extends Error`
  - `analyzeDiff(cwd: string): Promise<DiffAnalysis>`
  - `buildDiffAnalysis(files: ChangedFile[], patch: string): DiffAnalysis`
  - `splitPatchSections(patch: string): string[]`
  - `parseHunks(section: string): DiffHunk[]`
  - `addedLines(file: DiffFile): DiffLine[]` and `removedLines(file: DiffFile): DiffLine[]`
  - `changeSummaryFrom(analysis: DiffAnalysis): ChangeSummaryEntry[]`
  - `inlineDiffFrom(analysis: DiffAnalysis): string`
  - `buildPolicyContext(input: BuildPolicyContextInput): PolicyCheckContext` (in `context.ts`)

**Why:** This is the "diff analysis: changed, added, deleted, renamed; per-file hunks" bullet of `tasks.md` T08, and it is the only place any policy check learns what changed. R1 lives here: the input is `workingTreeDiff`, full stop.

- [ ] **Step 1: Write the failing analysis tests**

Create `tests/policy/diff.test.ts`. The first block uses real git repositories, because the association between name-status records and patch sections is a property of git's output and a hand-written fixture could not falsify it:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import {
  analyzeDiff,
  buildDiffAnalysis,
  changeSummaryFrom,
  DiffAnalysisError,
  inlineDiffFrom,
  parseHunks,
  splitPatchSections,
} from '../../src/policy/diff.js';
import { tempDir } from '../helpers/git-fixtures.js';

async function repo(): Promise<string> {
  const dir = join(tempDir(), 'r');
  mkdirSync(dir);
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  writeFileSync(join(dir, 'gone.ts'), 'export const gone = true;\n');
  writeFileSync(join(dir, 'old name.ts'), 'one\ntwo\nthree\nfour\nfive\n');
  await commitAll(dir, 'feat(r): base');
  return dir;
}

describe('analyzeDiff', () => {
  it('reports every changed file from the tree with its hunks', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\nconst b = 22;\nconst c = 3;\n');
    writeFileSync(join(dir, 'new.ts'), 'export const added = 1;\n');
    rmSync(join(dir, 'gone.ts'));
    await runGit(dir, ['mv', 'old name.ts', 'new name.ts']);

    const analysis = await analyzeDiff(dir);
    const byPath = new Map(analysis.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual(['gone.ts', 'new name.ts', 'new.ts', 'src-a.ts']);
    expect(byPath.get('new name.ts')?.status).toBe('R');
    expect(byPath.get('new name.ts')?.previousPath).toBe('old name.ts');
    expect(byPath.get('gone.ts')?.status).toBe('D');

    const modified = byPath.get('src-a.ts');
    expect(modified?.added).toBe(1);
    expect(modified?.removed).toBe(1);
    expect(modified?.hunks[0]?.added[0]).toEqual({ text: 'const b = 22;', line: 2 });
    expect(modified?.hunks[0]?.removed[0]).toEqual({ text: 'const b = 2;', line: 2 });
  });

  it('associates sections to files by order, so odd paths land on the right file', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'æøå.ts'), 'export const nordic = 1;\n');
    writeFileSync(join(dir, 'with space.ts'), 'export const spaced = 2;\n');
    const analysis = await analyzeDiff(dir);
    const byPath = new Map(analysis.files.map((file) => [file.path, file]));
    expect(byPath.get('æøå.ts')?.hunks[0]?.added[0]?.text).toBe('export const nordic = 1;');
    expect(byPath.get('with space.ts')?.hunks[0]?.added[0]?.text).toBe('export const spaced = 2;');
  });

  it('counts an empty tree as no change at all', async () => {
    const dir = await repo();
    const analysis = await analyzeDiff(dir);
    expect(analysis.files).toEqual([]);
    expect(analysis.totals).toEqual({ changedFiles: 0, addedLines: 0, removedLines: 0 });
  });

  it('sums totals across files', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 1;\n');
    writeFileSync(join(dir, 'new.ts'), 'one\ntwo\n');
    const analysis = await analyzeDiff(dir);
    expect(analysis.totals.changedFiles).toBe(2);
    expect(analysis.totals.addedLines).toBe(2);
    expect(analysis.totals.removedLines).toBe(2);
  });

  it('marks a lockfile generated and keeps it out of the inline diff', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFileSync(join(dir, 'src-a.ts'), 'const a = 9;\nconst b = 2;\nconst c = 3;\n');
    const analysis = await analyzeDiff(dir);
    expect(analysis.files.find((file) => file.path === 'pnpm-lock.yaml')?.generated).toBe(true);
    expect(changeSummaryFrom(analysis)).toContainEqual({ path: 'pnpm-lock.yaml', added: 1, removed: 0, generated: true });
    expect(inlineDiffFrom(analysis)).not.toContain('pnpm-lock.yaml');
    expect(inlineDiffFrom(analysis)).toContain('src-a.ts');
  });
});

describe('splitPatchSections', () => {
  it('returns one section per file, starting at each diff --git line', () => {
    const patch = [
      'diff --git a/one.ts b/one.ts',
      'index 111..222 100644',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/two.ts b/two.ts',
      'new file mode 100644',
    ].join('\n');
    const sections = splitPatchSections(patch);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.startsWith('diff --git a/one.ts')).toBe(true);
    expect(sections[1]).toBe('diff --git a/two.ts b/two.ts\nnew file mode 100644');
  });

  it('returns nothing for an empty patch', () => {
    expect(splitPatchSections('')).toEqual([]);
  });

  it('does not split on an added line whose content looks like a header', () => {
    const patch = ['diff --git a/one.ts b/one.ts', '@@ -0,0 +1 @@', '+diff --git a/fake b/fake'].join('\n');
    expect(splitPatchSections(patch)).toHaveLength(1);
  });
});

describe('parseHunks', () => {
  it('numbers added lines in the new file and removed lines in the old one', () => {
    const section = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,4 +10,4 @@ context header text',
      ' keep',
      '-gone',
      '+fresh',
      ' keep2',
      '@@ -40,2 +40,3 @@',
      ' keep3',
      '+extra',
      '\\ No newline at end of file',
    ].join('\n');
    const hunks = parseHunks(section);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.removed).toEqual([{ text: 'gone', line: 11 }]);
    expect(hunks[0]?.added).toEqual([{ text: 'fresh', line: 11 }]);
    expect(hunks[1]?.added).toEqual([{ text: 'extra', line: 41 }]);
  });

  it('ignores the file header lines that start with --- and +++', () => {
    const section = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '+x'].join('\n');
    expect(parseHunks(section)[0]?.added).toEqual([{ text: 'x', line: 1 }]);
  });

  it('returns nothing for a section with no hunks', () => {
    expect(parseHunks('diff --git a/a.ts b/a.ts\nold mode 100644\nnew mode 100755')).toEqual([]);
  });
});

describe('buildDiffAnalysis', () => {
  it('throws when the file list and the patch sections disagree', () => {
    expect(() =>
      buildDiffAnalysis([{ status: 'M', path: 'a.ts' }], 'diff --git a/a.ts b/a.ts\ndiff --git a/b.ts b/b.ts'),
    ).toThrow(DiffAnalysisError);
  });

  it('marks a binary section without trying to parse hunks', () => {
    const analysis = buildDiffAnalysis(
      [{ status: 'M', path: 'logo.png' }],
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ',
    );
    expect(analysis.files[0]?.binary).toBe(true);
    expect(analysis.files[0]?.added).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run --project unit tests/policy/diff.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/diff.js'`.

- [ ] **Step 3: Write `src/policy/diff.ts`**

```ts
import { isGeneratedPath } from '../agents/context.js';
import type { ChangeSummaryEntry } from '../agents/context.js';
import { workingTreeDiff } from '../git/tree.js';
import type { ChangedFile, ChangeStatus } from '../git/tree.js';

/** One line of a hunk. `line` is the new-file number for an added line, the old-file number for a removed one. */
export interface DiffLine {
  text: string;
  line: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  added: DiffLine[];
  removed: DiffLine[];
}

export interface DiffFile {
  status: ChangeStatus;
  path: string;
  /** The pre-rename path for `R`, else null. Both paths are scope-checked, so both must survive. */
  previousPath: string | null;
  binary: boolean;
  /** §18.2: a lockfile or build output. Listed in CHANGE SUMMARY, never inlined into a prompt. */
  generated: boolean;
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** The raw patch section for this file, so the fix agent's inline diff can be rebuilt without generated files. */
  section: string;
}

export interface DiffAnalysis {
  files: DiffFile[];
  /** The whole `git diff HEAD -M` text, exported verbatim as a patch when the tree is reset (§14). */
  patch: string;
  totals: { changedFiles: number; addedLines: number; removedLines: number };
}

export class DiffAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffAnalysisError';
  }
}

/**
 * Spec §14 step 1: "collects the diff (tracked and untracked, excluding ignored files)".
 *
 * The change set comes from the git tree and from nowhere else. An agent's `AgentResult.changes_made` is never
 * consulted: during the T06 prompt spike one agent reported two changed files when the tree held three, and
 * another reported two when the tree held one. A policy check built on a self-report is a policy check that can
 * be talked out of firing.
 */
export async function analyzeDiff(cwd: string): Promise<DiffAnalysis> {
  const { files, patch } = await workingTreeDiff(cwd);
  return buildDiffAnalysis(files, patch);
}

/**
 * Pairs each `--name-status` record with its patch section **by position**.
 *
 * Both listings are produced from the same diff queue in the same order, which is the only association that
 * survives git's path quoting: a `diff --git` header C-quotes any non-ASCII path (`"a/\303\246.txt"`) and is
 * genuinely ambiguous for a rename between two paths containing spaces, so parsing the header would be guessing.
 * When the counts disagree — which no observed git output does, including empty new files, mode-only changes and
 * binary files — this throws rather than mis-attributing a hunk, because a check reading the wrong file's added
 * lines is exactly the failure this module exists to prevent.
 */
export function buildDiffAnalysis(changed: ChangedFile[], patch: string): DiffAnalysis {
  const sections = splitPatchSections(patch);
  if (sections.length !== changed.length) {
    throw new DiffAnalysisError(
      `git reported ${changed.length} changed file(s) but ${sections.length} patch section(s); ` +
        'refusing to guess which hunk belongs to which file',
    );
  }
  const files: DiffFile[] = changed.map((file, index) => {
    const section = sections[index] ?? '';
    const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(section);
    const hunks = binary ? [] : parseHunks(section);
    return {
      status: file.status,
      path: file.path,
      previousPath: file.previousPath ?? null,
      binary,
      generated: isGeneratedPath(file.path),
      hunks,
      added: hunks.reduce((sum, hunk) => sum + hunk.added.length, 0),
      removed: hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0),
      section,
    };
  });
  return {
    files,
    patch,
    totals: {
      changedFiles: files.length,
      addedLines: files.reduce((sum, file) => sum + file.added, 0),
      removedLines: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

/**
 * Splits a unified diff at each `diff --git ` header.
 *
 * A content line can never be mistaken for a header: every line inside a hunk is prefixed with a space, `+`, `-`
 * or `\`, so `diff --git ` at column zero is always a section start.
 */
export function splitPatchSections(patch: string): string[] {
  if (patch === '') return [];
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) sections.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) sections.push(current.join('\n'));
  return sections;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

/**
 * Reads one file's hunks, carrying the old- and new-file line numbers forward.
 *
 * Lines before the first `@@` — `index`, `--- a/x`, `+++ b/x`, mode lines — are skipped because `current` is
 * still null, which is why a `+++` header never lands in `added`. `\ No newline at end of file` advances
 * neither counter.
 */
export function parseHunks(section: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of section.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      current = { oldStart: oldLine, newStart: newLine, added: [], removed: [] };
      hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.added.push({ text: line.slice(1), line: newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.removed.push({ text: line.slice(1), line: oldLine });
      oldLine += 1;
      continue;
    }
    oldLine += 1;
    newLine += 1;
  }
  return hunks;
}

/** Every added line of a file, across its hunks, in file order. */
export function addedLines(file: DiffFile): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.added);
}

/** Every removed line of a file, across its hunks, in file order. */
export function removedLines(file: DiffFile): DiffLine[] {
  return file.hunks.flatMap((hunk) => hunk.removed);
}

/** Spec §18.2 CHANGE SUMMARY: "file list with added/removed line counts", generated files marked but not inlined. */
export function changeSummaryFrom(analysis: DiffAnalysis): ChangeSummaryEntry[] {
  return analysis.files.map((file) => ({
    path: file.path,
    added: file.added,
    removed: file.removed,
    generated: file.generated,
  }));
}

/**
 * Spec §18.2 INLINE DIFF, for the code-writing fix agent.
 *
 * Generated files are dropped: `renderContextPackage` throws `ContextPackageError` when the inline diff contains
 * a lockfile or anything under `dist/`, `coverage/` or `.angular/`, and an `ng update` diff always contains a
 * lockfile — so handing over `analysis.patch` unfiltered would crash on the first real violation. The files are
 * still listed, with their counts, in CHANGE SUMMARY.
 */
export function inlineDiffFrom(analysis: DiffAnalysis): string {
  return analysis.files
    .filter((file) => !file.generated)
    .map((file) => file.section)
    .join('\n');
}
```

- [ ] **Step 4: Run the analysis tests and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/diff.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing context test**

Create `tests/policy/context.test.ts`:

```ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { buildPolicyContext } from '../../src/policy/context.js';
import { analyzeDiff } from '../../src/policy/diff.js';
import { tempDir } from '../helpers/git-fixtures.js';

const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });

async function repo(): Promise<string> {
  const dir = join(tempDir(), 'r');
  mkdirSync(dir);
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'a.spec.ts'), "it('one', () => {});\nit('two', () => {});\n");
  await commitAll(dir, 'feat(r): base');
  return dir;
}

describe('buildPolicyContext', () => {
  it('reads a file at HEAD and in the working tree', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'a.spec.ts'), "it('one', () => {});\n");
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: ['**'],
      allowTestFileDeletion: false,
    });
    expect(await ctx.readHead('a.spec.ts')).toContain("it('two'");
    expect(await ctx.readWorking('a.spec.ts')).not.toContain("it('two'");
  });

  it('returns null at HEAD for a file that did not exist there', async () => {
    const dir = await repo();
    writeFileSync(join(dir, 'fresh.spec.ts'), "it('new', () => {});\n");
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
      allowTestFileDeletion: false,
    });
    expect(await ctx.readHead('fresh.spec.ts')).toBeNull();
  });

  it('returns null in the working tree for a deleted file', async () => {
    const dir = await repo();
    rmSync(join(dir, 'a.spec.ts'));
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
      allowTestFileDeletion: false,
    });
    expect(await ctx.readWorking('a.spec.ts')).toBeNull();
    expect(await ctx.readHead('a.spec.ts')).toContain("it('one'");
  });

  it('defaults allowTestFileDeletion from the config when the package says nothing', async () => {
    const dir = await repo();
    const ctx = buildPolicyContext({
      cwd: dir,
      analysis: await analyzeDiff(dir),
      config,
      targetVersion: 16,
      allowedScope: null,
    });
    expect(ctx.allowTestFileDeletion).toBe(false);
  });
});
```

- [ ] **Step 6: Write `src/policy/context.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { GitError, runGit } from '../git/run.js';
import type { DiffAnalysis } from './diff.js';
import type { PolicyCheckContext } from './types.js';

export interface BuildPolicyContextInput {
  /** The repository work tree the diff came from. */
  cwd: string;
  analysis: DiffAnalysis;
  config: JanusConfig;
  /** `goal.target_version` as a number. */
  targetVersion: number;
  /** The work package's `allowed_scope` (§12), or null before a plan is approved. */
  allowedScope: readonly string[] | null;
  /** §14: "violation unless the package allows it". Defaults to `config.policy.allow_test_file_deletion`. */
  allowTestFileDeletion?: boolean;
}

/**
 * The production `PolicyCheckContext`: the two file-content seams are `git show HEAD:<path>` and an ordinary
 * read of the work tree.
 *
 * `HEAD:${path}` is safe for every path git can report, including one starting with `-`, because the `HEAD:`
 * prefix means the argument never begins with a dash. A path that did not exist at HEAD makes `git show` exit
 * 128, which is read as "absent" rather than propagated — that is the normal case for a newly added test file.
 */
export function buildPolicyContext(input: BuildPolicyContextInput): PolicyCheckContext {
  return {
    analysis: input.analysis,
    config: input.config,
    targetVersion: input.targetVersion,
    allowedScope: input.allowedScope,
    allowTestFileDeletion: input.allowTestFileDeletion ?? input.config.policy.allow_test_file_deletion,
    readHead: async (path) => {
      try {
        return await runGit(input.cwd, ['show', `HEAD:${path}`]);
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 128) return null;
        throw error;
      }
    },
    readWorking: async (path) => {
      try {
        return await readFile(join(input.cwd, path), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
```

- [ ] **Step 7: Write the shared test fixtures**

Create `tests/helpers/policy-fixtures.ts`. Every later check test builds its inputs through these, so a shape change lands in one place:

```ts
import { configSchema } from '../../src/config/config-schema.js';
import type { JanusConfig } from '../../src/config/config-schema.js';
import { buildDiffAnalysis } from '../../src/policy/diff.js';
import type { DiffAnalysis, DiffFile } from '../../src/policy/diff.js';
import type { PolicyCheckContext, PolicyReport } from '../../src/policy/types.js';

export const testConfig: JanusConfig = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });

export interface DiffFileSpec {
  path: string;
  status?: DiffFile['status'];
  previousPath?: string;
  added?: string[];
  removed?: string[];
  binary?: boolean;
  generated?: boolean;
  /** First new-file line number for the added block; the removed block starts at the same number. */
  startLine?: number;
}

/**
 * A `DiffFile` built from intent (these lines were added, those removed) rather than from raw patch text, so a
 * check's test says what it means. `analyzeDiff` itself is covered end to end in `tests/policy/diff.test.ts`
 * against real git repositories; these fixtures exercise the checks, not the parser.
 */
export function diffFile(spec: DiffFileSpec): DiffFile {
  const start = spec.startLine ?? 1;
  const added = (spec.added ?? []).map((text, index) => ({ text, line: start + index }));
  const removed = (spec.removed ?? []).map((text, index) => ({ text, line: start + index }));
  const section = [
    `diff --git a/${spec.path} b/${spec.path}`,
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((line) => `-${line.text}`),
    ...added.map((line) => `+${line.text}`),
  ].join('\n');
  return {
    status: spec.status ?? 'M',
    path: spec.path,
    previousPath: spec.previousPath ?? null,
    binary: spec.binary ?? false,
    generated: spec.generated ?? false,
    hunks: [{ oldStart: start, newStart: start, added, removed }],
    added: added.length,
    removed: removed.length,
    section,
  };
}

export function fixtureAnalysis(specs: DiffFileSpec[]): DiffAnalysis {
  const files = specs.map(diffFile);
  return {
    files,
    patch: files.map((file) => file.section).join('\n'),
    totals: {
      changedFiles: files.length,
      addedLines: files.reduce((sum, file) => sum + file.added, 0),
      removedLines: files.reduce((sum, file) => sum + file.removed, 0),
    },
  };
}

export interface PolicyContextOverrides {
  files?: DiffFileSpec[];
  analysis?: DiffAnalysis;
  config?: JanusConfig;
  targetVersion?: number;
  allowedScope?: readonly string[] | null;
  allowTestFileDeletion?: boolean;
  /** path -> contents at HEAD. Absent paths read as null. */
  head?: Record<string, string>;
  /** path -> contents in the work tree. Absent paths read as null. */
  working?: Record<string, string>;
}

export function policyContext(overrides: PolicyContextOverrides = {}): PolicyCheckContext {
  const head = overrides.head ?? {};
  const working = overrides.working ?? {};
  return {
    analysis: overrides.analysis ?? fixtureAnalysis(overrides.files ?? []),
    config: overrides.config ?? testConfig,
    targetVersion: overrides.targetVersion ?? 16,
    allowedScope: overrides.allowedScope === undefined ? null : overrides.allowedScope,
    allowTestFileDeletion: overrides.allowTestFileDeletion ?? false,
    readHead: async (path) => head[path] ?? null,
    readWorking: async (path) => working[path] ?? null,
  };
}

export function policyReportFixture(overrides: Partial<PolicyReport> = {}): PolicyReport {
  return {
    attempt_id: 'wp-01-ui-kit-a1',
    work_package: 'wp-01',
    repo: 'ui-kit',
    run_id: 'run-0001',
    phase: 'initial',
    checked_at: '2026-09-20T12:00:00.000Z',
    files: [],
    totals: { changed_files: 0, added_lines: 0, removed_lines: 0 },
    checks_run: [],
    violations: [],
    warnings: [],
    passed: true,
    ...overrides,
  };
}

/** `buildDiffAnalysis` re-exported so a test that wants the real parser does not reach into `src/`. */
export { buildDiffAnalysis };
```

- [ ] **Step 8: Run both test files and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/`
Expected: PASS — `glob.test.ts`, `diff.test.ts`, `context.test.ts`.

- [ ] **Step 9: Typecheck, lint, build, full test run**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green. `src/policy/types.ts` now typechecks, because `./diff.js` exists.

- [ ] **Step 10: Commit**

```bash
git add src/policy/types.ts src/policy/diff.ts src/policy/context.ts tests/policy/diff.test.ts tests/policy/context.test.ts tests/helpers/policy-fixtures.ts
git commit -m "feat(policy): derive per-file hunks from the git tree" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 4: Path, scope and size checks

**Files:**
- Create: `src/policy/checks/scope.ts`, `tests/policy/scope.test.ts`
- Test: `tests/policy/scope.test.ts`

**Interfaces:**
- Consumes: `PolicyCheck`, `PolicyCheckContext`, `violation` from `../types.js`; `matchesAnyGlob` from `../glob.js`; `DiffFile` from `../diff.js`.
- Produces:
  - `const forbiddenPathsCheck: PolicyCheck` — id `paths.forbidden`
  - `const allowedScopeCheck: PolicyCheck` — id `scope.outside_allowed`
  - `const diffSizeCheck: PolicyCheck` — id `size.limits`
  - `function pathsOf(file: DiffFile): string[]` — `[path]`, or `[previousPath, path]` for a rename

**Why:** Three rows of §14's table — "forbidden paths", "scope", "diff size" — that need nothing but the file list, so they share a module. `pathsOf` is shared because a rename must be judged on **both** names: moving `src/a.ts` to `.github/a.ts` is a forbidden-path violation only if the new name is checked, and moving `.github/ci.yml` out is one only if the old name is.

- [ ] **Step 1: Write the failing tests**

Create `tests/policy/scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { allowedScopeCheck, diffSizeCheck, forbiddenPathsCheck } from '../../src/policy/checks/scope.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('forbiddenPathsCheck', () => {
  it('passes when nothing touches a forbidden path', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await forbiddenPathsCheck.run(ctx)).toEqual([]);
  });

  it('flags a file under a configured forbidden path', async () => {
    const ctx = policyContext({ files: [{ path: '.github/workflows/ci.yml', added: ['on: push'] }] });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('paths.forbidden');
    expect(findings?.[0]?.severity).toBe('violation');
    expect(findings?.[0]?.path).toBe('.github/workflows/ci.yml');
    expect(findings?.[0]?.detail).toContain('.github/**');
  });

  it('flags a rename that moves a file INTO a forbidden path', async () => {
    const ctx = policyContext({
      files: [{ path: '.teamcity/settings.kts', status: 'R', previousPath: 'settings.kts' }],
    });
    expect(await forbiddenPathsCheck.run(ctx)).toHaveLength(1);
  });

  it('flags a rename that moves a file OUT of a forbidden path', async () => {
    const ctx = policyContext({
      files: [{ path: 'settings.kts', status: 'R', previousPath: '.teamcity/settings.kts' }],
    });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.path).toBe('.teamcity/settings.kts');
  });

  it('honours a configured forbidden-path list that is not the default', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { forbidden_paths: ['infra/**'] },
    });
    const ctx = policyContext({ config, files: [{ path: '.github/workflows/ci.yml' }, { path: 'infra/main.tf' }] });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings?.map((f) => f.path)).toEqual(['infra/main.tf']);
  });
});

describe('allowedScopeCheck', () => {
  it('does not run before a plan is approved', async () => {
    const ctx = policyContext({ allowedScope: null, files: [{ path: 'anything.ts' }] });
    expect(await allowedScopeCheck.run(ctx)).toBeNull();
  });

  it('passes when every path is inside the scope', async () => {
    const ctx = policyContext({
      allowedScope: ['package.json', 'pnpm-lock.yaml', 'src/**'],
      files: [{ path: 'package.json' }, { path: 'pnpm-lock.yaml' }, { path: 'src/app/a.ts' }],
    });
    expect(await allowedScopeCheck.run(ctx)).toEqual([]);
  });

  it('flags a file outside the scope and names the scope it was judged against', async () => {
    const ctx = policyContext({ allowedScope: ['src/**'], files: [{ path: 'angular.json' }] });
    const findings = await allowedScopeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('scope.outside_allowed');
    expect(findings?.[0]?.path).toBe('angular.json');
    expect(findings?.[0]?.detail).toContain('src/**');
  });

  it('requires both names of a rename to be in scope', async () => {
    const ctx = policyContext({
      allowedScope: ['src/**'],
      files: [{ path: 'src/b.ts', status: 'R', previousPath: 'lib/a.ts' }],
    });
    const findings = await allowedScopeCheck.run(ctx);
    expect(findings?.map((f) => f.path)).toEqual(['lib/a.ts']);
  });

  it('reports one finding per file, not one per unmatched pattern', async () => {
    const ctx = policyContext({ allowedScope: ['src/**', 'projects/**'], files: [{ path: 'angular.json' }] });
    expect(await allowedScopeCheck.run(ctx)).toHaveLength(1);
  });
});

describe('diffSizeCheck', () => {
  it('does not run when neither cap is configured', async () => {
    const ctx = policyContext({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    expect(await diffSizeCheck.run(ctx)).toBeNull();
  });

  it('flags a diff over max_changed_files', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_changed_files: 1 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    const findings = await diffSizeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('size.limits');
    expect(findings?.[0]?.path).toBeNull();
    expect(findings?.[0]?.detail).toContain('max_changed_files');
    expect(findings?.[0]?.detail).toContain('2');
  });

  it('flags a diff over max_diff_lines, counting added and removed together', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_diff_lines: 3 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts', added: ['x', 'y'], removed: ['z', 'w'] }] });
    const findings = await diffSizeCheck.run(ctx);
    expect(findings?.[0]?.detail).toContain('max_diff_lines');
    expect(findings?.[0]?.detail).toContain('4');
  });

  it('passes when both caps are satisfied', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_changed_files: 10, max_diff_lines: 100 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts', added: ['x'] }] });
    expect(await diffSizeCheck.run(ctx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run --project unit tests/policy/scope.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/checks/scope.js'`.

- [ ] **Step 3: Write `src/policy/checks/scope.ts`**

```ts
import type { DiffFile } from '../diff.js';
import { matchesAnyGlob } from '../glob.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/**
 * Every name a file is known by in this diff.
 *
 * A rename carries two: moving `src/a.ts` to `.github/a.ts` is a forbidden-path violation only if the *new* name
 * is judged, and moving `.github/ci.yml` out of the forbidden tree is one only if the *old* name is. Judging one
 * name would leave the other half of that pair as a hole big enough to relocate a CI config through.
 */
export function pathsOf(file: DiffFile): string[] {
  return file.previousPath === null ? [file.path] : [file.previousPath, file.path];
}

/**
 * Spec §14: "forbidden paths — `.teamcity/**`, `.github/**`, other CI paths as configured."
 *
 * Runner configs are deliberately not here: §14 says they "may change", and what is forbidden in them —
 * lowering a coverage threshold, excluding tests — is `runner_config.weakened`'s job.
 */
export const forbiddenPathsCheck: PolicyCheck = {
  id: 'paths.forbidden',
  title: 'no file under a forbidden path was changed',
  run: async (ctx) => {
    const patterns = ctx.config.policy.forbidden_paths;
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const path of pathsOf(file)) {
        if (!matchesAnyGlob(patterns, path)) continue;
        findings.push(
          violation('paths.forbidden', `${path} is under a forbidden path (policy.forbidden_paths: ${patterns.join(', ')})`, {
            path,
          }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "scope — files outside `allowed_scope`", where `allowed_scope` comes from the approved `plan.yaml`
 * (§12).
 *
 * Returns null — "did not run" — when no plan slice is in hand, which is the case for any diff produced before
 * Gate 1. §12's measured footprint is why the *plan* is where a too-tight scope must be caught: a scope that
 * lists `package.json` without the lockfile manufactures a violation out of an ordinary `ng update`, and
 * `lockfile.scope` warns about exactly that.
 */
export const allowedScopeCheck: PolicyCheck = {
  id: 'scope.outside_allowed',
  title: 'every changed file is inside the package allowed_scope',
  run: async (ctx) => {
    const scope = ctx.allowedScope;
    if (scope === null) return null;
    const patterns = [...scope];
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const path of pathsOf(file)) {
        if (matchesAnyGlob(patterns, path)) continue;
        findings.push(
          violation('scope.outside_allowed', `${path} is outside the package allowed_scope (${patterns.join(', ')})`, { path }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14 "diff size", bounded by §20's `max_changed_files` and `max_diff_lines`. Both are null by default, so
 * this check ordinarily does not run at all.
 */
export const diffSizeCheck: PolicyCheck = {
  id: 'size.limits',
  title: 'the diff is within the configured size caps',
  run: async (ctx) => {
    const { max_changed_files: maxFiles, max_diff_lines: maxLines } = ctx.config.guardrails;
    if (maxFiles === null && maxLines === null) return null;
    const findings: PolicyFinding[] = [];
    const { changedFiles, addedLines, removedLines } = ctx.analysis.totals;
    if (maxFiles !== null && changedFiles > maxFiles) {
      findings.push(
        violation('size.limits', `the diff changes ${changedFiles} files, over guardrails.max_changed_files (${maxFiles})`),
      );
    }
    const lines = addedLines + removedLines;
    if (maxLines !== null && lines > maxLines) {
      findings.push(
        violation('size.limits', `the diff has ${lines} changed lines, over guardrails.max_diff_lines (${maxLines})`),
      );
    }
    return findings;
  },
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/scope.test.ts`
Expected: PASS, 14 cases.

- [ ] **Step 5: Commit**

```bash
git add src/policy/checks/scope.ts tests/policy/scope.test.ts
git commit -m "feat(policy): add the forbidden-path, scope and diff-size checks" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 5: Test-integrity checks

**Files:**
- Create: `src/policy/checks/tests.ts`, `tests/policy/tests-checks.test.ts`
- Test: `tests/policy/tests-checks.test.ts`

**Interfaces:**
- Consumes: `addedLines` from `../diff.js`; `violation` from `../types.js`.
- Produces:
  - `const forbiddenTestPatternsCheck: PolicyCheck` — id `tests.forbidden_pattern_added`
  - `const testFileRemovalCheck: PolicyCheck` — id `tests.file_removed`
  - `const testCountCheck: PolicyCheck` — id `tests.count_decreased`
  - `function isTestFile(path: string): boolean`
  - `function countTestDeclarations(source: string): number`
  - `function isTautologicalExpectation(line: string): string | null` — the offending expectation, or null

**Why:** Three rows of §14's table, all about the same thing: an agent that makes the build green by weakening the tests. §21 explicitly leaves the judgment calls (a subtly weakened assertion, a changed behavior) to the AI checkpoint; these three are the deterministic floor underneath it.

- [ ] **Step 1: Write the failing tests**

Create `tests/policy/tests-checks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import {
  countTestDeclarations,
  forbiddenTestPatternsCheck,
  isTautologicalExpectation,
  isTestFile,
  testCountCheck,
  testFileRemovalCheck,
} from '../../src/policy/checks/tests.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('isTestFile', () => {
  it('recognises the spec and test suffixes in every JS/TS flavour', () => {
    for (const path of ['a.spec.ts', 'src/app/a.spec.ts', 'b.test.js', 'c.spec.tsx', 'd.test.mjs']) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it('recognises a __tests__ directory', () => {
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
  });

  it('does not claim ordinary source', () => {
    for (const path of ['src/app.ts', 'spec.ts', 'src/spectrum.ts', 'src/testing/harness.ts']) {
      expect(isTestFile(path)).toBe(false);
    }
  });
});

describe('forbiddenTestPatternsCheck', () => {
  it('passes a diff that adds an ordinary test', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', added: ["it('works', () => expect(sum(1, 2)).toBe(3));"] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('flags every configured pattern when it is ADDED', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["xit('skipped', () => {});", "describe.only('focus', () => {});"] }],
    });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings?.map((f) => f.detail.includes('xit(')).filter(Boolean)).toHaveLength(1);
    expect(findings?.map((f) => f.detail.includes('.only(')).filter(Boolean)).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.forbidden_pattern_added');
    expect(findings?.[0]?.line).toBe(1);
    expect(findings?.[0]?.evidence).toContain('xit(');
  });

  it('does not flag a pattern that was REMOVED', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', removed: ["xit('was skipped', () => {});"] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('flags a forbidden pattern added outside a test file too', async () => {
    const ctx = policyContext({ files: [{ path: 'karma.conf.js', added: ['  // fdescribe( left behind'] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toHaveLength(1);
  });

  it('flags a tautological expectation', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'a.spec.ts',
          added: ['    expect(true).toBe(true);', '    expect(result).toEqual(result);', '    expect(1).toBe(1);'],
        },
      ],
    });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings).toHaveLength(3);
    expect(findings?.every((f) => f.detail.includes('tautological'))).toBe(true);
  });

  it('does not call a real expectation tautological', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', added: ['expect(actual).toBe(expected);'] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('honours a configured pattern list', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { forbidden_test_patterns: ['pending('] },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.spec.ts', added: ["xit('x', () => {});", 'pending();'] }] });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('pending(');
  });
});

describe('isTautologicalExpectation', () => {
  it('finds a literal compared to itself', () => {
    expect(isTautologicalExpectation('expect(false).toBe(false);')).toBe('expect(false).toBe(false)');
  });

  it('finds an expression compared to itself', () => {
    expect(isTautologicalExpectation('expect(user.id).toStrictEqual(user.id)')).not.toBeNull();
  });

  it('finds expect(true).toBeTruthy()', () => {
    expect(isTautologicalExpectation('expect(true).toBeTruthy();')).not.toBeNull();
  });

  it('returns null for a real assertion', () => {
    expect(isTautologicalExpectation('expect(a).toBe(b)')).toBeNull();
    expect(isTautologicalExpectation('const x = 1;')).toBeNull();
  });
});

describe('testFileRemovalCheck', () => {
  it('passes when no test file was removed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', status: 'D' }] });
    expect(await testFileRemovalCheck.run(ctx)).toEqual([]);
  });

  it('flags a deleted test file', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.spec.ts', status: 'D' }] });
    const findings = await testFileRemovalCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.file_removed');
    expect(findings?.[0]?.path).toBe('src/a.spec.ts');
  });

  it('flags a renamed test file by its old name', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/a.spec.disabled.ts', status: 'R', previousPath: 'src/a.spec.ts' }],
    });
    const findings = await testFileRemovalCheck.run(ctx);
    expect(findings?.[0]?.path).toBe('src/a.spec.ts');
    expect(findings?.[0]?.detail).toContain('src/a.spec.disabled.ts');
  });

  it('allows the removal when the package allows it', async () => {
    const ctx = policyContext({ allowTestFileDeletion: true, files: [{ path: 'src/a.spec.ts', status: 'D' }] });
    expect(await testFileRemovalCheck.run(ctx)).toEqual([]);
  });
});

describe('countTestDeclarations', () => {
  it('counts it and test calls, including modifiers', () => {
    const source = [
      "describe('suite', () => {",
      "  it('one', () => {});",
      "  it.each([1])('two', () => {});",
      "  test('three', () => {});",
      '});',
    ].join('\n');
    expect(countTestDeclarations(source)).toBe(3);
  });

  it('does not count a method call that merely ends in it', () => {
    expect(countTestDeclarations('await page.submit();\nconst x = unit(1);\nfoo.it(2);')).toBe(0);
  });

  it('counts a declaration at the start of a line', () => {
    expect(countTestDeclarations("it('one', () => {});")).toBe(1);
  });
});

describe('testCountCheck', () => {
  it('does not run when the diff touches no test file', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: ['const a = 1;'] }] });
    expect(await testCountCheck.run(ctx)).toBeNull();
  });

  it('passes when the count is unchanged', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["it('renamed', () => {});"], removed: ["it('old', () => {});"] }],
      head: { 'a.spec.ts': "it('old', () => {});\nit('other', () => {});" },
      working: { 'a.spec.ts': "it('renamed', () => {});\nit('other', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('passes when the count grows', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["it('extra', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});\nit('extra', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('flags any decrease at the default threshold of zero percent', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', removed: ["it('two', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});" },
    });
    const findings = await testCountCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.count_decreased');
    expect(findings?.[0]?.detail).toContain('2');
    expect(findings?.[0]?.detail).toContain('1');
    expect(findings?.[0]?.detail).toContain('50');
  });

  it('allows a decrease inside a configured threshold', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { max_test_count_decrease_percent: 50 },
    });
    const ctx = policyContext({
      config,
      files: [{ path: 'a.spec.ts', removed: ["it('two', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('counts a deleted test file as zero afterwards', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', status: 'D' }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: {},
    });
    expect(await testCountCheck.run(ctx)).toHaveLength(1);
  });

  it('reads a renamed test file from its old name at HEAD', async () => {
    const ctx = policyContext({
      files: [{ path: 'b.spec.ts', status: 'R', previousPath: 'a.spec.ts' }],
      head: { 'a.spec.ts': "it('one', () => {});" },
      working: { 'b.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('does not divide by zero when the diff only adds new test files', async () => {
    const ctx = policyContext({
      files: [{ path: 'fresh.spec.ts', status: 'A', added: ["it('one', () => {});"] }],
      head: {},
      working: { 'fresh.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run --project unit tests/policy/tests-checks.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/checks/tests.js'`.

- [ ] **Step 3: Write `src/policy/checks/tests.ts`**

```ts
import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyCheckContext, PolicyFinding } from '../types.js';

/**
 * What counts as a test file: the `.spec.` / `.test.` suffix in any JS or TS flavour, or anything under a
 * `__tests__` directory. Deliberately narrow — `src/testing/harness.ts` is test *infrastructure*, not a test, and
 * flagging its deletion would train an operator to override the check.
 */
const TEST_FILE_SUFFIX = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY = /(?:^|\/)__tests__\//u;

export function isTestFile(path: string): boolean {
  return TEST_FILE_SUFFIX.test(path) || TEST_DIRECTORY.test(path);
}

/**
 * One `it(...)` / `test(...)` declaration, with or without a modifier (`it.each`, `it.skip`).
 *
 * `(?:^|[^\w.$])` keeps `unit(` and `page.it(` out: the first would match a bare substring search, the second is
 * a method call on some object. The `m` flag is what makes the `^` alternative mean "start of a line".
 */
const TEST_DECLARATION = /(?:^|[^\w.$])(?:it|test)\s*(?:\.\s*\w+\s*)?\(/gmu;

export function countTestDeclarations(source: string): number {
  return source.match(TEST_DECLARATION)?.length ?? 0;
}

// No `.not.` alternation on purpose: `expect(x).not.toBe(x)` always *fails*, so it is a broken test rather than
// a vacuous one, and calling it tautological in the finding would send a fix agent looking for the wrong thing.
const EXPECT_PAIR = /expect\(\s*([^()]*(?:\([^()]*\)[^()]*)*?)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\(\s*([^()]*(?:\([^()]*\)[^()]*)*?)\s*\)/u;
const EXPECT_TRUTHY = /expect\(\s*(true|false|1|0|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBeTruthy|toBeFalsy|toBeDefined)\(\s*\)/u;

/**
 * Spec §14's "tautological expectations" row.
 *
 * Two shapes, both of which pass no matter what the code does: comparing an expression to itself
 * (`expect(x).toBe(x)`, `expect(true).toBe(true)`) and asserting a literal's truthiness
 * (`expect(true).toBeTruthy()`). Returns the offending text so the finding can quote it; null when the line is
 * fine. Textual, by design: this runs on diff lines, not on a parsed AST, and §21 leaves the subtler
 * "is this assertion weaker than it was" judgment to the AI checkpoint.
 */
export function isTautologicalExpectation(line: string): string | null {
  const truthy = EXPECT_TRUTHY.exec(line);
  if (truthy !== null) return truthy[0];
  const pair = EXPECT_PAIR.exec(line);
  if (pair === null) return null;
  const [, left, , right] = pair;
  if (left === undefined || right === undefined || left === '') return null;
  return left === right ? pair[0] : null;
}

/**
 * Spec §14: "forbidden test patterns added — `xit(`, `xdescribe(`, `fit(`, `fdescribe(`, `.skip(`, `.only(`,
 * `it.todo(`, tautological expectations".
 *
 * Only **added** lines are examined: removing an `xit(` is a repair, and flagging it would make the check fight
 * the fix it is supposed to produce. Every file is examined, not only test files — a `.only(` left in a
 * `karma.conf.js` narrows the suite just as effectively.
 */
export const forbiddenTestPatternsCheck: PolicyCheck = {
  id: 'tests.forbidden_pattern_added',
  title: 'no skipped, focused or tautological test was added',
  run: async (ctx) => {
    const patterns = ctx.config.policy.forbidden_test_patterns;
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const line of addedLines(file)) {
        for (const pattern of patterns) {
          if (!line.text.includes(pattern)) continue;
          findings.push(
            violation('tests.forbidden_pattern_added', `${file.path}:${line.line} adds the forbidden test pattern "${pattern}"`, {
              path: file.path,
              line: line.line,
              evidence: line.text.trim(),
            }),
          );
        }
        const tautology = isTautologicalExpectation(line.text);
        if (tautology !== null) {
          findings.push(
            violation('tests.forbidden_pattern_added', `${file.path}:${line.line} adds the tautological expectation ${tautology}`, {
              path: file.path,
              line: line.line,
              evidence: line.text.trim(),
            }),
          );
        }
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "deleted or renamed test files — violation unless the package allows it."
 *
 * A rename is judged by its **old** name, because that is the test file that stopped existing; the detail names
 * where it went so a reviewer can tell a legitimate move from a quiet disabling (`a.spec.ts` to
 * `a.spec.disabled.ts` renames the file *and* takes it out of the runner's glob).
 */
export const testFileRemovalCheck: PolicyCheck = {
  id: 'tests.file_removed',
  title: 'no test file was deleted or renamed',
  run: async (ctx) => {
    if (ctx.allowTestFileDeletion) return [];
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      if (file.status === 'D' && isTestFile(file.path)) {
        findings.push(violation('tests.file_removed', `the test file ${file.path} was deleted`, { path: file.path }));
        continue;
      }
      if (file.status === 'R' && file.previousPath !== null && isTestFile(file.previousPath)) {
        findings.push(
          violation('tests.file_removed', `the test file ${file.previousPath} was renamed to ${file.path}`, {
            path: file.previousPath,
          }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "net decrease in test count — threshold per repo, default 0 percent"
 * (`policy.max_test_count_decrease_percent`).
 *
 * The denominator is the test count of the **files this diff touches**, read at HEAD through `readHead` and in
 * the working tree through `readWorking`. A diff-local delta could not produce a percentage at all, and a
 * repository-wide count would need to read every test file in the repo on every check. At the default threshold
 * of 0 the two are equivalent — any decrease is a violation — and above it this is deliberately the stricter
 * reading: one test removed from a two-test file is a real regression that a repo-wide denominator rounds away.
 *
 * Returns null when the diff touches no test file, so "nothing to measure" is not recorded as "measured, fine".
 */
export const testCountCheck: PolicyCheck = {
  id: 'tests.count_decreased',
  title: 'the number of tests did not fall beyond the configured threshold',
  run: async (ctx) => {
    const touched = ctx.analysis.files.filter(
      (file) => isTestFile(file.path) || (file.previousPath !== null && isTestFile(file.previousPath)),
    );
    if (touched.length === 0) return null;
    let before = 0;
    let after = 0;
    for (const file of touched) {
      const headPath = file.previousPath ?? file.path;
      const headSource = file.status === 'A' ? null : await ctx.readHead(headPath);
      const workingSource = file.status === 'D' ? null : await ctx.readWorking(file.path);
      before += headSource === null ? 0 : countTestDeclarations(headSource);
      after += workingSource === null ? 0 : countTestDeclarations(workingSource);
    }
    if (before === 0 || after >= before) return [];
    const decreasePercent = ((before - after) / before) * 100;
    const threshold = ctx.config.policy.max_test_count_decrease_percent;
    if (decreasePercent <= threshold) return [];
    return [
      violation(
        'tests.count_decreased',
        `the changed test files declared ${before} tests and now declare ${after}: a ${decreasePercent.toFixed(1)}% ` +
          `decrease, over policy.max_test_count_decrease_percent (${threshold}%)`,
      ),
    ];
  },
};

/** Exported for the registry's exhaustiveness assertion and for tests; not part of the public surface. */
export type { PolicyCheckContext };
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/tests-checks.test.ts`
Expected: PASS. If `countTestDeclarations` over-counts in the `does not count a method call that merely ends in it` case, the `[^\w.$]` class is the thing to inspect first — it is what separates `unit(` from ` it(`.

- [ ] **Step 5: Commit**

```bash
git add src/policy/checks/tests.ts tests/policy/tests-checks.test.ts
git commit -m "feat(policy): add the three test-integrity checks" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 6: Runner-config threshold detection

**Files:**
- Create: `src/policy/checks/runner-config.ts`, `tests/policy/runner-config.test.ts`
- Test: `tests/policy/runner-config.test.ts`

**Interfaces:**
- Consumes: `addedLines`, `removedLines` from `../diff.js`; `violation` from `../types.js`.
- Produces:
  - `const runnerConfigCheck: PolicyCheck` — id `runner_config.weakened`
  - `function isRunnerConfig(path: string): boolean`
  - `function thresholdsIn(lines: readonly string[]): Map<string, number>` — the highest value seen per coverage key

**Why:** The one row of §14's table with a conditional in it: "Runner configs (`karma.conf.js`, `jest.config.*`) may change, but lowering coverage thresholds or excluding tests in them is a violation." `tasks.md` T08 calls it out by name. A flat forbidden-path rule would block the legitimate half (an Angular major upgrade genuinely rewrites `karma.conf.js`), and no rule at all leaves the cheapest possible way to make a red build green.

- [ ] **Step 1: Write the failing tests**

Create `tests/policy/runner-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isRunnerConfig, runnerConfigCheck, thresholdsIn } from '../../src/policy/checks/runner-config.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('isRunnerConfig', () => {
  it('recognises karma, jest and vitest configs in every extension', () => {
    for (const path of [
      'karma.conf.js',
      'karma.conf.ts',
      'projects/ui-kit/karma.conf.js',
      'jest.config.js',
      'jest.config.mjs',
      'jest.config.ts',
      'jest.config.json',
      'vitest.config.ts',
    ]) {
      expect(isRunnerConfig(path)).toBe(true);
    }
  });

  it('does not claim ordinary config', () => {
    for (const path of ['angular.json', 'tsconfig.json', 'src/karma.ts', 'jest.setup.ts']) {
      expect(isRunnerConfig(path)).toBe(false);
    }
  });
});

describe('thresholdsIn', () => {
  it('reads the coverage keys and keeps the highest value per key', () => {
    expect(thresholdsIn(['statements: 80,', 'branches: 70,', 'statements: 90,'])).toEqual(
      new Map([
        ['statements', 90],
        ['branches', 70],
      ]),
    );
  });

  it('reads quoted and decimal values', () => {
    expect(thresholdsIn(['"lines": 77.5,'])).toEqual(new Map([['lines', 77.5]]));
  });

  it('is empty for lines with no threshold', () => {
    expect(thresholdsIn(['const x = 1;'])).toEqual(new Map());
  });
});

describe('runnerConfigCheck', () => {
  it('does not run when no runner config changed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await runnerConfigCheck.run(ctx)).toBeNull();
  });

  it('allows a runner config to change without touching thresholds or exclusions', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'karma.conf.js',
          removed: ["    require('karma-jasmine'),"],
          added: ["    require('karma-jasmine'),", "    require('@angular-devkit/build-angular/plugins/karma'),"],
        },
      ],
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a lowered coverage threshold', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      statements: 80,'], added: ['      statements: 40,'] }],
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('jest.config.js');
    expect(findings?.[0]?.detail).toContain('statements');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('flags a coverage threshold that was removed entirely', async () => {
    const ctx = policyContext({ files: [{ path: 'jest.config.js', removed: ['      branches: 60,'] }] });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings?.[0]?.detail).toContain('removed');
    expect(findings?.[0]?.detail).toContain('branches');
  });

  it('allows a raised coverage threshold', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      lines: 70,'], added: ['      lines: 85,'] }],
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags an added exclusion', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["  testPathIgnorePatterns: ['<rootDir>/src/legacy/'],"] }],
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('testPathIgnorePatterns');
    expect(findings?.[0]?.evidence).toContain('legacy');
  });

  it('flags a karma exclude block', async () => {
    const ctx = policyContext({ files: [{ path: 'karma.conf.js', added: ["      exclude: ['**/flaky.spec.ts'],"] }] });
    expect(await runnerConfigCheck.run(ctx)).toHaveLength(1);
  });

  it('ignores a threshold change in a file that is not a runner config', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', removed: ['statements: 80,'], added: ['statements: 10,'] }] });
    expect(await runnerConfigCheck.run(ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run --project unit tests/policy/runner-config.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/checks/runner-config.js'`.

- [ ] **Step 3: Write `src/policy/checks/runner-config.ts`**

```ts
import { addedLines, removedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/**
 * The test-runner configuration files §14 names, plus vitest, which is the same family and is what a modern
 * Angular workspace may use instead of karma. `jest.setup.ts` and `src/karma.ts` are deliberately excluded: they
 * are ordinary source that happens to mention the runner.
 */
const RUNNER_CONFIG = /(?:^|\/)(?:karma\.conf\.[cm]?[jt]s|jest\.config\.(?:[cm]?[jt]s|json)|vitest\.config\.[cm]?[jt]s)$/u;

export function isRunnerConfig(path: string): boolean {
  return RUNNER_CONFIG.test(path);
}

/** The coverage keys whose value is a percentage floor in both karma-coverage and jest. */
const THRESHOLD_KEY = /["']?\b(statements|branches|functions|lines)\b["']?\s*:\s*(\d+(?:\.\d+)?)/gu;

/**
 * The highest value each coverage key takes across a set of lines.
 *
 * Highest, not first: a jest config carries a `global` block and may carry per-path overrides, and the strictest
 * number is the one a weakening has to get past. Taking the lowest would let "add a lenient per-path override"
 * read as a threshold that did not move.
 */
export function thresholdsIn(lines: readonly string[]): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const line of lines) {
    for (const match of line.matchAll(THRESHOLD_KEY)) {
      const key = match[1];
      const raw = match[2];
      if (key === undefined || raw === undefined) continue;
      const value = Number(raw);
      const previous = thresholds.get(key);
      if (previous === undefined || value > previous) thresholds.set(key, value);
    }
  }
  return thresholds;
}

/**
 * Keys whose appearance on an ADDED line means tests stopped running.
 *
 * `testMatch` and `testRegex` are deliberately absent: narrowing them can exclude tests, but changing them is
 * also the ordinary way to adopt a new file-naming convention during an upgrade, and a check that fires on the
 * legitimate case teaches an operator to wave the real one through.
 */
const EXCLUSION_KEY = /["']?\b(exclude|testPathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*:/u;

/**
 * Spec §14: "Runner configs (`karma.conf.js`, `jest.config.*`) may change, but lowering coverage thresholds or
 * excluding tests in them is a violation."
 *
 * Returns null when the diff touches no runner config, so the evidence file distinguishes "not applicable" from
 * "checked and clean".
 */
export const runnerConfigCheck: PolicyCheck = {
  id: 'runner_config.weakened',
  title: 'no runner config lowered a coverage threshold or excluded tests',
  run: async (ctx) => {
    const configs = ctx.analysis.files.filter((file) => isRunnerConfig(file.path));
    if (configs.length === 0) return null;
    const findings: PolicyFinding[] = [];
    for (const file of configs) {
      const before = thresholdsIn(removedLines(file).map((line) => line.text));
      const after = thresholdsIn(addedLines(file).map((line) => line.text));
      for (const [key, was] of before) {
        const now = after.get(key);
        if (now === undefined) {
          findings.push(
            violation('runner_config.weakened', `${file.path} removed the ${key} coverage threshold, which was ${was}`, {
              path: file.path,
            }),
          );
          continue;
        }
        if (now < was) {
          findings.push(
            violation('runner_config.weakened', `${file.path} lowered the ${key} coverage threshold from ${was} to ${now}`, {
              path: file.path,
            }),
          );
        }
      }
      for (const line of addedLines(file)) {
        const match = EXCLUSION_KEY.exec(line.text);
        if (match === null) continue;
        findings.push(
          violation('runner_config.weakened', `${file.path}:${line.line} adds a test exclusion (${match[1]})`, {
            path: file.path,
            line: line.line,
            evidence: line.text.trim(),
          }),
        );
      }
    }
    return findings;
  },
};
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/runner-config.test.ts`
Expected: PASS, 12 cases.

- [ ] **Step 5: Commit**

```bash
git add src/policy/checks/runner-config.ts tests/policy/runner-config.test.ts
git commit -m "feat(policy): detect weakened runner configs in the diff" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 7: Angular version, secrets, and the lockfile warning

**Files:**
- Create: `src/policy/checks/versions.ts`, `src/policy/checks/secrets.ts`, `src/policy/checks/lockfile.ts`, `tests/policy/versions.test.ts`, `tests/policy/secrets.test.ts`, `tests/policy/lockfile.test.ts`
- Test: those three test files

**Interfaces:**
- Consumes: `addedLines` from `../diff.js`; `matchesAnyGlob` from `../glob.js`; `violation`, `warning` from `../types.js`.
- Produces:
  - `const angularVersionCheck: PolicyCheck` — id `angular.version_beyond_target`
  - `const secretsCheck: PolicyCheck` — id `secrets.detected`
  - `const SECRET_PATTERNS: readonly { label: string; re: RegExp }[]`
  - `const lockfileScopeCheck: PolicyCheck` — id `lockfile.scope`, severity `warning`
  - `const LOCKFILE_NAMES: readonly string[]`

**Why:** The last three rows T08 owes. The secrets check is where §32 rule 12 becomes executable; the lockfile warning is the `tasks.md` bullet that §14's table does not carry.

- [ ] **Step 1: Write the failing version test**

Create `tests/policy/versions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { angularVersionCheck } from '../../src/policy/checks/versions.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('angularVersionCheck', () => {
  it('does not run when no manifest changed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await angularVersionCheck.run(ctx)).toBeNull();
  });

  it('passes when every @angular dependency is at the target major', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [
        {
          path: 'package.json',
          added: ['    "@angular/core": "^16.2.0",', '    "@angular/cli": "~16.2.1",', '    "@angular/common": "16.2.0"'],
        },
      ],
    });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });

  it('passes when a dependency is below the target major', async () => {
    const ctx = policyContext({ targetVersion: 16, files: [{ path: 'package.json', added: ['"@angular/core": "^15.2.0",'] }] });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });

  it('flags a major above the target', async () => {
    const ctx = policyContext({ targetVersion: 16, files: [{ path: 'package.json', added: ['    "@angular/core": "^17.0.0",'] }] });
    const findings = await angularVersionCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('angular.version_beyond_target');
    expect(findings?.[0]?.detail).toContain('@angular/core');
    expect(findings?.[0]?.detail).toContain('17');
    expect(findings?.[0]?.detail).toContain('16');
  });

  it('reads a prerelease spec', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [{ path: 'package.json', added: ['"@angular/core": "17.0.0-next.3",'] }],
    });
    expect(await angularVersionCheck.run(ctx)).toHaveLength(1);
  });

  it('only looks at package.json files', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [
        { path: 'README.md', added: ['upgrade to "@angular/core": "^18.0.0" one day'] },
        { path: 'projects/ui-kit/package.json', added: ['"@angular/core": "^18.0.0"'] },
      ],
    });
    const findings = await angularVersionCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.path).toBe('projects/ui-kit/package.json');
  });

  it('ignores non-@angular scopes', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [{ path: 'package.json', added: ['"@angular-eslint/builder": "^17.0.0",', '"rxjs": "^7.8.0"'] }],
    });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing secrets test**

Create `tests/policy/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SECRET_PATTERNS, secretsCheck } from '../../src/policy/checks/secrets.js';
import { policyContext } from '../helpers/policy-fixtures.js';

const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`;
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

describe('secretsCheck', () => {
  it('passes a diff with no secret-shaped text', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const apiBase = "https://api.example.com";'] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('flags a GitHub token', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', added: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('secrets.detected');
    expect(findings?.[0]?.path).toBe('.env.local');
    expect(findings?.[0]?.line).toBe(1);
  });

  it('NEVER records the secret itself, in any field', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', added: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    const finding = (await secretsCheck.run(ctx))?.[0];
    expect(finding?.evidence).toBeNull();
    expect(JSON.stringify(finding)).not.toContain(GITHUB_TOKEN);
  });

  it('flags an AWS access key id, a private key header and a credentialed URL', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'config.ts',
          added: [
            `const key = '${AWS_KEY}';`,
            '-----BEGIN RSA PRIVATE KEY-----',
            "const repo = 'https://svc:hunter2hunter2@git.example.internal/a.git';",
          ],
        },
      ],
    });
    const findings = await secretsCheck.run(ctx);
    expect(findings).toHaveLength(3);
    expect(JSON.stringify(findings)).not.toContain('hunter2hunter2');
    expect(JSON.stringify(findings)).not.toContain(AWS_KEY);
  });

  it('flags a long quoted assignment to a credential-shaped name', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: ["  password: 'correct-horse-battery-staple',"] }] });
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
  });

  it('does not flag a short or env-var-sourced value', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/a.ts', added: ["  token: process.env['JANUS_BITBUCKET_TOKEN'],", "  password: '',"] }],
    });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('only looks at added lines', async () => {
    const ctx = policyContext({ files: [{ path: '.env.local', removed: [`GITHUB_TOKEN=${GITHUB_TOKEN}`] }] });
    expect(await secretsCheck.run(ctx)).toEqual([]);
  });

  it('reports one finding per line even when several patterns match it', async () => {
    const ctx = policyContext({ files: [{ path: 'a.ts', added: [`const a = '${GITHUB_TOKEN}'; const b = '${AWS_KEY}';`] }] });
    expect(await secretsCheck.run(ctx)).toHaveLength(1);
  });

  it('every pattern carries a label', () => {
    expect(SECRET_PATTERNS.every((pattern) => pattern.label.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 3: Write the failing lockfile test**

Create `tests/policy/lockfile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lockfileScopeCheck } from '../../src/policy/checks/lockfile.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('lockfileScopeCheck', () => {
  it('does not run before a plan is approved', async () => {
    const ctx = policyContext({ allowedScope: null, files: [{ path: 'package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toBeNull();
  });

  it('does not run when no manifest changed', async () => {
    const ctx = policyContext({ allowedScope: ['src/**'], files: [{ path: 'src/a.ts' }] });
    expect(await lockfileScopeCheck.run(ctx)).toBeNull();
  });

  it('passes when the sibling lockfile is inside the scope', async () => {
    const ctx = policyContext({ allowedScope: ['package.json', 'pnpm-lock.yaml'], files: [{ path: 'package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toEqual([]);
  });

  it('passes when a broad scope covers the lockfile', async () => {
    const ctx = policyContext({ allowedScope: ['**'], files: [{ path: 'projects/ui-kit/package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toEqual([]);
  });

  it('warns — not violates — when package.json is in scope but no lockfile is', async () => {
    const ctx = policyContext({ allowedScope: ['package.json', 'src/**'], files: [{ path: 'package.json' }] });
    const findings = await lockfileScopeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('lockfile.scope');
    expect(findings?.[0]?.severity).toBe('warning');
    expect(findings?.[0]?.path).toBe('package.json');
    expect(findings?.[0]?.detail).toContain('pnpm-lock.yaml');
  });

  it('warns once per manifest, not once per lockfile candidate', async () => {
    const ctx = policyContext({
      allowedScope: ['**/package.json'],
      files: [{ path: 'package.json' }, { path: 'projects/ui-kit/package.json' }],
    });
    expect(await lockfileScopeCheck.run(ctx)).toHaveLength(2);
  });

  it('names the directory the lockfile would sit in for a nested manifest', async () => {
    const ctx = policyContext({ allowedScope: ['projects/**/package.json'], files: [{ path: 'projects/ui-kit/package.json' }] });
    expect((await lockfileScopeCheck.run(ctx))?.[0]?.detail).toContain('projects/ui-kit/pnpm-lock.yaml');
  });
});
```

- [ ] **Step 4: Run all three and watch them fail**

Run: `pnpm vitest run --project unit tests/policy/versions.test.ts tests/policy/secrets.test.ts tests/policy/lockfile.test.ts`
Expected: FAIL — three `Cannot find module` errors.

- [ ] **Step 5: Write `src/policy/checks/versions.ts`**

```ts
import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

const MANIFEST = /(?:^|\/)package\.json$/u;

/**
 * `"@angular/<name>": "<range>"` with the major extracted from the range.
 *
 * The leading `[\^~>=<v\s]*` swallows a caret, tilde, comparison operator or `v` prefix; the major is whatever
 * digits come next, which is also correct for a prerelease (`17.0.0-next.3` reads as 17). Only the `@angular/`
 * scope is matched: §14 says "any `@angular/*` major above `target_version`", and `@angular-eslint`,
 * `@angular-devkit` and `@angular/cli`'s own peers version independently of the framework.
 */
const ANGULAR_DEPENDENCY = /"(@angular\/[^"]+)"\s*:\s*"[\^~>=<v\s]*(\d+)\./gu;

/**
 * Spec §14: "Angular version beyond target — any `@angular/*` major above `target_version`."
 *
 * Added lines of `package.json` files only. The lockfile is not scanned: its `@angular/*` entries are resolved
 * transitive versions, not declared intent, and an upgrade legitimately parks a newer transitive peer there.
 * Returns null when no manifest changed.
 */
export const angularVersionCheck: PolicyCheck = {
  id: 'angular.version_beyond_target',
  title: 'no @angular dependency was raised past the goal target version',
  run: async (ctx) => {
    const manifests = ctx.analysis.files.filter((file) => MANIFEST.test(file.path));
    if (manifests.length === 0) return null;
    const findings: PolicyFinding[] = [];
    for (const file of manifests) {
      for (const line of addedLines(file)) {
        for (const match of line.text.matchAll(ANGULAR_DEPENDENCY)) {
          const name = match[1];
          const major = Number(match[2]);
          if (name === undefined || !Number.isInteger(major) || major <= ctx.targetVersion) continue;
          findings.push(
            violation(
              'angular.version_beyond_target',
              `${file.path}:${line.line} sets ${name} to major ${major}, above the goal target_version ${ctx.targetVersion}`,
              { path: file.path, line: line.line, evidence: line.text.trim() },
            ),
          );
        }
      }
    }
    return findings;
  },
};
```

- [ ] **Step 6: Write `src/policy/checks/secrets.ts`**

```ts
import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

export interface SecretPattern {
  label: string;
  re: RegExp;
}

/**
 * Spec §14's "secrets — common token patterns" row.
 *
 * Deliberately shape-based, not entropy-based: an entropy heuristic on an `ng update` diff flags minified
 * bundles and lockfile integrity hashes by the hundred, and a check whose output is mostly noise is a check
 * whose output gets skipped. §32 rule 12 makes a false negative recoverable (the AI checkpoint and the human
 * reviewer both see the diff) and a **leaked secret in evidence** unrecoverable, which is why the finding below
 * records the pattern label and the location and never the matched text.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/u },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { label: 'private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/u },
  { label: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
  {
    label: 'credential-shaped assignment',
    re: /\b(?:token|password|secret|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/iu,
  },
  { label: 'credentialed URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu },
];

/**
 * One finding per **line**, not per pattern: a line that trips three patterns is one place to look, and
 * repeating it three times in the evidence file only makes the report harder to act on.
 */
export const secretsCheck: PolicyCheck = {
  id: 'secrets.detected',
  title: 'no secret-shaped value was added',
  run: async (ctx) => {
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const line of addedLines(file)) {
        const matched = SECRET_PATTERNS.filter((pattern) => pattern.re.test(line.text));
        if (matched.length === 0) continue;
        findings.push(
          violation(
            'secrets.detected',
            `${file.path}:${line.line} adds a value matching ${matched.map((pattern) => pattern.label).join(', ')}; ` +
              'the value is not reproduced here (§32 rule 12)',
            { path: file.path, line: line.line },
          ),
        );
      }
    }
    return findings;
  },
};
```

- [ ] **Step 7: Write `src/policy/checks/lockfile.ts`**

```ts
import { matchesAnyGlob } from '../glob.js';
import { warning } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/** The lockfiles `isGeneratedPath` already knows about, in the order a manifest's sibling is looked for. */
export const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'] as const;

const MANIFEST = /(?:^|\/)package\.json$/u;

/**
 * Spec §12, applied at diff time: "the validator warns when `package.json` is in scope but the lockfile is not."
 *
 * `tasks.md` T08 asks for a **warning**, and a warning is what this is: it never blocks a commit and never
 * charges `policy_violations`. Its job is to explain the `scope.outside_allowed` violation that is about to
 * happen — T06 measured an `ng update @angular/core@16 @angular/cli@16 --allow-dirty` that changed exactly two
 * files, `package.json` and the lockfile, so a scope covering the first and not the second manufactures a
 * violation out of the most ordinary operation in the entire goal.
 *
 * T11 owns the same warning at `plan.yaml` validation time, where it is cheaper to act on. This one is the
 * backstop for a plan that was approved anyway.
 */
export const lockfileScopeCheck: PolicyCheck = {
  id: 'lockfile.scope',
  title: 'a changed package.json has its lockfile inside the package allowed_scope',
  run: async (ctx) => {
    const scope = ctx.allowedScope;
    if (scope === null) return null;
    const manifests = ctx.analysis.files.filter((file) => MANIFEST.test(file.path));
    if (manifests.length === 0) return null;
    const patterns = [...scope];
    const findings: PolicyFinding[] = [];
    for (const file of manifests) {
      const dir = file.path.slice(0, Math.max(file.path.lastIndexOf('/'), 0));
      const candidates = LOCKFILE_NAMES.map((name) => (dir === '' ? name : `${dir}/${name}`));
      if (candidates.some((candidate) => matchesAnyGlob(patterns, candidate))) continue;
      findings.push(
        warning(
          'lockfile.scope',
          `${file.path} is inside allowed_scope but none of ${candidates.join(', ')} is; an \`ng update\` writes the ` +
            'lockfile, and the scope check will then report it as out of scope (§12)',
          { path: file.path },
        ),
      );
    }
    return findings;
  },
};
```

- [ ] **Step 8: Run all three and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/versions.test.ts tests/policy/secrets.test.ts tests/policy/lockfile.test.ts`
Expected: PASS.

- [ ] **Step 9: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add src/policy/checks/versions.ts src/policy/checks/secrets.ts src/policy/checks/lockfile.ts tests/policy/versions.test.ts tests/policy/secrets.test.ts tests/policy/lockfile.test.ts
git commit -m "feat(policy): add the angular-version, secrets and lockfile checks" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 8: The registry, the report, and the `policy.checked` event

**Files:**
- Create: `src/policy/registry.ts`, `src/policy/report.ts`, `tests/policy/registry.test.ts`, `tests/policy/report.test.ts`
- Modify: `src/state/files.ts`, `src/telemetry/events.ts`, `tests/telemetry/events.test.ts`
- Test: `tests/policy/registry.test.ts`, `tests/policy/report.test.ts`, `tests/telemetry/events.test.ts`

**Interfaces:**
- Consumes: every `PolicyCheck` from `./checks/*.js`; `stringify` from `yaml`; `WorkspacePaths` from `../workspace/layout.js`.
- Produces:
  - `const ALL_POLICY_CHECKS: readonly PolicyCheck[]` and `type UnregisteredPolicyCheck`
  - `const POLICY_EVIDENCE_DIR = 'evidence/policy'` (in `src/state/files.ts`)
  - `function policyAttemptId(workPackageId: string, repo: string, attempt: number): string`
  - `function policyEvidencePath(janusDir: string, attemptId: string): string`
  - `function policyPatchPath(janusDir: string, attemptId: string): string`
  - `async function runPolicyChecks(input: RunPolicyChecksInput): Promise<PolicyReport>`
  - `function writePolicyEvidence(paths: WorkspacePaths, report: PolicyReport): string`
  - `function writePolicyPatch(paths: WorkspacePaths, attemptId: string, patch: string): string`
  - `function renderPolicyReportForAgent(report: PolicyReport): string`
  - `interface PolicyCheckedEvent` in `src/telemetry/events.ts`

**Why:** §14 step 4 — "writes `evidence/policy/<attempt-id>.yaml`" — and §31.25 — "every diff is policy-checked before commit; violations are evidenced". This is where the ten checks become one auditable artifact and one telemetry event.

- [ ] **Step 1: Write the failing registry test**

Create `tests/policy/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALL_POLICY_CHECKS } from '../../src/policy/registry.js';
import { POLICY_CHECK_IDS } from '../../src/policy/types.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('ALL_POLICY_CHECKS', () => {
  it('registers exactly the declared check ids, once each', () => {
    expect(ALL_POLICY_CHECKS.map((check) => check.id).sort()).toEqual([...POLICY_CHECK_IDS].sort());
  });

  it('gives every check a non-empty title', () => {
    for (const check of ALL_POLICY_CHECKS) {
      expect(check.title.length, `check ${check.id} has no title`).toBeGreaterThan(0);
    }
  });

  it('lets every check run against an empty diff without throwing', async () => {
    const ctx = policyContext({ files: [], allowedScope: ['**'] });
    for (const check of ALL_POLICY_CHECKS) {
      const findings = await check.run(ctx);
      expect(findings ?? [], `check ${check.id} found something in an empty diff`).toEqual([]);
    }
  });

  it('never returns a finding whose check id is not its own', async () => {
    const ctx = policyContext({
      allowedScope: ['src/**'],
      files: [{ path: '.github/ci.yml', added: ["xit('x', () => {});"] }],
    });
    for (const check of ALL_POLICY_CHECKS) {
      for (const finding of (await check.run(ctx)) ?? []) {
        expect(finding.check).toBe(check.id);
      }
    }
  });
});
```

- [ ] **Step 2: Write `src/policy/registry.ts`**

```ts
import { lockfileScopeCheck } from './checks/lockfile.js';
import { runnerConfigCheck } from './checks/runner-config.js';
import { allowedScopeCheck, diffSizeCheck, forbiddenPathsCheck } from './checks/scope.js';
import { secretsCheck } from './checks/secrets.js';
import { forbiddenTestPatternsCheck, testCountCheck, testFileRemovalCheck } from './checks/tests.js';
import { angularVersionCheck } from './checks/versions.js';
import { POLICY_CHECK_IDS } from './types.js';
import type { PolicyCheck, PolicyCheckId } from './types.js';

/**
 * Spec §14's table, in its order, plus §12's lockfile warning last.
 *
 * Order matters only for how a report reads; every check is independent and none may look at another's findings.
 */
export const ALL_POLICY_CHECKS: readonly PolicyCheck[] = [
  forbiddenTestPatternsCheck,
  testFileRemovalCheck,
  testCountCheck,
  forbiddenPathsCheck,
  runnerConfigCheck,
  angularVersionCheck,
  allowedScopeCheck,
  diffSizeCheck,
  secretsCheck,
  lockfileScopeCheck,
];

type RegisteredCheckId = (typeof ALL_POLICY_CHECKS)[number]['id'];
type AssertNever<T extends never> = T;

/**
 * Compile-time proof that every declared id is registered. Adding an id to `POLICY_CHECK_IDS` without adding its
 * check to `ALL_POLICY_CHECKS` fails here, the same way `UnlistedEventType` guards `EVENT_TYPES`.
 *
 * `PolicyCheck.id` is typed as the whole `PolicyCheckId` union, so this catches the "declared but never
 * registered" direction; the runtime test in `tests/policy/registry.test.ts` catches the reverse — a check
 * registered twice, or one whose id is not in the list.
 */
export type UnregisteredPolicyCheck = AssertNever<Exclude<PolicyCheckId, RegisteredCheckId>>;

export const REGISTERED_CHECK_IDS: readonly PolicyCheckId[] = POLICY_CHECK_IDS;
```

- [ ] **Step 3: Run the registry test and watch it pass**

Run: `pnpm vitest run --project unit tests/policy/registry.test.ts`
Expected: PASS, 4 cases.

- [ ] **Step 4: Add the evidence directory constant**

In `src/state/files.ts`, after the `AGENTS_EVIDENCE_DIR` line, add:

```ts
/** Spec §14: `evidence/policy/<attempt-id>.yaml` — the policy report, and `<attempt-id>.patch` on a reset. */
export const POLICY_EVIDENCE_DIR = 'evidence/policy';
```

- [ ] **Step 5: Add the `policy.checked` event**

Three edits in `src/telemetry/events.ts`. First, a type-only import at the top, beside the existing ones:

```ts
import type { PolicyCheckId } from '../policy/types.js';
```

Then the interface, after `RepoDriftEvent`:

```ts
/**
 * Spec §27 `policy.checked`, emitted once per run of the §14 checks — including the recheck after the in-place
 * fix agent, which `phase` distinguishes.
 *
 * `violated_checks` lists the distinct ids that produced a violation, not every finding, so `janus telemetry`
 * (T21) can answer "which check costs us the most attempts" without reading every evidence file.
 */
export interface PolicyCheckedEvent {
  type: 'policy.checked';
  work_package: string;
  repo: string;
  attempt_id: string;
  /** The code-writing agent run whose diff was checked, or null. */
  run_id: string | null;
  phase: 'initial' | 'recheck';
  passed: boolean;
  changed_files: number;
  violations: number;
  warnings: number;
  violated_checks: PolicyCheckId[];
  /** `.janus`-relative path of the report YAML. */
  evidence: string;
}
```

Then add `| PolicyCheckedEvent` to the `TelemetryEvent` union and `'policy.checked',` to `EVENT_TYPES` (keep §27's order: after `agent.model_switch`, before `budget.incremented`). `UnlistedEventType` fails to compile if the third edit is missed.

Add to `tests/telemetry/events.test.ts`, inside the `lists every §27 event type` case:

```ts
    expect(EVENT_TYPES).toContain('policy.checked');
```

and a new case:

```ts
  it('narrows policy.checked to its §27 dimensions', () => {
    const event: TelemetryEvent = {
      type: 'policy.checked',
      work_package: 'wp-01',
      repo: 'ui-kit',
      attempt_id: 'wp-01-ui-kit-a1',
      run_id: 'run-0001',
      phase: 'initial',
      passed: false,
      changed_files: 3,
      violations: 1,
      warnings: 1,
      violated_checks: ['scope.outside_allowed'],
      evidence: 'evidence/policy/wp-01-ui-kit-a1.yaml',
    };
    if (event.type !== 'policy.checked') throw new Error('expected policy.checked');
    expect(event.violated_checks).toEqual(['scope.outside_allowed']);
  });
```

- [ ] **Step 6: Write the failing report test**

Create `tests/policy/report.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  policyAttemptId,
  policyEvidencePath,
  policyPatchPath,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from '../../src/policy/report.js';
import type { PolicyReport } from '../../src/policy/types.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { policyContext, policyReportFixture } from '../helpers/policy-fixtures.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function inputs(overrides: Partial<Parameters<typeof runPolicyChecks>[0]> = {}): Parameters<typeof runPolicyChecks>[0] {
  return {
    ctx: policyContext(),
    attemptId: 'wp-01-ui-kit-a1',
    workPackageId: 'wp-01',
    repo: 'ui-kit',
    runId: 'run-0001',
    phase: 'initial',
    now: NOW,
    ...overrides,
  };
}

describe('policyAttemptId', () => {
  it('names the package, the repo and the attempt', () => {
    expect(policyAttemptId('wp-01-ui-kit-angular', 'ui-kit', 2)).toBe('wp-01-ui-kit-angular-ui-kit-a2');
  });
});

describe('runPolicyChecks', () => {
  it('passes a clean diff and records which checks ran', async () => {
    const report = await runPolicyChecks(
      inputs({ ctx: policyContext({ allowedScope: ['src/**'], files: [{ path: 'src/a.ts', added: ['const a = 1;'] }] }) }),
    );
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.checks_run).toContain('scope.outside_allowed');
    expect(report.checks_run).toContain('paths.forbidden');
    expect(report.checked_at).toBe('2026-09-20T12:00:00.000Z');
  });

  it('leaves a check that could not run out of checks_run', async () => {
    const report = await runPolicyChecks(inputs({ ctx: policyContext({ allowedScope: null, files: [{ path: 'src/a.ts' }] }) }));
    expect(report.checks_run).not.toContain('scope.outside_allowed');
    expect(report.checks_run).not.toContain('lockfile.scope');
    expect(report.checks_run).toContain('paths.forbidden');
  });

  it('splits violations from warnings and fails only on violations', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          allowedScope: ['package.json', '.github/**'],
          files: [{ path: 'package.json', added: ['  "x": 1'] }, { path: '.github/ci.yml', added: ['on: push'] }],
        }),
      }),
    );
    expect(report.violations.map((finding) => finding.check)).toEqual(['paths.forbidden']);
    expect(report.warnings.map((finding) => finding.check)).toEqual(['lockfile.scope']);
    expect(report.passed).toBe(false);
  });

  it('describes every changed file with its counts', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          files: [
            { path: 'src/a.ts', added: ['one', 'two'], removed: ['old'] },
            { path: 'pnpm-lock.yaml', generated: true, added: ['x'] },
            { path: 'src/b.ts', status: 'R', previousPath: 'src/old.ts' },
          ],
        }),
      }),
    );
    expect(report.files).toContainEqual({
      path: 'src/a.ts',
      status: 'M',
      previous_path: null,
      added: 2,
      removed: 1,
      binary: false,
      generated: false,
    });
    expect(report.files.find((file) => file.path === 'pnpm-lock.yaml')?.generated).toBe(true);
    expect(report.files.find((file) => file.path === 'src/b.ts')?.previous_path).toBe('src/old.ts');
    expect(report.totals).toEqual({ changed_files: 3, added_lines: 3, removed_lines: 1 });
  });

  it('carries the identifying fields onto the report', async () => {
    const report = await runPolicyChecks(inputs({ phase: 'recheck', runId: null }));
    expect(report.attempt_id).toBe('wp-01-ui-kit-a1');
    expect(report.work_package).toBe('wp-01');
    expect(report.repo).toBe('ui-kit');
    expect(report.phase).toBe('recheck');
    expect(report.run_id).toBeNull();
  });

  it('runs only the checks it was given, when a caller narrows the set', async () => {
    const report = await runPolicyChecks(
      inputs({ checks: [], ctx: policyContext({ files: [{ path: '.github/ci.yml' }] }) }),
    );
    expect(report.checks_run).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('writePolicyEvidence and writePolicyPatch', () => {
  it('writes the report as YAML and returns its .janus-relative path', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    const report: PolicyReport = policyReportFixture({ passed: false, violations: [
      { check: 'paths.forbidden', severity: 'violation', path: '.github/ci.yml', line: null, detail: 'forbidden', evidence: null },
    ] });
    const relative = writePolicyEvidence(paths, report);
    expect(relative).toBe('evidence/policy/wp-01-ui-kit-a1.yaml');
    const parsed = parse(readFileSync(policyEvidencePath(paths.janusDir, 'wp-01-ui-kit-a1'), 'utf8')) as PolicyReport;
    expect(parsed.violations[0]?.check).toBe('paths.forbidden');
    expect(parsed.passed).toBe(false);
  });

  it('writes the patch beside the report', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    const relative = writePolicyPatch(paths, 'wp-01-ui-kit-a1', 'diff --git a/a b/a\n');
    expect(relative).toBe('evidence/policy/wp-01-ui-kit-a1.patch');
    expect(readFileSync(policyPatchPath(paths.janusDir, 'wp-01-ui-kit-a1'), 'utf8')).toContain('diff --git');
  });
});

describe('renderPolicyReportForAgent', () => {
  it('names each violation with its check id, path and detail', () => {
    const text = renderPolicyReportForAgent(
      policyReportFixture({
        passed: false,
        violations: [
          { check: 'scope.outside_allowed', severity: 'violation', path: 'angular.json', line: null, detail: 'outside scope', evidence: null },
          { check: 'tests.forbidden_pattern_added', severity: 'violation', path: 'a.spec.ts', line: 12, detail: 'adds xit(', evidence: "xit('x')" },
        ],
        warnings: [{ check: 'lockfile.scope', severity: 'warning', path: 'package.json', line: null, detail: 'no lockfile in scope', evidence: null }],
      }),
    );
    expect(text).toContain('scope.outside_allowed');
    expect(text).toContain('angular.json');
    expect(text).toContain('a.spec.ts:12');
    expect(text).toContain("xit('x')");
    expect(text).toContain('WARNING');
    expect(text).toContain('lockfile.scope');
  });

  it('says so plainly when the report passed', () => {
    expect(renderPolicyReportForAgent(policyReportFixture())).toContain('no violations');
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm vitest run --project unit tests/policy/report.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/report.js'`.

- [ ] **Step 8: Write `src/policy/report.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { POLICY_EVIDENCE_DIR } from '../state/files.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { ALL_POLICY_CHECKS } from './registry.js';
import type { PolicyCheck, PolicyCheckContext, PolicyCheckId, PolicyFinding, PolicyReport, PolicyReportFile } from './types.js';

/**
 * The basename of `evidence/policy/<attempt-id>.yaml` and of the patch beside it.
 *
 * Work package ids and repo names are kebab-case by schema (`src/config/goal-schema.ts`, §12), so the result is
 * always a safe filename with no escaping.
 */
export function policyAttemptId(workPackageId: string, repo: string, attempt: number): string {
  return `${workPackageId}-${repo}-a${attempt}`;
}

export function policyEvidencePath(janusDir: string, attemptId: string): string {
  return join(janusDir, POLICY_EVIDENCE_DIR, `${attemptId}.yaml`);
}

/** Spec §14: "the tree is reset, the diff is saved as a patch". It lives beside the report it belongs to. */
export function policyPatchPath(janusDir: string, attemptId: string): string {
  return join(janusDir, POLICY_EVIDENCE_DIR, `${attemptId}.patch`);
}

export interface RunPolicyChecksInput {
  ctx: PolicyCheckContext;
  attemptId: string;
  workPackageId: string;
  repo: string;
  /** The code-writing agent run whose diff this is, or null. */
  runId: string | null;
  phase: PolicyReport['phase'];
  now: Date;
  /** Defaults to `ALL_POLICY_CHECKS`; narrowed only by tests. */
  checks?: readonly PolicyCheck[];
}

/**
 * Spec §14 step 2: "runs policy checks".
 *
 * Every check runs, even after one has already failed: a fix agent that is told about one violation and then
 * trips the next one on its second attempt has cost the goal two attempts for one diff. A check that returns
 * `null` — its inputs were absent — is left out of `checks_run`, so the evidence file never claims a check ran
 * that did not.
 */
export async function runPolicyChecks(input: RunPolicyChecksInput): Promise<PolicyReport> {
  const checks = input.checks ?? ALL_POLICY_CHECKS;
  const checksRun: PolicyCheckId[] = [];
  const violations: PolicyFinding[] = [];
  const warnings: PolicyFinding[] = [];
  for (const check of checks) {
    const findings = await check.run(input.ctx);
    if (findings === null) continue;
    checksRun.push(check.id);
    for (const finding of findings) {
      if (finding.severity === 'violation') violations.push(finding);
      else warnings.push(finding);
    }
  }
  const files: PolicyReportFile[] = input.ctx.analysis.files.map((file) => ({
    path: file.path,
    status: file.status,
    previous_path: file.previousPath,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    generated: file.generated,
  }));
  const { changedFiles, addedLines, removedLines } = input.ctx.analysis.totals;
  return {
    attempt_id: input.attemptId,
    work_package: input.workPackageId,
    repo: input.repo,
    run_id: input.runId,
    phase: input.phase,
    checked_at: input.now.toISOString(),
    files,
    totals: { changed_files: changedFiles, added_lines: addedLines, removed_lines: removedLines },
    checks_run: checksRun,
    violations,
    warnings,
    passed: violations.length === 0,
  };
}

/**
 * Spec §14 step 4 and §31.25. Written on every check, pass or fail: a passing report is the only durable proof
 * that "every diff is policy-checked before commit" actually happened for this diff.
 *
 * Returns the `.janus`-relative path, which is what state, telemetry and the commit trailer reference — the same
 * convention `writeAgentEvidence` uses, so nothing on the state branch ever carries an absolute home path.
 */
export function writePolicyEvidence(paths: WorkspacePaths, report: PolicyReport): string {
  const path = policyEvidencePath(paths.janusDir, report.attempt_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(report));
  return relative(paths.janusDir, path);
}

/** The whole working-tree patch, generated files included: this one is for a human to re-apply, not for a prompt. */
export function writePolicyPatch(paths: WorkspacePaths, attemptId: string, patch: string): string {
  const path = policyPatchPath(paths.janusDir, attemptId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, patch.endsWith('\n') ? patch : `${patch}\n`);
  return relative(paths.janusDir, path);
}

function renderFinding(finding: PolicyFinding): string {
  const where = finding.path === null ? '' : ` ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`;
  const quote = finding.evidence === null ? '' : `\n    ${finding.evidence}`;
  const prefix = finding.severity === 'warning' ? 'WARNING' : 'VIOLATION';
  return `- ${prefix} [${finding.check}]${where}: ${finding.detail}${quote}`;
}

/**
 * The report as the §14 in-place fix agent sees it, carried in the §18.2 LATEST VERIFICATION EVIDENCE section.
 *
 * It names the check id for every finding so the agent can tell "this is a scope problem" from "this is a test
 * problem" without inferring it from prose, and it states the rule the agent is under: fix the violations, change
 * nothing else.
 */
export function renderPolicyReportForAgent(report: PolicyReport): string {
  const lines = [
    `POLICY REPORT ${report.attempt_id} (${report.phase}) for work package ${report.work_package} in ${report.repo}`,
    `${report.totals.changed_files} changed file(s), +${report.totals.added_lines} -${report.totals.removed_lines} lines`,
    '',
  ];
  if (report.violations.length === 0) {
    lines.push('The diff has no violations.');
  } else {
    lines.push(`${report.violations.length} violation(s) must be removed:`);
    lines.push(...report.violations.map(renderFinding));
  }
  if (report.warnings.length > 0) {
    lines.push('', `${report.warnings.length} warning(s), which do not block the commit:`);
    lines.push(...report.warnings.map(renderFinding));
  }
  lines.push(
    '',
    'Resolve every violation by changing the working tree in place. Do not revert unrelated work, do not run any ' +
      'git command that writes, and do not commit: Janus commits once the re-check passes.',
  );
  return lines.join('\n');
}
```

- [ ] **Step 9: Run the report test and watch it pass**

Run: `pnpm vitest run --project unit tests/policy/report.test.ts tests/telemetry/events.test.ts`
Expected: PASS.

- [ ] **Step 10: Full verification and commit**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green.

```bash
git add src/policy/registry.ts src/policy/report.ts src/state/files.ts src/telemetry/events.ts tests/policy/registry.test.ts tests/policy/report.test.ts tests/telemetry/events.test.ts
git commit -m "feat(policy): run the check registry into a serialisable report" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 9: The commit message convention, commit, and push

**Files:**
- Create: `src/policy/commit.ts`, `tests/policy/commit.test.ts`
- Modify: `src/telemetry/events.ts`
- Test: `tests/policy/commit.test.ts`

**Interfaces:**
- Consumes: `commitAll`, `push`, `PushRejectedError` from `../git/ops.js`; `Engine` from `../engine/engine.js`.
- Produces:
  - `interface CommitMessageInput { type: string; repo: string; subject: string; workPackageId: string; goalId: string; runId: string | null; policyEvidence: string }`
  - `function buildCommitMessage(input: CommitMessageInput): string`
  - `interface CommitAndPushInput { engine: Engine; repoDir: string; repo: string; branch: string; remote?: string; message: string; workPackageId: string; changedFiles: number; push?: boolean }`
  - `interface CommitAndPushResult { commit: string; pushed: boolean }`
  - `async function commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult>`
  - `interface CommitCreatedEvent` and `interface PushCompletedEvent` in `src/telemetry/events.ts`

**Why:** §14 step 3 — "commits with a conventional message referencing package and run id, then pushes" — and §27's `commit.created` / `push.completed`. Keeping it in its own module means the flow in Task 10 reads as the decision tree §14 describes, with no git mechanics inlined.

- [ ] **Step 1: Add the two events**

In `src/telemetry/events.ts`, after `PolicyCheckedEvent`:

```ts
/** Spec §27 `commit.created`: the orchestrator's own commit on a goal branch (§14 step 3, §32 rule 11). */
export interface CommitCreatedEvent {
  type: 'commit.created';
  repo: string;
  work_package: string;
  branch: string;
  sha: string;
  /** The subject line only; the trailers are already in the commit and in the evidence file. */
  subject: string;
  changed_files: number;
}

/** Spec §27 `push.completed`: the fast-forward-only push that followed (§2 "no rebase", `git push` without `--force`). */
export interface PushCompletedEvent {
  type: 'push.completed';
  repo: string;
  remote: string;
  branch: string;
  sha: string;
}
```

Add `| CommitCreatedEvent | PushCompletedEvent` to the union, and `'commit.created',` / `'push.completed',` to `EVENT_TYPES` immediately after `'policy.checked',`. Add to the existing `lists every §27 event type` case in `tests/telemetry/events.test.ts`:

```ts
    expect(EVENT_TYPES).toContain('commit.created');
    expect(EVENT_TYPES).toContain('push.completed');
```

- [ ] **Step 2: Write the failing commit test**

Create `tests/policy/commit.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PushRejectedError } from '../../src/git/ops.js';
import { checkoutBranch, clone, commitAll, initBare, initRepo, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { buildCommitMessage, commitAndPush } from '../../src/policy/commit.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';

describe('buildCommitMessage', () => {
  const input = {
    type: 'feat',
    repo: 'ui-kit',
    subject: 'upgrade ui-kit to Angular 16',
    workPackageId: 'wp-01-ui-kit-angular',
    goalId: 'angular-15-to-16',
    runId: 'run-0007',
    policyEvidence: 'evidence/policy/wp-01-ui-kit-angular-ui-kit-a1.yaml',
  };

  it('writes a conventional subject scoped to the repository', () => {
    expect(buildCommitMessage(input).split('\n')[0]).toBe('feat(ui-kit): upgrade ui-kit to Angular 16');
  });

  it('references the package and the run id in trailers, as §14 requires', () => {
    const message = buildCommitMessage(input);
    expect(message).toContain('\n\nWork-Package: wp-01-ui-kit-angular');
    expect(message).toContain('Run-Id: run-0007');
    expect(message).toContain('Goal: angular-15-to-16');
    expect(message).toContain('Janus-Policy: evidence/policy/wp-01-ui-kit-angular-ui-kit-a1.yaml');
  });

  it('writes "none" for a commit with no agent run behind it', () => {
    expect(buildCommitMessage({ ...input, runId: null })).toContain('Run-Id: none');
  });

  it('collapses a multi-line subject into one line and drops a trailing period', () => {
    const message = buildCommitMessage({ ...input, subject: 'upgrade\n  the  library.' });
    expect(message.split('\n')[0]).toBe('feat(ui-kit): upgrade the library');
  });

  it('truncates a very long subject so the header line stays readable', () => {
    const message = buildCommitMessage({ ...input, subject: 'x'.repeat(200) });
    const header = message.split('\n')[0] ?? '';
    expect(header.length).toBeLessThanOrEqual(72);
    expect(header.endsWith('...')).toBe(true);
  });

  it('falls back to a usable subject when the caller supplies an empty one', () => {
    expect(buildCommitMessage({ ...input, subject: '   ' }).split('\n')[0]).toBe(
      'feat(ui-kit): apply work package wp-01-ui-kit-angular',
    );
  });
});

describe('commitAndPush', () => {
  it('commits every change, pushes fast-forward, and emits both §27 events', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const repo = workspace.state.repos['ui-kit'] === undefined ? 'shell' : 'ui-kit';
      const dir = workspace.paths.repoDir(repo);
      const branch = `ai/${ws.fixture.goalId}`;
      await checkoutBranch(dir, branch, 'HEAD');
      writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1;\n');

      const result = await commitAndPush({
        engine,
        repoDir: dir,
        repo,
        branch,
        message: buildCommitMessage({
          type: 'feat',
          repo,
          subject: 'add a file',
          workPackageId: 'wp-01',
          goalId: ws.fixture.goalId,
          runId: 'run-0001',
          policyEvidence: 'evidence/policy/wp-01-a1.yaml',
        }),
        workPackageId: 'wp-01',
        changedFiles: 1,
      });

      expect(result.pushed).toBe(true);
      expect(result.commit).toBe(await revParse(dir, 'HEAD'));
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      const types = engine.workspace.paths.janusDir;
      const events = (await import('../../src/telemetry/events.js')).readEvents(types);
      expect(events.map((event) => event['type'])).toEqual(
        expect.arrayContaining(['commit.created', 'push.completed']),
      );
      const created = events.find((event) => event['type'] === 'commit.created');
      expect(created?.['sha']).toBe(result.commit);
      expect(created?.['subject']).toBe(`feat(${repo}): add a file`);
    } finally {
      workspace.release();
    }
  });

  it('can commit without pushing', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const repo = Object.keys(workspace.state.repos)[0] ?? 'ui-kit';
      const dir = workspace.paths.repoDir(repo);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      const result = await commitAndPush({
        engine,
        repoDir: dir,
        repo,
        branch: 'main',
        message: 'feat(x): local only',
        workPackageId: 'wp-01',
        changedFiles: 1,
        push: false,
      });
      expect(result.pushed).toBe(false);
      const events = (await import('../../src/telemetry/events.js')).readEvents(workspace.paths.janusDir);
      expect(events.some((event) => event['type'] === 'push.completed')).toBe(false);
    } finally {
      workspace.release();
    }
  });

  it('lets a rejected push surface as PushRejectedError', async () => {
    const parent = tempDir();
    const bare = join(parent, 'bare.git');
    mkdirSync(bare, { recursive: true });
    await initBare(bare, 'main');
    const seed = join(parent, 'seed');
    mkdirSync(seed);
    await initRepo(seed, 'main');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    await commitAll(seed, 'feat(seed): base');
    await runGit(seed, ['remote', 'add', 'origin', bare]);
    await push(seed, 'origin', 'main');

    const other = join(parent, 'other');
    await clone(bare, other, { branch: 'main' });
    writeFileSync(join(other, 'b.txt'), 'b\n');
    await commitAll(other, 'feat(other): diverge');
    await push(other, 'origin', 'main');

    writeFileSync(join(seed, 'c.txt'), 'c\n');
    await expect(
      (async () => {
        await commitAll(seed, 'feat(seed): local');
        await push(seed, 'origin', 'main');
      })(),
    ).rejects.toBeInstanceOf(PushRejectedError);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run --project unit tests/policy/commit.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/commit.js'`.

- [ ] **Step 4: Write `src/policy/commit.ts`**

```ts
import type { Engine } from '../engine/engine.js';
import { commitAll, push as gitPush } from '../git/ops.js';

export interface CommitMessageInput {
  /** The conventional-commit type: `feat` for an implementation commit, `fix` for a debug or review-fix commit. */
  type: string;
  /** The repository name, used as the conventional-commit scope. */
  repo: string;
  subject: string;
  workPackageId: string;
  goalId: string;
  /** The agent run whose work this commit carries, or null. */
  runId: string | null;
  /** `.janus`-relative path of the report that cleared this diff. */
  policyEvidence: string;
}

/** Header plus ": " plus "..." must still fit: a git subject line over 72 characters is a review annoyance. */
const MAX_HEADER = 72;

/**
 * Spec §14 step 3: "commits with a conventional message referencing package and run id".
 *
 * `type(scope): subject` with the repository as the scope — the same convention this project's own history uses —
 * and four trailers. §14 asks only for the package and the run id; the goal id is there because a state branch
 * outlives a workspace and `git log` on the product repo is often the only artifact a reviewer has, and the
 * policy-evidence path is there because §31.25 wants the evidence for a commit to be findable *from* the commit.
 *
 * These trailers are Janus's, for Janus's commits in a product repository. They are unrelated to the
 * `Co-Authored-By` / `Claude-Session` trailers this project's own commits carry.
 */
export function buildCommitMessage(input: CommitMessageInput): string {
  const collapsed = input.subject.replace(/\s+/gu, ' ').trim().replace(/\.$/u, '');
  const fallback = `apply work package ${input.workPackageId}`;
  const prefix = `${input.type}(${input.repo}): `;
  const room = MAX_HEADER - prefix.length;
  const chosen = collapsed === '' ? fallback : collapsed;
  const subject = chosen.length <= room ? chosen : `${chosen.slice(0, Math.max(room - 3, 0))}...`;
  return [
    `${prefix}${subject}`,
    '',
    `Work-Package: ${input.workPackageId}`,
    `Run-Id: ${input.runId ?? 'none'}`,
    `Goal: ${input.goalId}`,
    `Janus-Policy: ${input.policyEvidence}`,
  ].join('\n');
}

export interface CommitAndPushInput {
  engine: Engine;
  /** The repository work tree. */
  repoDir: string;
  repo: string;
  /** The goal branch, from `state.repos.<repo>.goal_branch`. */
  branch: string;
  /** The git remote name; `origin` everywhere in a Janus workspace. */
  remote?: string;
  message: string;
  workPackageId: string;
  /** For the `commit.created` event; the report already has the file list. */
  changedFiles: number;
  /** Default true. False only for a test or a caller that pushes later. */
  push?: boolean;
}

export interface CommitAndPushResult {
  commit: string;
  pushed: boolean;
}

/**
 * Spec §14 step 3 and §32 rule 11: the orchestrator — never an agent — stages every change, commits, and pushes.
 *
 * The push is `git push` with no `--force` (see `src/git/ops.ts`), so git itself refuses a non-fast-forward and
 * `PushRejectedError` propagates to the caller. That is §16.6's base-branch-sync situation and is deliberately
 * **not** handled here: the commit exists and must not be thrown away, so the decision belongs to the stage step.
 */
export async function commitAndPush(input: CommitAndPushInput): Promise<CommitAndPushResult> {
  const remote = input.remote ?? 'origin';
  const commit = await commitAll(input.repoDir, input.message);
  const subject = input.message.split('\n')[0] ?? '';
  input.engine.emit({
    type: 'commit.created',
    repo: input.repo,
    work_package: input.workPackageId,
    branch: input.branch,
    sha: commit,
    subject,
    changed_files: input.changedFiles,
  });
  if (input.push === false) return { commit, pushed: false };
  await gitPush(input.repoDir, remote, input.branch, { setUpstream: true });
  input.engine.emit({ type: 'push.completed', repo: input.repo, remote, branch: input.branch, sha: commit });
  return { commit, pushed: true };
}
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `pnpm vitest run --project unit tests/policy/commit.test.ts tests/telemetry/events.test.ts`
Expected: PASS. If `initWorkspace` gives a repo set whose first entry differs from the assumption, read the key from `workspace.state.repos` as the test already does rather than hard-coding one.

- [ ] **Step 6: Full verification and commit**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green.

```bash
git add src/policy/commit.ts src/telemetry/events.ts tests/policy/commit.test.ts tests/telemetry/events.test.ts
git commit -m "feat(policy): commit and push a cleared diff with a scoped conventional message" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 10: The §14 flow — check, fix in place, re-check, reset

**Files:**
- Create: `src/policy/flow.ts`, `tests/policy/flow.test.ts`
- Modify: `src/agents/output-schema.ts`, `tests/agents/output-schema.test.ts`
- Test: `tests/policy/flow.test.ts`

**Interfaces:**
- Consumes: `analyzeDiff`, `changeSummaryFrom`, `inlineDiffFrom` from `./diff.js`; `buildPolicyContext` from `./context.js`; `runPolicyChecks`, `policyAttemptId`, `writePolicyEvidence`, `writePolicyPatch`, `renderPolicyReportForAgent` from `./report.js`; `buildCommitMessage`, `commitAndPush` from `./commit.js`; `resetHard` from `../git/tree.js`; `PushRejectedError` from `../git/ops.js`; `buildAgentTask` from `../agents/task.js`; `runAgent` from `../agents/run.js`; `asFixResult` from `../agents/output-schema.js`; `incrementPolicyViolations`, `checkPolicyGuardrail` from `../engine/budgets.js`; `Engine` from `../engine/engine.js`; `Providers` from `../providers/types.js`.
- Produces:
  - `interface PolicyFixContext`, `interface PolicyFlowInput`, `interface PolicyFixRecord`
  - `type PolicyFlowOutcome`
  - `async function runPolicyFlow(input: PolicyFlowInput): Promise<PolicyFlowOutcome>`
  - `function asFixResult(result: AgentResult | null): FixAgentResult | null` (in `src/agents/output-schema.ts`)

**Why:** §14's four numbered steps as one function, and the only place `policy_violations` is charged. Everything before this task was a pure function over a diff; this is where the orchestrator acts.

- [ ] **Step 1: Add the typed `fix` result accessor**

`ROLE_RESULT_SCHEMAS.fix` already extends the base shape with `no_change_needed`, but `AgentResult` — the base type — does not carry it, so a caller would need a cast. Add to `src/agents/output-schema.ts`, after `validateAgentResult`:

```ts
/** §24: the `fix` role's extra field. Declared as a type so callers of the fix flow do not hand-roll a cast. */
export interface FixAgentResult extends AgentResult {
  no_change_needed: boolean;
}

/**
 * Narrows a validated result to the `fix` shape, or null when it is not one.
 *
 * `runAgent` returns `AgentResult`, which is the base §18.3 shape; the fix role's schema is the one that adds
 * `no_change_needed`, so the only honest way back to it is to re-validate against that schema. Cheap, and it
 * means a fake runner that was scripted with the wrong shape is caught here rather than read as `false`.
 */
export function asFixResult(result: AgentResult | null): FixAgentResult | null {
  if (result === null) return null;
  const parsed = ROLE_RESULT_SCHEMAS.fix.safeParse(result);
  return parsed.success ? (parsed.data as FixAgentResult) : null;
}
```

Add to `tests/agents/output-schema.test.ts`:

```ts
describe('asFixResult', () => {
  it('narrows a validated fix result to its no_change_needed field', () => {
    const validated = validateAgentResult('fix', { ...baseFixture(), no_change_needed: true });
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    expect(asFixResult(validated.result)?.no_change_needed).toBe(true);
  });

  it('returns null for a base result that is not a fix result', () => {
    const validated = validateAgentResult('implementation', baseFixture());
    if (!validated.ok) throw new Error(validated.errors.join('; '));
    expect(asFixResult(validated.result)).toBeNull();
  });

  it('returns null for no result at all', () => {
    expect(asFixResult(null)).toBeNull();
  });
});
```

`baseFixture()` is whatever that test file already uses to build a valid §18.3 result; reuse it rather than writing a second one. Import `asFixResult` alongside the existing imports.

Run: `pnpm vitest run --project unit tests/agents/output-schema.test.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing flow test**

Create `tests/policy/flow.test.ts`. It runs against a real workspace and a real git repository, because the flow's whole job is to commit, push and reset — none of which a stub can prove:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask } from '../../src/agents/types.js';
import { outcomeSummary } from '../../src/agents/types.js';
import { revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { runPolicyFlow } from '../../src/policy/flow.js';
import type { PolicyFixContext } from '../../src/policy/flow.js';
import type { PolicyReport } from '../../src/policy/types.js';
import type { AgentRunner, Providers } from '../../src/providers/types.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, testEngine, testProviders } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const FIX_CONTEXT: PolicyFixContext = {
  goal: 'upgrade ui-kit to Angular 16',
  repository: 'ui-kit (library)',
  planSlice: 'wp-01: upgrade ui-kit',
  currentState: 'implementation done, policy failed',
  previousAttempts: [],
  baselineExceptions: [],
  guardrails: ['allowed_scope: src/**'],
  budget: 'policy_violations 0 of 2',
};

/** A runner that edits the tree the way a scripted fix agent would, then reports whatever it was told to. */
function fixRunner(edit: (repoDir: string) => void, changesMade: string[] = []): AgentRunner {
  return {
    name: 'fake',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      edit(task.cwd);
      const result = {
        status: 'completed' as const,
        summary: 'removed the violation',
        changes_made: changesMade,
        findings: [],
        evidence: [],
        new_tasks: [],
        expected_temporary_failure: false,
        predicted_failures: null,
        plan_change_required: false,
        architecture_change_required: false,
        behavior_change_required: false,
        recommended_next_action: 'commit',
        handover: { current_state: 'fixed', next_action: 'commit', risks: [] },
        no_change_needed: false,
      };
      return {
        runId: task.runId,
        status: 'completed',
        summary: outcomeSummary(result, null),
        result,
        failure: null,
        tokens: null,
        durationMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        runnerVersion: null,
        jsonlTruncated: false,
        stderrTruncated: false,
      };
    },
  };
}

function providersWith(runner: AgentRunner, workspace: Workspace): Providers {
  return { ...testProviders(workspace.paths), agent: runner };
}

function seedWorkPackage(workspace: Workspace, repo: string): void {
  workspace.state.execution.work_packages['wp-01'] = {
    status: 'in_progress',
    repos: { [repo]: { commits: [], builds: [], attempts: 1, policy_violations: 0, last_failure_signature: null } },
    publish: { version: null, build_id: null },
    checkpoint: { outcome: null, run_id: null },
    regroups: [],
  };
}

describe('runPolicyFlow', () => {
  let ws: WorkspaceFixture;

  beforeEach(async () => {
    ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
  });

  it('reports a clean tree without committing anything', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const before = await revParse(workspace.paths.repoDir('ui-kit'), 'HEAD');
      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'nothing to do',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });
      expect(outcome.kind).toBe('clean');
      expect(await revParse(workspace.paths.repoDir('ui-kit'), 'HEAD')).toBe(before);
    } finally {
      workspace.release();
    }
  });

  it('commits and pushes a diff that passes every check, and writes passing evidence', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'src-new.ts'), 'export const added = 1;\n');

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a file',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.pushed).toBe(true);
      expect(outcome.fix).toBeNull();
      expect(outcome.commit).toBe(await revParse(dir, 'HEAD'));
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('feat(ui-kit): add a file');
      expect(await runGit(dir, ['log', '-1', '--format=%b'])).toContain('Work-Package: wp-01');

      const report = parse(readFileSync(join(workspace.paths.janusDir, outcome.evidence), 'utf8')) as PolicyReport;
      expect(report.passed).toBe(true);
      expect(report.phase).toBe('initial');
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked).toHaveLength(1);
      expect(checked[0]?.['passed']).toBe(true);
    } finally {
      workspace.release();
    }
  });

  it('runs one fix agent in place, re-checks, and commits when the fix worked', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(
          fixRunner((repoDir) => {
            writeFileSync(join(repoDir, 'a.spec.ts'), "it('runs', () => {});\n");
          }),
          workspace,
        ),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.fix?.runId).toBe('run-0002');
      expect(outcome.fix?.noChangeNeeded).toBe(false);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(0);
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked.map((event) => event['phase'])).toEqual(['initial', 'recheck']);
    } finally {
      workspace.release();
    }
  });

  it('resets the tree, exports the patch, and charges the budget when the fix failed', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.increment?.value).toBe(1);
      expect(outcome.increment?.exhausted).toBe(false);
      expect(outcome.guardrail).toBeNull();
      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(join(dir, 'a.spec.ts'))).toBe(false);
      const patch = readFileSync(join(workspace.paths.janusDir, outcome.patch), 'utf8');
      expect(patch).toContain('a.spec.ts');
      expect(patch).toContain("xit('skipped'");
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(1);
    } finally {
      workspace.release();
    }
  });

  it('skips the fix agent entirely once the per-package limit is already reached', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const entry = workspace.state.execution.work_packages['wp-01']?.repos['ui-kit'];
      if (entry === undefined) throw new Error('missing work package repo block');
      entry.policy_violations = 2; // max_policy_violations_per_package
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      let fixRuns = 0;
      const counting: AgentRunner = {
        name: 'fake',
        run: async (task) => {
          fixRuns += 1;
          return fixRunner(() => {}).run(task, { text: '', version: 'fix@3', bytes: 0, truncations: [] });
        },
      };

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(counting, workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 3,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(fixRuns).toBe(0);
      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.fix).toBeNull();
      expect(outcome.increment).toBeNull();
      expect(outcome.guardrail?.guardrail).toBe('policy_violations');
      expect(outcome.guardrail?.value).toBe(2);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(2);
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked).toHaveLength(1);
    } finally {
      workspace.release();
    }
  });

  it('sees every file the tree changed even when the fix agent under-reports its own work', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(
          // Removes the violation it was told about, quietly adds a forbidden path, and claims one file.
          fixRunner((repoDir) => {
            writeFileSync(join(repoDir, 'a.spec.ts'), "it('runs', () => {});\n");
            runGitSync(repoDir, ['init', '-q']);
            writeFileSync(join(repoDir, 'ci.yml.tmp'), 'x\n');
          }, ['a.spec.ts']),
          workspace,
        ),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['a.spec.ts'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.report.violations.map((finding) => finding.check)).toContain('scope.outside_allowed');
      expect(outcome.report.files.map((file) => file.path)).toContain('ci.yml.tmp');
      expect(outcome.fix?.runId).toBe('run-0002');
    } finally {
      workspace.release();
    }
  });
});
```

Delete the stray `runGitSync` call before running: the fix agent in that last case only needs to write two files, so the body is

```ts
          fixRunner((repoDir) => {
            writeFileSync(join(repoDir, 'a.spec.ts'), "it('runs', () => {});\n");
            writeFileSync(join(repoDir, 'ci.yml.tmp'), 'x\n');
          }, ['a.spec.ts']),
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run --project unit tests/policy/flow.test.ts`
Expected: FAIL — `Cannot find module '../../src/policy/flow.js'`.

- [ ] **Step 4: Write `src/policy/flow.ts`**

```ts
import { asFixResult } from '../agents/output-schema.js';
import { runAgent } from '../agents/run.js';
import { buildAgentTask } from '../agents/task.js';
import type { AgentResult } from '../agents/output-schema.js';
import { checkPolicyGuardrail, incrementPolicyViolations } from '../engine/budgets.js';
import type { BudgetIncrement, GuardrailHit } from '../engine/budgets.js';
import type { Engine } from '../engine/engine.js';
import { PushRejectedError } from '../git/ops.js';
import { resetHard } from '../git/tree.js';
import type { Providers } from '../providers/types.js';
import { buildCommitMessage, commitAndPush } from './commit.js';
import { buildPolicyContext } from './context.js';
import { analyzeDiff, changeSummaryFrom, inlineDiffFrom } from './diff.js';
import type { DiffAnalysis } from './diff.js';
import {
  policyAttemptId,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from './report.js';
import type { PolicyReport } from './types.js';

/** The §18.2 sections only the stage step knows; the rest of the fix agent's context comes from the diff. */
export interface PolicyFixContext {
  goal: string;
  repository: string | null;
  planSlice: string | null;
  currentState: string | null;
  previousAttempts: string[];
  baselineExceptions: string[];
  guardrails: string[];
  budget: string;
}

export interface PolicyFlowInput {
  engine: Engine;
  /** §3.2: the injected provider bag; `providers.agent` runs the in-place fix. Never a module singleton. */
  providers: Providers;
  repo: string;
  workPackageId: string;
  /** 1-based policy attempt for this (package, repo); names the evidence files. */
  attempt: number;
  /** The code-writing run whose diff this is, recorded on the report and in the commit trailer. */
  runId: string | null;
  /** The run id to give the in-place fix agent if one is needed. */
  fixRunId: string;
  /** The work package's `allowed_scope` from `plan.yaml` (§12), or null. */
  allowedScope: readonly string[] | null;
  /** §14: "violation unless the package allows it". Defaults to `policy.allow_test_file_deletion`. */
  allowTestFileDeletion?: boolean;
  /** Conventional-commit type: `feat` for implementation, `fix` for debug and review-fix commits. */
  commitType: string;
  commitSubject: string;
  fixContext: PolicyFixContext;
  /** `pnpm store path`, needed only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  /** Default true; false for a caller that pushes later. */
  push?: boolean;
}

export interface PolicyFixRecord {
  runId: string;
  status: AgentResult['status'];
  /** §24: the fix agent may answer "nothing to change here". Recorded so T12 can escalate instead of looping. */
  noChangeNeeded: boolean;
  /** `.janus`-relative path of `evidence/agents/<run-id>.yaml`. */
  evidencePath: string;
}

export type PolicyFlowOutcome =
  /** The tree had nothing to commit — before the fix agent ran, or because the fix agent reverted everything. */
  | { kind: 'clean'; stage: 'before_fix' | 'after_fix'; fix: PolicyFixRecord | null }
  /** §14 step 3: checks passed, the diff is committed and pushed. */
  | { kind: 'committed'; commit: string; pushed: boolean; report: PolicyReport; evidence: string; fix: PolicyFixRecord | null }
  /** The commit exists but the remote branch moved; §16.6 base sync owns this, and the commit must not be reset. */
  | { kind: 'push_rejected'; commit: string; report: PolicyReport; evidence: string; fix: PolicyFixRecord | null }
  /** §14 step 4: the tree was reset, the diff was saved as a patch, and the attempt counted. */
  | {
      kind: 'reset';
      report: PolicyReport;
      evidence: string;
      /** `.janus`-relative path of the exported patch. */
      patch: string;
      /** The increment this reset charged, or null when the counter was already at its limit. */
      increment: BudgetIncrement | null;
      /** Set when `policy_violations` is at `max_policy_violations_per_package`; T12 escalates on it (§20). */
      guardrail: GuardrailHit | null;
      fix: PolicyFixRecord | null;
    };

/**
 * Spec §14, the whole commit model, for one repository's working tree.
 *
 * 1. collect the diff — from the git tree only. `AgentResult.changes_made` is never consulted: the T06 spike
 *    showed agents mis-reporting their own file list in both directions, so a check built on a self-report can be
 *    talked out of firing.
 * 2. run the checks, write `evidence/policy/<attempt-id>.yaml`, emit `policy.checked`
 * 3. on pass: commit with a conventional message referencing package and run id, then push
 * 4. on violation: run one fresh fix agent with the report and the diff kept in place; if the re-check still
 *    fails, reset the tree, save the diff as a patch, and charge `policy_violations`
 *
 * The one exception to step 4 is §20's ceiling: when `policy_violations` is *already* at
 * `max_policy_violations_per_package`, the fix attempt cannot change what happens next, so it is skipped and the
 * tree is reset directly. That is §14's "or `max_policy_violations_per_package` is reached".
 *
 * §32 rule 11 holds throughout: every git write here — `commit`, `push`, `reset --hard` — runs in the
 * orchestrator process. The agent is handed a working tree and nothing else.
 *
 * This function writes **no** state beyond the `policy_violations` counter (which §20 requires and
 * `src/engine/budgets.ts` owns). Recording the commit sha on `state.repos.<repo>.head_commit` and on the work
 * package's `commits` array, and checkpointing, belong to the calling stage step (T12).
 */
export async function runPolicyFlow(input: PolicyFlowInput): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths, state, config, goal } = engine.workspace;
  const repoDir = paths.repoDir(repo);
  const attemptId = policyAttemptId(input.workPackageId, repo, input.attempt);

  const analysis = await analyzeDiff(repoDir);
  if (analysis.files.length === 0) return { kind: 'clean', stage: 'before_fix', fix: null };

  const first = await check(input, analysis, attemptId, 'initial');
  if (first.report.passed) return commitPass(input, analysis, first, null);

  const budgetCtx = { state, config, emit: engine.emit };
  const already = checkPolicyGuardrail(budgetCtx, input.workPackageId, repo);
  if (already !== null) {
    engine.warn(
      `policy violations in ${repo} are already ${already.value} of ${already.limit}; resetting without a fix attempt`,
    );
    return reset(input, analysis, first, null, null, already);
  }

  const fix = await runFixAgent(input, analysis, first.report);

  const after = await analyzeDiff(repoDir);
  if (after.files.length === 0) return { kind: 'clean', stage: 'after_fix', fix };

  const attemptIdRecheck = `${attemptId}-recheck`;
  const second = await check(input, after, attemptIdRecheck, 'recheck');
  if (second.report.passed) return commitPass(input, after, second, fix);

  const increment = incrementPolicyViolations(
    budgetCtx,
    input.workPackageId,
    repo,
    `policy check still failed after the in-place fix attempt (${second.report.violations.length} violation(s))`,
  );
  const guardrail = checkPolicyGuardrail(budgetCtx, input.workPackageId, repo);
  return reset(input, after, second, fix, increment, guardrail);
}

interface CheckResult {
  report: PolicyReport;
  evidence: string;
}

async function check(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  attemptId: string,
  phase: PolicyReport['phase'],
): Promise<CheckResult> {
  const { engine, repo } = input;
  const { paths, config, goal } = engine.workspace;
  const ctx = buildPolicyContext({
    cwd: paths.repoDir(repo),
    analysis,
    config,
    targetVersion: Number(goal.target_version),
    allowedScope: input.allowedScope,
    ...(input.allowTestFileDeletion === undefined ? {} : { allowTestFileDeletion: input.allowTestFileDeletion }),
  });
  const report = await runPolicyChecks({
    ctx,
    attemptId,
    workPackageId: input.workPackageId,
    repo,
    runId: input.runId,
    phase,
    now: engine.now(),
  });
  const evidence = writePolicyEvidence(paths, report);
  engine.emit({
    type: 'policy.checked',
    work_package: input.workPackageId,
    repo,
    attempt_id: attemptId,
    run_id: input.runId,
    phase,
    passed: report.passed,
    changed_files: report.totals.changed_files,
    violations: report.violations.length,
    warnings: report.warnings.length,
    violated_checks: [...new Set(report.violations.map((finding) => finding.check))],
    evidence,
  });
  for (const finding of report.warnings) engine.warn(`policy warning [${finding.check}]: ${finding.detail}`);
  return { report, evidence };
}

async function commitPass(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  checked: CheckResult,
  fix: PolicyFixRecord | null,
): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths, state } = engine.workspace;
  const repoState = state.repos[repo];
  if (repoState === undefined) throw new Error(`state has no repo ${repo}`);
  const message = buildCommitMessage({
    type: input.commitType,
    repo,
    subject: input.commitSubject,
    workPackageId: input.workPackageId,
    goalId: state.goal.id,
    runId: input.runId,
    policyEvidence: checked.evidence,
  });
  try {
    const result = await commitAndPush({
      engine,
      repoDir: paths.repoDir(repo),
      repo,
      branch: repoState.goal_branch,
      message,
      workPackageId: input.workPackageId,
      changedFiles: analysis.totals.changedFiles,
      ...(input.push === undefined ? {} : { push: input.push }),
    });
    return { kind: 'committed', commit: result.commit, pushed: result.pushed, report: checked.report, evidence: checked.evidence, fix };
  } catch (error) {
    if (error instanceof PushRejectedError) {
      // The commit exists. §16.6 owns the base-branch sync that resolves this; resetting here would throw the
      // work away for a reason that has nothing to do with the diff's content.
      const head = await engine.workspace.state.repos[repo]?.head_commit;
      engine.warn(`push of ${repoState.goal_branch} in ${repo} was rejected; the commit is kept for base sync (§16.6)`);
      return {
        kind: 'push_rejected',
        commit: head ?? '',
        report: checked.report,
        evidence: checked.evidence,
        fix,
      };
    }
    throw error;
  }
}

/**
 * §14 step 4: "one fresh 'remove the violation' fix agent with the report and the diff kept in place".
 *
 * Fresh: a new run id, no previous model, and no previous agent's reasoning in the context (§18.2). The report
 * travels in LATEST VERIFICATION EVIDENCE — §18.2's thirteen sections are fixed and T08 adds none, and that is
 * the section whose job is "what the last check said about this diff".
 *
 * The inline diff excludes generated files (`inlineDiffFrom`): `renderContextPackage` refuses a diff containing
 * a lockfile, and an `ng update` diff always contains one.
 */
async function runFixAgent(input: PolicyFlowInput, analysis: DiffAnalysis, report: PolicyReport): Promise<PolicyFixRecord> {
  const { engine } = input;
  const { paths, config } = engine.workspace;
  const task = buildAgentTask({
    runId: input.fixRunId,
    role: 'fix',
    repo: input.repo,
    attempt: input.attempt,
    paths,
    config,
    profile: input.profile,
    globalPnpmStore: input.globalPnpmStore,
    context: {
      goal: input.fixContext.goal,
      repository: input.fixContext.repository,
      planSlice: input.fixContext.planSlice,
      currentState: input.fixContext.currentState,
      changeSummary: changeSummaryFrom(analysis),
      inlineDiff: inlineDiffFrom(analysis),
      verificationEvidence: renderPolicyReportForAgent(report),
      previousAttempts: input.fixContext.previousAttempts,
      baselineExceptions: input.fixContext.baselineExceptions,
    },
    guardrails: input.fixContext.guardrails,
    budget: input.fixContext.budget,
  });
  const record = await runAgent({ engine, runner: input.providers.agent, task, previousModel: null });
  return {
    runId: task.runId,
    status: record.outcome.status,
    noChangeNeeded: asFixResult(record.outcome.result)?.no_change_needed === true,
    evidencePath: record.evidencePath,
  };
}

/** §14 step 4: "the tree is reset, the diff is saved as a patch, and the attempt counts against the role budget". */
async function reset(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  checked: CheckResult,
  fix: PolicyFixRecord | null,
  increment: BudgetIncrement | null,
  guardrail: GuardrailHit | null,
): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths } = engine.workspace;
  // The patch is written BEFORE the reset, and carries generated files too: it exists for a human to re-apply.
  const patch = writePolicyPatch(paths, checked.report.attempt_id, analysis.patch);
  await resetHard(paths.repoDir(repo));
  engine.warn(
    `policy check ${checked.report.attempt_id} failed with ${checked.report.violations.length} violation(s); ` +
      `${repo} was reset and the diff saved to ${patch}`,
  );
  return { kind: 'reset', report: checked.report, evidence: checked.evidence, patch, increment, guardrail, fix };
}
```

Two details to get right while writing this, both of which the tests above will catch:

1. In `commitPass`'s `PushRejectedError` branch, the commit sha is the one `commitAll` returned before `push` threw — but `commitAndPush` swallowed it inside the throw. Restructure so the sha survives: have `commitPass` call `commitAndPush` with `push: false`, then push separately, or (simpler, and what the code above intends) change `commitAndPush` to take the push failure itself. **Do the simple thing:** in `src/policy/commit.ts`, wrap the `gitPush` call so a `PushRejectedError` is re-thrown as `new PushRejectedCommitError(commit, cause)` carrying the sha, and have `commitPass` read `error.commit`. Add that class to `src/policy/commit.ts`:

```ts
/** A push that git refused, carrying the commit that was already made so the caller does not lose it (§16.6). */
export class PushRejectedCommitError extends Error {
  readonly commit: string;
  constructor(commit: string, cause: PushRejectedError) {
    super(`push rejected after commit ${commit}: ${cause.message}`);
    this.name = 'PushRejectedCommitError';
    this.commit = commit;
  }
}
```

and in `commitAndPush`:

```ts
  try {
    await gitPush(input.repoDir, remote, input.branch, { setUpstream: true });
  } catch (error) {
    if (error instanceof PushRejectedError) throw new PushRejectedCommitError(commit, error);
    throw error;
  }
```

Then `commitPass` catches `PushRejectedCommitError` and uses `error.commit`. Add a case to `tests/policy/commit.test.ts` asserting the sha survives on the error.

2. `goal` is destructured in `runPolicyFlow` but used only in `check`. Drop it from `runPolicyFlow`'s destructuring — `pnpm lint` will say so.

- [ ] **Step 5: Run the flow tests and watch them pass**

Run: `pnpm vitest run --project unit tests/policy/flow.test.ts`
Expected: PASS, 6 cases.

- [ ] **Step 6: Full verification and commit**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green.

```bash
git add src/policy/flow.ts src/policy/commit.ts src/agents/output-schema.ts tests/policy/flow.test.ts tests/policy/commit.test.ts tests/agents/output-schema.test.ts
git commit -m "feat(policy): add the check, fix-in-place, and reset flow" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 11: The public surface and the harness scenarios

**Files:**
- Create: `src/policy/index.ts`, `tests/integration/policy.test.ts`
- Test: `tests/integration/policy.test.ts`

**Interfaces:**
- Consumes: every module under `src/policy/`; `createHarness`, `expectNoAgentGitWrites`, `expectStatePushed` from `tests/integration/harness/harness.js`.
- Produces: `src/policy/index.ts` — the only module T11 and T12 import from.

**Why:** `tasks.md` T08's done criterion: "fixture-diff unit tests for every check, plus harness scenarios for pass, fix-in-place success, and reset after limit." The unit half is Tasks 4-10; this is the harness half, plus the seam T11 and T12 will consume (D11).

- [ ] **Step 1: Write `src/policy/index.ts`**

```ts
/**
 * The §14 policy package's public surface.
 *
 * T11 (plan validation and Gate 1) and T12 (the package loop) import from **this module only** — never from
 * `./checks/*` or from `./flow.js` directly — so the internal file layout can change without touching a stage
 * step. T08 wires no stage step of its own: `src/engine/steps.ts` keeps its `executing` placeholder until T12.
 */
export { analyzeDiff, buildDiffAnalysis, changeSummaryFrom, inlineDiffFrom, DiffAnalysisError } from './diff.js';
export type { DiffAnalysis, DiffFile, DiffHunk, DiffLine } from './diff.js';
export { buildPolicyContext } from './context.js';
export type { BuildPolicyContextInput } from './context.js';
export { matchesAnyGlob, matchesGlob } from './glob.js';
export { ALL_POLICY_CHECKS } from './registry.js';
export {
  policyAttemptId,
  policyEvidencePath,
  policyPatchPath,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from './report.js';
export type { RunPolicyChecksInput } from './report.js';
export { buildCommitMessage, commitAndPush, PushRejectedCommitError } from './commit.js';
export type { CommitAndPushInput, CommitAndPushResult, CommitMessageInput } from './commit.js';
export { runPolicyFlow } from './flow.js';
export type { PolicyFixContext, PolicyFixRecord, PolicyFlowInput, PolicyFlowOutcome } from './flow.js';
export { POLICY_CHECK_IDS } from './types.js';
export type {
  PolicyCheck,
  PolicyCheckContext,
  PolicyCheckId,
  PolicyFinding,
  PolicyReport,
  PolicyReportFile,
  PolicySeverity,
} from './types.js';
```

- [ ] **Step 2: Write the failing harness scenarios**

Create `tests/integration/policy.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkoutBranch, push, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { createEngine } from '../../src/engine/engine.js';
import { runPolicyFlow } from '../../src/policy/index.js';
import type { PolicyFixContext, PolicyReport } from '../../src/policy/index.js';
import { createFakeAgentRunner, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { createHarness, expectNoAgentGitWrites } from './harness/harness.js';
import type { Harness } from './harness/harness.js';

const SPECS = [{ name: 'ui-kit', kind: 'library' as const }];

const FIX_CONTEXT: PolicyFixContext = {
  goal: 'upgrade ui-kit to Angular 16',
  repository: 'ui-kit (library)',
  planSlice: 'wp-01: upgrade ui-kit',
  currentState: 'implementation finished',
  previousAttempts: [],
  baselineExceptions: [],
  guardrails: ['allowed_scope: src/**, a.spec.ts'],
  budget: 'policy_violations 0 of 2',
};

/** Puts `ui-kit` on its goal branch with a work-package block, and returns the open workspace. */
async function prepare(harness: Harness): Promise<Workspace> {
  const dir = join(harness.root, 'repos', 'ui-kit');
  const branch = `ai/${harness.fixture.goalId}`;
  await checkoutBranch(dir, branch, 'HEAD');
  await push(dir, 'origin', branch, { setUpstream: true });
  const workspace = await openWorkspace(harness.root);
  const repoState = workspace.state.repos['ui-kit'];
  if (repoState === undefined) throw new Error('state has no ui-kit');
  repoState.goal_branch = branch;
  workspace.state.execution.work_packages['wp-01'] = {
    status: 'in_progress',
    repos: { 'ui-kit': { commits: [], builds: [], attempts: 1, policy_violations: 0, last_failure_signature: null } },
    publish: { version: null, build_id: null },
    checkpoint: { outcome: null, run_id: null },
    regroups: [],
  };
  return workspace;
}

function engineFor(workspace: Workspace, harness: Harness) {
  return createEngine({ workspace, log: () => {}, warn: () => {}, push: false });
}

function flowInput(workspace: Workspace, harness: Harness, overrides: Record<string, unknown> = {}) {
  return {
    engine: engineFor(workspace, harness),
    providers: harness.providers,
    repo: 'ui-kit',
    workPackageId: 'wp-01',
    attempt: 1,
    runId: 'run-0001',
    fixRunId: 'run-0002',
    allowedScope: ['src/**', 'a.spec.ts'],
    commitType: 'feat',
    commitSubject: 'upgrade ui-kit',
    fixContext: FIX_CONTEXT,
    globalPnpmStore: null,
    profile: 'default',
    ...overrides,
  } as Parameters<typeof runPolicyFlow>[0];
}

describe('policy flow in the harness', () => {
  it('pass: commits a clean diff, pushes it, and leaves passing evidence', async () => {
    const harness = await createHarness(SPECS);
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'src-feature.ts'), 'export const feature = 1;\n');
      // Left untracked on purpose: `workingTreeDiff` registers it with `add --intent-to-add`,
      // so it must surface as an `A` record without the test staging it.

      const outcome = await runPolicyFlow(flowInput(workspace, harness, { allowedScope: ['**'] }));
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');

      expect(await remoteHead(dir, 'origin', `ai/${harness.fixture.goalId}`)).toBe(outcome.commit);
      const report = parse(readFileSync(join(workspace.paths.janusDir, outcome.evidence), 'utf8')) as PolicyReport;
      expect(report.passed).toBe(true);
      expect(report.files.map((file) => file.path)).toEqual(['src-feature.ts']);
      expect(harness.events().some((event) => event['type'] === 'push.completed')).toBe(true);
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('fix-in-place: one fix agent removes the violation and the diff is committed', async () => {
    const harness = await createHarness(SPECS);
    seedFakeAgents(harness.fakeDir, {
      fix: [
        {
          status: 'completed',
          summary: 'removed the skipped test',
          patch: [
            'diff --git a/a.spec.ts b/a.spec.ts',
            '--- a/a.spec.ts',
            '+++ b/a.spec.ts',
            '@@ -1 +1 @@',
            "-xit('skipped', () => {});",
            "+it('runs', () => {});",
            '',
          ].join('\n'),
          // §14 deliberately never reads this: the check reruns against the tree.
          result: { no_change_needed: false, changes_made: [] },
        },
      ],
    });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      // HEAD must be clean: `tests.forbidden_pattern_added` fires on ADDED lines, so the
      // forbidden pattern has to arrive in the diff, not already sit in the seed commit.
      writeFileSync(join(dir, 'a.spec.ts'), "it('placeholder', () => {});\n");
      await runGit(dir, ['add', '-A']);
      await runGit(dir, ['commit', '-q', '-m', 'feat(ui-kit): seed a spec file']);
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow(flowInput(workspace, harness));
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.fix?.runId).toBe('run-0002');
      expect(readFileSync(join(dir, 'a.spec.ts'), 'utf8')).toContain("it('runs'");
      expect(harness.evidence(`agents/run-0002.yaml`)).toContain('role: fix');
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('reset after limit: the tree goes back, the patch is exported, and the counter hits its limit', async () => {
    const harness = await createHarness(SPECS);
    // The fix agent changes nothing, so the recheck fails exactly as the first check did.
    seedFakeAgents(harness.fakeDir, {
      fix: [{ status: 'completed', summary: 'nothing to do', result: { no_change_needed: true } }],
    });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      const entry = workspace.state.execution.work_packages['wp-01']?.repos['ui-kit'];
      if (entry === undefined) throw new Error('missing work package repo block');
      entry.policy_violations = 1;

      writeFileSync(join(dir, 'forbidden.ts'), 'export const x = 1;\n');

      const outcome = await runPolicyFlow(flowInput(workspace, harness, { attempt: 2, allowedScope: ['src/**'] }));
      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');

      expect(outcome.increment?.value).toBe(2);
      expect(outcome.increment?.exhausted).toBe(true);
      expect(outcome.guardrail?.guardrail).toBe('policy_violations');
      expect(outcome.fix?.noChangeNeeded).toBe(true);

      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(join(dir, 'forbidden.ts'))).toBe(false);
      const patch = readFileSync(join(workspace.paths.janusDir, outcome.patch), 'utf8');
      expect(patch).toContain('forbidden.ts');

      const hits = harness.events().filter((event) => event['type'] === 'guardrail.hit');
      expect(hits.length).toBe(0); // the flow reports the hit; escalating on it is T12's job
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('no agent process moves a ref across the whole flow (§31.29, §32 rule 11)', async () => {
    const harness = await createHarness(SPECS);
    seedFakeAgents(harness.fakeDir, {
      fix: [
        {
          status: 'completed',
          summary: 'fixed',
          patch: [
            'diff --git a/a.spec.ts b/a.spec.ts',
            '--- a/a.spec.ts',
            '+++ b/a.spec.ts',
            '@@ -1 +1 @@',
            "-xit('skipped', () => {});",
            "+it('runs', () => {});",
            '',
          ].join('\n'),
        },
      ],
    });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "it('placeholder', () => {});\n");
      await runGit(dir, ['add', '-A']);
      await runGit(dir, ['commit', '-q', '-m', 'feat(ui-kit): seed a spec file']);
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      await runPolicyFlow(flowInput(workspace, harness));

      // The audit wrapper brackets every `AgentRunner.run()`; a commit, push or reset inside that window would
      // appear here. Every git write in this flow happens in the orchestrator, outside the window.
      expect(harness.agentGitWrites).toEqual([]);
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });
});
```

Before running, simplify the two scenarios that accumulated redundant setup while being written: the `fix-in-place` case only needs (a) a committed `a.spec.ts` containing a passing test and (b) a working-tree edit that replaces it with `xit('skipped', () => {});`. Remove the duplicated `writeFileSync` / `checkout --` lines and the stray `git mv` in the `pass` case — a plain `writeFileSync` of a new file is the whole setup there.

- [ ] **Step 3: Run the integration lane and watch it fail, then pass**

Run: `pnpm vitest run --project integration tests/integration/policy.test.ts`
Expected first: FAIL — `Cannot find module '../../src/policy/index.js'` until Step 1 is saved, then failures from the setup simplification above. Iterate until all four scenarios pass.

Two things that will bite, and their fixes:
- **The fake runner applies its patch with `git apply`**, which needs the patch's context to match the tree exactly. If a scenario's patch does not apply, the fake throws with git's own message; adjust the seeded file so the `@@ -1 +1 @@` hunk lines up.
- **`createHarness` asserts §31.29 automatically when the test finishes.** Do not pass `expectAgentGitWrites`. If the assertion fires, the flow committed inside an agent window — which would be a real bug, not a test problem.

- [ ] **Step 4: Full verification**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`
Expected: all green; integration goes from 24 passing to 28.

- [ ] **Step 5: Commit**

```bash
git add src/policy/index.ts tests/integration/policy.test.ts
git commit -m "feat(policy): expose the T11/T12 surface and cover the flow in the harness" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 12: Record T08 in the status table

**Files:**
- Modify: `tasks.md:22`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing in code. This task closes the loop `tasks.md` opens for every task.

**Why:** `tasks.md`'s Status section says "Update this table when a task merges to `main`." T06 and T07 were recorded in `cf5eb68`; T08 gets the same treatment, and the "next:" pointer moves on.

- [ ] **Step 1: Confirm the numbers before writing them down**

Run: `pnpm test:unit` and `pnpm test:integration`
Record the exact counts each prints. Do not write a number this step did not produce.

- [ ] **Step 2: Replace the pending row**

In `tasks.md`, replace line 22:

```markdown
| T08 to T24 | pending | | next: T08 (policy checks and orchestrator commit/push) |
```

with two rows (substituting the real merge sha and the counts from Step 1):

```markdown
| T08 | done | <sha> (2026-09-20) | <N> tests; `src/policy/` with ten checks, `-z` diff parsing, fix-in-place flow, `policy.checked`/`commit.created`/`push.completed` |
| T09 to T24 | pending | | next: T09 (CI providers) and T10 (SCM providers), parallel B |
```

- [ ] **Step 3: Verify nothing else changed**

Run: `git diff --stat`
Expected: `tasks.md` only, two lines changed for one.

- [ ] **Step 4: Commit**

```bash
git add tasks.md
git commit -m "docs(tasks): record T08 as done" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Self-Review

Run after the plan is written, against the spec with fresh eyes.

**1. Spec coverage.** Every §14 table row maps to a task:

| Spec requirement | Task |
|---|---|
| §14 step 1, collect the diff (tracked and untracked, ignored excluded) | Tasks 1, 3 (`workingTreeDiff` already does `add --intent-to-add`, which respects `.gitignore`) |
| §14 step 2, run policy checks | Task 8 |
| §14 step 3, commit with a message referencing package and run id, then push | Task 9 |
| §14 step 4, evidence, one fix agent in place, re-check, reset, patch, budget | Task 10 |
| §14 forbidden test patterns added | Task 5 |
| §14 deleted or renamed test files | Task 5 |
| §14 net decrease in test count | Task 5 |
| §14 forbidden paths | Task 4 |
| §14 runner-config threshold / exclusion detection | Task 6 |
| §14 Angular version beyond target | Task 7 |
| §14 scope | Task 4 |
| §14 diff size | Task 4 |
| §14 secrets | Task 7 |
| §12 lockfile-in-scope warning | Task 7 |
| §20 `policy_violations`, `max_policy_violations_per_package` | Task 10 |
| §20 `max_changed_files`, `max_diff_lines` | Task 4 |
| §27 `policy.checked` | Task 8 |
| §27 `commit.created`, `push.completed` | Task 9 |
| §31.25 every diff policy-checked, violations evidenced, fixed in place once, fed back | Tasks 8, 10, 11 |
| §31.29 / §32 rule 11, no agent git write | Task 11 (harness), and structurally: no git write lives outside `src/policy/commit.ts` and `src/policy/flow.ts` |
| §32 rule 12, no secret in evidence | Task 7 (`evidence: null`, plus an explicit assertion) |
| §29 item 1, unit tests for policy checks | Tasks 4-10 |
| §29 item 3, harness scenarios | Task 11 |
| `tasks.md` T08 done criterion | Tasks 4-7 (fixture-diff unit tests for every check) and Task 11 (pass, fix-in-place, reset after limit) |

Gaps found and closed while reviewing: §14's "tautological expectations" was initially folded into the substring pattern list, where it could not work — a tautology is a *shape*, not a substring. Task 5 now carries `isTautologicalExpectation` with its own cases. §16.6's rejected-push case had no outcome at all in the first draft of the flow union; D9 and the `push_rejected` member were added, along with `PushRejectedCommitError` so the commit sha survives the throw.

**2. Placeholder scan.** No "TBD", no "handle edge cases", no "similar to Task N", no "add appropriate error handling". Every code step carries the actual code; every test step carries the actual assertions.

Two defects were found in Task 11 Step 2 during controller review and fixed in place: the pass scenario carried a dead `git mv src-feature.ts src-feature.ts` on an untracked file (which fails with "bad source" and was swallowed by a `.catch`), and the fix-in-place scenario seeded `a.spec.ts` with the forbidden pattern already in HEAD and then reverted the working tree back to it, leaving an **empty diff** that never exercised the flow. The seed is now clean (`it('placeholder', ...)`) so the `xit(` arrives as an added line, matching the setup the git-audit scenario already used.

**3. Type consistency.** Checked across tasks:
- `PolicyCheck.run` returns `Promise<PolicyFinding[] | null>` everywhere — declared in Task 2, used with the `null` meaning in Tasks 4-7, consumed by `runPolicyChecks` in Task 8, tested for `toBeNull()` in Tasks 4, 5, 6, 7.
- `PolicyReport` fields are snake_case in all of Task 2 (declaration), Task 8 (construction and evidence test), Task 10 (`report.totals.changed_files`, `report.violations`), Task 11 (`report.files.map(...)`).
- `DiffFile.previousPath` is camelCase (an in-memory value) while `PolicyReportFile.previous_path` is snake_case (a YAML field); Task 8's `runPolicyChecks` is the one place that converts, and both spellings appear in the tests that touch them.
- `policyAttemptId(workPackageId, repo, attempt)` — same argument order in Task 8's declaration, its test, and Task 10's call.
- `analyzeDiff` / `buildDiffAnalysis` / `splitPatchSections` / `parseHunks` / `addedLines` / `removedLines` / `changeSummaryFrom` / `inlineDiffFrom` — the same names in Task 3's declaration, Tasks 5-7's imports, Task 10's flow, and Task 11's re-export list.
- `PolicyFlowOutcome`'s discriminant is `kind` in the declaration, in every `expect(outcome.kind)`, and in every narrowing guard.
- `commitAndPush` returns `{ commit, pushed }` in Task 9's declaration, Task 9's test, and Task 10's `commitPass`.
- `writePolicyEvidence` / `writePolicyPatch` both return a `.janus`-relative path, matching `writeAgentEvidence`'s existing convention; Tasks 10 and 11 join them onto `paths.janusDir` to read the file back, which is consistent.
- `EVENT_TYPES` gains exactly three literals and the union gains exactly three members, in Tasks 8 and 9; `UnlistedEventType` enforces the pairing.

One inconsistency found and fixed: `runPolicyFlow`'s recheck initially reused `attemptId`, which would have overwritten the initial report's evidence file with the recheck's. It now writes `<attempt-id>-recheck.yaml`, so both halves of §14 step 4 survive in the audit trail — and the exported patch is named after `checked.report.attempt_id`, so a reset after a recheck lands at `<attempt-id>-recheck.patch` beside the report that justified it.
