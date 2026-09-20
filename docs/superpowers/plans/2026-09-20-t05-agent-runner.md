# T05 Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn T04's three-field agent placeholder into the real agent runner: the §18.1 `AgentTask` and §18.3 `AgentResult`, per-role output schemas that are generated (not hand-copied) into the Codex strict JSON Schema, versioned prompt templates, the §18.2 context package with byte budgets, model profiles and ladders, the §18.4 Codex adapter with timeout kill and JSONL usage parsing, the full §18.5 scripted fake runner, `janus agent run <role> --task FILE`, and a discriminated telemetry event union to carry it all.

**Architecture:** Three layers, each testable alone. **`src/agents/**`** is provider-independent: types, role→sandbox-class map, model resolution, output schemas, prompt templates, context rendering, the sandbox plan, the evidence writer, and `runAgent` — the wrapper that emits `agent.model_switch` / `agent.started` / `agent.finished` and writes `evidence/agents/<run-id>.yaml` so neither runner has to. **`src/agents/codex/**`** is the §18.4 adapter, split at a `CodexSpawn` function seam so every adapter test runs on recorded JSONL fixtures instead of a `codex` binary. **`src/providers/fake/agent-runner.ts`** grows from T04's stub into the §18.5 scripted runner (prepared patches, prepared reports, prepared results, persisted in `fake/agents.json`). The engine still reaches a runner only through `StepContext.providers.agent`, exactly as T04 built it.

**Tech Stack:** Node 20+, TypeScript strict ESM (NodeNext), zod 3, yaml 2, commander 14, vitest 5 (`unit` and `integration` projects from T04), `node:child_process`, the system `git` binary.

**Spec:** `angular-ai-development-workflow-v2.md` — §18 in full (18.1 task contract, 18.2 context package, 18.3 output contract, 18.4 Codex adapter, 18.5 fake runner, 18.6 model selection and experiments), plus §3.2 (provider interfaces), §3.3 (agents and sandboxes), §5 (`.janus/` layout, `reports/<run-id>/`, `evidence/agents/<run-id>.yaml`), §6 (state, `execution.in_flight`), §14 (fix agent, output-schema note), §16.4/§16.5/§17 (debug, coupled red, triage), §19 (autonomy rules), §20 (budget table), §21–§24 (checkpoint, review, QA, fix roles), §27 (telemetry events), §28 (configuration), §29 (testing strategy), §31 items 29 and 33, §32 rules 11 and 12. Task definition: `tasks.md` T05. Immediate predecessor: `docs/superpowers/plans/2026-09-20-t04-integration-harness.md` (assume fully landed).

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`); every relative import ends in `.js`; type-only imports use `import type`.
- TypeScript `strict` with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. No `!` non-null assertions: narrow with `if (x === undefined) throw ...`. Never pass `undefined` to an optional property; spread it in conditionally (`...(v === undefined ? {} : { k: v })`).
- Package manager is `pnpm`. `pnpm test` runs both vitest projects; `pnpm test:unit` and `pnpm test:integration` target one.
- **Every commit message is `type(scope): subject` and ends, after a blank line, with these two trailer lines.** Every commit step below uses the two-`-m` form, which produces exactly that:

```bash
git commit -m "type(scope): subject" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

- Exit codes come only from `src/cli/exit-codes.ts` (`Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`). No new exit code is added.
- Local git only. No step in this plan pushes to a network remote; every "remote" is a bare repository in a temp directory.
- §32 rule 11: "Agents never commit, push, or otherwise rewrite Git history." Nothing in `src/agents/**` or `src/providers/fake/agent-runner.ts` ever runs a git command that updates a ref. The only git command any of it runs is `git apply` (working-tree only, no ref update), in the fake runner. T04's `expectNoAgentGitWrites(harness)` must keep passing; Task 14 asserts it.
- §32 rule 12: "Secrets never enter `.janus/`, prompts, or evidence." The adapter records environment variable **names** only, never values, and never dumps `process.env`. Task 9 has a test that proves a token in the environment never reaches an evidence file.
- §18.4: "`resume` and `--skip-git-repo-check` are never used." Task 11 asserts both against the built argv.
- §19 "may not" list and §32 rule 11 are rendered verbatim into the GUARDRAILS AND FORBIDDEN ACTIONS section of every prompt (Task 6).
- Providers are injected through `StepContext.providers`; never module singletons.
- Agent roles are the twelve of §18.1. `AGENT_ROLES` grows from 10 to 12 in Task 1.

## Decisions this plan locks in

**1. What replaces T04's placeholders, and where.** T04 shipped `AgentRunRequest { runId, role, repo }` and `AgentRunOutcome { runId, status, summary }` in `src/providers/types.ts`, each marked "T05 replaces this".

- `AgentRunRequest` is **deleted** and replaced by `AgentTask` in `src/agents/types.ts` (§18.1).
- `AgentRunOutcome` is **deleted** and replaced by `AgentOutcome` in `src/agents/types.ts`, which carries the validated §18.3 `AgentResult` plus what the adapter observed (tokens, duration, exit code, failure kind). `AgentOutcome` keeps a `summary: string` field so T04's existing `outcome.summary` call sites keep working.
- `src/providers/types.ts` keeps `AgentRunner` but re-types it as `run(task: AgentTask): Promise<AgentOutcome>` and re-exports both types from `../agents/types.js`, so no importer outside `src/agents/**` changes its import path.
- Task 3 names every call site and its migration.

**2. Naming convention: camelCase in memory, snake_case on the wire.** `AgentTask` is an in-memory TypeScript value built by Janus, so its fields are camelCase (`runId`, `writableRoots`, `timeoutMinutes`), each with a doc comment naming its §18.1 field. `AgentResult` is the JSON the model emits against a JSON Schema, so its fields are the spec's snake_case verbatim (`changes_made`, `expected_temporary_failure`). The evidence YAML and the telemetry events are also on-disk shapes, so they are snake_case. `AgentTask.class` is spelled `sandboxClass` because `class` reads badly in destructuring; the doc comment says "§18.1 `class`".

**3. Keeping the zod validator and the Codex JSON Schema in sync: generate one from the other.** `src/agents/output-schema.ts` owns one zod schema per role. `src/agents/json-schema.ts` has `toCodexJsonSchema`, a small hand-written walker over the zod node kinds these schemas use (object, string, boolean, number, array, enum, nullable). It emits `required: <every key>` and `additionalProperties: false` — the §14 output-schema note — and **throws** on any zod node it does not understand, including `.optional()` and `.default()`, so a field added by hand in a way that could drift fails the test suite instead of silently producing a lax schema. There is no hand-written JSON Schema anywhere in the repo, so there is nothing to drift. A test additionally proves, for all twelve roles, that the generated `required` array equals `Object.keys(zodSchema.shape)` and that dropping any one key makes zod reject the result.

*Rejected alternative:* the `zod-to-json-schema` package. It would be a new runtime dependency for ~90 lines of walker, and it emits `$ref`/`definitions` constructs that Codex strict schemas reject.

**4. Testing the Codex adapter hermetically.** CI has no `codex` binary, so the adapter never spawns one in the default lane. `src/agents/codex/spawn.ts` exports the seam:

```ts
export type CodexSpawn = (request: CodexSpawnRequest) => Promise<CodexSpawnResult>;
export const spawnCodex: CodexSpawn = /* real node:child_process.spawn */;
```

`createCodexAgentRunner({ ..., spawn = spawnCodex })` takes it by injection. Adapter tests pass a fake spawn that (a) captures the argv and env so the test can assert §18.4's exact invocation, (b) returns the text of a recorded JSONL fixture from `tests/fixtures/codex/`, and (c) writes a recorded last-message JSON to whatever path it finds after `-o` in the argv — so the test exercises argument construction, JSONL usage parsing, `-o` reading, and schema validation together. `spawnCodex` itself is tested separately against `process.execPath` (Task 10), which covers stdin delivery, output capture, and the timeout kill without needing Codex. The opt-in real-Codex smoke test lives in `tests/integration/codex-smoke.test.ts` behind `describe.skipIf(process.env['JANUS_REAL_CODEX'] !== '1')` and is skipped by default (Task 14).

**5. Where prompt templates live, and how a change forces a version bump.** `tsconfig.build.json` sets `"include": ["src/**/*.ts"]`, so a `.md` file under `src/` would never reach `dist/`. Templates therefore live in **TypeScript modules holding markdown strings**: `src/agents/prompts/shared.ts` (the blocks every role gets) and `src/agents/prompts/templates.ts` (`ROLE_TEMPLATES: Record<AgentRole, PromptTemplate>` where `PromptTemplate = { version: string; text: string }`). The version stamp format is **`<role>@<n>`** — `implementation@1`, `debug@2` — an integer that only ever increases.

The bump is **forced** by a checked-in fingerprint table: `PROMPT_FINGERPRINTS: Record<AgentRole, string>` holds the first 8 hex chars of `sha256(SHARED_BLOCK_TEXT + "\n" + ROLE_TEMPLATES[role].text)`, and a unit test compares the whole table at once. Editing any role's text, or any shared block, changes a fingerprint and fails the test until the implementer bumps `version` and pastes the new fingerprint in. Editing a shared block bumps **all twelve** versions, which is correct: the rendered prompt really did change for all twelve roles, and §18.6 requires that a comparison never silently mix prompt changes with model changes.

*Rejected alternative:* `.md` files plus a copy step in `pnpm build`. It adds a build stage, a `dist/` layout question, and a runtime `import.meta.url` path resolution — three new ways to break the published package, for cosmetics.

**6. Ladder index: the spec's `n` is the 0-based attempt ordinal.** §18.6 says "attempt `n` uses ladder entry `min(n, len-1)`". Janus counts attempts 1-based (`attempt: 1` is the first try), so the resolver uses `Math.min(attempt - 1, ladder.length - 1)`. Read 1-based, `min(1, len-1)` would be entry 1 on the very first attempt and entry 0 would never run — which contradicts the intent of the example ladder `[gpt-5.6-sol, gpt-5.6-sol:xhigh]`, whose whole point is that the cheaper/lower-effort entry goes first. This is recorded as an interpretation, not a reading.

**7. Effort encoded in a ladder entry.** `gpt-5.6-sol:xhigh` splits at the **last** `:`. If the suffix after it is exactly one of the five efforts (`minimal|low|medium|high|xhigh`), the prefix is the model and the suffix is the effort; otherwise the whole string is the model and the effort falls back to the `ModelSpec.effort` of the role. A leading colon (`:high`) has an empty prefix, so the whole string is the model. This keeps namespaced model ids like `vendor:model` working and keeps `vendor:model:high` meaning "model `vendor:model`, effort high".

**8. `model_switch` never adds budget.** `runAgent` emits `agent.model_switch` when the resolved model or effort differs from the previous attempt's, and the event carries a literal `budget_added: false` so the JSONL itself states the §18.6 guarantee. No function in `src/agents/**` imports `incrementBudget`; a unit test asserts that (`grep`-style import check is fragile, so the test asserts that a two-attempt ladder run leaves `state.execution.budgets` untouched). Budget accounting stays with the stage steps (T12).

**9. Section order, and what the role template is.** §18.2 fixes thirteen section names in one order and says "nothing else is injected, in particular no previous agent reasoning". The role instruction must still reach the model, so the rendered prompt is: a `# TASK: <role>` heading, the role template text, then the thirteen §18.2 sections in the spec's order and no other section. The "nothing else" rule is read as "no fourteenth context section, and never a previous agent's reasoning" — recorded as an interpretation.

**10. Byte budgets degrade in a fixed, deterministic order.** The renderer first caps INLINE DIFF at `agents.max_inline_diff_bytes`. If the whole prompt still exceeds `agents.max_context_bytes`, it applies these reductions in order, re-measuring after each, and stops as soon as it fits: (1) inline diff to zero, (2) PREVIOUS ATTEMPTS to the most recent three, (3) to the most recent one, (4) LATEST VERIFICATION EVIDENCE to its last 4096 bytes, (5) CHANGE SUMMARY to its first 200 entries. If it still does not fit it throws `ContextTooLargeError`. GOAL, REPOSITORY, APPROVED PLAN SLICE, GUARDRAILS AND FORBIDDEN ACTIONS, ANGULAR GUIDANCE, BUDGET and OUTPUT CONTRACT are **never** truncated — shipping a prompt with a truncated guardrail block is worse than failing loudly. Every applied reduction is recorded in `RenderedPrompt.truncations` and stamped into the evidence file.

**11. Sandbox class mapping (§3.3, §18.4).**

| Class | Roles | `-s` | `network_access` | cwd | Writable roots |
|---|---|---|---|---|---|
| code-writing | implementation, debug, fix, sync_conflict | `workspace-write` | `true` | `repos/<repo>` | `repos/<repo>` plus, with `agents.pnpm_store: workspace` (the default), `<workspace>/.pnpm-store`; with `global`, the output of `pnpm store path` and `<home>/.cache` |
| report-writing | discovery, integration_discovery, planning, replanning, qa | `workspace-write` | `false` | `.janus/reports/<run-id>/` | that directory only |
| read-only | checkpoint, review, triage | `read-only` | — (flag not passed) | the workspace root | none |

With `agents.pnpm_store: workspace` every code-writing agent's environment gets `npm_config_store_dir=<workspace>/.pnpm-store` (§18.4: "this is the default"). No `.npmrc` is ever written. With `agents.allow_unsandboxed: true` the class mapping is overridden to `-s danger-full-access`, no `network_access` flag, and no `--add-dir`; it is recorded in every checkpoint by way of a warning block in `handover.md`, which §7 regenerates at every checkpoint.

**12. `janus agent run <role> --task FILE` exit codes.** `0` when the result status is `completed`; `1` (`UnexpectedError`) when it is `blocked` or `failed`, or when the adapter could not produce a valid result, with the summary and failure kind on stderr; `2` (`UsageError`) for an unknown role, an unreadable or invalid `--task` file, or an unknown `--model-profile` (a `ConfigError`, which `main` already maps to 2); `13` (`Locked`) when another process holds the workspace lock, which `openWorkspace` already produces. No new exit code.

**13. Seams left for later tasks**, each marked in code with a `TNN` doc comment the way T04 marked T05's:

- `ChangeSummaryEntry[]`, `inlineDiff`, `verificationEvidence`, `previousAttempts` on `ContextPackageInput` are produced by **T08** (diff analysis, policy reports) and **T09** (failure digests). T05 defines the shapes and renders them.
- The `review` role's structured findings loop and the `fix` role's `no_change_needed` reply belong to **T13**; T05 defines only the schema fields §22 and §24 name.
- Budget increments after an agent finishes belong to **T12** (§20's table).
- `janus doctor`'s model probe, sandbox probe and pnpm-store probe belong to **T07**; T05 exports `resolveModel` and `planSandbox` for it to call.
- `janus telemetry export|compare` belongs to **T21**; T05's contribution is the discriminated event union with §27's dimensions on it.
- §18.6 says a ladder step "is recorded as `model_switch` in the attempt record". T05 emits the `agent.model_switch` **event** and stamps the resolved model on the evidence file; the per-attempt record under `execution.work_packages.<id>.repos.<repo>` is written by **T12**, which owns attempt accounting and no-progress detection. `runAgent` gives T12 everything it needs on `AgentRunRecord` and on the event log.
- §18.6 also says `--model-profile` "is recorded in state and telemetry". §6's v2 state schema has no field for it, and T05 adds none (state fields may be added within v2, but inventing one here would pre-empt T12's attempt records). T05 records the profile on `run.started`, on all three agent events, and in every `evidence/agents/<run-id>.yaml`. Flagged for the controller in the handback.

---

## Controller rulings on the plan's open items

The plan's handback raised ten items. Rulings, binding on the implementer:

1. **Ladder index (Decision 6) — confirmed.** `Math.min(attempt - 1, ladder.length - 1)` with 1-based attempts. The other reading makes entry 0 unreachable, which defeats the cheap-first ladder in §18.6's own example.
2. **`--model-profile` "recorded in state" — overruled; add the field.** §18.6 is literal, and today a resumed goal's `state.yaml` cannot say which profile produced its evidence. Add ONE additive v2 field, `execution.model_profile: string | null`, written at run start alongside the existing `in_flight` bookkeeping. It is **descriptive only**: resume never re-applies it, and each invocation still resolves the profile from `--model-profile` or `workflow_models.profile`. This is not an attempt record and does not pre-empt T12. Cost if wrong: T12 may prefer a different shape — an additive field is cheap to move.
3. **`model_switch` in the attempt record → T12 seam — accepted** as Decision 13 states. T05 emits the event and stamps evidence.
4. **Prompt templates as TypeScript modules holding markdown — accepted.** `tsconfig.build.json` is `include: ["src/**/*.ts"]`, so `.md` under `src/` never reaches `dist/`. `tasks.md`'s "versioned markdown" describes the content, not the container.
5. **§18.2 "nothing else is injected" (Decision 9) — accepted.** A `# TASK: <role>` heading plus the role template, then the thirteen sections and nothing else. The role instruction has to reach the model somehow; the rule bars a fourteenth section and any prior agent reasoning.
6. **Codex JSONL event shape — accepted as provisional.** Fixtures are written from the expected stream shape and the parser tolerates both reasoning-token spellings and unparseable lines. T06's manual spike (§29.4) refreshes them against the real binary; if the shape differs, only `jsonl.ts` and the fixtures change.
7. **Touching `CheckpointInput.allowUnsandboxed` and a fourth `renderHandover` parameter — accepted.** §18.4 requires the unsandboxed mode be "recorded in every checkpoint", so it cannot wait for T14. Keep it to the four lines described; T14 still owns handover rendering.
8. **`toCodexJsonSchema` reading zod 3 internals — accepted.** The walker throws on unknown nodes and a test covers that, so a zod 4 upgrade breaks loudly rather than silently emitting a lax schema.
9. **Scope — accepted.** Every `tasks.md` T05 bullet maps to a task.
10. **Integration-lane budget — accepted with a condition.** T04 set a <90 s budget for the lane that `pnpm test` runs by default. Task 14 must re-measure it and report the number; if the lane exceeds 90 s, say so in the handback rather than quietly absorbing it.

## File Structure

```text
src/config/config-schema.ts          modify: AGENT_ROLES 10 -> 12 (§18.1 order), roles.* timeouts, AGENT_EFFORTS, Effort
src/telemetry/events.ts              modify: TelemetryEvent becomes a discriminated union on `type`; AgentTokenUsage; RunStopReason; GuardrailName
src/engine/budgets.ts                modify: re-export GuardrailName from telemetry
src/engine/run-loop.ts               modify: RunStopReason imported from telemetry instead of declared
src/engine/engine.ts                 modify: pass agents.allow_unsandboxed into checkpoint
src/state/checkpoint.ts              modify: CheckpointInput.allowUnsandboxed
src/state/files.ts                   modify: REPORTS_DIR, AGENTS_EVIDENCE_DIR
src/render/handover.ts               modify: unsandboxed warning block

src/agents/roles.ts                  SandboxClass, ROLE_CLASSES, sandboxClassFor, isCodeWriting
src/agents/types.ts                  AgentTask, AgentResult, AgentOutcome, AgentRunFailure, ResolvedModel, re-export AgentTokenUsage
src/agents/models.ts                 parseLadderEntry, resolveModel, isModelSwitch
src/agents/json-schema.ts            JsonSchema, toCodexJsonSchema, UnsupportedSchemaNodeError
src/agents/output-schema.ts          baseResultSchema, ROLE_RESULT_SCHEMAS, resultSchemaFor, outputSchemaFor, validateAgentResult
src/agents/prompts/shared.ts         FORBIDDEN_ACTIONS, ANGULAR_GUIDANCE, SHARED_BLOCK_TEXT, outputContractBlock
src/agents/prompts/templates.ts      PromptTemplate, ROLE_TEMPLATES, PROMPT_FINGERPRINTS, promptFingerprint, promptVersionFor
src/agents/context.ts                ChangeSummaryEntry, ContextPackage, ContextPackageInput, buildContextPackage, SECTION_ORDER, isGeneratedPath
src/agents/render.ts                 RenderedPrompt, renderContextPackage, truncateUtf8, truncationMarker, ContextTooLargeError
src/agents/sandbox.ts                SandboxPlan, planSandbox, unsandboxedNote
src/agents/task.ts                   BuildAgentTaskInput, buildAgentTask
src/agents/task-file.ts              agentTaskFileSchema, AgentTaskFile, loadAgentTaskFile
src/agents/evidence.ts               AgentEvidence, agentEvidencePath, writeAgentEvidence
src/agents/run.ts                    RunAgentInput, AgentRunRecord, runAgent
src/agents/codex/spawn.ts            CodexSpawn, CodexSpawnRequest, CodexSpawnResult, spawnCodex, SIGKILL_GRACE_MS
src/agents/codex/jsonl.ts            parseCodexUsage
src/agents/codex/adapter.ts          CodexAdapterInput, createCodexAgentRunner, buildCodexArgs

src/providers/types.ts               modify: AgentRunner.run(task: AgentTask): Promise<AgentOutcome>; drop the two placeholders
src/providers/index.ts               modify: workflow.agent_runner 'codex' builds the real adapter
src/providers/fake/agent-runner.ts   modify: full §18.5 script (patches, reports, results), keyed by role and attempt
src/cli/commands/agent.ts            modify: real `janus agent run <role> --task FILE [--dry-run] [--model-profile]`

tests/helpers/agent-fixtures.ts      agentTaskFixture, contextPackageFixture, resultFixture, stubOutcome
tests/fixtures/codex/implementation-success.jsonl
tests/fixtures/codex/implementation-success.last-message.json
tests/fixtures/codex/usage-nested.jsonl
tests/fixtures/codex/timeout-partial.jsonl
tests/fixtures/codex/invalid-output.last-message.json
tests/agents/roles.test.ts           tests/agents/models.test.ts        tests/agents/json-schema.test.ts
tests/agents/output-schema.test.ts   tests/agents/prompts.test.ts       tests/agents/render.test.ts
tests/agents/sandbox.test.ts         tests/agents/task.test.ts          tests/agents/evidence.test.ts
tests/agents/run.test.ts             tests/agents/codex-spawn.test.ts   tests/agents/codex-jsonl.test.ts
tests/agents/codex-adapter.test.ts   tests/cli/agent-run.test.ts
tests/integration/agent-run.test.ts  harness scenario: scripted fake agent, evidence, events, no git writes
tests/integration/codex-smoke.test.ts opt-in, JANUS_REAL_CODEX=1
```

---

## Task 1: Twelve agent roles and their sandbox classes

**Files:**
- Modify: `src/config/config-schema.ts:3-14` (`AGENT_ROLES`), `:118-131` (`agents.roles`)
- Create: `src/agents/roles.ts`
- Test: `tests/config/config-schema.test.ts`, `tests/agents/roles.test.ts` (create)

**Interfaces:**
- Consumes: `AGENT_ROLES`, `AgentRole` from `src/config/config-schema.ts`.
- Produces:
  - `AGENT_ROLES` with twelve entries in §18.1 order: `discovery, integration_discovery, planning, replanning, implementation, debug, fix, sync_conflict, checkpoint, review, triage, qa`
  - `agents.roles.integration_discovery.timeout_minutes` default `30`, `agents.roles.replanning.timeout_minutes` default `45`
  - `const SANDBOX_CLASSES = ['code-writing', 'report-writing', 'read-only'] as const`
  - `type SandboxClass = (typeof SANDBOX_CLASSES)[number]`
  - `const ROLE_CLASSES: Readonly<Record<AgentRole, SandboxClass>>`
  - `sandboxClassFor(role: AgentRole): SandboxClass`
  - `isCodeWriting(role: AgentRole): boolean`

**Why:** §18.1 lists twelve roles; `AGENT_ROLES` has ten. `integration_discovery` is needed by T11 (`tasks.md`: "integration discovery with `loads_remotes` cross-check") and `replanning` by T13 ("replanning agent, Gate 2"). Adding them now means no later task has to reopen the config schema, the model-profile validator, or the timeout ceiling check.

- [ ] **Step 1: Write the failing config test**

Append to `tests/config/config-schema.test.ts`, inside its top-level `describe`:

```ts
  it('knows the twelve §18.1 agent roles and gives each a default timeout', () => {
    const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    expect(AGENT_ROLES).toEqual([
      'discovery',
      'integration_discovery',
      'planning',
      'replanning',
      'implementation',
      'debug',
      'fix',
      'sync_conflict',
      'checkpoint',
      'review',
      'triage',
      'qa',
    ]);
    expect(config.agents.roles.integration_discovery.timeout_minutes).toBe(30);
    expect(config.agents.roles.replanning.timeout_minutes).toBe(45);
    for (const role of AGENT_ROLES) {
      expect(config.agents.roles[role].timeout_minutes).toBeGreaterThan(0);
    }
  });

  it('accepts a model profile entry for a newly added role and rejects an unknown one', () => {
    const ok = configSchema.safeParse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'm' }, replanning: { model: 'm', effort: 'low' } } },
    });
    expect(ok.success).toBe(true);
    const bad = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      model_profiles: { default: { '*': { model: 'm' }, integration: { model: 'm' } } },
    });
    expect(bad.some((issue) => issue.startsWith('model_profiles.default.integration'))).toBe(true);
  });

  it('applies the runtime ceiling to the new roles too', () => {
    const issues = issuesOf({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      agents: { roles: { replanning: { timeout_minutes: 90 } } },
    });
    expect(issues).toContain('agents.roles.replanning.timeout_minutes: must not exceed guardrails.max_agent_runtime_minutes (60)');
  });
```

Add `AGENT_ROLES` to the file's existing import from `../../src/config/config-schema.js`. The file already has a helper that collects issue strings from a failed parse; it is used as `issuesOf(...)` above — if the existing helper is named differently, use the existing name rather than adding a second one.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/config/config-schema.test.ts`
Expected: FAIL — the `AGENT_ROLES` array does not match, and `config.agents.roles.integration_discovery` does not type-check.

- [ ] **Step 3: Add the two roles to `AGENT_ROLES`**

In `src/config/config-schema.ts`, replace the `AGENT_ROLES` declaration with the §18.1 order:

```ts
/** Spec §18.1, in the spec's order. `agents.roles.<role>` and `ROLE_CLASSES` must both cover every entry. */
export const AGENT_ROLES = [
  'discovery',
  'integration_discovery',
  'planning',
  'replanning',
  'implementation',
  'debug',
  'fix',
  'sync_conflict',
  'checkpoint',
  'review',
  'triage',
  'qa',
] as const;
```

- [ ] **Step 4: Give the two new roles a timeout**

In the same file, replace the `roles:` object inside `agents` with (spec §28 lists ten; `integration_discovery` follows `discovery` at 30 and `replanning` follows `planning` at 45, because each is the same kind of report-writing work):

```ts
        roles: z
          .object({
            discovery: roleTimeout(30),
            integration_discovery: roleTimeout(30),
            planning: roleTimeout(45),
            replanning: roleTimeout(45),
            implementation: roleTimeout(60),
            debug: roleTimeout(45),
            fix: roleTimeout(45),
            sync_conflict: roleTimeout(30),
            checkpoint: roleTimeout(20),
            review: roleTimeout(60),
            triage: roleTimeout(20),
            qa: roleTimeout(30),
          })
          .strict()
          .default({}),
```

Nothing else in `configSchema` needs editing: `modelProfileSchema`'s `superRefine` already reads `AGENT_ROLES` (its "unknown agent role" message now lists twelve names), and the ceiling check at the bottom already loops `for (const role of AGENT_ROLES)` over `config.agents.roles[role]`, which type-checks because `roles` is an object with all twelve keys, not an index signature.

- [ ] **Step 5: Run the config tests**

Run: `pnpm exec vitest run --project unit tests/config`
Expected: PASS.

- [ ] **Step 6: Write the failing roles test**

Create `tests/agents/roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { isCodeWriting, ROLE_CLASSES, sandboxClassFor, SANDBOX_CLASSES } from '../../src/agents/roles.js';

describe('agent roles and sandbox classes', () => {
  it('assigns every §18.1 role to one of the three §3.3 classes', () => {
    for (const role of AGENT_ROLES) {
      expect(SANDBOX_CLASSES).toContain(sandboxClassFor(role));
    }
    expect(Object.keys(ROLE_CLASSES).sort()).toEqual([...AGENT_ROLES].sort());
  });

  it('matches the §3.3 table exactly', () => {
    const byClass = (wanted: string): string[] =>
      AGENT_ROLES.filter((role) => ROLE_CLASSES[role] === wanted).sort();
    expect(byClass('code-writing')).toEqual(['debug', 'fix', 'implementation', 'sync_conflict']);
    expect(byClass('report-writing')).toEqual(['discovery', 'integration_discovery', 'planning', 'qa', 'replanning']);
    expect(byClass('read-only')).toEqual(['checkpoint', 'review', 'triage']);
  });

  it('isCodeWriting is true exactly for the code-writing class', () => {
    expect(isCodeWriting('implementation')).toBe(true);
    expect(isCodeWriting('review')).toBe(false);
    expect(isCodeWriting('discovery')).toBe(false);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/roles.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/roles.js"`.

- [ ] **Step 8: Implement the role-class map**

Create `src/agents/roles.ts`:

```ts
import type { AgentRole } from '../config/config-schema.js';

/** Spec §3.3: the three sandbox classes. The class decides the `-s` value, the network flag, the cwd, and the writable roots. */
export const SANDBOX_CLASSES = ['code-writing', 'report-writing', 'read-only'] as const;

export type SandboxClass = (typeof SANDBOX_CLASSES)[number];

/** Spec §3.3's table, one entry per §18.1 role. */
export const ROLE_CLASSES: Readonly<Record<AgentRole, SandboxClass>> = {
  discovery: 'report-writing',
  integration_discovery: 'report-writing',
  planning: 'report-writing',
  replanning: 'report-writing',
  qa: 'report-writing',
  implementation: 'code-writing',
  debug: 'code-writing',
  fix: 'code-writing',
  sync_conflict: 'code-writing',
  checkpoint: 'read-only',
  review: 'read-only',
  triage: 'read-only',
};

export function sandboxClassFor(role: AgentRole): SandboxClass {
  return ROLE_CLASSES[role];
}

/** Only code-writing roles receive an INLINE DIFF (§18.2) and a writable repository (§3.3). */
export function isCodeWriting(role: AgentRole): boolean {
  return ROLE_CLASSES[role] === 'code-writing';
}
```

- [ ] **Step 9: Run the roles test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/roles.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Run the whole unit lane, lint, and typecheck**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/config/config-schema.ts src/agents/roles.ts tests/config/config-schema.test.ts tests/agents/roles.test.ts
git commit -m "feat(agents): add the twelve spec roles and their sandbox classes" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 2: Discriminated telemetry event union

**Files:**
- Modify: `src/telemetry/events.ts` (whole file)
- Modify: `src/engine/budgets.ts:1-10`, `src/engine/run-loop.ts:15`, `src/engine/recover.ts:46-53`
- Test: `tests/telemetry/events.test.ts`, `tests/engine/engine.test.ts:24`

**Interfaces:**
- Consumes: `GoalStatus`, `GateType`, `BudgetName` from `src/state/state-schema.ts`; `AgentRole` from `src/config/config-schema.ts`.
- Produces:
  - `type TelemetryEvent` — a union discriminated on `type`, with one exported interface per member
  - `type RecordedEvent = TelemetryEvent & { timestamp: string }`
  - `type EventType = TelemetryEvent['type']`, `const EVENT_TYPES: readonly EventType[]`
  - `type UnlistedEventType` — a compile-time proof that `EVENT_TYPES` covers the union
  - `interface AgentTokenUsage { input: number; cached_input: number; output: number; reasoning: number | null; total: number }`
  - `type RunStopReason` (moved here from `run-loop.ts`), `type GuardrailName` (moved here from `budgets.ts`)
  - `appendEvent(janusDir, event: TelemetryEvent, now?): RecordedEvent` and `readEvents(janusDir): RecordedEvent[]`, unchanged signatures

**Why now:** T05 adds three agent event types with eleven §27 dimensions each, and T21 has to aggregate them per model, role and prompt version. An open `{ type: string; [key: string]: unknown }` cannot catch a misspelled dimension at any point before T21 reads the log, and by then the runs are already recorded. Closing the union before the agent events multiply is cheaper than closing it after.

- [ ] **Step 1: Write the failing test**

Replace the body of `tests/telemetry/events.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENTS_FILE } from '../../src/state/files.js';
import { appendEvent, EVENT_TYPES, readEvents } from '../../src/telemetry/events.js';
import type { TelemetryEvent } from '../../src/telemetry/events.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('telemetry events', () => {
  it('appends one JSON line per event with a timestamp first', () => {
    const janusDir = tempDir();
    const now = new Date('2026-09-19T12:00:00.000Z');
    const recorded = appendEvent(janusDir, { type: 'goal.created', goal_id: 'g', repos: ['ui-kit'] }, now);
    appendEvent(janusDir, { type: 'stage.entered', stage: 'preparing', from: 'created' }, now);
    expect(recorded).toEqual({ timestamp: '2026-09-19T12:00:00.000Z', type: 'goal.created', goal_id: 'g', repos: ['ui-kit'] });
    const lines = readFileSync(join(janusDir, EVENTS_FILE), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toEqual(recorded);
    expect(readEvents(janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
  });

  it('reads an empty list when no events exist', () => {
    expect(readEvents(tempDir())).toEqual([]);
  });

  it('lists every §27 event type this version can emit, including the three agent events', () => {
    expect(EVENT_TYPES).toContain('agent.started');
    expect(EVENT_TYPES).toContain('agent.finished');
    expect(EVENT_TYPES).toContain('agent.model_switch');
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('narrows on the discriminant so a consumer reaches §27 dimensions without a cast', () => {
    const events: TelemetryEvent[] = [
      {
        type: 'agent.finished',
        run_id: 'run-0001',
        role: 'implementation',
        repo: 'ui-kit',
        status: 'completed',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        prompt_version: 'implementation@1',
        profile: 'default',
        experiment_id: 'exp-1',
        tokens: { input: 100, cached_input: 40, output: 20, reasoning: 8, total: 120 },
        duration_ms: 4200,
        failure: null,
        step: null,
        patch: null,
      },
    ];
    const first = events[0];
    if (first === undefined || first.type !== 'agent.finished') throw new Error('expected agent.finished');
    expect(first.tokens?.reasoning).toBe(8);
    expect(first.prompt_version).toBe('implementation@1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/telemetry/events.test.ts`
Expected: FAIL — `EVENT_TYPES` is not exported.

- [ ] **Step 3: Rewrite `src/telemetry/events.ts` as a union**

Replace the whole file with:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '../config/config-schema.js';
import { EVENTS_FILE } from '../state/files.js';
import type { BudgetName, GateType, GoalStatus } from '../state/state-schema.js';

/**
 * Spec §27's event list, as a union discriminated on `type`.
 *
 * **Adding an event type in a later task takes three edits, all in this file:** declare an exported interface whose
 * `type` is a string literal, add it to the `TelemetryEvent` union below, and add its literal to `EVENT_TYPES`.
 * `UnlistedEventType` fails to compile if the third edit is forgotten. Never widen a member with an index
 * signature: that would defeat the discriminant for every other member.
 */

/** Why `janus run` stopped. Declared here rather than in `run-loop.ts` so `run.stopped` and the run loop cannot drift. */
export type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented';

/** Every counter a guardrail can name (spec §20): the seven budgets, per-package `policy_violations`, and the goal runtime. */
export type GuardrailName = BudgetName | 'policy_violations' | 'goal_runtime_hours';

/** Codex `turn.completed.usage` (§18.4), normalized. `reasoning` is null when the model did not report it. */
export interface AgentTokenUsage {
  input: number;
  cached_input: number;
  output: number;
  reasoning: number | null;
  total: number;
}

export interface RunStartedEvent {
  type: 'run.started';
  pid: number;
  status: GoalStatus;
  until: GoalStatus | null;
  max_wait_ms: number;
  model_profile: string;
}

export interface RunStoppedEvent {
  type: 'run.stopped';
  reason: RunStopReason;
  status: GoalStatus;
  steps: number;
}

export interface GoalCreatedEvent {
  type: 'goal.created';
  goal_id: string;
  repos: string[];
}

export interface GoalCompletedEvent {
  type: 'goal.completed';
  goal_id: string;
}

export interface StageEnteredEvent {
  type: 'stage.entered';
  stage: GoalStatus;
  from: GoalStatus;
}

export interface StageExitedEvent {
  type: 'stage.exited';
  stage: GoalStatus;
  to: GoalStatus;
}

/** Spec §27: role, repo, run_id, model, effort, prompt_version, profile, experiment_id, tokens, duration, status. */
export interface AgentStartedEvent {
  type: 'agent.started';
  run_id: string;
  role: AgentRole;
  repo: string | null;
  model: string;
  effort: string;
  prompt_version: string;
  profile: string;
  experiment_id: string | null;
  /** 1-based attempt within the current failure; drives the §18.6 ladder. */
  attempt: number;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  network: boolean;
}

/**
 * Every dimension is present; the ones an interrupted run never learned are `null`.
 *
 * `status: 'interrupted'` is emitted by `recoverInFlight` (§7 rule 3) for a run whose process died with the
 * orchestrator; it is not a §18.3 status, which is why the field is widened rather than `AgentResult['status']`.
 */
export interface AgentFinishedEvent {
  type: 'agent.finished';
  run_id: string;
  role: AgentRole | null;
  repo: string | null;
  status: 'completed' | 'blocked' | 'failed' | 'interrupted';
  model: string | null;
  effort: string | null;
  prompt_version: string | null;
  profile: string | null;
  experiment_id: string | null;
  tokens: AgentTokenUsage | null;
  duration_ms: number | null;
  /** §18.4 adapter failure kind; null when the run produced a valid §18.3 result. */
  failure: 'timeout' | 'nonzero_exit' | 'invalid_output' | 'spawn_failed' | 'interrupted' | null;
  /** Interrupted runs only: the step that was in flight and the `.janus`-relative saved patch. */
  step: string | null;
  patch: string | null;
}

/** Spec §18.6: a ladder step, so no-progress detection can tell "same model, same failure" from "new model, same failure". */
export interface AgentModelSwitchEvent {
  type: 'agent.model_switch';
  run_id: string;
  role: AgentRole;
  repo: string | null;
  attempt: number;
  from_model: string;
  from_effort: string;
  to_model: string;
  to_effort: string;
  ladder_index: number;
  profile: string;
  experiment_id: string | null;
  /** §18.6: "Switching models never adds budget." Recorded in the log so the guarantee is auditable. */
  budget_added: false;
}

export interface BudgetIncrementedEvent {
  type: 'budget.incremented';
  budget: GuardrailName;
  value: number;
  limit: number;
  reason: string;
  /** Present only for the per-package `policy_violations` counter. */
  work_package?: string;
  repo?: string;
}

export interface BudgetResetEvent {
  type: 'budget.reset';
  budget: BudgetName;
  previous: number;
  reason: string;
}

export interface GuardrailHitEvent {
  type: 'guardrail.hit';
  guardrail: GuardrailName;
  value: number;
  limit: number;
  detail: string;
}

export interface GateEnteredEvent {
  type: 'gate.entered';
  gate: GateType;
  checkpoint_commit: string;
  stage: GoalStatus;
}

export interface GatePassedEvent {
  type: 'gate.passed';
  gate: GateType;
  approver: string;
  commit: string;
  waited_ms: number;
}

/**
 * `gate` is nullable because `escalate` clears a waiting gate whose `state.gate.type` is typed `GateType | null`;
 * making the field non-null would force a guard there that could leave a gate stuck in `waiting`.
 */
export interface GateRejectedEvent {
  type: 'gate.rejected';
  gate: GateType | null;
  reason: string;
  waited_ms: number;
  approver?: string;
}

export interface EscalationCreatedEvent {
  type: 'escalation.created';
  reason: string;
  stage: GoalStatus;
  repo: string | null;
  work_package: string | null;
}

export interface RepoDriftEvent {
  type: 'repo.drift';
  repo: string;
  local_drift: 'none' | 'fast_forward' | 'non_fast_forward' | 'missing';
  remote: 'absent' | 'in_sync' | 'ahead_fast_forwarded' | 'behind' | 'diverged';
  base_moved: boolean;
  recorded_head: string | null;
  head: string | null;
  remote_base: string;
}

export type TelemetryEvent =
  | RunStartedEvent
  | RunStoppedEvent
  | GoalCreatedEvent
  | GoalCompletedEvent
  | StageEnteredEvent
  | StageExitedEvent
  | AgentStartedEvent
  | AgentFinishedEvent
  | AgentModelSwitchEvent
  | BudgetIncrementedEvent
  | BudgetResetEvent
  | GuardrailHitEvent
  | GateEnteredEvent
  | GatePassedEvent
  | GateRejectedEvent
  | EscalationCreatedEvent
  | RepoDriftEvent;

export type EventType = TelemetryEvent['type'];

/**
 * Every type this version can emit. `janus doctor` (T07) and `janus telemetry` (T21) read it instead of a literal
 * list. `as const satisfies` is load-bearing: `as const` keeps the element type a union of literals so
 * `UnlistedEventType` below can compare it against the union, and `satisfies` still rejects a typo'd name.
 */
export const EVENT_TYPES = [
  'run.started',
  'run.stopped',
  'goal.created',
  'goal.completed',
  'stage.entered',
  'stage.exited',
  'agent.started',
  'agent.finished',
  'agent.model_switch',
  'budget.incremented',
  'budget.reset',
  'guardrail.hit',
  'gate.entered',
  'gate.passed',
  'gate.rejected',
  'escalation.created',
  'repo.drift',
] as const satisfies readonly EventType[];

type AssertNever<T extends never> = T;

/** Compile-time proof that `EVENT_TYPES` lists every union member. Adding a member without listing it fails here. */
export type UnlistedEventType = AssertNever<Exclude<EventType, (typeof EVENT_TYPES)[number]>>;

export type RecordedEvent = TelemetryEvent & { timestamp: string };

/** Appends one event as a JSON line under `.janus/telemetry/`. Telemetry never controls correctness (spec §27). */
export function appendEvent(janusDir: string, event: TelemetryEvent, now: Date = new Date()): RecordedEvent {
  const path = join(janusDir, EVENTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const recorded = { timestamp: now.toISOString(), ...event } as RecordedEvent;
  appendFileSync(path, `${JSON.stringify(recorded)}\n`);
  return recorded;
}

/**
 * Reads the log back. The cast is deliberate and unchecked: a log written by a newer Janus may hold a `type` this
 * version does not know, and telemetry must never be the reason a run fails. Consumers narrow on `type` and ignore
 * what they do not recognize.
 */
export function readEvents(janusDir: string): RecordedEvent[] {
  const path = join(janusDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}
```

- [ ] **Step 4: Point `budgets.ts` and `run-loop.ts` at the moved types**

In `src/engine/budgets.ts`, replace the local `GuardrailName` declaration (the line `export type GuardrailName = BudgetName | 'policy_violations' | 'goal_runtime_hours';` and its doc comment) with a re-export, and keep the existing `TelemetryEvent` import:

```ts
/** Every counter a guardrail can name: the seven budgets, per-package `policy_violations`, and `goal_runtime_hours`. */
export type { GuardrailName } from '../telemetry/events.js';
```

Add `import type { GuardrailName } from '../telemetry/events.js';` to the import block as well, because `GuardrailHit` and `BudgetIncrement` below still reference the name locally. The `BudgetName` import stays; if ESLint reports it unused after the change, drop it.

In `src/engine/run-loop.ts`, replace the local declaration

```ts
export type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented';
```

with

```ts
import type { RunStopReason } from '../telemetry/events.js';

export type { RunStopReason };
```

placing the `import type` line in the existing import block (after `../git/ops.js`) and the `export type` line where the declaration was.

- [ ] **Step 5: Fix the three event constructions that no longer type-check**

1. `src/engine/recover.ts` emits `agent.finished` for an interrupted run and now has to supply every dimension,
`null` where the dead run never learned it. Replace its `engine.emit({ ... })` call with:

```ts
    engine.emit({
      type: 'agent.finished',
      run_id: runId,
      role: null,
      repo: inFlight.repo,
      status: 'interrupted',
      model: null,
      effort: null,
      prompt_version: null,
      profile: null,
      experiment_id: null,
      tokens: null,
      duration_ms: null,
      failure: 'interrupted',
      step,
      patch: patchFile === null ? null : relative(paths.janusDir, patchFile),
    });
```

(`relative`, `paths`, `runId`, `inFlight`, `step` and `patchFile` are all already in scope there.)
`tests/engine/recover.test.ts` asserts with `toMatchObject`, so it keeps passing unchanged.

2. `tests/engine/engine.test.ts` line 24, the emit call gains the now-required `from`:

```ts
      const recorded = engine.emit({ type: 'stage.entered', stage: 'preparing', from: 'created' });
```

3. Nothing else constructs an event: every other site reads with `readEvents(...)` and asserts through
`event['type']`, `find`, or `toMatchObject`, all of which still compile against the union.

- [ ] **Step 6: Run the unit lane and typecheck**

Run: `pnpm test:unit && pnpm typecheck`
Expected: PASS and exit 0. If `typecheck` reports `escalate.ts` cannot assign `state.gate.type` to `gate`, the `GateRejectedEvent.gate` field is missing its `| null` — re-check Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/telemetry/events.ts src/engine/budgets.ts src/engine/run-loop.ts tests/telemetry/events.test.ts tests/engine/engine.test.ts
git commit -m "refactor(telemetry): make TelemetryEvent a discriminated union on type" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 3: Per-role output schemas, as zod, with the Codex JSON Schema generated from them

**Files:**
- Create: `src/agents/json-schema.ts`, `src/agents/output-schema.ts`
- Test: `tests/agents/json-schema.test.ts`, `tests/agents/output-schema.test.ts`

**Interfaces:**
- Consumes: `AGENT_ROLES`, `AgentRole`; `formatZodIssues` from `src/config/errors.ts`.
- Produces:
  - `type JsonSchema = Record<string, unknown>`
  - `class UnsupportedSchemaNodeError extends Error`
  - `toCodexJsonSchema(schema: z.ZodTypeAny, title: string): JsonSchema`
  - `const baseResultSchema` (zod) and `type AgentResult = z.infer<typeof baseResultSchema>`
  - `const ROLE_RESULT_SCHEMAS: Readonly<Record<AgentRole, z.ZodObject<z.ZodRawShape>>>`
  - `resultSchemaFor(role: AgentRole): z.ZodObject<z.ZodRawShape>`
  - `outputSchemaFor(role: AgentRole): JsonSchema`
  - `validateAgentResult(role, raw): { ok: true; result: AgentResult } | { ok: false; errors: string[] }`

**Why the generator:** §14's output-schema note — "Codex strict schemas require every property to be present, so role schemas list all fields as required and use `null` for 'not applicable'". A hand-written JSON Schema beside a hand-written zod schema is two sources for one contract. Generating the JSON Schema from the zod schema makes drift impossible, and making the generator throw on `.optional()` and `.default()` makes the strictness rule mechanical instead of a review habit.

- [ ] **Step 1: Write the failing generator test**

Create `tests/agents/json-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toCodexJsonSchema, UnsupportedSchemaNodeError } from '../../src/agents/json-schema.js';

describe('toCodexJsonSchema', () => {
  it('marks every property required and forbids extras, as Codex strict schemas demand (§14)', () => {
    const schema = z
      .object({
        status: z.enum(['completed', 'failed']),
        summary: z.string(),
        count: z.number(),
        done: z.boolean(),
        items: z.array(z.string()),
        maybe: z.array(z.string()).nullable(),
        nested: z.object({ a: z.string() }).strict(),
      })
      .strict();

    expect(toCodexJsonSchema(schema, 'janus-test-result')).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'janus-test-result',
      type: 'object',
      additionalProperties: false,
      required: ['status', 'summary', 'count', 'done', 'items', 'maybe', 'nested'],
      properties: {
        status: { type: 'string', enum: ['completed', 'failed'] },
        summary: { type: 'string' },
        count: { type: 'number' },
        done: { type: 'boolean' },
        items: { type: 'array', items: { type: 'string' } },
        maybe: { type: ['array', 'null'], items: { type: 'string' } },
        nested: {
          type: 'object',
          additionalProperties: false,
          required: ['a'],
          properties: { a: { type: 'string' } },
        },
      },
    });
  });

  it('refuses an optional property, because Codex requires every property to be present', () => {
    const schema = z.object({ a: z.string().optional() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow(UnsupportedSchemaNodeError);
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodOptional');
  });

  it('refuses a default, which would hide a missing property instead of rejecting it', () => {
    const schema = z.object({ a: z.string().default('x') }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a: ZodDefault');
  });

  it('names the path of an unsupported node', () => {
    const schema = z.object({ a: z.object({ b: z.record(z.string(), z.string()) }).strict() }).strict();
    expect(() => toCodexJsonSchema(schema, 't')).toThrow('a.b: ZodRecord');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/json-schema.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/json-schema.js"`.

- [ ] **Step 3: Implement the generator**

Create `src/agents/json-schema.ts`:

```ts
import type { z } from 'zod';

/** A JSON Schema document, as handed to `codex exec --output-schema` (§18.4). */
export type JsonSchema = Record<string, unknown>;

export class UnsupportedSchemaNodeError extends Error {
  readonly path: string;
  readonly typeName: string;

  constructor(path: string, typeName: string) {
    super(
      `cannot convert ${path === '' ? '<root>' : path}: ${typeName} to a Codex output schema; ` +
        'agent result schemas may use only object, string, number, boolean, array, enum, and nullable nodes, ' +
        'and every property must be required (spec §14: "role schemas list all fields as required and use null ' +
        'for not applicable")',
    );
    this.name = 'UnsupportedSchemaNodeError';
    this.path = path;
    this.typeName = typeName;
  }
}

interface ZodDefLike {
  typeName: string;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  return (schema as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
}

function child(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Makes the node accept `null` as well, by widening its `type` to a two-entry array. */
function nullable(node: JsonSchema): JsonSchema {
  const current = node['type'];
  if (typeof current !== 'string') {
    throw new UnsupportedSchemaNodeError('<nullable>', 'ZodNullable of a node without a simple type');
  }
  return { ...node, type: [current, 'null'] };
}

function convert(schema: z.ZodTypeAny, path: string): JsonSchema {
  const def = defOf(schema);
  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum': {
      const values = def.values;
      if (values === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodEnum without values');
      return { type: 'string', enum: [...values] };
    }
    case 'ZodArray': {
      const item = def.type;
      if (item === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodArray without an item type');
      return { type: 'array', items: convert(item, child(path, '[]')) };
    }
    case 'ZodNullable': {
      const inner = def.innerType;
      if (inner === undefined) throw new UnsupportedSchemaNodeError(path, 'ZodNullable without an inner type');
      return nullable(convert(inner, path));
    }
    case 'ZodObject': {
      const shape = shapeOf(schema);
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value, child(path, key));
        required.push(key);
      }
      return { type: 'object', additionalProperties: false, required, properties };
    }
    default:
      throw new UnsupportedSchemaNodeError(path, def.typeName);
  }
}

/**
 * Converts a zod schema into the strict JSON Schema `codex exec --output-schema` accepts (§18.4).
 *
 * There is no hand-written JSON Schema anywhere in Janus: every schema Codex sees is produced here from the same
 * zod object the adapter validates the answer with, so the two cannot disagree. Unsupported nodes throw rather
 * than degrade, so a future field written with `.optional()` or `.default()` fails the suite instead of shipping a
 * schema Codex would reject at runtime.
 */
export function toCodexJsonSchema(schema: z.ZodTypeAny, title: string): JsonSchema {
  const root = convert(schema, '');
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', title, ...root };
}
```

- [ ] **Step 4: Run the generator test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/json-schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing output-schema test**

Create `tests/agents/output-schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { outputSchemaFor, resultSchemaFor, validateAgentResult } from '../../src/agents/output-schema.js';

const MINIMUM = {
  status: 'completed',
  summary: 'upgraded ui-kit to Angular 16',
  changes_made: ['package.json: raised @angular/core to 16.2.12'],
  findings: [],
  evidence: ['reports/run-0001/ng-update.log'],
  new_tasks: [],
  expected_temporary_failure: false,
  predicted_failures: null,
  plan_change_required: false,
  architecture_change_required: false,
  behavior_change_required: false,
  recommended_next_action: 'run the PR build',
  handover: { current_state: 'ui-kit builds on 16', next_action: 'commit and push', risks: ['peer deps'] },
};

describe('agent output schemas', () => {
  it('accepts the §18.3 minimum shape for every role', () => {
    for (const role of AGENT_ROLES) {
      const extra = extrasFor(role);
      const outcome = validateAgentResult(role, { ...MINIMUM, ...extra });
      expect(outcome.ok, `${role}: ${outcome.ok ? '' : outcome.errors.join('; ')}`).toBe(true);
    }
  });

  it('rejects a result that omits any single required field, for every role', () => {
    for (const role of AGENT_ROLES) {
      const full: Record<string, unknown> = { ...MINIMUM, ...extrasFor(role) };
      for (const key of Object.keys(full)) {
        const { [key]: _dropped, ...without } = full;
        const outcome = validateAgentResult(role, without);
        expect(outcome.ok, `${role} still accepted a result without "${key}"`).toBe(false);
      }
    }
  });

  it('rejects an unknown property, because Codex strict schemas forbid extras', () => {
    const outcome = validateAgentResult('implementation', { ...MINIMUM, mood: 'confident' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a rejection');
    expect(outcome.errors.join('\n')).toContain('mood');
  });

  it('generates a JSON Schema whose required list is exactly the zod shape, for every role', () => {
    for (const role of AGENT_ROLES) {
      const json = outputSchemaFor(role);
      expect(json['required'], role).toEqual(Object.keys(resultSchemaFor(role).shape));
      expect(json['additionalProperties'], role).toBe(false);
      expect(json['type'], role).toBe('object');
      expect(json['title'], role).toBe(`janus-${role}-result`);
    }
  });

  it('allows null exactly where §18.3 makes a field conditional', () => {
    const json = outputSchemaFor('implementation');
    const properties = json['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['predicted_failures']?.['type']).toEqual(['array', 'null']);
    expect(properties['summary']?.['type']).toBe('string');
    expect(validateAgentResult('implementation', { ...MINIMUM, predicted_failures: ['AppComponent > renders'] }).ok).toBe(true);
  });

  it('gives the four roles the spec names extra fields their stage needs', () => {
    expect(Object.keys(resultSchemaFor('checkpoint').shape)).toContain('outcome');
    expect(Object.keys(resultSchemaFor('triage').shape)).toEqual(
      expect.arrayContaining(['suspect_repo', 'confidence', 'rationale']),
    );
    expect(Object.keys(resultSchemaFor('fix').shape)).toContain('no_change_needed');
    const reviewFindings = (outputSchemaFor('review')['properties'] as Record<string, Record<string, unknown>>)['findings'];
    const item = reviewFindings?.['items'] as Record<string, unknown>;
    expect(item['required']).toEqual(['repo', 'file', 'severity', 'category', 'description', 'suggested_action']);
  });
});

function extrasFor(role: string): Record<string, unknown> {
  switch (role) {
    case 'checkpoint':
      return { outcome: 'PASS' };
    case 'triage':
      return { suspect_repo: 'ui-kit', confidence: 'high', rationale: 'the failing spec lives in ui-kit' };
    case 'fix':
      return { no_change_needed: false };
    case 'review':
      return {
        findings: [
          {
            repo: 'ui-kit',
            file: 'src/lib/button.ts',
            severity: 'major',
            category: 'behaviour',
            description: 'the disabled input is no longer honoured',
            suggested_action: 'restore the disabled binding',
          },
        ],
      };
    default:
      return {};
  }
}
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/output-schema.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/output-schema.js"`.

- [ ] **Step 7: Implement the role schemas**

Create `src/agents/output-schema.ts`:

```ts
import { z } from 'zod';
import { AGENT_ROLES } from '../config/config-schema.js';
import type { AgentRole } from '../config/config-schema.js';
import { formatZodIssues } from '../config/errors.js';
import { toCodexJsonSchema } from './json-schema.js';
import type { JsonSchema } from './json-schema.js';

/**
 * Spec §18.3: the minimum shape every role answers with. Every property is required — §14: "Codex strict schemas
 * require every property to be present, so role schemas list all fields as required and use `null` for 'not
 * applicable'". That is why nothing here uses `.optional()` or `.default()`: a missing property must be a
 * validation failure (one failed attempt, §18.3), never a silently filled-in value.
 *
 * `predicted_failures` is the one nullable field in the base shape, because §18.3 marks it conditional: "test
 * identities, when `expected_temporary_failure` is true".
 */
export const baseResultSchema = z
  .object({
    status: z.enum(['completed', 'blocked', 'failed']),
    summary: z.string(),
    changes_made: z.array(z.string()),
    findings: z.array(z.string()),
    evidence: z.array(z.string()),
    new_tasks: z.array(z.string()),
    expected_temporary_failure: z.boolean(),
    predicted_failures: z.array(z.string()).nullable(),
    plan_change_required: z.boolean(),
    architecture_change_required: z.boolean(),
    behavior_change_required: z.boolean(),
    recommended_next_action: z.string(),
    handover: z
      .object({ current_state: z.string(), next_action: z.string(), risks: z.array(z.string()) })
      .strict(),
  })
  .strict();

export type AgentResult = z.infer<typeof baseResultSchema>;

/** Spec §22: "Findings are structured (repo, file, severity, category, description, suggested action)." */
const reviewFindingSchema = z
  .object({
    repo: z.string(),
    file: z.string(),
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    category: z.string(),
    description: z.string(),
    suggested_action: z.string(),
  })
  .strict();

/**
 * Role schemas: the base shape plus the fields the spec names for that role's stage. A role absent here answers
 * with the base shape.
 *
 * T13 owns the review-findings loop and the fix agent's `no_change_needed` reply; T05 only fixes their shape so
 * the stage that consumes them does not have to renegotiate the contract with the model.
 */
export const ROLE_RESULT_SCHEMAS: Readonly<Partial<Record<AgentRole, z.ZodObject<z.ZodRawShape>>>> = {
  /** §21: the AI checkpoint's four outcomes, mirrored by `execution.work_packages.*.checkpoint.outcome`. */
  checkpoint: baseResultSchema.extend({
    outcome: z.enum(['PASS', 'CONTINUE_WITH_REFINED_TASKS', 'REGROUP_VERIFICATION', 'ESCALATE']),
  }),
  /** §22: structured findings instead of free-text lines. */
  review: baseResultSchema.extend({ findings: z.array(reviewFindingSchema) }),
  /** §17: "returns the most likely repo and a rationale" and is escalated when confidence is below medium. */
  triage: baseResultSchema.extend({
    suspect_repo: z.string().nullable(),
    confidence: z.enum(['low', 'medium', 'high']),
    rationale: z.string(),
  }),
  /** §24: "the fix agent may answer `no_change_needed` with a rationale". The rationale is `summary`. */
  fix: baseResultSchema.extend({ no_change_needed: z.boolean() }),
};

export function resultSchemaFor(role: AgentRole): z.ZodObject<z.ZodRawShape> {
  return ROLE_RESULT_SCHEMAS[role] ?? baseResultSchema;
}

/** The JSON Schema for `codex exec --output-schema`, generated from the zod schema so the two cannot drift. */
export function outputSchemaFor(role: AgentRole): JsonSchema {
  return toCodexJsonSchema(resultSchemaFor(role), `janus-${role}-result`);
}

export type ValidationOutcome =
  | { ok: true; result: AgentResult }
  | { ok: false; errors: string[] };

/**
 * Spec §18.3: "Invalid output is one failed attempt; the validation error is included in the retry context."
 * The `errors` strings are what the caller puts into PREVIOUS ATTEMPTS on the next try.
 */
export function validateAgentResult(role: AgentRole, raw: unknown): ValidationOutcome {
  const parsed = resultSchemaFor(role).safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatZodIssues(parsed.error) };
  return { ok: true, result: parsed.data as AgentResult };
}

/** Every role has a schema that converts; called by the tests and by `janus doctor` (T07). */
export function allOutputSchemas(): Record<AgentRole, JsonSchema> {
  const out = {} as Record<AgentRole, JsonSchema>;
  for (const role of AGENT_ROLES) out[role] = outputSchemaFor(role);
  return out;
}
```

- [ ] **Step 8: Run the output-schema test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/output-schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0. `AgentResult` being `z.infer` of the base schema while `resultSchemaFor` returns a wider `ZodObject<ZodRawShape>` is deliberate: the extra role fields are read by their stage through `outcome.result` plus a role-specific re-parse, not through `AgentResult`.

- [ ] **Step 10: Commit**

```bash
git add src/agents/json-schema.ts src/agents/output-schema.ts tests/agents/json-schema.test.ts tests/agents/output-schema.test.ts
git commit -m "feat(agents): add per-role output schemas with a generated Codex JSON Schema" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 4: `AgentTask` and `AgentOutcome` replace T04's placeholders

**Files:**
- Create: `src/agents/types.ts`, `src/agents/context.ts` (data shapes only; Task 7 adds the builders)
- Create: `tests/helpers/agent-fixtures.ts`
- Modify: `src/providers/types.ts` (delete `AgentRunRequest` and `AgentRunOutcome`, re-type `AgentRunner`)
- Modify: `src/providers/index.ts` (its `export type { ... } from './types.js'` line)
- Modify: `src/providers/fake/agent-runner.ts` (accept `AgentTask`, return `AgentOutcome`)
- Test: `tests/agents/types.test.ts` (create), `tests/providers/fake-agent-runner.test.ts`, `tests/engine/steps.test.ts`, `tests/integration/harness.test.ts`, `tests/integration/smoke.test.ts`

**Interfaces:**
- Consumes: `SandboxClass` (Task 1), `AgentResult` and `JsonSchema` (Task 3), `AgentTokenUsage` (Task 2), `AgentRole`, `Effort` (added here to `config-schema.ts`).
- Produces:
  - `interface ResolvedModel { model: string; effort: Effort; ladderIndex: number | null; ladderLength: number | null }`
  - `type AgentFailureKind = 'timeout' | 'nonzero_exit' | 'invalid_output' | 'spawn_failed'`
  - `interface AgentRunFailure { kind: AgentFailureKind; detail: string }`
  - `interface AgentTask` — the §18.1 contract
  - `interface AgentOutcome` — the §18.3 result plus what the adapter observed
  - `outcomeSummary(result: AgentResult | null, failure: AgentRunFailure | null): string`
  - `interface ChangeSummaryEntry { path: string; added: number; removed: number; generated: boolean }`
  - `interface ContextPackage` and `interface ContextPackageInput`
  - test helpers `contextPackageFixture`, `agentTaskFixture`, `resultFixture`, `stubOutcome`

**What is being replaced.** T04's `src/providers/types.ts` shipped two placeholders marked "T05 replaces this":
`AgentRunRequest { runId; role; repo }` → **deleted**, replaced by `AgentTask`; `AgentRunOutcome { runId; status; summary }` → **deleted**, replaced by `AgentOutcome`. `AgentOutcome` keeps `runId`, `status` and `summary` with the same meanings, so every existing reader (`outcome.summary` in `tests/integration/harness.test.ts`, the fake runner's own store) keeps working; only the *constructors* of the two types change, and every one of them is named below.

- [ ] **Step 1: Add `AGENT_EFFORTS` and `Effort` to the config schema**

In `src/config/config-schema.ts`, above `modelSpecSchema`, add:

```ts
/** Spec §18.6: the reasoning efforts a model spec or a ladder entry may name. */
export const AGENT_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export type Effort = (typeof AGENT_EFFORTS)[number];
```

and change `modelSpecSchema`'s effort line to use it:

```ts
    effort: z.enum(AGENT_EFFORTS).default('high'),
```

- [ ] **Step 2: Write the failing test**

Create `tests/agents/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { outcomeSummary } from '../../src/agents/types.js';
import { agentTaskFixture, resultFixture } from '../helpers/agent-fixtures.js';

describe('agent task and outcome', () => {
  it('carries the §18.1 contract fields', () => {
    const task = agentTaskFixture({ role: 'implementation', repo: 'ui-kit' });
    expect(task.sandboxClass).toBe('code-writing');
    expect(task.writableRoots.length).toBeGreaterThan(0);
    expect(task.network).toBe(true);
    expect(task.timeoutMinutes).toBe(60);
    expect(task.outputSchema['title']).toBe('janus-implementation-result');
    expect(task.attempt).toBe(1);
    expect(task.promptVersion).toMatch(/^implementation@\d+$/);
  });

  it('summarizes a successful run from the result and a failed one from the failure', () => {
    expect(outcomeSummary(resultFixture({ summary: 'raised @angular/core to 16' }), null)).toBe('raised @angular/core to 16');
    expect(outcomeSummary(null, { kind: 'timeout', detail: 'killed after 45 minutes' })).toBe(
      'agent run failed (timeout): killed after 45 minutes',
    );
    expect(outcomeSummary(null, null)).toBe('agent run produced no result and reported no failure');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/types.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/types.js"`.

- [ ] **Step 4: Create the context data shapes**

Create `src/agents/context.ts` (Task 7 adds `SECTION_ORDER`, `buildContextPackage`, `isGeneratedPath` and the renderer to this module; this step defines only the data):

```ts
import type { AgentRole } from '../config/config-schema.js';

/**
 * One line of the §18.2 CHANGE SUMMARY: "file list with added/removed line counts; lockfiles and generated files
 * listed but never inlined".
 *
 * T08 (diff analysis) produces these from the working-tree diff and sets `generated` for lockfiles and build
 * output; T05 only renders them and refuses an inline diff that still contains a generated file.
 */
export interface ChangeSummaryEntry {
  path: string;
  added: number;
  removed: number;
  generated: boolean;
}

/**
 * The variable half of a §18.2 context package: what the caller knows about this particular task. The fixed
 * blocks (guardrails, Angular guidance, budget, output contract) are filled in by `buildAgentTask` so a caller
 * cannot accidentally ship a prompt without them.
 *
 * Every field is required so a caller must decide; `null` means "this section has nothing to say" and renders as
 * a `(none)` body, which is information the model needs.
 */
export interface ContextPackageInput {
  /** §18.2 GOAL. */
  goal: string;
  /** §18.2 REPOSITORY: name, kind, dependencies, coupled repos, base branch, prerelease versions to pin. */
  repository: string | null;
  /** §18.2 APPROVED PLAN SLICE. */
  planSlice: string | null;
  /** §18.2 CURRENT STATE (relevant subset only — never the whole `state.yaml`). */
  currentState: string | null;
  /** §18.2 CHANGE SUMMARY. */
  changeSummary: ChangeSummaryEntry[];
  /** §18.2 INLINE DIFF. Ignored for every class but code-writing. Must not contain generated files. */
  inlineDiff: string | null;
  /** §18.2 LATEST VERIFICATION EVIDENCE (digest or build refs). Produced by T09. */
  verificationEvidence: string | null;
  /** §18.2 PREVIOUS ATTEMPTS: "summaries only" — one paragraph each (§16.4), never a previous agent's reasoning. */
  previousAttempts: string[];
  /** §18.2 KNOWN BASELINE EXCEPTIONS. */
  baselineExceptions: string[];
}

/** A complete §18.2 context package: the caller's input plus the blocks Janus always supplies. */
export interface ContextPackage extends ContextPackageInput {
  role: AgentRole;
  /** §18.2 GUARDRAILS AND FORBIDDEN ACTIONS: §19's "may not" list plus the repo's configured limits. */
  guardrails: string[];
  /** §18.2 ANGULAR GUIDANCE (package manager, `ng update` flags, migration expectations). */
  angularGuidance: string;
  /** §18.2 BUDGET: the counters and limits this attempt runs under (§20). */
  budget: string;
  /** §18.2 OUTPUT CONTRACT: the role's result fields, rendered from its schema. */
  outputContract: string;
}
```

- [ ] **Step 5: Create the agent types**

Create `src/agents/types.ts`:

```ts
import type { AgentRole, Effort } from '../config/config-schema.js';
import type { AgentTokenUsage } from '../telemetry/events.js';
import type { ContextPackage } from './context.js';
import type { JsonSchema } from './json-schema.js';
import type { AgentResult } from './output-schema.js';
import type { SandboxClass } from './roles.js';

export type { AgentTokenUsage };
export type { AgentResult };

/** Spec §18.6: the model and effort this attempt resolved to, and where in the role's ladder it came from. */
export interface ResolvedModel {
  model: string;
  effort: Effort;
  /** Index into the role's ladder, or null when the role has no ladder. */
  ladderIndex: number | null;
  ladderLength: number | null;
}

/** Why the adapter could not hand back a validated §18.3 result. */
export type AgentFailureKind = 'timeout' | 'nonzero_exit' | 'invalid_output' | 'spawn_failed';

export interface AgentRunFailure {
  kind: AgentFailureKind;
  /**
   * Spec §18.3: "Invalid output is one failed attempt; the validation error is included in the retry context."
   * This string is what the caller puts into the next attempt's PREVIOUS ATTEMPTS section.
   */
  detail: string;
}

/**
 * Spec §18.1 task contract. Built by `buildAgentTask` (Task 8) and handed to `AgentRunner.run`.
 *
 * Field names are camelCase because this is an in-memory value Janus constructs; each one names its §18.1 field
 * where the spelling differs. `model`, `attempt` and `promptVersion` are not in §18.1's list: §18.4 passes the
 * model and effort as `codex exec` arguments and §18.6 requires the resolved model, the attempt and the prompt
 * version stamped on every evidence file and event, so they travel with the task rather than forcing every runner
 * to re-read the config.
 */
export interface AgentTask {
  /** §18.1 `run_id`. Also the basename of `evidence/agents/<run-id>.yaml` and of `reports/<run-id>/`. */
  runId: string;
  role: AgentRole;
  /** §18.1 `class`. */
  sandboxClass: SandboxClass;
  /** §18.1 `repo`: the repository this run is assigned to, or null for workspace-level roles. */
  repo: string | null;
  /** §18.1 `cwd`: absolute. */
  cwd: string;
  /** §18.1 `writable_roots`: absolute paths passed as `--add-dir`. Empty for the read-only class. */
  writableRoots: string[];
  /** §18.1 `network`: `sandbox_workspace_write.network_access`. */
  network: boolean;
  /** §18.1 `timeout_minutes`: `agents.roles.<role>.timeout_minutes`, capped by `max_agent_runtime_minutes`. */
  timeoutMinutes: number;
  /** §18.1 `context`. */
  context: ContextPackage;
  /** §18.1 `output_schema`: generated from the role's zod schema (§14). */
  outputSchema: JsonSchema;
  /** §18.6: the resolved model for this attempt. */
  model: ResolvedModel;
  /** 1-based attempt within the current failure. Attempt 1 uses ladder entry 0. */
  attempt: number;
  /** §18.6: the version of the role's prompt template, stamped on evidence and events. */
  promptVersion: string;
  /** §18.6: the active model profile name (`--model-profile` or `workflow_models.profile`). */
  profile: string;
  /** §18.6: `experiment.id` from `config.yaml`, or null. */
  experimentId: string | null;
  /** The `-s` value §18.4 passes; derived from the class, or `danger-full-access` when `allow_unsandboxed`. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Environment additions for the child process (for example `npm_config_store_dir`). Never holds a secret. */
  env: Record<string, string>;
}

/**
 * What one agent run answers.
 *
 * Replaces T04's `AgentRunOutcome`. `runId`, `status` and `summary` keep their T04 meanings so existing readers
 * are unaffected; everything else is new. Telemetry and the evidence file are **not** written here — `runAgent`
 * (Task 9) does that for every runner, so the Codex adapter and the fake do not each reimplement it.
 */
export interface AgentOutcome {
  runId: string;
  /** §18.3 `status`. `failed` when `failure` is set, because an unusable answer is one failed attempt. */
  status: AgentResult['status'];
  /** `result.summary` when there is a result, otherwise a rendering of `failure`. */
  summary: string;
  /** The validated §18.3 result, or null when the run produced none. */
  result: AgentResult | null;
  failure: AgentRunFailure | null;
  tokens: AgentTokenUsage | null;
  durationMs: number;
  /** Process exit code; null for a signal, a spawn failure, or the fake runner. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** `codex --version` for the Codex adapter; null for the fake runner. */
  runnerVersion: string | null;
}

export function outcomeSummary(result: AgentResult | null, failure: AgentRunFailure | null): string {
  if (result !== null) return result.summary;
  if (failure !== null) return `agent run failed (${failure.kind}): ${failure.detail}`;
  return 'agent run produced no result and reported no failure';
}
```

- [ ] **Step 6: Re-type the provider seam**

In `src/providers/types.ts`, delete the `AgentRunRequest` and `AgentRunOutcome` interfaces and their doc comments, add the import, and re-type `AgentRunner`:

```ts
import type { AgentOutcome, AgentTask } from '../agents/types.js';

/**
 * §3.2 `AgentRunner`: `run(task: AgentTask): Promise<AgentResult>`. Implementations: the Codex adapter (§18.4)
 * and the scripted fake (§18.5). A runner executes one task and reports what happened; it writes no telemetry and
 * no evidence — `runAgent` in `src/agents/run.ts` does that around every runner.
 */
export interface AgentRunner {
  readonly name: 'codex' | 'fake';
  run(task: AgentTask): Promise<AgentOutcome>;
}

export type { AgentOutcome, AgentTask };
```

The `AgentRole` import at the top of the file is now unused — remove it if ESLint reports it. `CiProvider`, `ScmProvider` and `Providers` are untouched.

In `src/providers/index.ts`, change the trailing re-export line to:

```ts
export type { AgentOutcome, AgentRunner, AgentTask, CiProvider, Providers, ScmProvider } from './types.js';
```

- [ ] **Step 7: Write the test fixtures**

Create `tests/helpers/agent-fixtures.ts`:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRole } from '../../src/config/config-schema.js';
import type { ContextPackage, ContextPackageInput } from '../../src/agents/context.js';
import { outputSchemaFor } from '../../src/agents/output-schema.js';
import type { AgentResult } from '../../src/agents/output-schema.js';
import { promptVersionFor } from '../../src/agents/prompts/templates.js';
import { sandboxClassFor } from '../../src/agents/roles.js';
import type { AgentOutcome, AgentTask } from '../../src/agents/types.js';
import { outcomeSummary } from '../../src/agents/types.js';

export function contextPackageInputFixture(overrides: Partial<ContextPackageInput> = {}): ContextPackageInput {
  return {
    goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
    repository: 'ui-kit (library), base branch main, no dependencies',
    planSlice: 'wp-01-ui-kit-angular: run ng update for @angular/core and @angular/cli',
    currentState: 'stage executing, work package wp-01-ui-kit-angular, attempt 1',
    changeSummary: [],
    inlineDiff: null,
    verificationEvidence: null,
    previousAttempts: [],
    baselineExceptions: [],
    ...overrides,
  };
}

export function contextPackageFixture(role: AgentRole = 'implementation', overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    ...contextPackageInputFixture(),
    role,
    guardrails: ['never run a git write command', 'never edit .teamcity/** or .github/**'],
    angularGuidance: 'Use pnpm. Run ng update with --allow-dirty.',
    budget: 'ci_fix_attempts: 0 of 5',
    outputContract: 'Answer with JSON matching the schema you were given.',
    ...overrides,
  };
}

export function resultFixture(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: 'completed',
    summary: 'raised @angular/core to 16.2.12',
    changes_made: ['package.json'],
    findings: [],
    evidence: [],
    new_tasks: [],
    expected_temporary_failure: false,
    predicted_failures: null,
    plan_change_required: false,
    architecture_change_required: false,
    behavior_change_required: false,
    recommended_next_action: 'run the PR build',
    handover: { current_state: 'builds on 16', next_action: 'commit', risks: [] },
    ...overrides,
  };
}

/** A structurally valid §18.1 task. Tasks that need real paths build them with `buildAgentTask` instead. */
export function agentTaskFixture(overrides: Partial<AgentTask> = {}): AgentTask {
  const role = overrides.role ?? 'implementation';
  const repo = overrides.repo === undefined ? 'ui-kit' : overrides.repo;
  const root = join(tmpdir(), 'janus-task-fixture');
  return {
    runId: 'run-0001',
    role,
    sandboxClass: sandboxClassFor(role),
    repo,
    cwd: join(root, 'repos', repo ?? 'ui-kit'),
    writableRoots: [join(root, 'repos', repo ?? 'ui-kit')],
    network: true,
    timeoutMinutes: 60,
    context: contextPackageFixture(role),
    outputSchema: outputSchemaFor(role),
    model: { model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null },
    attempt: 1,
    promptVersion: promptVersionFor(role),
    profile: 'default',
    experimentId: null,
    sandbox: 'workspace-write',
    env: {},
    ...overrides,
  };
}

/** A minimal successful `AgentOutcome`, for tests that need an `AgentRunner` but do not care what it answers. */
export function stubOutcome(task: AgentTask, overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  const result = overrides.result === undefined ? resultFixture() : overrides.result;
  return {
    runId: task.runId,
    status: result?.status ?? 'failed',
    summary: outcomeSummary(result, overrides.failure ?? null),
    result,
    failure: null,
    tokens: null,
    durationMs: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    runnerVersion: null,
    ...overrides,
  };
}
```

This file imports `promptVersionFor` from Task 6. Until Task 6 lands, replace that import with a local `const promptVersionFor = (role: AgentRole): string => \`${role}@1\`;` and delete it when Task 6 adds the real one. Task 6's Step 8 makes that swap.

- [ ] **Step 8: Migrate the fake runner to the new types**

In `src/providers/fake/agent-runner.ts`, change the imports and the `run` body. The script shape and the persisted store stay exactly as T04 left them (Task 12 grows them):

```ts
import type { AgentOutcome, AgentResult, AgentTask } from '../../agents/types.js';
import { outcomeSummary } from '../../agents/types.js';
```

`FakeAgentScriptEntry.status` keeps its type by switching its source: `status: AgentResult['status'];`. `FakeAgentCall.status` likewise. The `run` body becomes:

```ts
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const store = readFakeAgents(input.fakeDir);
      const attempt = store.calls.filter((call) => call.role === task.role).length;
      const scripted = store.script[task.role]?.[attempt];
      const status = scripted?.status ?? 'completed';
      const summary = scripted?.summary ?? `fake ${task.role} agent attempt ${attempt + 1} completed`;
      const result: AgentResult = {
        status,
        summary,
        changes_made: [],
        findings: [],
        evidence: [],
        new_tasks: [],
        expected_temporary_failure: false,
        predicted_failures: null,
        plan_change_required: false,
        architecture_change_required: false,
        behavior_change_required: false,
        recommended_next_action: '',
        handover: { current_state: summary, next_action: '', risks: [] },
      };
      store.calls.push({
        run_id: task.runId,
        role: task.role,
        repo: task.repo,
        at: input.now().toISOString(),
        status,
      });
      writeFakeStore(input.fakeDir, FAKE_AGENTS_FILE, store);
      return {
        runId: task.runId,
        status,
        summary: outcomeSummary(result, null),
        result,
        failure: null,
        tokens: null,
        durationMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        runnerVersion: null,
      };
    },
```

- [ ] **Step 9: Migrate the four test call sites**

1. `tests/providers/fake-agent-runner.test.ts` — every `runner.run({ runId: 'x', role: 'y', repo: 'z' })` becomes `runner.run(agentTaskFixture({ runId: 'x', role: 'y', repo: 'z' }))`, with `import { agentTaskFixture } from '../helpers/agent-fixtures.js';` added. The first test's `expect(first).toEqual({ runId, status, summary })` becomes:

```ts
    expect(first.status).toBe('failed');
    expect(first.summary).toBe('first attempt broke the build');
    expect(first.result?.summary).toBe('first attempt broke the build');
```

and the second test's `expect(await runner.run(...)).toEqual({ runId: 'r2', status: 'completed', summary: '...' })` becomes:

```ts
    const second = await runner.run(agentTaskFixture({ runId: 'r2', role: 'review', repo: null }));
    expect(second.status).toBe('completed');
    expect(second.summary).toBe('fake review agent attempt 2 completed');
```

The `store.calls` assertions are unchanged — the persisted shape did not move.

2. `tests/engine/steps.test.ts` — the inline `agent` member of the `Providers` literal becomes:

```ts
  agent: { name: 'fake', run: async (task) => stubOutcome(task) },
```

with `import { stubOutcome } from '../helpers/agent-fixtures.js';` added.

3. `tests/integration/harness.test.ts` — `harness.providers.agent.run({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' })` becomes `harness.providers.agent.run(agentTaskFixture({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' }))`, with the import added.

4. `tests/integration/smoke.test.ts` — the scripted step that drives one agent calls `ctx.providers.agent.run({...})`; wrap the same object literal in `agentTaskFixture({...})` and add the import. If the file has no such call, nothing changes there.

- [ ] **Step 10: Run the whole suite**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0. `tests/agents/types.test.ts` passes (2 tests); the four migrated files pass unchanged in behaviour.

- [ ] **Step 11: Commit**

```bash
git add src/agents/types.ts src/agents/context.ts src/config/config-schema.ts src/providers tests/agents/types.test.ts tests/helpers/agent-fixtures.ts tests/providers/fake-agent-runner.test.ts tests/engine/steps.test.ts tests/integration
git commit -m "feat(agents): replace the placeholder agent request and outcome with the spec contract" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 5: Model profiles, ladders, and model switches

**Files:**
- Create: `src/agents/models.ts`
- Test: `tests/agents/models.test.ts`

**Interfaces:**
- Consumes: `JanusConfig`, `AGENT_EFFORTS`, `Effort`, `AgentRole`; `ResolvedModel` (Task 4).
- Produces:
  - `parseLadderEntry(entry: string, fallback: Effort): { model: string; effort: Effort }`
  - `resolveModel(input: ResolveModelInput): ResolvedModel`
  - `isModelSwitch(previous: ResolvedModel | null, next: ResolvedModel): boolean`
  - `class ModelProfileError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/models.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { isModelSwitch, ModelProfileError, parseLadderEntry, resolveModel } from '../../src/agents/models.js';

const config = configSchema.parse({
  workflow: { ci_provider: 'fake', scm_provider: 'fake' },
  model_profiles: {
    default: {
      '*': { model: 'gpt-5.6-sol', effort: 'high' },
      implementation: { model: 'gpt-5.6-sol', effort: 'xhigh' },
      debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-sol', 'gpt-5.6-sol:xhigh'] },
    },
    'fast-first': {
      '*': { model: 'gpt-5.6-mini', effort: 'medium' },
      debug: { model: 'gpt-5.6-mini', effort: 'medium', ladder: ['gpt-5.6-mini', 'gpt-5.6-sol', 'gpt-5.6-sol:xhigh'] },
    },
  },
});

const resolve = (role: Parameters<typeof resolveModel>[0]['role'], attempt: number, profile = 'default') =>
  resolveModel({ config, profile, role, attempt });

describe('parseLadderEntry', () => {
  it('reads an effort suffix after the last colon when it names an effort', () => {
    expect(parseLadderEntry('gpt-5.6-sol:xhigh', 'high')).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(parseLadderEntry('vendor:model:minimal', 'high')).toEqual({ model: 'vendor:model', effort: 'minimal' });
  });

  it('falls back to the spec effort when there is no suffix or the suffix is not an effort', () => {
    expect(parseLadderEntry('gpt-5.6-sol', 'medium')).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
    expect(parseLadderEntry('vendor:model', 'medium')).toEqual({ model: 'vendor:model', effort: 'medium' });
    expect(parseLadderEntry('gpt-5.6-sol:turbo', 'low')).toEqual({ model: 'gpt-5.6-sol:turbo', effort: 'low' });
  });

  it('treats a leading colon as part of the model name, not an empty model', () => {
    expect(parseLadderEntry(':high', 'low')).toEqual({ model: ':high', effort: 'low' });
  });
});

describe('resolveModel', () => {
  it('uses the role entry when the profile has one and the "*" entry otherwise', () => {
    expect(resolve('implementation', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: null, ladderLength: null });
    expect(resolve('qa', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null });
  });

  it('walks the ladder one step per attempt and then holds at the last entry (§18.6)', () => {
    expect(resolve('debug', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: 0, ladderLength: 2 });
    expect(resolve('debug', 2)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
    expect(resolve('debug', 3)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
    expect(resolve('debug', 99).ladderIndex).toBe(1);
  });

  it('walks a three-entry ladder from a different profile', () => {
    expect(resolve('debug', 1, 'fast-first').model).toBe('gpt-5.6-mini');
    expect(resolve('debug', 2, 'fast-first')).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', ladderIndex: 1, ladderLength: 3 });
    expect(resolve('debug', 3, 'fast-first')).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 2, ladderLength: 3 });
  });

  it('clamps an attempt below 1 to the first ladder entry', () => {
    expect(resolve('debug', 0).ladderIndex).toBe(0);
  });

  it('names the profile that does not exist', () => {
    expect(() => resolveModel({ config, profile: 'nope', role: 'debug', attempt: 1 })).toThrow(ModelProfileError);
    expect(() => resolveModel({ config, profile: 'nope', role: 'debug', attempt: 1 })).toThrow(
      'model profile "nope" is not defined in config.yaml model_profiles',
    );
  });
});

describe('isModelSwitch', () => {
  it('is false for the first attempt and for an unchanged model', () => {
    expect(isModelSwitch(null, resolve('debug', 1))).toBe(false);
    expect(isModelSwitch(resolve('debug', 2), resolve('debug', 3))).toBe(false);
  });

  it('is true when the model or the effort changes', () => {
    expect(isModelSwitch(resolve('debug', 1), resolve('debug', 2))).toBe(true);
    expect(isModelSwitch(resolve('debug', 1, 'fast-first'), resolve('debug', 2, 'fast-first'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/models.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/models.js"`.

- [ ] **Step 3: Implement model resolution**

Create `src/agents/models.ts`:

```ts
import { AGENT_EFFORTS } from '../config/config-schema.js';
import type { AgentRole, Effort, JanusConfig } from '../config/config-schema.js';
import type { ResolvedModel } from './types.js';

export class ModelProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProfileError';
  }
}

function isEffort(value: string): value is Effort {
  return (AGENT_EFFORTS as readonly string[]).includes(value);
}

/**
 * Spec §18.6's ladder entries are opaque model strings that may encode a reasoning effort, as in
 * `gpt-5.6-sol:xhigh`.
 *
 * The split is at the **last** colon, and only when what follows it is exactly one of the five efforts. That
 * keeps a namespaced id like `vendor/model:tag` intact, keeps `vendor:model` meaning a model, and still lets
 * `vendor:model:high` mean "model `vendor:model` at high effort". A leading colon leaves an empty prefix, so the
 * whole string is taken as the model.
 */
export function parseLadderEntry(entry: string, fallback: Effort): { model: string; effort: Effort } {
  const colon = entry.lastIndexOf(':');
  if (colon > 0) {
    const suffix = entry.slice(colon + 1);
    if (isEffort(suffix)) return { model: entry.slice(0, colon), effort: suffix };
  }
  return { model: entry, effort: fallback };
}

export interface ResolveModelInput {
  config: JanusConfig;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  role: AgentRole;
  /** 1-based attempt within the current failure. */
  attempt: number;
}

/**
 * Spec §18.6: "For roles with a ladder, attempt `n` uses ladder entry `min(n, len-1)`."
 *
 * Janus counts attempts 1-based, so `n` here is `attempt - 1`: attempt 1 uses entry 0. Read the other way, entry 0
 * of a two-entry ladder would never run, which would defeat the cheap-first ladder the spec's own example shows.
 */
export function resolveModel(input: ResolveModelInput): ResolvedModel {
  const profile = input.config.model_profiles[input.profile];
  if (profile === undefined) {
    throw new ModelProfileError(`model profile "${input.profile}" is not defined in config.yaml model_profiles`);
  }
  const spec = profile[input.role] ?? profile['*'];
  if (spec === undefined) {
    throw new ModelProfileError(
      `model profile "${input.profile}" has no entry for role "${input.role}" and no "*" entry`,
    );
  }
  const ladder = spec.ladder;
  if (ladder === undefined || ladder.length === 0) {
    return { model: spec.model, effort: spec.effort, ladderIndex: null, ladderLength: null };
  }
  const index = Math.min(Math.max(input.attempt, 1) - 1, ladder.length - 1);
  const entry = ladder[index];
  if (entry === undefined) {
    throw new ModelProfileError(`ladder for role "${input.role}" in profile "${input.profile}" has no entry ${index}`);
  }
  const parsed = parseLadderEntry(entry, spec.effort);
  return { model: parsed.model, effort: parsed.effort, ladderIndex: index, ladderLength: ladder.length };
}

/**
 * Spec §18.6: a ladder step is recorded as `model_switch` "so no-progress detection can distinguish 'same model,
 * same failure' from 'new model, same failure'". Switching never adds budget — nothing in this module or in
 * `runAgent` touches `execution.budgets`.
 */
export function isModelSwitch(previous: ResolvedModel | null, next: ResolvedModel): boolean {
  if (previous === null) return false;
  return previous.model !== next.model || previous.effort !== next.effort;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/models.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/agents/models.ts tests/agents/models.test.ts
git commit -m "feat(agents): resolve models and ladders from the active profile" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 6: Versioned prompt templates with a fingerprint that forces the bump

**Files:**
- Create: `src/agents/prompts/shared.ts`, `src/agents/prompts/templates.ts`
- Modify: `tests/helpers/agent-fixtures.ts` (swap the temporary `promptVersionFor` for the real import)
- Test: `tests/agents/prompts.test.ts`

**Interfaces:**
- Consumes: `AGENT_ROLES`, `AgentRole`; `outputSchemaFor` (Task 3); `SandboxClass`, `ROLE_CLASSES` (Task 1).
- Produces:
  - `const FORBIDDEN_ACTIONS: string[]` — §19's "may not" list plus §32 rule 11
  - `const ANGULAR_GUIDANCE: string` — §18.4's injected guidance
  - `const SHARED_BLOCK_TEXT: string` — the fingerprint input for the shared half
  - `outputContractBlock(role: AgentRole): string` — rendered from the role's generated JSON Schema
  - `interface PromptTemplate { version: string; text: string }`
  - `const ROLE_TEMPLATES: Readonly<Record<AgentRole, PromptTemplate>>`
  - `const PROMPT_FINGERPRINTS: Readonly<Record<AgentRole, string>>`
  - `promptFingerprint(role: AgentRole): string`, `promptVersionFor(role: AgentRole): string`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_ROLES } from '../../src/config/config-schema.js';
import { ANGULAR_GUIDANCE, FORBIDDEN_ACTIONS, outputContractBlock } from '../../src/agents/prompts/shared.js';
import { PROMPT_FINGERPRINTS, promptFingerprint, promptVersionFor, ROLE_TEMPLATES } from '../../src/agents/prompts/templates.js';

describe('prompt templates', () => {
  it('has a versioned template for every §18.1 role', () => {
    for (const role of AGENT_ROLES) {
      expect(ROLE_TEMPLATES[role].text.trim().length, role).toBeGreaterThan(80);
      expect(promptVersionFor(role), role).toMatch(new RegExp(`^${role}@\\d+$`));
    }
  });

  /**
   * §18.6: "Prompt templates are versioned so a comparison never mixes prompt changes with model changes
   * silently." This is the mechanism. When this fails: change `version` in ROLE_TEMPLATES to the next integer for
   * every role the diff lists, then paste the received object into PROMPT_FINGERPRINTS.
   */
  it('fingerprints match the checked-in table, so a template edit cannot ship without a version bump', () => {
    const actual = Object.fromEntries(AGENT_ROLES.map((role) => [role, promptFingerprint(role)]));
    expect(actual).toEqual(PROMPT_FINGERPRINTS);
  });

  it('spells out every git write the agent may not perform (§19, §32 rule 11)', () => {
    const text = FORBIDDEN_ACTIONS.join('\n');
    for (const forbidden of ['git commit', 'git push', 'git add', 'git rebase', 'git reset', 'git tag', 'git stash']) {
      expect(text, forbidden).toContain(forbidden);
    }
    expect(text).toContain('outside');
    expect(text).toContain('publish');
  });

  it('carries §18.4 Angular guidance including the --allow-dirty reason', () => {
    expect(ANGULAR_GUIDANCE).toContain('--allow-dirty');
    expect(ANGULAR_GUIDANCE).toContain('pnpm');
    expect(ANGULAR_GUIDANCE).toContain('CI configuration');
  });

  it('renders the output contract from the role schema, so a schema change reaches the prompt', () => {
    const block = outputContractBlock('triage');
    expect(block).toContain('suspect_repo');
    expect(block).toContain('confidence');
    expect(block).toContain('null');
    expect(outputContractBlock('implementation')).not.toContain('suspect_repo');
    expect(outputContractBlock('checkpoint')).toContain('CONTINUE_WITH_REFINED_TASKS');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/prompts/shared.js"`.

- [ ] **Step 3: Write the shared blocks**

Create `src/agents/prompts/shared.ts`:

```ts
import type { AgentRole } from '../../config/config-schema.js';
import type { JsonSchema } from '../json-schema.js';
import { outputSchemaFor } from '../output-schema.js';

/**
 * Spec §19's "may not" additions plus §32 rule 11. Rendered verbatim into GUARDRAILS AND FORBIDDEN ACTIONS for
 * every role, in every class — §3.3: "Every prompt states that git write commands are forbidden."
 */
export const FORBIDDEN_ACTIONS: string[] = [
  'Never run a git write command: no `git commit`, `git add`, `git push`, `git rebase`, `git merge`, `git reset`, `git checkout -b`, `git tag`, `git stash`, `git cherry-pick`, or any command that moves a ref. Janus commits your work; you only edit files.',
  'Never modify a file outside the writable roots listed under REPOSITORY. Everything else in the workspace is readable and must stay unchanged.',
  'Never change a file under the forbidden paths listed below.',
  'Never publish a package, cut a release, or run a deploy command.',
  'During a sync-conflict task, resolve merge conflicts only; make no other change.',
  'Never weaken, skip, delete, or rename a test to make a build pass. Disabling a test is a policy violation, not a fix.',
  'Never edit CI configuration.',
  'Never read or echo an environment variable that holds a token or a password, and never write one into a file or into your answer.',
];

/** Spec §18.4: "Angular guidance injected into code-writing prompts". */
export const ANGULAR_GUIDANCE = [
  'Use the repository’s own package manager, pnpm. Never switch package managers and never hand-edit a lockfile.',
  'Run `ng update` with `--allow-dirty`: the working tree is intentionally uncommitted, because Janus commits, not you.',
  'Expect CLI migrations to touch files across the whole repository. That is normal and in scope.',
  'Never edit CI configuration (`.teamcity/**`, `.github/**`, or any pipeline file).',
  'Never raise an `@angular/*` package above the goal’s target major version.',
  'Peer-dependency warnings from a partially upgraded workspace are expected while a package is in flight; do not silence them by pinning unrelated versions.',
].join('\n');

function typeName(node: Record<string, unknown>): string {
  const type = node['type'];
  const rendered = Array.isArray(type) ? type.join(' | ') : String(type);
  const enumValues = node['enum'];
  if (Array.isArray(enumValues)) return `${rendered} (one of: ${enumValues.join(', ')})`;
  if (rendered.startsWith('array')) {
    const items = node['items'];
    const itemType = typeof items === 'object' && items !== null ? typeName(items as Record<string, unknown>) : 'string';
    return `${rendered} of ${itemType}`;
  }
  return rendered;
}

/**
 * Spec §18.2 OUTPUT CONTRACT, rendered from the role's generated JSON Schema so a schema change always reaches
 * the prompt. §14: every property is required; `null` is how "not applicable" is expressed.
 */
export function outputContractBlock(role: AgentRole): string {
  const schema: JsonSchema = outputSchemaFor(role);
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null) throw new Error(`role ${role} has no output properties`);
  const lines = Object.entries(properties as Record<string, Record<string, unknown>>).map(
    ([key, node]) => `- \`${key}\`: ${typeName(node)}`,
  );
  return [
    'Answer with a single JSON object matching the schema you were given, and nothing else.',
    'Every field below is required. Use `null` (or an empty list) where a field does not apply; never omit a field.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The fingerprint input for the half of every prompt that does not depend on the role. Editing any shared block
 * changes this, which changes every role's fingerprint, which forces every role's version to be bumped — which is
 * correct, because the rendered prompt really did change for all of them (§18.6).
 */
export const SHARED_BLOCK_TEXT = `${FORBIDDEN_ACTIONS.join('\n')}\n---\n${ANGULAR_GUIDANCE}`;
```

- [ ] **Step 4: Write the role templates**

Create `src/agents/prompts/templates.ts`. Write all twelve entries; four are shown in full and the remaining eight follow the same three-paragraph shape (what you are, what you must produce, what would make the answer useless):

```ts
import { createHash } from 'node:crypto';
import type { AgentRole } from '../../config/config-schema.js';
import { SHARED_BLOCK_TEXT } from './shared.js';

export interface PromptTemplate {
  /** `<role>@<n>`, `n` strictly increasing. Bumped whenever `text` or any shared block changes (§18.6). */
  version: string;
  /** Markdown. Rendered as the prompt's task preamble, before the thirteen §18.2 sections. */
  text: string;
}

export const ROLE_TEMPLATES: Readonly<Record<AgentRole, PromptTemplate>> = {
  discovery: {
    version: 'discovery@1',
    text: [
      'You are a discovery agent. You are reading one repository to describe what an Angular major upgrade will require in it. You change no source file.',
      'Write your report as markdown files in your working directory, one per area you were asked about. Ground every claim in a file you actually read or a command you actually ran, and name it. Where you are guessing, say so.',
      'An answer that summarizes the repository without naming the specific blockers, pinned versions, and custom build steps that will bite during the upgrade is worthless. Prefer three concrete findings to twenty generic ones.',
    ].join('\n\n'),
  },
  integration_discovery: {
    version: 'integration_discovery@1',
    text: [
      'You are an integration discovery agent. You are reading several repositories together to describe how they depend on each other at build time and at runtime, including module-federation remotes.',
      'Write one markdown report covering: which repository publishes what, which consumes it, which versions are pinned where, and which pairs must be released together. Name the files you read.',
      'An answer that repeats each repository’s own README is worthless. The value is only in the couplings that are not written down anywhere.',
    ].join('\n\n'),
  },
  planning: {
    version: 'planning@1',
    text: [
      'You are a planning agent. You turn the goal, the discovery reports, and the baseline into an ordered plan of work packages.',
      'Every work package must name the repository it touches, the files or areas it is allowed to change, and how it will be verified. Order packages so that a package never depends on one that comes later. Write the plan into your working directory.',
      'A plan whose packages are "upgrade the app" or "fix the tests" is worthless. Each package must be small enough that one agent can finish it and one build can verify it.',
    ].join('\n\n'),
  },
  replanning: {
    version: 'replanning@1',
    text: [
      'You are a replanning agent. An execution attempt escalated, a human recorded a direction, and you are producing the revised plan from the current state, not from scratch.',
      'Keep every package that already completed. Say explicitly which packages you are changing, dropping, or adding, and why the new shape addresses the escalation reason and the human direction.',
      'A revised plan that quietly re-does finished work, or that ignores the recorded direction, is worse than no plan: it will be rejected at the gate and the goal will stall.',
    ].join('\n\n'),
  },
  implementation: {
    version: 'implementation@1',
    text: [
      'You are an implementation agent. You are making the code change for exactly one work package, in exactly one repository, and nothing else.',
      'Stay inside the plan slice you were given. Run the repository’s own build and tests to check your work. Report every file you changed and why, and if the package cannot be finished, say so with `status: blocked` and name the obstacle precisely.',
      'If you expect this package to leave the build red until a dependency package lands, set `expected_temporary_failure: true` and list the exact test identities you expect to fail in `predicted_failures`. An unlisted failure is treated as a defect.',
      'Changing files outside the slice, or making the tests pass by weakening them, fails the policy check and costs the goal an attempt.',
    ].join('\n\n'),
  },
  debug: {
    version: 'debug@1',
    text: [
      'You are a debug agent. A build failed; you have the failure digest, the diff so far, and the summaries of previous attempts. You fix the cause.',
      'Read the digest before touching anything, and say in one sentence what you believe the cause is before you change a file. If a previous attempt already tried your idea, try a different one: repeating a failed approach costs the goal an attempt and tells it nothing new.',
      'Making the failing test pass by changing the test, adding a skip, or loosening an assertion is a policy violation, not a fix.',
    ].join('\n\n'),
  },
  fix: {
    version: 'fix@1',
    text: [
      'You are a fix agent. You are addressing specific feedback: a policy violation report, a review finding, or a human’s pull-request comment. You make the smallest change that resolves it.',
      'If the feedback is wrong or already handled, set `no_change_needed: true` and put the rationale in `summary`; Janus will post it as a reply. Otherwise change only what the feedback names.',
      'Taking the opportunity to refactor, rename, or clean up something else makes the diff unreviewable and will be rejected.',
    ].join('\n\n'),
  },
  sync_conflict: {
    version: 'sync_conflict@1',
    text: [
      'You are a sync-conflict agent. A merge of the base branch into the goal branch left conflicts in the working tree. You resolve them.',
      'Resolve every conflict so that both sides’ intent survives: the base branch’s change and the goal branch’s upgrade. Leave no conflict markers. Do not run `git add`, `git commit`, or `git merge --continue`; Janus finishes the merge.',
      'Changing anything that was not conflicted, or resolving a conflict by discarding one side wholesale, is out of scope and will be rejected.',
    ].join('\n\n'),
  },
  checkpoint: {
    version: 'checkpoint@1',
    text: [
      'You are a checkpoint agent. A work package finished. You judge, from the change summary, the policy results, and the build outcomes, whether the goal should continue as planned.',
      'Run `git diff` yourself to read the change; you have read-only access to the whole workspace. Answer with one `outcome`: `PASS`, `CONTINUE_WITH_REFINED_TASKS`, `REGROUP_VERIFICATION`, or `ESCALATE`, and justify it in one paragraph.',
      'You are the judgment the deterministic policy checks cannot make: weakened assertions, quietly changed behaviour, an upgrade that technically builds but broke an API. A `PASS` that misses one of those is the most expensive answer you can give.',
    ].join('\n\n'),
  },
  review: {
    version: 'review@1',
    text: [
      'You are an independent reviewer. You did not write any of this code. You are reading the complete change across every repository before a human is asked to look at it.',
      'Run `git diff` yourself in each repository; you have read-only access to the whole workspace. Report findings as structured entries: repo, file, severity, category, description, suggested action. Severity `blocker` means the change must not merge as it stands.',
      'Findings that restate the diff, or style opinions the repository’s own lint does not hold, waste a review cycle. Report what a careful human reviewer would actually stop the merge for.',
    ].join('\n\n'),
  },
  triage: {
    version: 'triage@1',
    text: [
      'You are a triage agent. An end-to-end suite failed across several repositories. You name the single repository most likely responsible.',
      'You have the failure digest, each repository’s change summary, and the map from suite to repository. Run `git diff` yourself where it helps. Answer with `suspect_repo`, a `confidence` of low, medium, or high, and a `rationale` that cites the evidence you used.',
      'If the evidence does not support at least medium confidence, say so honestly with `confidence: low` and `suspect_repo: null`. A confident guess sends a debug agent into the wrong repository and burns the E2E budget.',
    ].join('\n\n'),
  },
  qa: {
    version: 'qa@1',
    text: [
      'You are a QA agent. The change is complete and green. You are telling a human tester what to exercise by hand before this ships.',
      'Write one section per repository plus one goal-level section, into your working directory. Each recommendation names a user-visible flow and why this change could have broken it.',
      '"Regression-test the application" is not a recommendation. Name screens, flows, and the specific behaviours the upgrade most plausibly changed.',
    ].join('\n\n'),
  },
};

export function promptVersionFor(role: AgentRole): string {
  return ROLE_TEMPLATES[role].version;
}

/**
 * Spec §18.6: "Prompt templates are versioned so a comparison never mixes prompt changes with model changes
 * silently."
 *
 * The fingerprint covers the shared blocks as well as the role text, because both are rendered into the prompt.
 * `tests/agents/prompts.test.ts` compares the whole table, so any edit to either fails the suite until the
 * version is bumped and the new fingerprint is pasted in.
 */
export function promptFingerprint(role: AgentRole): string {
  return createHash('sha256').update(`${SHARED_BLOCK_TEXT}\n---\n${ROLE_TEMPLATES[role].text}`).digest('hex').slice(0, 8);
}

/** Regenerated by pasting the received object from the fingerprint test. Never edited by hand. */
export const PROMPT_FINGERPRINTS: Readonly<Record<AgentRole, string>> = {
  discovery: '00000000',
  integration_discovery: '00000000',
  planning: '00000000',
  replanning: '00000000',
  implementation: '00000000',
  debug: '00000000',
  fix: '00000000',
  sync_conflict: '00000000',
  checkpoint: '00000000',
  review: '00000000',
  triage: '00000000',
  qa: '00000000',
};
```

- [ ] **Step 5: Run the test and fill in the fingerprint table**

Run: `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`
Expected: FAIL on the fingerprint test only, with a diff whose "received" side is the twelve real fingerprints. Copy each received value over the matching `'00000000'` in `PROMPT_FINGERPRINTS`.

- [ ] **Step 6: Run the test again to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Prove the guard actually bites**

Temporarily append ` Extra.` to `ROLE_TEMPLATES.debug.text`, run `pnpm exec vitest run --project unit tests/agents/prompts.test.ts`, and confirm it FAILS on `debug`. Revert the edit and confirm it passes again. Do not commit the temporary edit.

- [ ] **Step 8: Point the fixtures at the real `promptVersionFor`**

In `tests/helpers/agent-fixtures.ts`, delete the temporary local `const promptVersionFor = ...` added in Task 4 Step 7 and keep the real import from `../../src/agents/prompts/templates.js`.

- [ ] **Step 9: Run the unit lane, lint, and typecheck**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/agents/prompts tests/agents/prompts.test.ts tests/helpers/agent-fixtures.ts
git commit -m "feat(agents): add versioned per-role prompt templates with a fingerprint guard" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 7: Context package rendering with byte budgets and truncation markers

**Files:**
- Modify: `src/agents/context.ts` (add `SECTION_ORDER`, `isGeneratedPath`, `buildContextPackage`)
- Create: `src/agents/render.ts`
- Test: `tests/agents/render.test.ts`

**Interfaces:**
- Consumes: `ContextPackage`, `ContextPackageInput`, `ChangeSummaryEntry` (Task 4); `isCodeWriting` (Task 1); `ANGULAR_GUIDANCE`, `FORBIDDEN_ACTIONS`, `outputContractBlock`, `ROLE_TEMPLATES`, `promptVersionFor` (Task 6).
- Produces:
  - `const SECTION_ORDER: readonly string[]` — §18.2's thirteen names, in order
  - `isGeneratedPath(path: string): boolean`
  - `buildContextPackage(input: BuildContextPackageInput): ContextPackage`
  - `interface RenderLimits { maxContextBytes: number; maxInlineDiffBytes: number }`
  - `interface RenderedPrompt { text: string; version: string; bytes: number; truncations: string[] }`
  - `renderContextPackage(pkg: ContextPackage, limits: RenderLimits): RenderedPrompt`
  - `truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number; totalBytes: number }`
  - `truncationMarker(what: string, omitted: number, total: number, key: string): string`
  - `class ContextTooLargeError extends Error`, `class ContextPackageError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isGeneratedPath, SECTION_ORDER } from '../../src/agents/context.js';
import { ContextPackageError, ContextTooLargeError, renderContextPackage, truncateUtf8 } from '../../src/agents/render.js';
import { contextPackageFixture } from '../helpers/agent-fixtures.js';

const LIMITS = { maxContextBytes: 200_000, maxInlineDiffBytes: 60_000 };

function headings(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3));
}

describe('renderContextPackage', () => {
  it('renders the thirteen §18.2 sections in the spec order, after the role task preamble', () => {
    const rendered = renderContextPackage(contextPackageFixture('implementation'), LIMITS);
    expect(headings(rendered.text)).toEqual([...SECTION_ORDER]);
    expect(rendered.text.startsWith('# TASK: implementation')).toBe(true);
    expect(rendered.text.indexOf('# TASK: implementation')).toBeLessThan(rendered.text.indexOf('## GOAL'));
    expect(rendered.version).toMatch(/^implementation@\d+$/);
    expect(rendered.bytes).toBe(Buffer.byteLength(rendered.text, 'utf8'));
    expect(rendered.truncations).toEqual([]);
  });

  it('renders an empty section as (none) rather than dropping it', () => {
    const rendered = renderContextPackage(
      contextPackageFixture('implementation', { planSlice: null, previousAttempts: [], baselineExceptions: [] }),
      LIMITS,
    );
    expect(headings(rendered.text)).toEqual([...SECTION_ORDER]);
    expect(rendered.text).toContain('## APPROVED PLAN SLICE\n\n(none)');
  });

  it('inlines a diff only for code-writing roles and tells the others to run git diff themselves', () => {
    const pkg = contextPackageFixture('implementation', { inlineDiff: 'diff --git a/x.ts b/x.ts\n+const a = 1;\n' });
    expect(renderContextPackage(pkg, LIMITS).text).toContain('+const a = 1;');

    const review = renderContextPackage({ ...pkg, role: 'review' }, LIMITS);
    expect(review.text).not.toContain('+const a = 1;');
    expect(review.text).toContain('run `git diff` yourself');
    expect(review.text).toContain('## CHANGE SUMMARY');
  });

  it('lists generated files in the change summary but marks them as never inlined (§18.2)', () => {
    const pkg = contextPackageFixture('implementation', {
      changeSummary: [
        { path: 'package.json', added: 12, removed: 3, generated: false },
        { path: 'pnpm-lock.yaml', added: 980, removed: 240, generated: true },
      ],
    });
    const text = renderContextPackage(pkg, LIMITS).text;
    expect(text).toContain('+12 -3 package.json');
    expect(text).toContain('+980 -240 pnpm-lock.yaml (generated; never inlined)');
  });

  it('refuses an inline diff that still contains a generated file', () => {
    const pkg = contextPackageFixture('implementation', {
      inlineDiff: 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+  foo: 1\n',
    });
    expect(() => renderContextPackage(pkg, LIMITS)).toThrow(ContextPackageError);
    expect(() => renderContextPackage(pkg, LIMITS)).toThrow('pnpm-lock.yaml');
  });

  it('truncates the inline diff at max_inline_diff_bytes with a marker naming the config key', () => {
    const diff = `diff --git a/big.ts b/big.ts\n${'+// filler line\n'.repeat(4000)}`;
    const rendered = renderContextPackage(contextPackageFixture('implementation', { inlineDiff: diff }), {
      maxContextBytes: 200_000,
      maxInlineDiffBytes: 1_000,
    });
    expect(rendered.text).toContain('[janus truncated the inline diff:');
    expect(rendered.text).toContain('agents.max_inline_diff_bytes]');
    expect(rendered.truncations.join('\n')).toContain('agents.max_inline_diff_bytes');
  });

  it('degrades in a fixed order when the whole prompt exceeds max_context_bytes', () => {
    const pkg = contextPackageFixture('implementation', {
      inlineDiff: `diff --git a/big.ts b/big.ts\n${'+// x\n'.repeat(2000)}`,
      previousAttempts: Array.from({ length: 9 }, (_, index) => `attempt ${index + 1}: ${'detail '.repeat(400)}`),
    });
    const rendered = renderContextPackage(pkg, { maxContextBytes: 12_000, maxInlineDiffBytes: 60_000 });
    expect(Buffer.byteLength(rendered.text, 'utf8')).toBeLessThanOrEqual(12_000);
    expect(rendered.truncations[0]).toContain('inline diff');
    expect(rendered.truncations.some((line) => line.includes('previous attempts'))).toBe(true);
    expect(rendered.text).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(rendered.text).toContain('## OUTPUT CONTRACT');
  });

  it('throws rather than ship a prompt without its guardrails when nothing can be dropped', () => {
    const pkg = contextPackageFixture('implementation', { goal: 'g'.repeat(50_000) });
    expect(() => renderContextPackage(pkg, { maxContextBytes: 4_000, maxInlineDiffBytes: 1_000 })).toThrow(
      ContextTooLargeError,
    );
    expect(() => renderContextPackage(pkg, { maxContextBytes: 4_000, maxInlineDiffBytes: 1_000 })).toThrow(
      'agents.max_context_bytes',
    );
  });
});

describe('truncateUtf8', () => {
  it('returns the text untouched when it fits', () => {
    expect(truncateUtf8('hello', 10)).toEqual({ text: 'hello', omittedBytes: 0, totalBytes: 5 });
  });

  it('cuts at the last newline inside the budget', () => {
    expect(truncateUtf8('aaa\nbbb\nccc\n', 9).text).toBe('aaa\nbbb\n');
  });

  it('never splits a multi-byte character', () => {
    const text = 'éééé';
    const cut = truncateUtf8(text, 5);
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(5);
    expect(cut.text).not.toContain('�');
    expect(cut.omittedBytes).toBeGreaterThan(0);
  });
});

describe('isGeneratedPath', () => {
  it('knows the lockfiles §18.2 says are listed but never inlined', () => {
    expect(isGeneratedPath('pnpm-lock.yaml')).toBe(true);
    expect(isGeneratedPath('packages/ui/package-lock.json')).toBe(true);
    expect(isGeneratedPath('yarn.lock')).toBe(true);
    expect(isGeneratedPath('src/app/app.component.ts')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/render.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/render.js"`.

- [ ] **Step 3: Add the section order, the generated-path rule, and the package builder**

Append to `src/agents/context.ts`:

```ts
import { ANGULAR_GUIDANCE, outputContractBlock } from './prompts/shared.js';

/** Spec §18.2, verbatim and in order. The renderer emits exactly these, no more and no fewer. */
export const SECTION_ORDER = [
  'GOAL',
  'REPOSITORY',
  'APPROVED PLAN SLICE',
  'CURRENT STATE',
  'CHANGE SUMMARY',
  'INLINE DIFF',
  'LATEST VERIFICATION EVIDENCE',
  'PREVIOUS ATTEMPTS',
  'KNOWN BASELINE EXCEPTIONS',
  'GUARDRAILS AND FORBIDDEN ACTIONS',
  'ANGULAR GUIDANCE',
  'BUDGET',
  'OUTPUT CONTRACT',
] as const;

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json']);

/** Spec §18.2: "lockfiles and generated files listed but never inlined". */
export function isGeneratedPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return LOCKFILES.has(base);
}

export interface BuildContextPackageInput {
  role: AgentRole;
  context: ContextPackageInput;
  /** Repo-specific guardrails: forbidden paths, allowed scope, diff caps. §19's fixed list is added by the renderer. */
  guardrails: string[];
  /** §18.2 BUDGET: the counters and limits this attempt runs under. */
  budget: string;
}

/** Fills the four blocks Janus always supplies, so no caller can ship a prompt without guardrails or a contract. */
export function buildContextPackage(input: BuildContextPackageInput): ContextPackage {
  return {
    ...input.context,
    role: input.role,
    guardrails: input.guardrails,
    angularGuidance: ANGULAR_GUIDANCE,
    budget: input.budget,
    outputContract: outputContractBlock(input.role),
  };
}
```

- [ ] **Step 4: Implement the renderer**

Create `src/agents/render.ts`:

```ts
import { isGeneratedPath, SECTION_ORDER } from './context.js';
import type { ChangeSummaryEntry, ContextPackage } from './context.js';
import { FORBIDDEN_ACTIONS } from './prompts/shared.js';
import { promptVersionFor, ROLE_TEMPLATES } from './prompts/templates.js';
import { isCodeWriting } from './roles.js';

export class ContextPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextPackageError';
  }
}

export class ContextTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(
      `context package is ${bytes} bytes after every safe reduction, over the ${limit}-byte agents.max_context_bytes; ` +
        'raise agents.max_context_bytes or give the agent a smaller plan slice. Janus refuses to truncate GOAL, ' +
        'REPOSITORY, APPROVED PLAN SLICE, GUARDRAILS AND FORBIDDEN ACTIONS, ANGULAR GUIDANCE, BUDGET or OUTPUT CONTRACT.',
    );
    this.name = 'ContextTooLargeError';
  }
}

export interface RenderLimits {
  /** `agents.max_context_bytes`. */
  maxContextBytes: number;
  /** `agents.max_inline_diff_bytes`. */
  maxInlineDiffBytes: number;
}

export interface RenderedPrompt {
  text: string;
  /** The role's prompt template version, stamped on evidence and events (§18.6). */
  version: string;
  bytes: number;
  /** One line per reduction that was applied, recorded in the evidence file. */
  truncations: string[];
}

export function truncationMarker(what: string, omitted: number, total: number, key: string): string {
  return `... [janus truncated the ${what}: ${omitted} of ${total} bytes omitted at ${key}] ...`;
}

/** Cuts at the last newline inside the budget, falling back to a byte cut that never splits a code point. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; omittedBytes: number; totalBytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  const totalBytes = buffer.byteLength;
  if (totalBytes <= maxBytes) return { text, omittedBytes: 0, totalBytes };
  const head = buffer.subarray(0, Math.max(maxBytes, 0));
  const newline = head.lastIndexOf(0x0a);
  const cut = newline > 0 ? newline + 1 : head.byteLength;
  const kept = buffer.subarray(0, cut).toString('utf8').replace(/�+$/u, '');
  return { text: kept, omittedBytes: totalBytes - Buffer.byteLength(kept, 'utf8'), totalBytes };
}

function section(name: string, body: string): string {
  return `## ${name}\n\n${body.trim() === '' ? '(none)' : body}`;
}

function renderChangeSummary(entries: ChangeSummaryEntry[], limit: number): { body: string; truncation: string | null } {
  if (entries.length === 0) return { body: '', truncation: null };
  const kept = entries.slice(0, limit);
  const lines = kept.map(
    (entry) => `+${entry.added} -${entry.removed} ${entry.path}${entry.generated ? ' (generated; never inlined)' : ''}`,
  );
  if (kept.length === entries.length) return { body: lines.join('\n'), truncation: null };
  const note = `... [janus truncated the change summary: ${entries.length - kept.length} of ${entries.length} files omitted]`;
  return { body: [...lines, note].join('\n'), truncation: note };
}

function assertNoGeneratedFilesInDiff(diff: string): void {
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const path of line.split(' ').slice(2)) {
      const stripped = path.replace(/^[ab]\//u, '');
      if (isGeneratedPath(stripped)) {
        throw new ContextPackageError(
          `inline diff contains the generated file ${stripped}; spec §18.2 says lockfiles and generated files are ` +
            'listed in CHANGE SUMMARY but never inlined. Remove it from the diff before building the context package.',
        );
      }
    }
  }
}

interface Reduction {
  inlineDiffBytes: number;
  previousAttempts: number;
  evidenceBytes: number;
  changeSummaryEntries: number;
}

const UNBOUNDED = Number.POSITIVE_INFINITY;

function assemble(pkg: ContextPackage, reduction: Reduction): { text: string; truncations: string[] } {
  const truncations: string[] = [];
  const bodies = new Map<string, string>();

  bodies.set('GOAL', pkg.goal);
  bodies.set('REPOSITORY', pkg.repository ?? '');
  bodies.set('APPROVED PLAN SLICE', pkg.planSlice ?? '');
  bodies.set('CURRENT STATE', pkg.currentState ?? '');

  const summary = renderChangeSummary(pkg.changeSummary, reduction.changeSummaryEntries);
  bodies.set('CHANGE SUMMARY', summary.body);
  if (summary.truncation !== null) truncations.push(summary.truncation);

  if (!isCodeWriting(pkg.role)) {
    bodies.set(
      'INLINE DIFF',
      'No diff is inlined for this role. You have read access to the whole workspace: run `git diff` yourself ' +
        'in the repositories named in CHANGE SUMMARY (spec §18.2).',
    );
  } else if (pkg.inlineDiff === null || pkg.inlineDiff === '') {
    bodies.set('INLINE DIFF', '');
  } else {
    assertNoGeneratedFilesInDiff(pkg.inlineDiff);
    const cut = truncateUtf8(pkg.inlineDiff, reduction.inlineDiffBytes);
    if (cut.omittedBytes === 0) {
      bodies.set('INLINE DIFF', cut.text);
    } else {
      const marker = truncationMarker('inline diff', cut.omittedBytes, cut.totalBytes, 'agents.max_inline_diff_bytes');
      bodies.set('INLINE DIFF', `${cut.text}\n${marker}`);
      truncations.push(marker);
    }
  }

  const evidence = truncateUtf8(pkg.verificationEvidence ?? '', reduction.evidenceBytes);
  if (evidence.omittedBytes === 0) {
    bodies.set('LATEST VERIFICATION EVIDENCE', evidence.text);
  } else {
    const marker = truncationMarker('verification evidence', evidence.omittedBytes, evidence.totalBytes, 'agents.max_context_bytes');
    bodies.set('LATEST VERIFICATION EVIDENCE', `${evidence.text}\n${marker}`);
    truncations.push(marker);
  }

  const attempts = Number.isFinite(reduction.previousAttempts)
    ? pkg.previousAttempts.slice(-reduction.previousAttempts)
    : pkg.previousAttempts;
  if (attempts.length < pkg.previousAttempts.length) {
    const note = `... [janus kept the ${attempts.length} most recent of ${pkg.previousAttempts.length} previous attempts at agents.max_context_bytes]`;
    bodies.set('PREVIOUS ATTEMPTS', [note, ...attempts.map((line) => `- ${line}`)].join('\n'));
    truncations.push(note);
  } else {
    bodies.set('PREVIOUS ATTEMPTS', attempts.map((line) => `- ${line}`).join('\n'));
  }

  bodies.set('KNOWN BASELINE EXCEPTIONS', pkg.baselineExceptions.map((line) => `- ${line}`).join('\n'));
  bodies.set(
    'GUARDRAILS AND FORBIDDEN ACTIONS',
    [...FORBIDDEN_ACTIONS, ...pkg.guardrails].map((line) => `- ${line}`).join('\n'),
  );
  bodies.set('ANGULAR GUIDANCE', pkg.angularGuidance);
  bodies.set('BUDGET', pkg.budget);
  bodies.set('OUTPUT CONTRACT', pkg.outputContract);

  const sections = SECTION_ORDER.map((name) => section(name, bodies.get(name) ?? ''));
  const text = [`# TASK: ${pkg.role}`, '', ROLE_TEMPLATES[pkg.role].text, '', ...sections].join('\n\n');
  return { text, truncations };
}

/**
 * Spec §18.2: the thirteen sections in one order, preceded by the role's task instruction and nothing else — in
 * particular no previous agent's reasoning, only the one-paragraph summaries in PREVIOUS ATTEMPTS.
 *
 * When the assembled prompt exceeds `agents.max_context_bytes`, reductions are applied in this fixed order,
 * re-measuring after each and stopping as soon as it fits: inline diff to zero, previous attempts to the most
 * recent three, then to one, verification evidence to its last 4096 bytes, change summary to its first 200 files.
 * GOAL, REPOSITORY, APPROVED PLAN SLICE, GUARDRAILS AND FORBIDDEN ACTIONS, ANGULAR GUIDANCE, BUDGET and OUTPUT
 * CONTRACT are never reduced: a prompt missing its guardrails is worse than a run that fails loudly.
 */
export function renderContextPackage(pkg: ContextPackage, limits: RenderLimits): RenderedPrompt {
  const stages: Reduction[] = [
    { inlineDiffBytes: limits.maxInlineDiffBytes, previousAttempts: UNBOUNDED, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: UNBOUNDED, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 3, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: UNBOUNDED, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: 4096, changeSummaryEntries: UNBOUNDED },
    { inlineDiffBytes: 0, previousAttempts: 1, evidenceBytes: 4096, changeSummaryEntries: 200 },
  ];
  let bytes = 0;
  for (const stage of stages) {
    const assembled = assemble(pkg, stage);
    bytes = Buffer.byteLength(assembled.text, 'utf8');
    if (bytes <= limits.maxContextBytes) {
      return { text: assembled.text, version: promptVersionFor(pkg.role), bytes, truncations: assembled.truncations };
    }
  }
  throw new ContextTooLargeError(bytes, limits.maxContextBytes);
}
```

- [ ] **Step 5: Run the render test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/render.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Run the unit lane, lint, and typecheck**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/agents/context.ts src/agents/render.ts tests/agents/render.test.ts
git commit -m "feat(agents): render the spec context package with byte budgets and truncation markers" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 8: Sandbox plan, `buildAgentTask`, and the unsandboxed record

**Files:**
- Create: `src/agents/sandbox.ts`, `src/agents/task.ts`
- Modify: `src/state/files.ts` (add `REPORTS_DIR`, `AGENTS_EVIDENCE_DIR`)
- Modify: `src/render/handover.ts:5` (options parameter and the warning block)
- Modify: `src/state/checkpoint.ts:19-28, 44` (pass the flag through)
- Modify: `src/engine/engine.ts:41-49`, `src/workspace/create-workspace.ts:84-98` (supply the flag)
- Test: `tests/agents/sandbox.test.ts`, `tests/agents/task.test.ts`, `tests/render/handover.test.ts`

**Interfaces:**
- Consumes: `WorkspacePaths`; `JanusConfig`; `sandboxClassFor`, `isCodeWriting`; `resolveModel`; `outputSchemaFor`; `buildContextPackage`; `promptVersionFor`.
- Produces:
  - `const REPORTS_DIR = 'reports'`, `const AGENTS_EVIDENCE_DIR = 'evidence/agents'`
  - `class SandboxPlanError extends Error`
  - `interface SandboxPlan { sandbox; network; cwd; writableRoots; env; envKeys }`
  - `planSandbox(input: PlanSandboxInput): SandboxPlan`
  - `unsandboxedNote(config: JanusConfig): string | null`
  - `resolveGlobalPnpmStore(): Promise<string>`
  - `buildAgentTask(input: BuildAgentTaskInput): AgentTask`
  - `renderHandover(state, goal, now, options?: { allowUnsandboxed: boolean })`

- [ ] **Step 1: Write the failing sandbox test**

Create `tests/agents/sandbox.test.ts`:

```ts
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { planSandbox, SandboxPlanError, unsandboxedNote } from '../../src/agents/sandbox.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

const base = { workflow: { ci_provider: 'fake', scm_provider: 'fake' } };
const config = (overrides: Record<string, unknown> = {}) => configSchema.parse({ ...base, ...overrides });
const paths = () => workspacePaths(tempDir('janus-sandbox-'));

describe('planSandbox', () => {
  it('gives a code-writing role a writable repo, network on, and the workspace pnpm store (§3.3, §18.4)', () => {
    const p = paths();
    const plan = planSandbox({ role: 'implementation', runId: 'run-0001', repo: 'ui-kit', paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('workspace-write');
    expect(plan.network).toBe(true);
    expect(plan.cwd).toBe(p.repoDir('ui-kit'));
    expect(plan.writableRoots).toEqual([p.repoDir('ui-kit'), p.pnpmStoreDir]);
    expect(plan.env).toEqual({ npm_config_store_dir: p.pnpmStoreDir });
    expect(plan.envKeys).toEqual(['npm_config_store_dir']);
  });

  it('adds the global store and the user cache as writable roots when agents.pnpm_store is global', () => {
    const p = paths();
    const plan = planSandbox({
      role: 'debug',
      runId: 'run-0002',
      repo: 'shell',
      paths: p,
      config: config({ agents: { pnpm_store: 'global' } }),
      globalPnpmStore: '/home/dev/.local/share/pnpm/store/v3',
    });
    expect(plan.writableRoots).toEqual([p.repoDir('shell'), '/home/dev/.local/share/pnpm/store/v3', join(homedir(), '.cache')]);
    expect(plan.env).toEqual({});
  });

  it('refuses the global store when nobody resolved `pnpm store path`', () => {
    expect(() =>
      planSandbox({ role: 'fix', runId: 'r', repo: 'ui-kit', paths: paths(), config: config({ agents: { pnpm_store: 'global' } }), globalPnpmStore: null }),
    ).toThrow(SandboxPlanError);
  });

  it('gives a report-writing role its own report directory, network off, and creates it', () => {
    const p = paths();
    const plan = planSandbox({ role: 'discovery', runId: 'run-0003', repo: null, paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('workspace-write');
    expect(plan.network).toBe(false);
    expect(plan.cwd).toBe(join(p.janusDir, 'reports', 'run-0003'));
    expect(plan.writableRoots).toEqual([plan.cwd]);
    expect(existsSync(plan.cwd)).toBe(true);
  });

  it('gives a read-only role the workspace root and no writable root', () => {
    const p = paths();
    const plan = planSandbox({ role: 'review', runId: 'run-0004', repo: null, paths: p, config: config(), globalPnpmStore: null });
    expect(plan.sandbox).toBe('read-only');
    expect(plan.network).toBe(false);
    expect(plan.cwd).toBe(p.root);
    expect(plan.writableRoots).toEqual([]);
  });

  it('requires a repo for a code-writing role', () => {
    expect(() =>
      planSandbox({ role: 'implementation', runId: 'r', repo: null, paths: paths(), config: config(), globalPnpmStore: null }),
    ).toThrow('code-writing role "implementation" needs a repo');
  });

  it('overrides every class with danger-full-access when agents.allow_unsandboxed is true (§18.4)', () => {
    const p = paths();
    const unsandboxed = config({ agents: { allow_unsandboxed: true } });
    const plan = planSandbox({ role: 'review', runId: 'r', repo: null, paths: p, config: unsandboxed, globalPnpmStore: null });
    expect(plan.sandbox).toBe('danger-full-access');
    expect(plan.writableRoots).toEqual([]);
    expect(unsandboxedNote(unsandboxed)).toContain('danger-full-access');
    expect(unsandboxedNote(config())).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/sandbox.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/sandbox.js"`.

- [ ] **Step 3: Add the two directory names**

In `src/state/files.ts`, after `EVIDENCE_DIR`:

```ts
/** Spec §5: `reports/<run-id>/` — raw agent-written reports before the orchestrator files them. */
export const REPORTS_DIR = 'reports';
/** Spec §5: `evidence/agents/<run-id>.yaml` — validated result, token usage, duration. */
export const AGENTS_EVIDENCE_DIR = 'evidence/agents';
```

- [ ] **Step 4: Implement the sandbox plan**

Create `src/agents/sandbox.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRole, JanusConfig } from '../config/config-schema.js';
import { REPORTS_DIR } from '../state/files.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { sandboxClassFor } from './roles.js';

const execFileAsync = promisify(execFile);

export class SandboxPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPlanError';
  }
}

export interface SandboxPlan {
  /** The `-s` value §18.4 passes to `codex exec`. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** `-c sandbox_workspace_write.network_access=<bool>`; only meaningful for `workspace-write`. */
  network: boolean;
  cwd: string;
  /** Absolute paths passed as `--add-dir`. */
  writableRoots: string[];
  /** Environment additions for the child. Never holds a secret; §32 rule 12. */
  env: Record<string, string>;
  /** The keys of `env`, for the evidence file. Values are never recorded. */
  envKeys: string[];
}

export interface PlanSandboxInput {
  role: AgentRole;
  runId: string;
  repo: string | null;
  paths: WorkspacePaths;
  config: JanusConfig;
  /** The output of `pnpm store path`, required only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
}

/**
 * Spec §3.3's class table plus §18.4's writable roots.
 *
 * With `agents.pnpm_store: workspace` (the default) every code-writing agent gets
 * `npm_config_store_dir=<workspace>/.pnpm-store`, so the store is inside the workspace and one extra writable root
 * suffices. §18.4: "No `.npmrc` is written, because pnpm reads `.npmrc` only from a project root." With `global`,
 * the resolved store path and `~/.cache` become writable roots instead.
 */
export function planSandbox(input: PlanSandboxInput): SandboxPlan {
  const unsandboxed = input.config.agents.allow_unsandboxed;
  const cls = sandboxClassFor(input.role);

  if (cls === 'read-only') {
    return {
      sandbox: unsandboxed ? 'danger-full-access' : 'read-only',
      network: false,
      cwd: input.paths.root,
      writableRoots: [],
      env: {},
      envKeys: [],
    };
  }

  if (cls === 'report-writing') {
    const dir = join(input.paths.janusDir, REPORTS_DIR, input.runId);
    mkdirSync(dir, { recursive: true });
    return {
      sandbox: unsandboxed ? 'danger-full-access' : 'workspace-write',
      network: false,
      cwd: dir,
      writableRoots: unsandboxed ? [] : [dir],
      env: {},
      envKeys: [],
    };
  }

  if (input.repo === null) {
    throw new SandboxPlanError(`code-writing role "${input.role}" needs a repo; none was assigned to run ${input.runId}`);
  }
  const repoDir = input.paths.repoDir(input.repo);
  if (unsandboxed) {
    return { sandbox: 'danger-full-access', network: true, cwd: repoDir, writableRoots: [], env: {}, envKeys: [] };
  }
  if (input.config.agents.pnpm_store === 'global') {
    if (input.globalPnpmStore === null) {
      throw new SandboxPlanError(
        'agents.pnpm_store is "global" but the store path was not resolved; run `pnpm store path` and pass it, ' +
          'or set agents.pnpm_store: workspace. `janus doctor` checks that the store is writable.',
      );
    }
    return {
      sandbox: 'workspace-write',
      network: true,
      cwd: repoDir,
      writableRoots: [repoDir, input.globalPnpmStore, join(homedir(), '.cache')],
      env: {},
      envKeys: [],
    };
  }
  return {
    sandbox: 'workspace-write',
    network: true,
    cwd: repoDir,
    writableRoots: [repoDir, input.paths.pnpmStoreDir],
    env: { npm_config_store_dir: input.paths.pnpmStoreDir },
    envKeys: ['npm_config_store_dir'],
  };
}

/**
 * Spec §18.4: running with `danger-full-access` "is possible only with `agents.allow_unsandboxed: true` and is
 * recorded in every checkpoint". `handover.md` is regenerated at every checkpoint (§7), so the note lands there;
 * `src/render/handover.ts` renders this constant.
 */
export const UNSANDBOXED_NOTE =
  'Agents in this workspace run with `danger-full-access`: `agents.allow_unsandboxed` is true in config.yaml, so ' +
  'the Codex sandbox is off. The reflog audit is the only remaining guard against an agent git write (spec §18.4, §31).';

export function unsandboxedNote(config: JanusConfig): string | null {
  return config.agents.allow_unsandboxed ? UNSANDBOXED_NOTE : null;
}

/** `pnpm store path`, for `agents.pnpm_store: global`. Called by the CLI and by `janus doctor` (T07), never per run. */
export async function resolveGlobalPnpmStore(): Promise<string> {
  const { stdout } = await execFileAsync('pnpm', ['store', 'path'], { env: { ...process.env, LC_ALL: 'C' } });
  const path = stdout.trim();
  if (path === '') throw new SandboxPlanError('`pnpm store path` returned nothing; is pnpm on PATH?');
  return path;
}
```

- [ ] **Step 5: Run the sandbox test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/sandbox.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Write the failing handover test**

Append to `tests/render/handover.test.ts`, inside its `describe('renderHandover', ...)`:

```ts
  it('records that agents run unsandboxed, because §18.4 wants it in every checkpoint', () => {
    const text = renderHandover(current, goal, now, { allowUnsandboxed: true });
    expect(text).toContain('danger-full-access');
    expect(renderHandover(current, goal, now)).not.toContain('danger-full-access');
  });
```

(`current`, `goal` and `now` are the values the existing tests in this file already build.)

- [ ] **Step 7: Add the note to the handover and thread the flag through the checkpoint**

In `src/render/handover.ts`, add the import and the options parameter:

```ts
import { UNSANDBOXED_NOTE } from '../agents/sandbox.js';
```

```ts
export interface RenderHandoverOptions {
  /** `agents.allow_unsandboxed`; §18.4 requires it recorded in every checkpoint. */
  allowUnsandboxed: boolean;
}

/** The human-readable handover regenerated at every checkpoint (spec §5, §7). state.yaml stays authoritative. */
export function renderHandover(
  state: JanusState,
  goal: Goal,
  now: Date,
  options: RenderHandoverOptions = { allowUnsandboxed: false },
): string {
```

and, immediately before the final `lines.push('', '## Next action', ...)`:

```ts
  if (options.allowUnsandboxed) {
    lines.push('', '## Sandbox', '', `> ${UNSANDBOXED_NOTE}`);
  }
```

In `src/state/checkpoint.ts`, add the optional input and pass it:

```ts
export interface CheckpointInput {
  janusDir: string;
  state: JanusState;
  goal: Goal;
  message: string;
  push: boolean;
  decision?: DecisionEntry;
  now?: Date;
  /** `agents.allow_unsandboxed`; recorded in the handover this checkpoint writes (spec §18.4). */
  allowUnsandboxed?: boolean;
}
```

```ts
  writeFileSync(
    join(input.janusDir, HANDOVER_FILE),
    renderHandover(input.state, input.goal, now, { allowUnsandboxed: input.allowUnsandboxed ?? false }),
  );
```

In `src/engine/engine.ts`, inside the `checkpoint:` property passed to `checkpoint({ ... })`, add:

```ts
        allowUnsandboxed: input.workspace.config.agents.allow_unsandboxed,
```

In `src/workspace/create-workspace.ts`, add the same to the `checkpoint({ ... })` call:

```ts
      allowUnsandboxed: input.config.agents.allow_unsandboxed,
```

- [ ] **Step 8: Run the handover, checkpoint, and engine tests**

Run: `pnpm exec vitest run --project unit tests/render tests/state tests/engine`
Expected: PASS.

- [ ] **Step 9: Write the failing `buildAgentTask` test**

Create `tests/agents/task.test.ts`:

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { buildAgentTask } from '../../src/agents/task.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { contextPackageInputFixture } from '../helpers/agent-fixtures.js';

const config = configSchema.parse({
  workflow: { ci_provider: 'fake', scm_provider: 'fake' },
  experiment: { id: 'exp-ladder-1' },
  model_profiles: {
    default: {
      '*': { model: 'gpt-5.6-sol', effort: 'high' },
      debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-mini', 'gpt-5.6-sol:xhigh'] },
    },
  },
});

const build = (overrides: Record<string, unknown> = {}) =>
  buildAgentTask({
    runId: 'run-0007',
    role: 'implementation',
    repo: 'ui-kit',
    attempt: 1,
    paths: workspacePaths(tempDir('janus-task-')),
    config,
    profile: 'default',
    globalPnpmStore: null,
    context: contextPackageInputFixture(),
    guardrails: ['files outside src/ are out of scope'],
    budget: 'ci_fix_attempts: 1 of 5',
    ...overrides,
  });

describe('buildAgentTask', () => {
  it('fills the §18.1 contract from the role, the config, and the workspace', () => {
    const task = build();
    expect(task.runId).toBe('run-0007');
    expect(task.sandboxClass).toBe('code-writing');
    expect(task.sandbox).toBe('workspace-write');
    expect(task.network).toBe(true);
    expect(task.timeoutMinutes).toBe(60);
    expect(task.model).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null });
    expect(task.profile).toBe('default');
    expect(task.experimentId).toBe('exp-ladder-1');
    expect(task.promptVersion).toMatch(/^implementation@\d+$/);
    expect(task.outputSchema['title']).toBe('janus-implementation-result');
    expect(task.env['npm_config_store_dir']).toBe(join(task.cwd, '..', '..', '.pnpm-store').replace('/repos/ui-kit/../..', ''));
  });

  it('always supplies the four fixed context blocks, whatever the caller passed', () => {
    const task = build();
    expect(task.context.guardrails).toEqual(['files outside src/ are out of scope']);
    expect(task.context.angularGuidance).toContain('--allow-dirty');
    expect(task.context.outputContract).toContain('predicted_failures');
    expect(task.context.budget).toBe('ci_fix_attempts: 1 of 5');
    expect(task.context.role).toBe('implementation');
  });

  it('walks the ladder with the attempt number', () => {
    expect(build({ role: 'debug', attempt: 1 }).model).toEqual({ model: 'gpt-5.6-mini', effort: 'high', ladderIndex: 0, ladderLength: 2 });
    expect(build({ role: 'debug', attempt: 2 }).model).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
  });

  it('caps a role timeout at guardrails.max_agent_runtime_minutes', () => {
    const capped = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_agent_runtime_minutes: 20 },
      agents: { roles: { implementation: { timeout_minutes: 20 } } },
    });
    expect(build({ config: capped }).timeoutMinutes).toBe(20);
  });
});
```

The `npm_config_store_dir` assertion above is awkward; replace that one line with the direct comparison, which is what the implementation guarantees:

```ts
    const paths = workspacePaths(tempDir('janus-task-'));
    const task = buildAgentTask({ /* ...as `build`, but with this `paths` */ });
    expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/task.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/task.js"`.

- [ ] **Step 11: Implement `buildAgentTask`**

Create `src/agents/task.ts`:

```ts
import type { AgentRole, JanusConfig } from '../config/config-schema.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { buildContextPackage } from './context.js';
import type { ContextPackageInput } from './context.js';
import { resolveModel } from './models.js';
import { outputSchemaFor } from './output-schema.js';
import { promptVersionFor } from './prompts/templates.js';
import { sandboxClassFor } from './roles.js';
import { planSandbox } from './sandbox.js';
import type { AgentTask } from './types.js';

export interface BuildAgentTaskInput {
  runId: string;
  role: AgentRole;
  repo: string | null;
  /** 1-based attempt within the current failure; drives the §18.6 ladder. */
  attempt: number;
  paths: WorkspacePaths;
  config: JanusConfig;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  /** `pnpm store path`, needed only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
  /** The variable §18.2 sections. */
  context: ContextPackageInput;
  /** Repo-specific guardrails on top of §19's fixed list. */
  guardrails: string[];
  /** §18.2 BUDGET. */
  budget: string;
}

/**
 * Assembles one §18.1 `AgentTask`. This is the seam T11 and T12 call: a stage step decides *what* the agent
 * should see, this decides *how* the run is shaped — class, sandbox, roots, timeout, model, schema, prompt version.
 *
 * §20: "`max_agent_runtime_minutes` is the ceiling; per-role `timeout_minutes` may only be lower." The config
 * schema already rejects a role timeout above the ceiling, so the `Math.min` here is belt and braces for a config
 * that was hand-edited between load and use.
 */
export function buildAgentTask(input: BuildAgentTaskInput): AgentTask {
  const plan = planSandbox({
    role: input.role,
    runId: input.runId,
    repo: input.repo,
    paths: input.paths,
    config: input.config,
    globalPnpmStore: input.globalPnpmStore,
  });
  const timeoutMinutes = Math.min(
    input.config.agents.roles[input.role].timeout_minutes,
    input.config.guardrails.max_agent_runtime_minutes,
  );
  return {
    runId: input.runId,
    role: input.role,
    sandboxClass: sandboxClassFor(input.role),
    repo: input.repo,
    cwd: plan.cwd,
    writableRoots: plan.writableRoots,
    network: plan.network,
    timeoutMinutes,
    context: buildContextPackage({
      role: input.role,
      context: input.context,
      guardrails: input.guardrails,
      budget: input.budget,
    }),
    outputSchema: outputSchemaFor(input.role),
    model: resolveModel({ config: input.config, profile: input.profile, role: input.role, attempt: input.attempt }),
    attempt: input.attempt,
    promptVersion: promptVersionFor(input.role),
    profile: input.profile,
    experimentId: input.config.experiment.id,
    sandbox: plan.sandbox,
    env: plan.env,
  };
}
```

- [ ] **Step 12: Run the task test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/task.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 13: Run the whole suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 14: Commit**

```bash
git add src/agents/sandbox.ts src/agents/task.ts src/state/files.ts src/state/checkpoint.ts src/render/handover.ts src/engine/engine.ts src/workspace/create-workspace.ts tests/agents/sandbox.test.ts tests/agents/task.test.ts tests/render/handover.test.ts
git commit -m "feat(agents): plan sandboxes per role class and assemble the spec agent task" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 9: The evidence file and the `runAgent` wrapper

**Files:**
- Create: `src/agents/evidence.ts`, `src/agents/run.ts`
- Modify: `src/agents/types.ts` (two fields on `AgentOutcome`)
- Modify: `src/providers/fake/agent-runner.ts`, `tests/helpers/agent-fixtures.ts` (the two new fields)
- Test: `tests/agents/evidence.test.ts`, `tests/agents/run.test.ts`

**Interfaces:**
- Consumes: `Engine` (`emit`, `now`, `markInFlight`, `workspace.paths`); `AgentRunner`; `AgentTask`, `AgentOutcome`, `ResolvedModel`; `isModelSwitch`; `AGENTS_EVIDENCE_DIR`.
- Produces:
  - `AgentOutcome.promptBytes: number | null` and `AgentOutcome.truncations: string[]`
  - `interface AgentEvidence` — the on-disk shape of `evidence/agents/<run-id>.yaml`
  - `agentEvidencePath(janusDir: string, runId: string): string`
  - `buildAgentEvidence(input: BuildAgentEvidenceInput): AgentEvidence`
  - `writeAgentEvidence(paths: WorkspacePaths, evidence: AgentEvidence): string` (returns the `.janus`-relative path)
  - `interface AgentRunRecord { outcome: AgentOutcome; evidencePath: string }`
  - `runAgent(input: RunAgentInput): Promise<AgentRunRecord>`

**Why a wrapper rather than doing it in each runner:** §18.4 makes the adapter responsible for the evidence file and §27 wants three events per run. If each runner did that, the fake and the real adapter would produce different evidence and the harness would prove nothing about the real one. One wrapper, two thin runners.

- [ ] **Step 1: Add the two prompt fields to `AgentOutcome`**

In `src/agents/types.ts`, add to `AgentOutcome` after `runnerVersion`:

```ts
  /** Bytes of the rendered prompt, for the evidence file and §18.6 comparisons. Null when no prompt was rendered. */
  promptBytes: number | null;
  /** Reductions the §18.2 renderer applied, one line each. Empty when nothing was truncated. */
  truncations: string[];
```

In `src/providers/fake/agent-runner.ts`, add `promptBytes: null, truncations: [],` to the returned outcome. In `tests/helpers/agent-fixtures.ts`, add the same two lines to `stubOutcome`'s literal (before the `...overrides` spread).

- [ ] **Step 2: Write the failing evidence test**

Create `tests/agents/evidence.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { agentEvidencePath, buildAgentEvidence, writeAgentEvidence } from '../../src/agents/evidence.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture, resultFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const TOKEN = 'bbt-super-secret-token-value';

function evidenceFor(paths = workspacePaths(tempDir('janus-evidence-'))) {
  const task = agentTaskFixture({
    runId: 'run-0042',
    role: 'implementation',
    repo: 'ui-kit',
    cwd: paths.repoDir('ui-kit'),
    writableRoots: [paths.repoDir('ui-kit'), paths.pnpmStoreDir],
    env: { npm_config_store_dir: paths.pnpmStoreDir },
    model: { model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 },
    attempt: 2,
    experimentId: 'exp-ladder-1',
  });
  const evidence = buildAgentEvidence({
    task,
    paths,
    runner: 'codex',
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: '2026-09-20T10:04:12.000Z',
    outcome: {
      runId: 'run-0042',
      status: 'completed',
      summary: 'raised @angular/core to 16.2.12',
      result: resultFixture(),
      failure: null,
      tokens: { input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 },
      durationMs: 252_000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      runnerVersion: 'codex-cli 0.48.0',
      promptBytes: 91_204,
      truncations: ['... [janus truncated the inline diff: 12 of 72012 bytes omitted at agents.max_inline_diff_bytes] ...'],
    },
  });
  return { paths, task, evidence };
}

describe('agent evidence', () => {
  it('writes evidence/agents/<run-id>.yaml with every §18.6 dimension stamped', () => {
    const { paths, evidence } = evidenceFor();
    const relative = writeAgentEvidence(paths, evidence);
    expect(relative).toBe(join('evidence', 'agents', 'run-0042.yaml'));
    expect(agentEvidencePath(paths.janusDir, 'run-0042')).toBe(join(paths.janusDir, 'evidence', 'agents', 'run-0042.yaml'));

    const written = parse(readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8')) as Record<string, unknown>;
    expect(written['run_id']).toBe('run-0042');
    expect(written['role']).toBe('implementation');
    expect(written['class']).toBe('code-writing');
    expect(written['attempt']).toBe(2);
    expect(written['model']).toBe('gpt-5.6-sol');
    expect(written['effort']).toBe('xhigh');
    expect(written['ladder_index']).toBe(1);
    expect(written['profile']).toBe('default');
    expect(written['experiment_id']).toBe('exp-ladder-1');
    expect(written['prompt_version']).toMatch(/^implementation@\d+$/);
    expect(written['runner_version']).toBe('codex-cli 0.48.0');
    expect(written['duration_ms']).toBe(252_000);
    expect(written['exit_code']).toBe(0);
    expect(written['timed_out']).toBe(false);
    expect(written['tokens']).toEqual({ input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 });
    expect((written['result'] as Record<string, unknown>)['summary']).toBe('raised @angular/core to 16.2.12');
  });

  it('records paths relative to the workspace, so no home directory leaks into the state branch', () => {
    const { paths, evidence } = evidenceFor();
    writeAgentEvidence(paths, evidence);
    const text = readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8');
    expect(text).not.toContain(paths.root);
    expect(evidence.cwd).toBe(join('repos', 'ui-kit'));
    expect(evidence.writable_roots).toEqual([join('repos', 'ui-kit'), '.pnpm-store']);
  });

  it('records environment variable names only, and never a token or an env dump (§32 rule 12)', () => {
    process.env['JANUS_TEAMCITY_TOKEN'] = TOKEN;
    try {
      const { paths, evidence } = evidenceFor();
      writeAgentEvidence(paths, evidence);
      const text = readFileSync(agentEvidencePath(paths.janusDir, 'run-0042'), 'utf8');
      expect(evidence.env_keys).toEqual(['npm_config_store_dir']);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('JANUS_TEAMCITY_TOKEN');
      expect(text).not.toContain('PATH');
    } finally {
      delete process.env['JANUS_TEAMCITY_TOKEN'];
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/evidence.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/evidence.js"`.

- [ ] **Step 4: Implement the evidence writer**

Create `src/agents/evidence.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import type { AgentRole } from '../config/config-schema.js';
import { AGENTS_EVIDENCE_DIR } from '../state/files.js';
import type { AgentTokenUsage } from '../telemetry/events.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import type { AgentResult } from './output-schema.js';
import type { SandboxClass } from './roles.js';
import type { AgentOutcome, AgentRunFailure, AgentTask } from './types.js';

/**
 * Spec §5: `evidence/agents/<run-id>.yaml` — "validated result, token usage, duration". §18.6 adds the experiment
 * id, active profile, resolved model, effort, Codex version, and prompt template version.
 *
 * §32 rule 12: no secret ever reaches this file. Paths are workspace-relative so a home directory never lands on
 * the state branch, and the environment is recorded as **key names only** — the values, and `process.env` itself,
 * are never read here.
 */
export interface AgentEvidence {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  class: SandboxClass;
  attempt: number;
  status: AgentResult['status'];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  runner: 'codex' | 'fake';
  runner_version: string | null;
  model: string;
  effort: string;
  ladder_index: number | null;
  ladder_length: number | null;
  profile: string;
  experiment_id: string | null;
  prompt_version: string;
  prompt_bytes: number | null;
  truncations: string[];
  sandbox: AgentTask['sandbox'];
  network: boolean;
  timeout_minutes: number;
  /** Workspace-relative. */
  cwd: string;
  /** Workspace-relative. */
  writable_roots: string[];
  /** Names only. */
  env_keys: string[];
  tokens: AgentTokenUsage | null;
  failure: AgentRunFailure | null;
  result: AgentResult | null;
}

export interface BuildAgentEvidenceInput {
  task: AgentTask;
  paths: WorkspacePaths;
  runner: 'codex' | 'fake';
  startedAt: string;
  finishedAt: string;
  outcome: AgentOutcome;
}

export function buildAgentEvidence(input: BuildAgentEvidenceInput): AgentEvidence {
  const { task, outcome } = input;
  const rel = (path: string): string => relative(input.paths.root, path);
  return {
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    class: task.sandboxClass,
    attempt: task.attempt,
    status: outcome.status,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    duration_ms: outcome.durationMs,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    timed_out: outcome.timedOut,
    runner: input.runner,
    runner_version: outcome.runnerVersion,
    model: task.model.model,
    effort: task.model.effort,
    ladder_index: task.model.ladderIndex,
    ladder_length: task.model.ladderLength,
    profile: task.profile,
    experiment_id: task.experimentId,
    prompt_version: task.promptVersion,
    prompt_bytes: outcome.promptBytes,
    truncations: outcome.truncations,
    sandbox: task.sandbox,
    network: task.network,
    timeout_minutes: task.timeoutMinutes,
    cwd: rel(task.cwd),
    writable_roots: task.writableRoots.map(rel),
    env_keys: Object.keys(task.env),
    tokens: outcome.tokens,
    failure: outcome.failure,
    result: outcome.result,
  };
}

export function agentEvidencePath(janusDir: string, runId: string): string {
  return join(janusDir, AGENTS_EVIDENCE_DIR, `${runId}.yaml`);
}

/** Writes the file and returns its `.janus`-relative path, which is what state and telemetry reference. */
export function writeAgentEvidence(paths: WorkspacePaths, evidence: AgentEvidence): string {
  const path = agentEvidencePath(paths.janusDir, evidence.run_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(evidence));
  return relative(paths.janusDir, path);
}
```

- [ ] **Step 5: Run the evidence test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/evidence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the failing `runAgent` test**

Create `tests/agents/run.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agents/run.js';
import { readEvents } from '../../src/telemetry/events.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { agentTaskFixture, stubOutcome } from '../helpers/agent-fixtures.js';

const clock = () => new Date('2026-09-20T11:00:00.000Z');

function runner(name: 'fake' | 'codex' = 'fake'): AgentRunner {
  return { name, run: async (task) => stubOutcome(task, { promptBytes: 4096, durationMs: 1234 }) };
}

describe('runAgent', () => {
  it('emits agent.started and agent.finished with the §27 dimensions and writes the evidence file', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const task = agentTaskFixture({ runId: 'run-0100', role: 'implementation', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      const record = await runAgent({ engine, runner: runner(), task, previousModel: null });

      expect(record.evidencePath).toBe(join('evidence', 'agents', 'run-0100.yaml'));
      expect(readFileSync(join(ws.janusDir, record.evidencePath), 'utf8')).toContain('run_id: run-0100');

      const events = readEvents(ws.janusDir);
      const started = events.find((event) => event['type'] === 'agent.started');
      const finished = events.find((event) => event['type'] === 'agent.finished');
      expect(started).toMatchObject({
        run_id: 'run-0100',
        role: 'implementation',
        repo: 'ui-kit',
        model: 'gpt-5.6-sol',
        effort: 'high',
        profile: 'default',
        attempt: 1,
        sandbox: 'workspace-write',
      });
      expect(started?.['prompt_version']).toMatch(/^implementation@\d+$/);
      expect(finished).toMatchObject({ run_id: 'run-0100', status: 'completed', duration_ms: 1234, failure: null });
      expect(events.indexOf(started as never)).toBeLessThan(events.indexOf(finished as never));
    } finally {
      workspace.release();
    }
  });

  it('records the run in execution.in_flight while it runs and clears it afterwards (§7 rule 3)', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const seen: (string | null)[] = [];
      const watching: AgentRunner = {
        name: 'fake',
        run: async (task) => {
          seen.push(workspace.state.execution.in_flight.agent_run_id);
          return stubOutcome(task);
        },
      };
      const task = agentTaskFixture({ runId: 'run-0101', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      await runAgent({ engine, runner: watching, task, previousModel: null });
      expect(seen).toEqual(['run-0101']);
      expect(workspace.state.execution.in_flight.agent_run_id).toBeNull();
      expect(workspace.state.execution.in_flight.repo).toBeNull();
    } finally {
      workspace.release();
    }
  });

  it('leaves in_flight set when the runner throws, so resume can recover it', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const exploding: AgentRunner = {
        name: 'fake',
        run: async () => {
          throw new Error('the runner died');
        },
      };
      const task = agentTaskFixture({ runId: 'run-0102', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      await expect(runAgent({ engine, runner: exploding, task, previousModel: null })).rejects.toThrow('the runner died');
      expect(workspace.state.execution.in_flight.agent_run_id).toBe('run-0102');
    } finally {
      workspace.release();
    }
  });

  it('emits agent.model_switch before agent.started when the ladder moved, and adds no budget (§18.6)', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const before = { ...workspace.state.execution.budgets };
      const task = agentTaskFixture({
        runId: 'run-0103',
        role: 'debug',
        repo: 'ui-kit',
        cwd: workspace.paths.repoDir('ui-kit'),
        attempt: 2,
        model: { model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 },
      });
      await runAgent({
        engine,
        runner: runner(),
        task,
        previousModel: { model: 'gpt-5.6-mini', effort: 'medium', ladderIndex: 0, ladderLength: 2 },
      });
      const types = readEvents(ws.janusDir).map((event) => event['type']);
      expect(types.indexOf('agent.model_switch')).toBeLessThan(types.indexOf('agent.started'));
      const change = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.model_switch');
      expect(change).toMatchObject({
        from_model: 'gpt-5.6-mini',
        from_effort: 'medium',
        to_model: 'gpt-5.6-sol',
        to_effort: 'xhigh',
        ladder_index: 1,
        budget_added: false,
      });
      expect(workspace.state.execution.budgets).toEqual(before);
    } finally {
      workspace.release();
    }
  });

  it('reports a failure kind on agent.finished and still writes evidence', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const failing: AgentRunner = {
        name: 'codex',
        run: async (task) =>
          stubOutcome(task, {
            status: 'failed',
            result: null,
            failure: { kind: 'timeout', detail: 'killed after 60 minutes' },
            timedOut: true,
            exitCode: null,
            signal: 'SIGKILL',
          }),
      };
      const task = agentTaskFixture({ runId: 'run-0104', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      const record = await runAgent({ engine, runner: failing, task, previousModel: null });
      expect(record.outcome.status).toBe('failed');
      const finished = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.finished');
      expect(finished).toMatchObject({ status: 'failed', failure: 'timeout' });
      expect(readFileSync(join(ws.janusDir, record.evidencePath), 'utf8')).toContain('kind: timeout');
    } finally {
      workspace.release();
    }
  });
});
```

`testEngine(workspace, clock)` is the helper `tests/engine/engine.test.ts` already uses from `tests/helpers/engine-fixtures.ts`. If it is not exported from there, export it before writing this test.

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/run.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/run.js"`.

- [ ] **Step 8: Implement `runAgent`**

Create `src/agents/run.ts`:

```ts
import type { Engine } from '../engine/engine.js';
import type { AgentRunner } from '../providers/types.js';
import { buildAgentEvidence, writeAgentEvidence } from './evidence.js';
import { isModelSwitch } from './models.js';
import type { AgentOutcome, AgentTask, ResolvedModel } from './types.js';

export interface RunAgentInput {
  engine: Engine;
  runner: AgentRunner;
  task: AgentTask;
  /** The model the previous attempt at this same failure used, or null for the first attempt (§18.6). */
  previousModel: ResolvedModel | null;
}

export interface AgentRunRecord {
  outcome: AgentOutcome;
  /** `.janus`-relative path of `evidence/agents/<run-id>.yaml`. */
  evidencePath: string;
}

/**
 * Runs one agent task and records it: `agent.model_switch` when the ladder moved, `agent.started`, the run itself,
 * `evidence/agents/<run-id>.yaml`, then `agent.finished` (spec §18.4, §18.6, §27).
 *
 * Every runner goes through here, so the fake and the Codex adapter leave identical evidence and identical events —
 * which is what makes a harness scenario on the fake evidence for the real one.
 *
 * §7 rule 3: `execution.in_flight.agent_run_id` and `.repo` are set before the run and cleared after it. If the
 * runner throws they stay set on purpose, so the next `janus run` recovers the interrupted agent. The caller sets
 * `in_flight.budget` before calling, because §20 decides per stage which counter an interrupted run charges.
 *
 * Budgets are never touched here. §18.6: "Switching models never adds budget."
 */
export async function runAgent(input: RunAgentInput): Promise<AgentRunRecord> {
  const { engine, task } = input;
  const startedAt = engine.now().toISOString();

  if (isModelSwitch(input.previousModel, task.model) && input.previousModel !== null) {
    engine.emit({
      type: 'agent.model_switch',
      run_id: task.runId,
      role: task.role,
      repo: task.repo,
      attempt: task.attempt,
      from_model: input.previousModel.model,
      from_effort: input.previousModel.effort,
      to_model: task.model.model,
      to_effort: task.model.effort,
      ladder_index: task.model.ladderIndex ?? 0,
      profile: task.profile,
      experiment_id: task.experimentId,
      budget_added: false,
    });
  }

  engine.emit({
    type: 'agent.started',
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    model: task.model.model,
    effort: task.model.effort,
    prompt_version: task.promptVersion,
    profile: task.profile,
    experiment_id: task.experimentId,
    attempt: task.attempt,
    sandbox: task.sandbox,
    network: task.network,
  });
  engine.markInFlight({ agent_run_id: task.runId, repo: task.repo });

  const outcome = await input.runner.run(task);
  const finishedAt = engine.now().toISOString();

  const evidencePath = writeAgentEvidence(
    engine.workspace.paths,
    buildAgentEvidence({ task, paths: engine.workspace.paths, runner: input.runner.name, startedAt, finishedAt, outcome }),
  );

  engine.emit({
    type: 'agent.finished',
    run_id: task.runId,
    role: task.role,
    repo: task.repo,
    status: outcome.status,
    model: task.model.model,
    effort: task.model.effort,
    prompt_version: task.promptVersion,
    profile: task.profile,
    experiment_id: task.experimentId,
    tokens: outcome.tokens,
    duration_ms: outcome.durationMs,
    failure: outcome.failure === null ? null : outcome.failure.kind,
    step: null,
    patch: null,
  });
  engine.markInFlight({ agent_run_id: null, repo: null });

  return { outcome, evidencePath };
}
```

- [ ] **Step 9: Run the run test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/run.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Run the whole suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/agents/evidence.ts src/agents/run.ts src/agents/types.ts src/providers/fake/agent-runner.ts tests/agents/evidence.test.ts tests/agents/run.test.ts tests/helpers/agent-fixtures.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(agents): record every agent run as evidence and three telemetry events" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 10: The process-spawn seam, timeout kill, and JSONL usage parsing

**Files:**
- Create: `src/agents/codex/spawn.ts`, `src/agents/codex/jsonl.ts`
- Create: `tests/fixtures/codex/implementation-success.jsonl`, `tests/fixtures/codex/usage-nested.jsonl`, `tests/fixtures/codex/timeout-partial.jsonl`
- Test: `tests/agents/codex-jsonl.test.ts`, `tests/agents/codex-spawn.test.ts`

**Interfaces:**
- Consumes: `AgentTokenUsage` (Task 2).
- Produces:
  - `interface CodexSpawnRequest { bin; args; cwd; env; stdin; timeoutMs }`
  - `interface CodexSpawnResult { exitCode; signal; jsonl; stderr; timedOut; spawnFailed; durationMs }`
  - `type CodexSpawn = (request: CodexSpawnRequest) => Promise<CodexSpawnResult>`
  - `const spawnCodex: CodexSpawn`, `const SIGKILL_GRACE_MS = 5000`
  - `parseCodexUsage(jsonl: string): AgentTokenUsage | null`

**Why the seam:** CI has no `codex` binary. Everything above this line is tested against recorded JSONL; `spawnCodex` itself is tested against `process.execPath`, which every CI runner has, so the timeout kill and the stdin/stdout plumbing are still covered by a real process.

- [ ] **Step 1: Write the recorded JSONL fixtures**

Create `tests/fixtures/codex/implementation-success.jsonl` (one JSON object per line, no trailing blank line):

```text
{"type":"thread.started","thread_id":"01JQ8Z2N4T3M9V0C7B6A5D4E3F"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","item_type":"reasoning"}}
{"type":"item.completed","item":{"id":"item_0","item_type":"reasoning","text":"Reading package.json to find the current Angular version, then running ng update."}}
{"type":"item.started","item":{"id":"item_1","item_type":"command_execution","command":"pnpm ng update @angular/core@16 @angular/cli@16 --allow-dirty"}}
{"type":"item.completed","item":{"id":"item_1","item_type":"command_execution","command":"pnpm ng update @angular/core@16 @angular/cli@16 --allow-dirty","exit_code":0,"aggregated_output":"Using package manager: pnpm\nCollecting installed dependencies...\nUpdating package.json with dependency @angular/core @ \"16.2.12\" (was \"15.2.10\")...\nUPDATE package.json (2184 bytes)\n"}}
{"type":"item.completed","item":{"id":"item_2","item_type":"file_change","changes":[{"path":"package.json","kind":"update"},{"path":"src/app/app.module.ts","kind":"update"}]}}
{"type":"item.started","item":{"id":"item_3","item_type":"command_execution","command":"pnpm test -- --watch=false"}}
{"type":"item.completed","item":{"id":"item_3","item_type":"command_execution","command":"pnpm test -- --watch=false","exit_code":0,"aggregated_output":"TOTAL: 214 SUCCESS\n"}}
{"type":"item.completed","item":{"id":"item_4","item_type":"agent_message","text":"Updated ui-kit to Angular 16.2.12; 214 tests pass."}}
{"type":"turn.completed","usage":{"input_tokens":184320,"cached_input_tokens":172032,"output_tokens":9184,"reasoning_output_tokens":7040,"total_tokens":193504}}
```

Create `tests/fixtures/codex/usage-nested.jsonl`, the other usage shape Codex has emitted:

```text
{"type":"thread.started","thread_id":"01JQ8Z2N4T3M9V0C7B6A5D4E3G"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","item_type":"agent_message","text":"Done."}}
{"type":"turn.completed","usage":{"input_tokens":4096,"cached_input_tokens":0,"output_tokens":512,"output_tokens_details":{"reasoning_tokens":384},"total_tokens":4608}}
```

Create `tests/fixtures/codex/timeout-partial.jsonl`, a stream cut off mid-turn by the timeout kill:

```text
{"type":"thread.started","thread_id":"01JQ8Z2N4T3M9V0C7B6A5D4E3H"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_0","item_type":"command_execution","command":"pnpm install"}}
{"type":"item.completed","item":{"id":"item_0","item_
```

(The last line is deliberately truncated mid-JSON — that is exactly what a killed process leaves behind, and the parser must survive it.)

- [ ] **Step 2: Write the failing JSONL test**

Create `tests/agents/codex-jsonl.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCodexUsage } from '../../src/agents/codex/jsonl.js';

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'codex', name), 'utf8');

describe('parseCodexUsage', () => {
  it('reads turn.completed.usage from a recorded stream (§18.4)', () => {
    expect(parseCodexUsage(fixture('implementation-success.jsonl'))).toEqual({
      input: 184_320,
      cached_input: 172_032,
      output: 9_184,
      reasoning: 7_040,
      total: 193_504,
    });
  });

  it('reads reasoning tokens from the nested output_tokens_details shape', () => {
    expect(parseCodexUsage(fixture('usage-nested.jsonl'))).toEqual({
      input: 4_096,
      cached_input: 0,
      output: 512,
      reasoning: 384,
      total: 4_608,
    });
  });

  it('survives a stream the timeout kill cut mid-line and reports no usage', () => {
    expect(parseCodexUsage(fixture('timeout-partial.jsonl'))).toBeNull();
  });

  it('returns null for an empty stream and takes the last turn.completed when there are several', () => {
    expect(parseCodexUsage('')).toBeNull();
    const two = [
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"total_tokens":2}}',
      '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":0,"output_tokens":9,"total_tokens":18}}',
    ].join('\n');
    expect(parseCodexUsage(two)?.input).toBe(9);
  });

  it('defaults a missing counter to zero and a missing reasoning count to null', () => {
    expect(parseCodexUsage('{"type":"turn.completed","usage":{"input_tokens":5}}')).toEqual({
      input: 5,
      cached_input: 0,
      output: 0,
      reasoning: null,
      total: 0,
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/codex-jsonl.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/codex/jsonl.js"`.

- [ ] **Step 4: Implement the JSONL parser**

Create `src/agents/codex/jsonl.ts`:

```ts
import type { AgentTokenUsage } from '../../telemetry/events.js';

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function reasoningOf(usage: Record<string, unknown>): number | null {
  const flat = usage['reasoning_output_tokens'];
  if (typeof flat === 'number' && Number.isFinite(flat)) return flat;
  const details = usage['output_tokens_details'];
  if (typeof details === 'object' && details !== null) {
    const nested = (details as Record<string, unknown>)['reasoning_tokens'];
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return null;
}

/**
 * Spec §18.4: "The adapter parses `turn.completed.usage`."
 *
 * Only the usage block is read from the stream; the final message comes from the `-o <last-message.json>` file, so
 * a stream the timeout kill cut mid-line costs nothing but the token counts. Unparseable lines are skipped rather
 * than thrown on, and the last `turn.completed` wins. Two reasoning-token spellings are accepted because Codex has
 * emitted both; T06's manual spike (§29 item 4) refreshes these fixtures against the real binary.
 */
export function parseCodexUsage(jsonl: string): AgentTokenUsage | null {
  let usage: AgentTokenUsage | null = null;
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record['type'] !== 'turn.completed') continue;
    const block = record['usage'];
    if (typeof block !== 'object' || block === null) continue;
    const fields = block as Record<string, unknown>;
    usage = {
      input: count(fields['input_tokens']),
      cached_input: count(fields['cached_input_tokens']),
      output: count(fields['output_tokens']),
      reasoning: reasoningOf(fields),
      total: count(fields['total_tokens']),
    };
  }
  return usage;
}
```

- [ ] **Step 5: Run the JSONL test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/codex-jsonl.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Write the failing spawn test**

Create `tests/agents/codex-spawn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { spawnCodex } from '../../src/agents/codex/spawn.js';

const node = process.execPath;

describe('spawnCodex', () => {
  it('feeds the prompt on stdin and returns stdout, stderr, and the exit code', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.stdin.on("data", (d) => { process.stdout.write("got:" + d); process.stderr.write("warn"); });'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: 'the prompt',
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.jsonl).toBe('got:the prompt');
    expect(result.stderr).toBe('warn');
    expect(result.timedOut).toBe(false);
    expect(result.spawnFailed).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('kills a process that outruns its timeout and says so (§18.4 "kills the process at timeout")', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.stdout.write("started\\n"); setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.exitCode).toBeNull();
    expect(result.jsonl).toContain('started');
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await spawnCodex({
      bin: node,
      args: ['-e', 'process.exit(7);'],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it('reports a missing binary as spawnFailed instead of throwing', async () => {
    const result = await spawnCodex({
      bin: 'janus-no-such-binary-9f2c',
      args: [],
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '' },
      stdin: '',
      timeoutMs: 5_000,
    });
    expect(result.spawnFailed).toBe(true);
    expect(result.stderr).toContain('ENOENT');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/codex-spawn.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/codex/spawn.js"`.

- [ ] **Step 8: Implement the spawn seam**

Create `src/agents/codex/spawn.ts`:

```ts
import { spawn } from 'node:child_process';

/** How long a timed-out child gets to exit on SIGTERM before it is SIGKILLed. */
export const SIGKILL_GRACE_MS = 5_000;

export interface CodexSpawnRequest {
  /** The binary to run; `codex` in production, `process.execPath` in the spawn tests. */
  bin: string;
  args: string[];
  cwd: string;
  /** The complete environment for the child. The caller decides what to inherit; nothing is added here. */
  env: Record<string, string>;
  /** The prompt, written to the child's stdin and then closed (§18.4 invokes `codex exec ... - < prompt.md`). */
  stdin: string;
  /** `agents.roles.<role>.timeout_minutes`, in milliseconds. */
  timeoutMs: number;
}

export interface CodexSpawnResult {
  exitCode: number | null;
  signal: string | null;
  /** Everything the child wrote to stdout: the `--json` event stream. */
  jsonl: string;
  stderr: string;
  timedOut: boolean;
  /** True when the binary could not be started at all (for example it is not on PATH). */
  spawnFailed: boolean;
  durationMs: number;
}

/** The seam every adapter test replaces. */
export type CodexSpawn = (request: CodexSpawnRequest) => Promise<CodexSpawnResult>;

/**
 * Runs one child process to completion, never rejecting: a missing binary, a non-zero exit, and a timeout are all
 * outcomes the adapter turns into an `AgentResult`, not exceptions.
 *
 * Spec §18.4: "kills the process at timeout". The kill is SIGTERM first so Codex can tear its sandbox down, then
 * SIGKILL after a grace period. Whatever the child had already written is kept, so the partial JSONL is still
 * available for the usage parser and the evidence file.
 */
export const spawnCodex: CodexSpawn = (request) =>
  new Promise<CodexSpawnResult>((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let settled = false;

    const child = spawn(request.bin, request.args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, SIGKILL_GRACE_MS);
    }, request.timeoutMs);

    const finish = (result: Omit<CodexSpawnResult, 'durationMs' | 'jsonl' | 'stderr' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({ ...result, jsonl: stdout, stderr, timedOut, durationMs: Date.now() - started });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      stderr += error.message;
      finish({ exitCode: null, signal: null, spawnFailed: true });
    });
    child.on('close', (code, signal) => {
      finish({ exitCode: code, signal, spawnFailed: false });
    });
    // The child may exit before the whole prompt is written; that is an outcome, not a crash.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin);
  });
```

- [ ] **Step 9: Run the spawn test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/codex-spawn.test.ts`
Expected: PASS (4 tests). The timeout case takes about 300 ms.

- [ ] **Step 10: Run the unit lane, lint, and typecheck**

Run: `pnpm test:unit && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/agents/codex tests/agents/codex-spawn.test.ts tests/agents/codex-jsonl.test.ts tests/fixtures/codex
git commit -m "feat(agents): add the codex process seam with a timeout kill and usage parsing" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 11: The Codex adapter, tested on recorded JSONL

**Files:**
- Create: `src/agents/codex/adapter.ts`
- Create: `tests/fixtures/codex/implementation-success.last-message.json`, `tests/fixtures/codex/invalid-output.last-message.json`
- Modify: `src/providers/index.ts` (the `agent_runner: 'codex'` branch)
- Test: `tests/agents/codex-adapter.test.ts`, `tests/providers/create-providers.test.ts`, `tests/cli/run.test.ts`

**Interfaces:**
- Consumes: `CodexSpawn`, `spawnCodex`, `CodexSpawnRequest` (Task 10); `parseCodexUsage`; `renderContextPackage`; `validateAgentResult`; `outcomeSummary`; `AgentTask`, `AgentOutcome`.
- Produces:
  - `interface CodexAdapterInput { paths; config; spawn?; bin?; }`
  - `buildCodexArgs(task: AgentTask, files: { schemaPath: string; lastMessagePath: string }): string[]`
  - `createCodexAgentRunner(input: CodexAdapterInput): AgentRunner`

- [ ] **Step 1: Write the last-message fixtures**

Create `tests/fixtures/codex/implementation-success.last-message.json` — what Codex writes to `-o` when `--output-schema` is in force:

```json
{
  "status": "completed",
  "summary": "Updated ui-kit to Angular 16.2.12; 214 tests pass.",
  "changes_made": [
    "package.json: @angular/core 15.2.10 -> 16.2.12, @angular/cli 15.2.11 -> 16.2.16",
    "src/app/app.module.ts: removed the deprecated RouterModule.forRoot second argument"
  ],
  "findings": [],
  "evidence": ["pnpm test -- --watch=false: TOTAL: 214 SUCCESS"],
  "new_tasks": [],
  "expected_temporary_failure": false,
  "predicted_failures": null,
  "plan_change_required": false,
  "architecture_change_required": false,
  "behavior_change_required": false,
  "recommended_next_action": "Commit the change and let the PR build run.",
  "handover": {
    "current_state": "ui-kit builds and tests green on Angular 16.2.12, working tree uncommitted.",
    "next_action": "Policy-check the diff, then commit and push to the goal branch.",
    "risks": ["@angular/material is still on 15 and will need its own package"]
  }
}
```

Create `tests/fixtures/codex/invalid-output.last-message.json` — the same answer with `handover` missing, which §18.3 makes one failed attempt:

```json
{
  "status": "completed",
  "summary": "Updated ui-kit to Angular 16.2.12.",
  "changes_made": ["package.json"],
  "findings": [],
  "evidence": [],
  "new_tasks": [],
  "expected_temporary_failure": false,
  "predicted_failures": null,
  "plan_change_required": false,
  "architecture_change_required": false,
  "behavior_change_required": false,
  "recommended_next_action": "Commit the change."
}
```

- [ ] **Step 2: Write the failing adapter test**

Create `tests/agents/codex-adapter.test.ts`:

```ts
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { buildCodexArgs, createCodexAgentRunner } from '../../src/agents/codex/adapter.js';
import type { CodexSpawn, CodexSpawnRequest } from '../../src/agents/codex/spawn.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures', 'codex');
const fixture = (name: string): string => readFileSync(join(fixtures, name), 'utf8');
const config = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });

/** Replays a recorded run: captures the request, writes the recorded last message to the `-o` path, returns the JSONL. */
function replay(options: {
  jsonl?: string;
  lastMessage?: string | null;
  exitCode?: number;
  timedOut?: boolean;
  spawnFailed?: boolean;
  seen?: CodexSpawnRequest[];
}): CodexSpawn {
  return async (request) => {
    options.seen?.push(request);
    if (request.args[0] === '--version') {
      return { exitCode: 0, signal: null, jsonl: 'codex-cli 0.48.0\n', stderr: '', timedOut: false, spawnFailed: false, durationMs: 3 };
    }
    const outIndex = request.args.indexOf('-o');
    const outPath = request.args[outIndex + 1];
    if (options.lastMessage !== null && outPath !== undefined) {
      copyFileSync(join(fixtures, options.lastMessage ?? 'implementation-success.last-message.json'), outPath);
    }
    return {
      exitCode: options.exitCode ?? 0,
      signal: options.timedOut === true ? 'SIGTERM' : null,
      jsonl: options.jsonl ?? fixture('implementation-success.jsonl'),
      stderr: options.spawnFailed === true ? 'spawn codex ENOENT' : '',
      timedOut: options.timedOut ?? false,
      spawnFailed: options.spawnFailed ?? false,
      durationMs: 252_000,
    };
  };
}

function runnerFor(spawn: CodexSpawn) {
  const paths = workspacePaths(tempDir('janus-codex-'));
  return { paths, runner: createCodexAgentRunner({ paths, config, spawn }) };
}

const task = (overrides = {}) => {
  const paths = workspacePaths(tempDir('janus-codex-task-'));
  return agentTaskFixture({
    runId: 'run-0201',
    role: 'implementation',
    repo: 'ui-kit',
    cwd: paths.repoDir('ui-kit'),
    writableRoots: [paths.repoDir('ui-kit'), paths.pnpmStoreDir],
    env: { npm_config_store_dir: paths.pnpmStoreDir },
    ...overrides,
  });
};

describe('buildCodexArgs', () => {
  it('builds the §18.4 invocation in order for a code-writing task', () => {
    const t = task();
    expect(buildCodexArgs(t, { schemaPath: '/tmp/s/schema.json', lastMessagePath: '/tmp/s/last-message.json' })).toEqual([
      'exec',
      '-C',
      t.cwd,
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '--add-dir',
      t.writableRoots[0],
      '--add-dir',
      t.writableRoots[1],
      '--output-schema',
      '/tmp/s/schema.json',
      '--json',
      '-o',
      '/tmp/s/last-message.json',
      '--ephemeral',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high',
      '-',
    ]);
  });

  it('omits the network flag and every --add-dir for a read-only task', () => {
    const t = task({ role: 'review', repo: null, sandboxClass: 'read-only', sandbox: 'read-only', network: false, writableRoots: [] });
    const args = buildCodexArgs(t, { schemaPath: '/s.json', lastMessagePath: '/m.json' });
    expect(args).toContain('read-only');
    expect(args).not.toContain('--add-dir');
    expect(args.join(' ')).not.toContain('network_access');
  });

  it('never passes resume or --skip-git-repo-check (§18.4)', () => {
    for (const t of [task(), task({ role: 'review', sandbox: 'read-only', network: false, writableRoots: [] })]) {
      const args = buildCodexArgs(t, { schemaPath: '/s.json', lastMessagePath: '/m.json' });
      expect(args).not.toContain('resume');
      expect(args).not.toContain('--skip-git-repo-check');
    }
  });
});

describe('createCodexAgentRunner', () => {
  it('replays a recorded run into a validated result with tokens and duration', async () => {
    const { runner } = runnerFor(replay({}));
    const outcome = await runner.run(task());
    expect(runner.name).toBe('codex');
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toBe('Updated ui-kit to Angular 16.2.12; 214 tests pass.');
    expect(outcome.result?.handover.risks).toEqual(['@angular/material is still on 15 and will need its own package']);
    expect(outcome.tokens).toEqual({ input: 184_320, cached_input: 172_032, output: 9_184, reasoning: 7_040, total: 193_504 });
    expect(outcome.durationMs).toBe(252_000);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failure).toBeNull();
    expect(outcome.runnerVersion).toBe('codex-cli 0.48.0');
    expect(outcome.promptBytes).toBeGreaterThan(0);
  });

  it('writes the generated output schema to the file it passes to --output-schema', async () => {
    const seen: CodexSpawnRequest[] = [];
    const { runner } = runnerFor(replay({ seen }));
    await runner.run(task());
    const exec = seen.find((request) => request.args[0] === 'exec');
    if (exec === undefined) throw new Error('expected an exec call');
    const schemaPath = exec.args[exec.args.indexOf('--output-schema') + 1];
    if (schemaPath === undefined) throw new Error('expected a schema path');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    expect(schema['title']).toBe('janus-implementation-result');
    expect(schema['additionalProperties']).toBe(false);
    expect(schema['required']).toContain('handover');
  });

  it('sends the rendered §18.2 prompt on stdin and the sandbox env to the child', async () => {
    const seen: CodexSpawnRequest[] = [];
    const t = task();
    const { runner } = runnerFor(replay({ seen }));
    await runner.run(t);
    const exec = seen.find((request) => request.args[0] === 'exec');
    expect(exec?.stdin).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(exec?.stdin).toContain('# TASK: implementation');
    expect(exec?.env['npm_config_store_dir']).toBe(t.env['npm_config_store_dir']);
    expect(exec?.cwd).toBe(t.cwd);
    expect(exec?.timeoutMs).toBe(60 * 60_000);
  });

  it('turns an invalid answer into one failed attempt whose detail names the missing field (§18.3)', async () => {
    const { runner } = runnerFor(replay({ lastMessage: 'invalid-output.last-message.json' }));
    const outcome = await runner.run(task());
    expect(outcome.status).toBe('failed');
    expect(outcome.result).toBeNull();
    expect(outcome.failure?.kind).toBe('invalid_output');
    expect(outcome.failure?.detail).toContain('handover');
  });

  it('turns a missing -o file into invalid_output rather than a crash', async () => {
    const { runner } = runnerFor(replay({ lastMessage: null }));
    const outcome = await runner.run(task());
    expect(outcome.failure?.kind).toBe('invalid_output');
    expect(outcome.failure?.detail).toContain('no final message');
  });

  it('reports a timeout kill, keeping whatever usage the partial stream held', async () => {
    const { runner } = runnerFor(replay({ timedOut: true, exitCode: 0, lastMessage: null, jsonl: fixture('timeout-partial.jsonl') }));
    const outcome = await runner.run(task());
    expect(outcome.status).toBe('failed');
    expect(outcome.timedOut).toBe(true);
    expect(outcome.failure?.kind).toBe('timeout');
    expect(outcome.failure?.detail).toContain('60 minutes');
    expect(outcome.tokens).toBeNull();
  });

  it('reports a non-zero exit with no usable answer as nonzero_exit', async () => {
    const { runner } = runnerFor(replay({ exitCode: 2, lastMessage: null, jsonl: '' }));
    const outcome = await runner.run(task());
    expect(outcome.failure?.kind).toBe('nonzero_exit');
    expect(outcome.exitCode).toBe(2);
  });

  it('prefers a valid answer over a non-zero exit code', async () => {
    const { runner } = runnerFor(replay({ exitCode: 1 }));
    const outcome = await runner.run(task());
    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();
    expect(outcome.exitCode).toBe(1);
  });

  it('reports a missing codex binary as spawn_failed with a doctor hint', async () => {
    const { runner } = runnerFor(replay({ spawnFailed: true, lastMessage: null, jsonl: '' }));
    const outcome = await runner.run(task());
    expect(outcome.failure?.kind).toBe('spawn_failed');
    expect(outcome.failure?.detail).toContain('janus doctor');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/agents/codex-adapter.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/agents/codex/adapter.js"`.

- [ ] **Step 4: Implement the adapter**

Create `src/agents/codex/adapter.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JanusConfig } from '../../config/config-schema.js';
import type { AgentRunner } from '../../providers/types.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import { validateAgentResult } from '../output-schema.js';
import { renderContextPackage } from '../render.js';
import type { AgentOutcome, AgentRunFailure, AgentTask } from '../types.js';
import { outcomeSummary } from '../types.js';
import { parseCodexUsage } from './jsonl.js';
import { spawnCodex } from './spawn.js';
import type { CodexSpawn } from './spawn.js';

export interface CodexAdapterInput {
  paths: WorkspacePaths;
  config: JanusConfig;
  /** The process seam. Tests replace it with a replay of a recorded run; production uses `spawnCodex`. */
  spawn?: CodexSpawn;
  /** The binary name; overridable for the opt-in real-Codex smoke test. */
  bin?: string;
}

/**
 * Spec §18.4's invocation, in its order:
 *
 * ```text
 * codex exec -C <cwd> -s <read-only|workspace-write> \
 *   -c sandbox_workspace_write.network_access=<bool> \
 *   --add-dir <root> ... \
 *   --output-schema <schema.json> --json -o <last-message.json> --ephemeral \
 *   [-m <model>] [-c model_reasoning_effort=<x>] - < prompt.md
 * ```
 *
 * `resume` and `--skip-git-repo-check` are never passed. The network flag is passed only for `workspace-write`,
 * because it configures that sandbox; `read-only` and `danger-full-access` do not take it.
 */
export function buildCodexArgs(task: AgentTask, files: { schemaPath: string; lastMessagePath: string }): string[] {
  const args = ['exec', '-C', task.cwd, '-s', task.sandbox];
  if (task.sandbox === 'workspace-write') {
    args.push('-c', `sandbox_workspace_write.network_access=${String(task.network)}`);
  }
  for (const root of task.writableRoots) args.push('--add-dir', root);
  args.push('--output-schema', files.schemaPath, '--json', '-o', files.lastMessagePath, '--ephemeral');
  args.push('-m', task.model.model, '-c', `model_reasoning_effort=${task.model.effort}`);
  args.push('-');
  return args;
}

function readLastMessage(path: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, detail: 'codex wrote no final message file; the run produced no answer to validate' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `codex final message is not JSON: ${message}` };
  }
}

/**
 * Spec §18.4's Codex adapter.
 *
 * The child inherits `process.env` plus the sandbox plan's additions, because Codex authenticates from the
 * environment and §28 says "Codex authentication is handled outside Janus". No environment **value** is ever
 * written to evidence, a prompt, or a log (§32 rule 12) — `AgentEvidence.env_keys` records names only.
 */
export function createCodexAgentRunner(input: CodexAdapterInput): AgentRunner {
  const spawn = input.spawn ?? spawnCodex;
  const bin = input.bin ?? 'codex';
  let version: string | null = null;

  const resolveVersion = async (): Promise<string | null> => {
    if (version !== null) return version;
    const probe = await spawn({ bin, args: ['--version'], cwd: input.paths.root, env: { ...process.env } as Record<string, string>, stdin: '', timeoutMs: 30_000 });
    version = probe.spawnFailed || probe.exitCode !== 0 ? null : probe.jsonl.trim();
    return version;
  };

  return {
    name: 'codex',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const rendered = renderContextPackage(task.context, {
        maxContextBytes: input.config.agents.max_context_bytes,
        maxInlineDiffBytes: input.config.agents.max_inline_diff_bytes,
      });
      const scratch = mkdtempSync(join(tmpdir(), `janus-codex-${task.runId}-`));
      try {
        const schemaPath = join(scratch, 'schema.json');
        const lastMessagePath = join(scratch, 'last-message.json');
        writeFileSync(schemaPath, `${JSON.stringify(task.outputSchema, null, 2)}\n`);

        const runnerVersion = await resolveVersion();
        const result = await spawn({
          bin,
          args: buildCodexArgs(task, { schemaPath, lastMessagePath }),
          cwd: task.cwd,
          env: { ...process.env, ...task.env } as Record<string, string>,
          stdin: rendered.text,
          timeoutMs: task.timeoutMinutes * 60_000,
        });

        const tokens = parseCodexUsage(result.jsonl);
        const message = result.spawnFailed ? { ok: false as const, detail: 'codex did not start' } : readLastMessage(lastMessagePath);
        const validated = message.ok ? validateAgentResult(task.role, message.value) : null;

        let failure: AgentRunFailure | null = null;
        if (result.timedOut) {
          failure = {
            kind: 'timeout',
            detail: `codex exec exceeded the ${task.timeoutMinutes} minutes allowed for role ${task.role} (agents.roles.${task.role}.timeout_minutes) and was killed`,
          };
        } else if (result.spawnFailed) {
          failure = {
            kind: 'spawn_failed',
            detail: `could not start "${bin}": ${result.stderr.trim()}; run janus doctor to check the Codex installation`,
          };
        } else if (!message.ok) {
          failure = { kind: 'invalid_output', detail: message.detail };
        } else if (validated !== null && !validated.ok) {
          failure = {
            kind: 'invalid_output',
            detail: `codex answered with JSON that does not match the ${task.role} output schema: ${validated.errors.join('; ')}`,
          };
        } else if (result.exitCode !== 0) {
          failure = { kind: 'nonzero_exit', detail: `codex exec exited ${String(result.exitCode)}: ${result.stderr.trim()}` };
        }

        const answer = validated !== null && validated.ok ? validated.result : null;
        return {
          runId: task.runId,
          status: failure === null && answer !== null ? answer.status : 'failed',
          summary: outcomeSummary(answer, failure),
          result: answer,
          failure,
          tokens,
          durationMs: result.durationMs,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          runnerVersion,
          promptBytes: rendered.bytes,
          truncations: rendered.truncations,
        };
      } finally {
        if (process.env['JANUS_KEEP_TMP'] !== '1') rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
}
```

Note the precedence the `if/else` chain encodes: a timeout beats everything (the answer, if any, is from a killed run); a failed spawn next; then a missing or unparseable answer; then a schema violation; and only then a non-zero exit. A run that exits non-zero but still produced a valid answer is **not** a failure — §18.3 cares about the answer, and Codex exits non-zero for conditions the answer already describes.

- [ ] **Step 5: Run the adapter test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/agents/codex-adapter.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Wire the adapter into `createProviders`**

In `src/providers/index.ts`, add the import and replace the `agent_runner` guard:

```ts
import { createCodexAgentRunner } from '../agents/codex/adapter.js';
```

```ts
  const agent =
    workflow.agent_runner === 'codex'
      ? createCodexAgentRunner({ paths: input.paths, config: input.config })
      : createFakeAgentRunner({ fakeDir, now: input.now });
```

and use `agent` in the returned bag. Delete the `ProviderNotImplementedError` throw for the agent runner; `ProviderNotImplementedError` itself stays, because T09 and T10 still use it.

- [ ] **Step 7: Update the two tests that asserted the agent runner was not implemented**

In `tests/providers/create-providers.test.ts`, replace the `const agent = attempt({ agent_runner: 'codex', ... })` block and its three assertions with:

```ts
    const providers = createProviders({
      config: config({ agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' }),
      paths: paths(),
      now,
    });
    expect(providers.agent.name).toBe('codex');
```

(placed in the first test; the second test keeps only its T09 and T10 cases).

In `tests/cli/run.test.ts`, the case "exits 3 and names the task when config selects a provider that is not implemented yet" now needs a provider that really is unimplemented: change its config rewrite from `{ agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' }` to `{ agent_runner: 'fake', ci_provider: 'teamcity', scm_provider: 'fake' }`, add `teamcity: { url: 'https://tc.invalid' }` to the rewritten config so the schema accepts it, and change the expected stderr to `'CI provider "teamcity" is not implemented yet (planned in T09)'`.

- [ ] **Step 8: Run the whole suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/agents/codex/adapter.ts src/providers/index.ts tests/agents/codex-adapter.test.ts tests/fixtures/codex tests/providers/create-providers.test.ts tests/cli/run.test.ts
git commit -m "feat(agents): add the codex exec adapter with schema validation and evidence inputs" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 12: The full §18.5 fake runner

**Files:**
- Modify: `src/providers/fake/agent-runner.ts` (whole file)
- Modify: `src/providers/index.ts`, `tests/helpers/engine-fixtures.ts`, `tests/integration/harness/harness.ts` (the constructor now takes `paths`)
- Test: `tests/providers/fake-agent-runner.test.ts`

**Interfaces:**
- Consumes: `WorkspacePaths`; `runGit`; `REPORTS_DIR`; `validateAgentResult`; `AgentTask`, `AgentOutcome`, `AgentResult`.
- Produces:
  - `interface FakeAgentScriptEntry { status; summary; patch?; reports?; result?; tokens?; durationMs?; failure? }`
  - `interface FakeAgentCall { run_id; role; repo; attempt; at; status; applied_patch; wrote_reports }`
  - `createFakeAgentRunner(input: { paths: WorkspacePaths; now(): Date }): AgentRunner` — **was** `{ fakeDir, now }`
  - `seedFakeAgents(fakeDir, script)`, `readFakeAgents(fakeDir)`, `emptyFakeAgentStore()` — unchanged signatures
  - `testProviders(paths: WorkspacePaths, now?)` — **was** `testProviders(fakeDir, now?)`

**What changes from T04, and why.** T04's stub picked its scripted answer by counting previous calls for the role. §18.5 says "scripted by role and attempt number", and `AgentTask.attempt` now exists, so the index comes from the task: entry `attempt - 1`. That is both more faithful and more deterministic — a test that drives attempt 2 gets entry 2 whether or not attempt 1 ever ran. What stays persisted in `fake/agents.json` is the script itself, read fresh from disk by every process (§3.2: "every `janus run` is a new process"), plus the call log.

- [ ] **Step 1: Write the failing test**

Replace `tests/providers/fake-agent-runner.test.ts` with:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeAgentRunner, readFakeAgents, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { runGit } from '../../src/git/run.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T10:00:00.000Z');

/** A workspace with one real git repository holding one committed file, so `git apply` has something to patch. */
async function workspace() {
  const paths = workspacePaths(tempDir('janus-fake-ws-'));
  const repo = paths.repoDir('ui-kit');
  mkdirSync(repo, { recursive: true });
  mkdirSync(paths.janusDir, { recursive: true });
  await runGit(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'version.txt'), 'fifteen\n');
  await runGit(repo, ['add', 'version.txt']);
  await runGit(repo, ['commit', '-q', '-m', 'seed']);
  return { paths, repo };
}

const PATCH = [
  'diff --git a/version.txt b/version.txt',
  'index 0000000..1111111 100644',
  '--- a/version.txt',
  '+++ b/version.txt',
  '@@ -1 +1 @@',
  '-fifteen',
  '+sixteen',
  '',
].join('\n');

describe('createFakeAgentRunner', () => {
  it('answers from the script by role and attempt number (§18.5)', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [
        { status: 'failed', summary: 'first attempt broke the build' },
        { status: 'completed', summary: 'second attempt is green' },
      ],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    const first = await runner.run(agentTaskFixture({ runId: 'run-0001', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(first.status).toBe('failed');
    expect(first.summary).toBe('first attempt broke the build');

    const second = await runner.run(agentTaskFixture({ runId: 'run-0002', role: 'implementation', repo: 'ui-kit', attempt: 2 }));
    expect(second.status).toBe('completed');
    expect(second.summary).toBe('second attempt is green');
  });

  it('generates a completed answer past the end of a role script, per role', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, { review: [{ status: 'blocked', summary: 'needs the plan' }] });
    const runner = createFakeAgentRunner({ paths, now: clock });

    expect((await runner.run(agentTaskFixture({ runId: 'r1', role: 'review', repo: null, attempt: 1 }))).status).toBe('blocked');
    const past = await runner.run(agentTaskFixture({ runId: 'r2', role: 'review', repo: null, attempt: 2 }));
    expect(past.status).toBe('completed');
    expect(past.summary).toBe('fake review agent attempt 2 completed');
    const other = await runner.run(agentTaskFixture({ runId: 'r3', role: 'planning', repo: null, attempt: 1 }));
    expect(other.summary).toBe('fake planning agent attempt 1 completed');
  });

  it('applies a prepared patch to the assigned repo working tree without touching any ref (§18.5, §32 rule 11)', async () => {
    const { paths, repo } = await workspace();
    const before = await runGit(repo, ['rev-parse', 'HEAD']);
    seedFakeAgents(paths.fakeDir, { implementation: [{ status: 'completed', summary: 'bumped', patch: PATCH }] });
    const runner = createFakeAgentRunner({ paths, now: clock });

    await runner.run(agentTaskFixture({ runId: 'run-0010', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(readFileSync(join(repo, 'version.txt'), 'utf8')).toBe('sixteen\n');
    expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await runGit(repo, ['status', '--porcelain'])).toContain('version.txt');
    expect(readFakeAgents(paths.fakeDir).calls[0]?.applied_patch).toBe(true);
  });

  it('writes prepared reports under .janus/reports/<run-id>/ for a report-writing role', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      discovery: [{ status: 'completed', summary: 'surveyed', reports: { 'deps-and-build.md': '# Deps\n\nAngular 15.2.10\n' } }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    await runner.run(agentTaskFixture({ runId: 'run-0011', role: 'discovery', repo: null, attempt: 1 }));
    const path = join(paths.janusDir, 'reports', 'run-0011', 'deps-and-build.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('Angular 15.2.10');
    expect(readFakeAgents(paths.fakeDir).calls[0]?.wrote_reports).toEqual(['deps-and-build.md']);
  });

  it('returns a prepared §18.3 result, merged over the generated base', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [
        {
          status: 'completed',
          summary: 'coupled red expected',
          result: { expected_temporary_failure: true, predicted_failures: ['ButtonComponent > renders'] },
          tokens: { input: 10, cached_input: 2, output: 3, reasoning: null, total: 13 },
          durationMs: 4_000,
        },
      ],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    const outcome = await runner.run(agentTaskFixture({ runId: 'run-0012', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(outcome.result?.expected_temporary_failure).toBe(true);
    expect(outcome.result?.predicted_failures).toEqual(['ButtonComponent > renders']);
    expect(outcome.result?.summary).toBe('coupled red expected');
    expect(outcome.tokens?.total).toBe(13);
    expect(outcome.durationMs).toBe(4_000);
  });

  it('can script an adapter failure, so a harness scenario can exercise a timeout', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      debug: [{ status: 'failed', summary: 'killed', failure: { kind: 'timeout', detail: 'killed after 45 minutes' } }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });
    const outcome = await runner.run(agentTaskFixture({ runId: 'run-0013', role: 'debug', repo: 'ui-kit', attempt: 1 }));
    expect(outcome.status).toBe('failed');
    expect(outcome.result).toBeNull();
    expect(outcome.failure).toEqual({ kind: 'timeout', detail: 'killed after 45 minutes' });
    expect(outcome.timedOut).toBe(true);
  });

  it('refuses a scripted result the real output schema would reject', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [{ status: 'completed', summary: 's', result: { summary: 42 } as never }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });
    await expect(
      runner.run(agentTaskFixture({ runId: 'run-0014', role: 'implementation', repo: 'ui-kit', attempt: 1 })),
    ).rejects.toThrow('fake agent script for role implementation attempt 1 is not a valid implementation result');
  });

  it('reads the script from disk in a second process and keeps appending to the call log', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      debug: [
        { status: 'failed', summary: 'still red' },
        { status: 'completed', summary: 'fixed' },
      ],
    });
    await createFakeAgentRunner({ paths, now: clock }).run(agentTaskFixture({ runId: 'a', role: 'debug', repo: 'ui-kit', attempt: 1 }));
    const laterProcess = createFakeAgentRunner({ paths, now: clock });
    const second = await laterProcess.run(agentTaskFixture({ runId: 'b', role: 'debug', repo: 'ui-kit', attempt: 2 }));
    expect(second.summary).toBe('fixed');
    expect(readFakeAgents(paths.fakeDir).calls.map((call) => call.run_id)).toEqual(['a', 'b']);
    expect(readFakeAgents(paths.fakeDir).calls.map((call) => call.attempt)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/providers/fake-agent-runner.test.ts`
Expected: FAIL — `createFakeAgentRunner` does not accept `paths`.

- [ ] **Step 3: Rewrite the fake runner**

Replace `src/providers/fake/agent-runner.ts` with:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '../../config/config-schema.js';
import { validateAgentResult } from '../../agents/output-schema.js';
import type { AgentResult } from '../../agents/output-schema.js';
import type { AgentOutcome, AgentRunFailure, AgentTask, AgentTokenUsage } from '../../agents/types.js';
import { outcomeSummary } from '../../agents/types.js';
import { runGit } from '../../git/run.js';
import { REPORTS_DIR } from '../../state/files.js';
import type { WorkspacePaths } from '../../workspace/layout.js';
import type { AgentRunner } from '../types.js';
import { FAKE_AGENTS_FILE, readFakeStore, writeFakeStore } from './store.js';

/**
 * One scripted answer. Spec §18.5: "Scripted by role and attempt number; applies prepared patches, writes prepared
 * reports, returns prepared results; state persisted under `fake/agents.json`."
 */
export interface FakeAgentScriptEntry {
  status: AgentResult['status'];
  summary: string;
  /** A unified diff applied to the assigned repo's **working tree**. Never a commit: §32 rule 11. */
  patch?: string;
  /** Files written under `.janus/reports/<run-id>/`, keyed by relative path. */
  reports?: Record<string, string>;
  /** Overrides merged over the generated §18.3 result. Validated against the role schema before it is returned. */
  result?: Partial<AgentResult>;
  tokens?: AgentTokenUsage;
  durationMs?: number;
  /** An adapter-level failure to simulate (timeout, invalid output, ...). Suppresses `result`. */
  failure?: AgentRunFailure;
}

export interface FakeAgentCall {
  run_id: string;
  role: AgentRole;
  repo: string | null;
  attempt: number;
  at: string;
  status: AgentResult['status'];
  applied_patch: boolean;
  wrote_reports: string[];
}

/** The contents of `<workspace>/fake/agents.json` (spec §18.5). */
export interface FakeAgentStore {
  /** Answers per role, indexed by `attempt - 1`. A role that runs out falls back to a generated `completed`. */
  script: Partial<Record<AgentRole, FakeAgentScriptEntry[]>>;
  /** Every call made in this workspace, across processes. */
  calls: FakeAgentCall[];
}

export function emptyFakeAgentStore(): FakeAgentStore {
  return { script: {}, calls: [] };
}

/** Seeds the script before a run and clears any recorded calls. */
export function seedFakeAgents(fakeDir: string, script: FakeAgentStore['script']): void {
  writeFakeStore(fakeDir, FAKE_AGENTS_FILE, { script, calls: [] } satisfies FakeAgentStore);
}

export function readFakeAgents(fakeDir: string): FakeAgentStore {
  return readFakeStore(fakeDir, FAKE_AGENTS_FILE, emptyFakeAgentStore());
}

export interface FakeAgentRunnerInput {
  paths: WorkspacePaths;
  now(): Date;
}

function baseResult(role: AgentRole, status: AgentResult['status'], summary: string): AgentResult {
  return {
    status,
    summary,
    changes_made: [],
    findings: [],
    evidence: [],
    new_tasks: [],
    expected_temporary_failure: false,
    predicted_failures: null,
    plan_change_required: false,
    architecture_change_required: false,
    behavior_change_required: false,
    recommended_next_action: `fake ${role} agent has nothing further to recommend`,
    handover: { current_state: summary, next_action: '', risks: [] },
  };
}

/**
 * Spec §18.5's scripted runner.
 *
 * It applies a patch with `git apply`, which writes the working tree and **no ref**, so T04's reflog audit
 * (§31.29) still sees zero git writes during an agent run — exactly as a real Codex agent, which edits files and
 * never commits.
 */
export function createFakeAgentRunner(input: FakeAgentRunnerInput): AgentRunner {
  const { paths } = input;
  return {
    name: 'fake',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      const store = readFakeAgents(paths.fakeDir);
      const index = Math.max(task.attempt, 1) - 1;
      const scripted = store.script[task.role]?.[index];
      const status = scripted?.status ?? 'completed';
      const summary = scripted?.summary ?? `fake ${task.role} agent attempt ${index + 1} completed`;

      let appliedPatch = false;
      if (scripted?.patch !== undefined && scripted.patch !== '') {
        if (task.repo === null) {
          throw new Error(`fake agent script for role ${task.role} attempt ${index + 1} has a patch but the task has no repo`);
        }
        const patchFile = join(paths.fakeDir, 'patches', `${task.runId}.patch`);
        mkdirSync(dirname(patchFile), { recursive: true });
        writeFileSync(patchFile, scripted.patch.endsWith('\n') ? scripted.patch : `${scripted.patch}\n`);
        await runGit(paths.repoDir(task.repo), ['apply', '--whitespace=nowarn', patchFile]);
        appliedPatch = true;
      }

      const wroteReports: string[] = [];
      if (scripted?.reports !== undefined) {
        const dir = join(paths.janusDir, REPORTS_DIR, task.runId);
        for (const [name, contents] of Object.entries(scripted.reports)) {
          const path = join(dir, name);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, contents);
          wroteReports.push(name);
        }
      }

      const failure = scripted?.failure ?? null;
      let result: AgentResult | null = null;
      if (failure === null) {
        const merged = { ...baseResult(task.role, status, summary), ...(scripted?.result ?? {}) };
        const validated = validateAgentResult(task.role, merged);
        if (!validated.ok) {
          throw new Error(
            `fake agent script for role ${task.role} attempt ${index + 1} is not a valid ${task.role} result: ${validated.errors.join('; ')}`,
          );
        }
        result = validated.result;
      }

      store.calls.push({
        run_id: task.runId,
        role: task.role,
        repo: task.repo,
        attempt: task.attempt,
        at: input.now().toISOString(),
        status: failure === null ? status : 'failed',
        applied_patch: appliedPatch,
        wrote_reports: wroteReports,
      });
      writeFakeStore(paths.fakeDir, FAKE_AGENTS_FILE, store);

      return {
        runId: task.runId,
        status: failure === null ? status : 'failed',
        summary: outcomeSummary(result, failure),
        result,
        failure,
        tokens: scripted?.tokens ?? null,
        durationMs: scripted?.durationMs ?? 0,
        exitCode: failure === null ? 0 : null,
        signal: failure?.kind === 'timeout' ? 'SIGTERM' : null,
        timedOut: failure?.kind === 'timeout',
        runnerVersion: null,
        promptBytes: null,
        truncations: [],
      };
    },
  };
}
```

- [ ] **Step 4: Update the three constructor call sites**

1. `src/providers/index.ts`: `createFakeAgentRunner({ fakeDir, now: input.now })` becomes `createFakeAgentRunner({ paths: input.paths, now: input.now })`. The local `const fakeDir = input.paths.fakeDir;` stays for the CI and SCM fakes.
2. `tests/helpers/engine-fixtures.ts`: change `testProviders` to take the paths object:

```ts
/** A providers bag backed by the fakes, rooted at a workspace's paths. */
export function testProviders(paths: WorkspacePaths, now: () => Date = () => new Date()): Providers {
  return {
    agent: createFakeAgentRunner({ paths, now }),
    ci: createFakeCiProvider({ fakeDir: paths.fakeDir, now }),
    scm: createFakeScmProvider({ fakeDir: paths.fakeDir, now }),
  };
}
```

with `import type { WorkspacePaths } from '../../src/workspace/layout.js';` added. Its three callers in `tests/engine/run-loop.test.ts` change from `testProviders(workspace.paths.fakeDir)` to `testProviders(workspace.paths)`.

3. `tests/integration/harness/harness.ts`: `createFakeAgentRunner({ fakeDir: paths.fakeDir, now })` becomes `createFakeAgentRunner({ paths, now })`.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm test`
Expected: PASS. `tests/providers/fake-agent-runner.test.ts` is 8 tests.

- [ ] **Step 6: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/providers/fake/agent-runner.ts src/providers/index.ts tests/providers/fake-agent-runner.test.ts tests/helpers/engine-fixtures.ts tests/engine/run-loop.test.ts tests/integration/harness/harness.ts
git commit -m "feat(providers): grow the fake agent runner into the full scripted runner" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 13: `janus agent run <role> --task FILE`

**Files:**
- Create: `src/agents/task-file.ts`
- Modify: `src/cli/commands/agent.ts` (whole file)
- Test: `tests/cli/agent-run.test.ts`

**Interfaces:**
- Consumes: `buildAgentTask`; `runAgent`; `createProviders`; `createEngine`; `openWorkspace`, `findWorkspaceRoot`; `resolveGlobalPnpmStore`; `buildCodexArgs`; `renderContextPackage`; `AGENT_ROLES`.
- Produces:
  - `const agentTaskFileSchema` (zod) and `type AgentTaskFile`
  - `loadAgentTaskFile(path: string): AgentTaskFile`
  - `janus agent run <role> --task <file> [--dry-run] [--model-profile <name>]`

**Exit codes:** `0` on `completed`; `1` on `blocked`, `failed`, or an adapter failure; `2` for an unknown role, an unreadable or invalid task file, or an unknown model profile; `13` when the workspace is locked. All already exist in `src/cli/exit-codes.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/agent-run.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { readEvents } from '../../src/telemetry/events.js';
import { initWorkspace } from '../helpers/engine-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

const TASK_FILE = {
  repo: 'ui-kit',
  attempt: 1,
  guardrails: ['files outside src/ are out of scope'],
  budget: 'ci_fix_attempts: 0 of 5',
  context: {
    goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
    repository: 'ui-kit (library), base branch main',
    plan_slice: 'wp-01-ui-kit-angular',
    current_state: null,
    change_summary: [{ path: 'package.json', added: 12, removed: 3, generated: false }],
    inline_diff: null,
    verification_evidence: null,
    previous_attempts: [],
    baseline_exceptions: [],
  },
};

async function workspaceWithTask(task: Record<string, unknown> = TASK_FILE) {
  const ws = await initWorkspace();
  const taskPath = join(ws.root, 'task.yaml');
  writeFileSync(taskPath, stringify(task));
  return { ws, taskPath };
}

describe('janus agent run', () => {
  it('runs one scripted agent, writes evidence, and exits 0', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    seedFakeAgents(ws.fakeDir, { implementation: [{ status: 'completed', summary: 'bumped @angular/core to 16' }] });

    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('status: completed');
    expect(result.stdout).toContain('bumped @angular/core to 16');
    expect(result.stdout).toContain('model: gpt-5.6-sol');
    expect(result.stdout).toMatch(/prompt: implementation@\d+/);
    expect(result.stdout).toContain('evidence/agents/');
    expect(result.stdout).toContain('committed by the next janus run checkpoint');

    const runId = /evidence\/agents\/(\S+)\.yaml/u.exec(result.stdout)?.[1];
    expect(runId).toBeDefined();
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', `${runId ?? ''}.yaml`))).toBe(true);
    const types = readEvents(ws.janusDir).map((event) => event['type']);
    expect(types).toContain('agent.started');
    expect(types).toContain('agent.finished');
  });

  it('exits 1 when the agent answers blocked, and says why', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    seedFakeAgents(ws.fakeDir, { implementation: [{ status: 'blocked', summary: 'the peer dependency is not published yet' }] });
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stderr).toContain('the peer dependency is not published yet');
  });

  it('prints the rendered prompt and the codex invocation for --dry-run, without running anything', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath, '--dry-run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('# TASK: implementation');
    expect(result.stdout).toContain('## GUARDRAILS AND FORBIDDEN ACTIONS');
    expect(result.stdout).toContain('## OUTPUT CONTRACT');
    expect(result.stdout).toContain('codex exec -C ');
    expect(result.stdout).toContain('--output-schema');
    expect(result.stdout).not.toContain('resume');
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents'))).toBe(false);
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'agent.started')).toBe(false);
  });

  it('exits 2 for an unknown role', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'architect', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('unknown agent role "architect"');
    expect(result.stderr).toContain('integration_discovery');
  });

  it('exits 2 for a task file that is missing or does not match the schema', async () => {
    const { ws } = await workspaceWithTask();
    const missing = await runCli(['agent', 'run', 'qa', '--task', join(ws.root, 'nope.yaml')], { cwd: ws.root });
    expect(missing.code).toBe(ExitCode.UsageError);
    expect(missing.stderr).toContain('file not found');

    const badPath = join(ws.root, 'bad.yaml');
    writeFileSync(badPath, stringify({ repo: 'ui-kit', context: { goal: 42 } }));
    const bad = await runCli(['agent', 'run', 'qa', '--task', badPath], { cwd: ws.root });
    expect(bad.code).toBe(ExitCode.UsageError);
    expect(bad.stderr).toContain('context.goal');
  });

  it('exits 2 for a model profile that config.yaml does not define', async () => {
    const { ws, taskPath } = await workspaceWithTask();
    const result = await runCli(['agent', 'run', 'implementation', '--task', taskPath, '--model-profile', 'nope'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('model profile "nope"');
  });

  it('runs a report-writing role with no repo', async () => {
    const { ws, taskPath } = await workspaceWithTask({ ...TASK_FILE, repo: null });
    seedFakeAgents(ws.fakeDir, { qa: [{ status: 'completed', summary: 'test the order flow', reports: { 'qa.md': '# QA\n' } }] });
    const result = await runCli(['agent', 'run', 'qa', '--task', taskPath], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    const runId = /evidence\/agents\/(\S+)\.yaml/u.exec(result.stdout)?.[1] ?? '';
    expect(readFileSync(join(ws.janusDir, 'reports', runId, 'qa.md'), 'utf8')).toContain('# QA');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit tests/cli/agent-run.test.ts`
Expected: FAIL — the command still answers `ExitCode.NotImplemented`.

- [ ] **Step 3: Implement the task file schema**

Create `src/agents/task-file.ts`:

```ts
import { z } from 'zod';
import { ConfigError, formatZodIssues } from '../config/errors.js';
import { readYamlFile } from '../config/yaml.js';
import type { ContextPackageInput } from './context.js';

const changeSummaryEntrySchema = z
  .object({
    path: z.string().min(1),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    generated: z.boolean().default(false),
  })
  .strict();

/**
 * The `--task FILE` a human writes for `janus agent run`: the variable half of a §18.2 context package plus the
 * repo, the attempt, and the two blocks that depend on the stage. Everything else — class, sandbox, roots,
 * timeout, model, schema, prompt version, and the fixed guardrail and Angular blocks — is filled in by
 * `buildAgentTask`, so a hand-written task file cannot produce a prompt the engine would not.
 */
export const agentTaskFileSchema = z
  .object({
    repo: z.string().min(1).nullable().default(null),
    attempt: z.number().int().positive().default(1),
    guardrails: z.array(z.string().min(1)).default([]),
    budget: z.string().default('(not tracked for a manual run)'),
    context: z
      .object({
        goal: z.string().min(1),
        repository: z.string().nullable().default(null),
        plan_slice: z.string().nullable().default(null),
        current_state: z.string().nullable().default(null),
        change_summary: z.array(changeSummaryEntrySchema).default([]),
        inline_diff: z.string().nullable().default(null),
        verification_evidence: z.string().nullable().default(null),
        previous_attempts: z.array(z.string()).default([]),
        baseline_exceptions: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();

export type AgentTaskFile = z.infer<typeof agentTaskFileSchema>;

/** The file's snake_case sections, as the camelCase `ContextPackageInput` the builder takes. */
export function contextInputFrom(file: AgentTaskFile): ContextPackageInput {
  return {
    goal: file.context.goal,
    repository: file.context.repository,
    planSlice: file.context.plan_slice,
    currentState: file.context.current_state,
    changeSummary: file.context.change_summary,
    inlineDiff: file.context.inline_diff,
    verificationEvidence: file.context.verification_evidence,
    previousAttempts: file.context.previous_attempts,
    baselineExceptions: file.context.baseline_exceptions,
  };
}

export function loadAgentTaskFile(path: string): AgentTaskFile {
  const parsed = agentTaskFileSchema.safeParse(readYamlFile(path));
  if (!parsed.success) throw new ConfigError(path, formatZodIssues(parsed.error));
  return parsed.data;
}
```

- [ ] **Step 4: Implement the command**

Replace `src/cli/commands/agent.ts` with:

```ts
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { buildCodexArgs } from '../../agents/codex/adapter.js';
import { renderContextPackage } from '../../agents/render.js';
import { runAgent } from '../../agents/run.js';
import { resolveGlobalPnpmStore } from '../../agents/sandbox.js';
import { buildAgentTask } from '../../agents/task.js';
import { contextInputFrom, loadAgentTaskFile } from '../../agents/task-file.js';
import { AGENT_ROLES } from '../../config/config-schema.js';
import type { AgentRole } from '../../config/config-schema.js';
import { ConfigError } from '../../config/errors.js';
import { createEngine } from '../../engine/engine.js';
import { createProviders } from '../../providers/index.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface AgentRunOptions {
  task: string;
  dryRun?: boolean;
  modelProfile?: string;
}

function parseRole(value: string): AgentRole {
  if (!(AGENT_ROLES as readonly string[]).includes(value)) {
    throw new ConfigError('<role>', [`unknown agent role "${value}"; expected one of ${AGENT_ROLES.join(', ')}`]);
  }
  return value as AgentRole;
}

/** `manual-<compact ISO>`, so a hand-run never collides with an engine run id and is obvious in the evidence directory. */
function manualRunId(now: Date): string {
  return `manual-${now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}`;
}

export function registerAgent(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description('Debug helpers for agent tasks');

  agent
    .command('run')
    .description('Run one agent task by hand')
    .argument('<role>', `agent role, one of ${AGENT_ROLES.join(', ')}`)
    .requiredOption('--task <file>', 'task file describing the context package')
    .option('--dry-run', 'print the rendered prompt and the codex invocation without running anything')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(async (role: string, options: AgentRunOptions) => {
      ctx.exitCode = await agentRunCommand(ctx, role, options);
    });
}

async function agentRunCommand(ctx: CliContext, roleArgument: string, options: AgentRunOptions): Promise<ExitCode> {
  const role = parseRole(roleArgument);
  const file = loadAgentTaskFile(resolve(ctx.io.cwd, options.task));
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    const { config, paths } = workspace;
    const profile = options.modelProfile ?? config.workflow_models.profile;
    if (!(profile in config.model_profiles)) {
      throw new ConfigError('--model-profile', [`model profile "${profile}" is not defined in config.yaml model_profiles`]);
    }
    const now = new Date();
    const task = buildAgentTask({
      runId: manualRunId(now),
      role,
      repo: file.repo,
      attempt: file.attempt,
      paths,
      config,
      profile,
      globalPnpmStore: config.agents.pnpm_store === 'global' ? await resolveGlobalPnpmStore() : null,
      context: contextInputFrom(file),
      guardrails: file.guardrails,
      budget: file.budget,
    });

    if (options.dryRun === true) {
      const rendered = renderContextPackage(task.context, {
        maxContextBytes: config.agents.max_context_bytes,
        maxInlineDiffBytes: config.agents.max_inline_diff_bytes,
      });
      ctx.io.stdout(`${rendered.text}\n`);
      ctx.io.stdout(`\n--- invocation (${rendered.bytes} prompt bytes, ${rendered.truncations.length} truncation(s)) ---\n`);
      const args = buildCodexArgs(task, { schemaPath: '<scratch>/schema.json', lastMessagePath: '<scratch>/last-message.json' });
      ctx.io.stdout(`codex ${args.join(' ')}\n`);
      return ExitCode.Ok;
    }

    const providers = ctx.providers ?? createProviders({ config, paths, now: () => new Date() });
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const record = await runAgent({ engine, runner: providers.agent, task, previousModel: null });
    const { outcome } = record;

    ctx.io.stdout(`run ${task.runId} (${role}${task.repo === null ? '' : ` in ${task.repo}`}, attempt ${task.attempt})\n`);
    ctx.io.stdout(`  status: ${outcome.status}\n`);
    ctx.io.stdout(`  model: ${task.model.model} (effort ${task.model.effort})\n`);
    ctx.io.stdout(`  prompt: ${task.promptVersion}, profile ${task.profile}\n`);
    ctx.io.stdout(`  duration: ${outcome.durationMs} ms, tokens: ${outcome.tokens === null ? 'not reported' : String(outcome.tokens.total)}\n`);
    ctx.io.stdout(`  summary: ${outcome.summary}\n`);
    ctx.io.stdout(`  evidence: ${record.evidencePath}\n`);
    ctx.io.stdout('  (evidence and telemetry are uncommitted; they are committed by the next janus run checkpoint)\n');

    if (outcome.status === 'completed') return ExitCode.Ok;
    ctx.io.stderr(`janus: agent run ${task.runId} ended ${outcome.status}: ${outcome.summary}\n`);
    return ExitCode.UnexpectedError;
  } finally {
    workspace.release();
  }
}
```

- [ ] **Step 5: Run the CLI test to verify it passes**

Run: `pnpm exec vitest run --project unit tests/cli/agent-run.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Check the command list test still describes `agent run`**

Run: `pnpm exec vitest run --project unit tests/cli/commands.test.ts`
Expected: PASS. If that test asserted `agent run` exits 3 as a placeholder, delete that assertion — the command is implemented now and `tests/cli/agent-run.test.ts` covers it.

- [ ] **Step 7: Run the whole suite, lint, and typecheck**

Run: `pnpm test && pnpm lint && pnpm typecheck`
Expected: all exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/agents/task-file.ts src/cli/commands/agent.ts tests/cli/agent-run.test.ts tests/cli/commands.test.ts
git commit -m "feat(cli): implement janus agent run for one hand-driven agent task" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Task 14: Harness scenario and the opt-in real-Codex smoke test

**Files:**
- Create: `tests/integration/agent-run.test.ts`, `tests/integration/codex-smoke.test.ts`
- Modify: `README.md` (one paragraph on `JANUS_REAL_CODEX`) — only if the repo has a README section on running tests; skip otherwise
- Test: both new files

**Interfaces:**
- Consumes: `createHarness`, `expectNoAgentGitWrites` (T04); `buildAgentTask`, `runAgent`, `seedFakeAgents`, `readFakeAgents`; `createCodexAgentRunner`; `openWorkspace`, `createEngine`, `loadConfig`.
- Produces: the T05 done-when evidence — a scripted agent drives a task inside the harness, leaves evidence and events, and performs no git write.

- [ ] **Step 1: Write the failing harness scenario**

Create `tests/integration/agent-run.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildAgentTask } from '../../src/agents/task.js';
import { runAgent } from '../../src/agents/run.js';
import { createEngine } from '../../src/engine/engine.js';
import { runGit } from '../../src/git/run.js';
import { readFakeAgents, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createHarness, expectNoAgentGitWrites } from './harness/harness.js';

const SPECS = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit'] },
];

const PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # ui-kit',
  '+Upgraded to Angular 16.',
  '',
].join('\n');

const CONTEXT = {
  goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
  repository: 'ui-kit (library), base branch main',
  planSlice: 'wp-01-ui-kit-angular: run ng update',
  currentState: 'stage executing, attempt 1',
  changeSummary: [{ path: 'package.json', added: 12, removed: 3, generated: false }],
  inlineDiff: null,
  verificationEvidence: null,
  previousAttempts: [],
  baselineExceptions: [],
};

describe('an agent run inside the harness', () => {
  it('applies the scripted patch, stamps the evidence, emits the events, and writes no git ref (§31.29)', async () => {
    const harness = await createHarness(SPECS, {
      agents: { implementation: [{ status: 'completed', summary: 'bumped ui-kit to 16', patch: PATCH }] },
      now: () => new Date('2026-09-20T13:00:00.000Z'),
    });
    const repoDir = join(harness.root, 'repos', 'ui-kit');
    const headBefore = await runGit(repoDir, ['rev-parse', 'HEAD']);

    const workspace = await openWorkspace(harness.root);
    try {
      const engine = createEngine({
        workspace,
        log: () => undefined,
        warn: () => undefined,
        now: () => new Date('2026-09-20T13:00:00.000Z'),
      });
      const task = buildAgentTask({
        runId: 'run-0001',
        role: 'implementation',
        repo: 'ui-kit',
        attempt: 1,
        paths: workspace.paths,
        config: workspace.config,
        profile: workspace.config.workflow_models.profile,
        globalPnpmStore: null,
        context: CONTEXT,
        guardrails: ['files outside src/ are out of scope'],
        budget: 'ci_fix_attempts: 0 of 5',
      });
      const record = await runAgent({ engine, runner: harness.providers.agent, task, previousModel: null });

      expect(record.outcome.status).toBe('completed');
      expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toContain('Upgraded to Angular 16.');
      expect(await runGit(repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repoDir, ['status', '--porcelain'])).toContain('README.md');

      const evidence = parse(harness.evidence(join('agents', 'run-0001.yaml'))) as Record<string, unknown>;
      expect(evidence['role']).toBe('implementation');
      expect(evidence['class']).toBe('code-writing');
      expect(evidence['sandbox']).toBe('workspace-write');
      expect(evidence['model']).toBe('gpt-5.6-sol');
      expect(evidence['profile']).toBe('default');
      expect(evidence['prompt_version']).toMatch(/^implementation@\d+$/);
      expect(evidence['cwd']).toBe(join('repos', 'ui-kit'));
      expect(evidence['env_keys']).toEqual(['npm_config_store_dir']);

      const types = readEvents(workspace.paths.janusDir).map((event) => event['type']);
      expect(types).toContain('agent.started');
      expect(types).toContain('agent.finished');
      expect(readFakeAgents(harness.fakeDir).calls[0]?.applied_patch).toBe(true);
    } finally {
      workspace.release();
    }

    expectNoAgentGitWrites(harness);
  });

  it('gives a report-writing role its own report directory and no writable repo', async () => {
    const harness = await createHarness(SPECS, {
      agents: { discovery: [{ status: 'completed', summary: 'surveyed ui-kit', reports: { 'deps-and-build.md': '# Deps\n' } }] },
    });
    const workspace = await openWorkspace(harness.root);
    try {
      const engine = createEngine({ workspace, log: () => undefined, warn: () => undefined });
      const task = buildAgentTask({
        runId: 'run-0002',
        role: 'discovery',
        repo: null,
        attempt: 1,
        paths: workspace.paths,
        config: workspace.config,
        profile: 'default',
        globalPnpmStore: null,
        context: { ...CONTEXT, changeSummary: [] },
        guardrails: [],
        budget: '(discovery has no budget)',
      });
      expect(task.cwd).toBe(join(workspace.paths.janusDir, 'reports', 'run-0002'));
      expect(task.writableRoots).toEqual([task.cwd]);
      expect(task.network).toBe(false);

      await runAgent({ engine, runner: harness.providers.agent, task, previousModel: null });
      expect(existsSync(join(task.cwd, 'deps-and-build.md'))).toBe(true);
    } finally {
      workspace.release();
    }

    expectNoAgentGitWrites(harness);
  });
});
```

`harness.evidence(relativePath)` from T04 reads `.janus/evidence/<relativePath>`, which is why the call above is `harness.evidence(join('agents', 'run-0001.yaml'))` — the same shape T04's own harness test uses (`harness.evidence('agents/run-9999.yaml')`).

- [ ] **Step 2: Run it to verify it fails, then passes**

Run: `pnpm test:integration`
Expected: FAIL first (the scenario asserts behaviour that only lands once Tasks 8, 9 and 12 are in — if those are already committed, it should pass on the first run). Fix any mismatch against the T04 harness API, then re-run.
Expected after fixes: PASS.

- [ ] **Step 3: Write the opt-in real-Codex smoke test**

Create `tests/integration/codex-smoke.test.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCodexAgentRunner } from '../../src/agents/codex/adapter.js';
import { configSchema } from '../../src/config/config-schema.js';
import { buildAgentTask } from '../../src/agents/task.js';
import { runGit } from '../../src/git/run.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';

const ENABLED = process.env['JANUS_REAL_CODEX'] === '1';
const TEN_MINUTES = 600_000;

const config = configSchema.parse({
  workflow: { agent_runner: 'codex', ci_provider: 'fake', scm_provider: 'fake' },
  agents: { roles: { review: { timeout_minutes: 5 }, implementation: { timeout_minutes: 10 } } },
  guardrails: { max_agent_runtime_minutes: 10 },
});

const CONTEXT = {
  goal: 'Prove the Codex sandbox works on this machine',
  repository: null,
  planSlice: null,
  currentState: null,
  changeSummary: [],
  inlineDiff: null,
  verificationEvidence: null,
  previousAttempts: [],
  baselineExceptions: [],
};

/**
 * Spec §29 item 5 and `tasks.md` T05: "opt-in real-Codex smoke test (`JANUS_REAL_CODEX=1`) for a read-only echo
 * and a workspace-write scratch install". Skipped by default — CI has no `codex` binary and no Codex credentials.
 * Run it by hand: `JANUS_REAL_CODEX=1 pnpm test:integration`.
 */
describe.skipIf(!ENABLED)('real codex smoke test', () => {
  it(
    'answers a read-only task with a schema-valid result',
    async () => {
      const paths = workspacePaths(tempDir('janus-real-codex-ro-'));
      mkdirSync(paths.root, { recursive: true });
      const runner = createCodexAgentRunner({ paths, config });
      const task = buildAgentTask({
        runId: 'smoke-read-only',
        role: 'review',
        repo: null,
        attempt: 1,
        paths,
        config,
        profile: 'default',
        globalPnpmStore: null,
        context: {
          ...CONTEXT,
          planSlice: 'Answer with status "completed" and the single word "pong" as the summary. Change nothing.',
        },
        guardrails: [],
        budget: '(smoke test)',
      });
      expect(task.sandbox).toBe('read-only');

      const outcome = await runner.run(task);
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(outcome.status).toBe('completed');
      expect(outcome.result?.summary.length).toBeGreaterThan(0);
      expect(outcome.tokens?.input).toBeGreaterThan(0);
      expect(outcome.runnerVersion).not.toBeNull();
    },
    TEN_MINUTES,
  );

  it(
    'installs into a workspace-write scratch project and moves no git ref',
    async () => {
      const paths = workspacePaths(tempDir('janus-real-codex-ww-'));
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
      const headBefore = await runGit(repo, ['rev-parse', 'HEAD']);

      const runner = createCodexAgentRunner({ paths, config });
      const task = buildAgentTask({
        runId: 'smoke-workspace-write',
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
        budget: '(smoke test)',
      });
      expect(task.sandbox).toBe('workspace-write');
      expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);

      const outcome = await runner.run(task);
      expect(outcome.failure, JSON.stringify(outcome.failure)).toBeNull();
      expect(existsSync(join(repo, 'node_modules'))).toBe(true);
      // §32 rule 11: the agent edited the tree and moved nothing.
      expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repo, ['reflog', 'show', '--format=%H', 'HEAD'])).toBe(headBefore);
    },
    TEN_MINUTES,
  );
});
```

- [ ] **Step 4: Verify the smoke test is skipped by default**

Run: `pnpm test:integration`
Expected: PASS, with `tests/integration/codex-smoke.test.ts` reported as skipped (2 skipped).

- [ ] **Step 5: Run the whole suite, lint, typecheck, and build**

Run: `pnpm test && pnpm lint && pnpm typecheck && pnpm build`
Expected: all exit 0.

Run: `ls dist/agents dist/agents/codex dist/agents/prompts`
Expected: the compiled `.js` files are there — the prompt templates ship because they are TypeScript modules, not `.md` files (Decision 5).

Run: `ls dist | grep -i test`
Expected: no output; nothing from `tests/` reached the build.

- [ ] **Step 6: Record the real-Codex smoke test in the README**

If `README.md` has a "Testing" or "Development" section, add:

```markdown
### Real-Codex smoke test

`tests/integration/codex-smoke.test.ts` runs two real `codex exec` invocations — a read-only echo and a
workspace-write `pnpm install` in a scratch project. It is skipped unless you opt in, because it needs the `codex`
binary and working Codex credentials:

```bash
JANUS_REAL_CODEX=1 pnpm test:integration
```
```

If the README has no such section, skip this step rather than inventing one.

- [ ] **Step 7: Commit**

```bash
git add tests/integration/agent-run.test.ts tests/integration/codex-smoke.test.ts README.md
git commit -m "test(agents): drive a scripted agent through the harness and add the real-codex smoke test" -m "Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RdkoUAjkde39p4Lxnb857N"
```

---

## Self-Review

Run after the plan was complete, against the spec with fresh eyes. Issues found were fixed inline above; they are listed here so the executor knows what was already checked.

**1. Spec coverage.**

| Spec | Task |
|---|---|
| §3.2 `AgentRunner.run(task): Promise<AgentResult>` | 4 |
| §3.3 sandbox class table (roles, `-s`, cwd, writable roots) | 1, 8 |
| §5 `reports/<run-id>/`, `evidence/agents/<run-id>.yaml` | 8, 9 |
| §6 `execution.in_flight.agent_run_id` / `.repo` | 9 |
| §14 output-schema note (all properties required, `null` for N/A) | 3 |
| §16.5 `expected_temporary_failure` / `predicted_failures` | 3 (base schema), 12 (scriptable) |
| §17 triage `suspect_repo` / `confidence` / `rationale` | 3 |
| §18.1 `AgentTask` | 4 |
| §18.2 thirteen sections in order, byte budgets, no inline diff for read-only roles, lockfiles never inlined | 4, 7 |
| §18.3 `AgentResult`, invalid output is one failed attempt with the error in the retry context | 3, 11 |
| §18.4 invocation, `--output-schema`, `--json`, `-o`, `--ephemeral`, no `resume`, no `--skip-git-repo-check`, JSONL usage, timeout kill, evidence file, pnpm store roots, Angular guidance, `danger-full-access` recorded in every checkpoint | 6, 8, 9, 10, 11 |
| §18.5 fake runner: patches, reports, results, persisted, by role and attempt | 12 |
| §18.6 profiles, ladders, `min(n, len-1)`, `model_switch`, no added budget, prompt versioning, experiment stamping | 5, 6, 9 |
| §19 "may not" list in every prompt | 6 |
| §20 `max_agent_runtime_minutes` as a ceiling | 8 |
| §21 checkpoint outcomes; §22 structured review findings; §23 QA; §24 `no_change_needed` | 3, 6 |
| §27 `agent.started`, `agent.finished`, `agent.model_switch` with their dimensions | 2, 9 |
| §28 `agents.roles.<role>` for all twelve roles | 1 |
| §31.29 no agent git write | 12, 14 |
| §32 rule 11 (never commit) and rule 12 (no secrets in evidence) | 6, 9, 12, 14 |
| `tasks.md` T05 done-when: adapter tests on recorded JSONL; fake runner drives a task; real smoke test | 11, 14 |

*Gaps found and closed:* §18.6's "recorded in the attempt record" and "recorded in state" both needed an explicit owner — both are now named in Decision 13 rather than left implied.

*Deliberately out of scope,* each marked in code: policy checks and the orchestrator commit (T08), `janus doctor`'s probes (T07), the CI and SCM providers (T09, T10), every stage step (T11+), `janus telemetry export|compare` (T21).

**2. Placeholder scan.** Searched for `TBD`, `TODO`, `implement later`, `fill in details`, `add appropriate error handling`, `add validation`, `handle edge cases`, `Similar to Task`, and trailing `etc.` — none present. Every code step carries the actual code. Two places tell the implementer to produce a value by running a command rather than transcribing one from the plan, which is deliberate because the plan cannot know it: the twelve prompt fingerprints (Task 6 Step 5, produced by the failing test's diff) and the T04 harness API shape (Task 14 Step 2, if T04 shipped a different signature).

**3. Type consistency.** Checked every name used across task boundaries:

- `AgentTask` / `AgentOutcome` / `AgentResult` / `AgentRunFailure` / `ResolvedModel` are defined once (Tasks 3, 4) and imported everywhere else. `AgentOutcome` gains exactly two fields in Task 9, and all three constructors of it (`stubOutcome`, the fake runner, the Codex adapter) are updated in the same task.
- `createFakeAgentRunner` changes its input from `{ fakeDir, now }` to `{ paths, now }` in Task 12; all three call sites (`createProviders`, `testProviders`, the harness) are named there, as is the matching `testProviders(fakeDir)` → `testProviders(paths)` change and its three callers.
- `sandboxClassFor` / `isCodeWriting` (Task 1) are used by Tasks 7, 8 under those names.
- `outputSchemaFor` / `resultSchemaFor` / `validateAgentResult` (Task 3) are used by Tasks 6, 8, 11, 12 under those names.
- `promptVersionFor` (Task 6) is used by Tasks 4, 7, 8; Task 4 ships a temporary local stub and Task 6 Step 8 removes it.
- `renderContextPackage(pkg, limits)` (Task 7) is called with the same two arguments by Tasks 11 and 13.
- `buildAgentTask` (Task 8) is called with the identical input object by Tasks 13 and 14.
- `runAgent({ engine, runner, task, previousModel })` (Task 9) is called with that exact shape by Tasks 13 and 14.
- `buildCodexArgs(task, { schemaPath, lastMessagePath })` (Task 11) is called with that exact shape by Task 13.

*Issues found and fixed:* (a) `EVENT_TYPES` was annotated `readonly EventType[]`, which would have made the `UnlistedEventType` exhaustiveness proof vacuously true — changed to `as const satisfies readonly EventType[]`; (b) `src/engine/recover.ts` emits `agent.finished` and would not have compiled against the closed union — its migration is now Task 2 Step 5 item 1, and Task 2's file list names it; (c) Task 8 Step 7 showed a first attempt at the handover note and then corrected it — rewritten to show only `UNSANDBOXED_NOTE`, and Task 8 Step 4 now exports that constant; (d) `janus agent run --task` resolved a relative path against `process.cwd()` instead of `ctx.io.cwd`, which would have broken under `runCli` — now `resolve(ctx.io.cwd, options.task)`; (e) Task 14 called `harness.evidence('run-0001.yaml')` but T04's helper takes the path relative to `evidence/` — corrected to `harness.evidence(join('agents', 'run-0001.yaml'))`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-20-t05-agent-runner.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
