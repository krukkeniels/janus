# T03 Engine Core: State Machine, Run Loop, Gates, Resume, Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Janus a real `janus run`: an explicit goal state machine, a step loop that brackets every step with `in_flight` and ends it with a checkpoint, resume reconciliation of repo heads, in-flight crash recovery, the §20 budget table with guardrail escalation, Gate 1 and Gate 2 through `janus approve --commit` and `janus reject`, and the telemetry events for all of it, so that a scripted run goes from `created` to `completed` with no providers.

**Architecture:** `src/engine/` is new and owns the machine: `transitions.ts` (pure allowed-transition table), `budgets.ts` (pure §20 table over `state.execution.budgets`), `engine.ts` (the `Engine` handle: workspace, clock, log, telemetry, checkpoint, `enterStage`), `steps.ts` (the pluggable `Step` registry; every real stage is a placeholder that stops the run with exit 3), `reconcile.ts` and `recover.ts` (§7 rules 2 and 3), `escalate.ts` (guardrail and step escalations write an `escalation.md` stub and move to `escalated`), `gates.ts` (enter, approve, reject), and `run-loop.ts` (`runEngine`). `src/workspace/open-workspace.ts` is the single entry every command uses to lock and load a workspace. The CLI commands `run`, `approve`, `reject` become real; `status` and `escalation` stay stubs for T14 and T13. Tests drive the machine with scripted steps against real temporary git repositories.

**Tech Stack:** Node 20+, TypeScript strict ESM (NodeNext), commander 14, zod 3, yaml 2, vitest, the system `git` binary.

**Spec:** `angular-ai-development-workflow-v2.md` §6 (state schema), §7 (checkpoint rule and resume semantics), §8 (CLI surface and run model), §9 (core workflow), §20 (guardrails and budget table), §25 (escalation), §26 (human gates), §27 (telemetry), §35 (operator skill consumes `--json`). Task definition: `tasks.md` T03. Builds on T01 (`docs/superpowers/plans/2026-09-19-t01-bootstrap-cli.md`) and T02 (`docs/superpowers/plans/2026-09-19-t02-state-workspace.md`).

## Global Constraints

- Node `>=20`; ESM (`"type": "module"`); relative imports use `.js` extensions; `import type` for type-only imports (ESLint `consistent-type-imports`); TypeScript `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (no `!` non-null assertions; narrow with `if`; never pass `undefined` to an optional property, spread it in conditionally).
- Package manager is `pnpm`; every commit message is `type(scope): subject` and ends, after a blank line, with the two trailer lines the controller gives the implementer.
- Exit codes come only from `src/cli/exit-codes.ts` (`Ok=0, UnexpectedError=1, UsageError=2, NotImplemented=3, GateWaiting=10, WaitExceeded=11, Escalated=12, Locked=13`). No new exit code is added in this plan.
- §6: "`state.yaml` is authoritative. Version 2. Fields may be added within v2 but not removed or repurposed." This plan adds `execution.in_flight.repo` and `execution.in_flight.budget`.
- §7: "Every meaningful state transition ends in a checkpoint commit on the state branch containing the updated `state.yaml`, regenerated `handover.md`, new evidence, and any `decisions.md` append."
- §7 rule 1: "A human gate is never entered before a checkpoint exists; `gate.checkpoint_commit` records it."
- §7 rule 2: "`janus run` starts by loading committed state, then reconciles with reality: for each repo it verifies the local goal branch head equals `repos.<name>.head_commit`, fetches the remote goal branch and base branch, and records drift. Non-fast-forward drift on a goal branch escalates. New base-branch commits are noted and handled by the sync step (§16.6)."
- §7 rule 3: "If `execution.in_flight.step` is set at load time, the previous process died mid-step: agent run: the uncommitted diff in the assigned repo is saved to `evidence/agents/<run-id>.interrupted.patch`, the tree is reset, the run counts as one failed attempt against the budget of its role (§20), and the step re-runs. CI or E2E wait: resume waiting on the recorded build id. any other step: re-run (all such steps are idempotent)."
- §7 rule 4: "State pushes are fast-forward only. If the remote state branch moved, `run` stops and asks the human to reconcile."
- §7 rule 6: "`janus.lock` stores PID and timestamp; a lock whose PID is dead is reclaimed with a warning."
- §8: "`janus run` advances step by step until a human gate, a blocking wait longer than `--max-wait`, an escalation, or completion. It prints a status summary and exits with a distinct exit code per reason." "Every step is bracketed by `in_flight` set/clear and ends with a checkpoint." "Gates 1 and 2 are passed only by `janus approve`, which requires `--commit` so approval is bound to an exact state-branch commit, and records the approver from git identity in `decisions.md`. Gates 3 and 4 are observed from the SCM provider (approvals and merges) and recorded on the next run."
- §9: "Escalation can happen from any autonomous step and leads to `escalated` -> human direction -> `replanning` -> GATE 2 -> `executing`."
- §20 budget table (counter: incremented when / reset when / escalates at): `ci_fix_attempts` (5), `e2e_fix_attempts` (3), `no_progress_iterations` (2), `work_packages_without_green` (3), `ai_review_cycles` (3), `policy_violations` per package (2), `sync_conflict_attempts` (2), `infra_retries` (1); "`max_changed_files`, `max_diff_lines`, `max_goal_runtime_hours` are null by default."
- §26: "Gate entry and exit times are recorded to measure human wait time."
- §27 event names used here: `stage.entered, stage.exited, agent.finished, budget.incremented, budget.reset, guardrail.hit, gate.entered, gate.passed, escalation.created, goal.completed`. Rulings (extensions, flagged in the report): `run.started`, `run.stopped` (the controller asked for run start/stop), `gate.rejected` (a gate exit that is not a pass), `repo.drift` (the "records drift" of §7 rule 2).
- §32 rule 14: "Approval commands bind to an explicit state-branch commit; no tool or skill may infer approval."
- Controller rulings: `openWorkspace(root)` is the single entry for `run`, `approve`, `reject` (and for `status`/`escalation` when T13/T14 implement them); resume reconciliation adopts fast-forward drift and escalates non-fast-forward drift on a goal branch; base-branch drift is only noted; `StateBranchDivergedError` keeps exit 1 but prints the reconcile instruction; every real stage step is a placeholder returning `not_implemented` with its task number; guardrail hits route to `escalated` with an `escalation.md` stub; `approve plan --commit <sha>` requires the sha to equal the current state-branch HEAD; `reject plan --reason` moves back to `planning`.
- Gate 2 ruling: the goal status while waiting at Gate 2 is `awaiting_plan_approval` with `gate.type = revised_plan_approval` (the status list in §6 has no separate waiting status for Gate 2); `reject plan` at Gate 2 returns to `replanning`.
- Gate checkpoint ruling: entering a gate is one checkpoint commit (C1) whose parent (C0) is the step-end checkpoint that existed before the gate was entered; `gate.checkpoint_commit = C0` (rule 1), and `approve --commit` must name C1, the state-branch HEAD at which the gate was entered.
- Budget ruling ("escalates at N"): a counter is `exhausted` once `value >= limit`; callers increment after an attempt finishes and call `checkGuardrail` before spending the next attempt, so exactly N attempts run before escalation and one infra retry runs before `infra_retries` (1) escalates.
- Every git-touching test uses real temporary repositories through `tests/helpers/git-fixtures.ts` and `tests/helpers/workspace-fixtures.ts`; the hermetic git identity in `vitest.config.ts` is `Janus Test <janus@test.invalid>`.

---

## File Structure

```text
src/engine/transitions.ts          TRANSITIONS table, HAPPY_PATH, allowedTransitions, canTransition, assertTransition, IllegalTransitionError
src/engine/budgets.ts              BUDGET_LIMIT_KEYS, budgetLimit, incrementBudget, resetBudget, checkGuardrail,
                                   incrementPolicyViolations, checkPolicyGuardrail, checkGoalRuntime, budgetSnapshot, GuardrailHit
src/engine/engine.ts               Engine handle: createEngine (now, log, warn, emit, checkpoint), enterStage (stage events)
src/engine/escalate.ts             escalate(): guardrail.hit + escalation.created events, escalation.md stub, -> escalated, checkpoint
src/engine/steps.ts                Step, StepContext, StepOutcome, StepRegistry, placeholderStep, startStep, defaultSteps, STEPLESS_STAGES
src/engine/reconcile.ts            reconcileRepos(): §7 rule 2 per repo (local drift, remote relation, base moved)
src/engine/recover.ts              recoverInFlight(): §7 rule 3 (interrupted patch, reset, budget increment, clear in_flight)
src/engine/gates.ts                CLI_GATES, isCliGate, gateStage, gateCommand, GateError, enterGate, approvePlan, rejectPlan
src/engine/run-loop.ts             runEngine(): recover, reconcile, step loop, stop reasons; describeNextStep() for --dry-run
src/git/identity.ts                gitIdentity(cwd) from `git var GIT_COMMITTER_IDENT`, parseIdent, formatIdentity
src/git/ops.ts                     modify: tryRevParse, fastForward
src/state/state-schema.ts          modify: BUDGET_NAMES/BudgetName, GATE_TYPES/GateType (Task 2); in_flight.repo, in_flight.budget, emptyInFlight (Task 8)
src/state/files.ts                 modify: ESCALATION_FILE, EVIDENCE_DIR
src/workspace/open-workspace.ts    Workspace type, isWorkspaceRoot, findWorkspaceRoot, openWorkspace (lock + load + verify + release)
src/cli/duration.ts                parseDuration('45m') -> ms
src/cli/context.ts                 modify: CliOverrides { steps } so tests inject a StepRegistry
src/cli/main.ts                    modify: main(argv, io, overrides); StateBranchDivergedError and GateError branches
src/cli/commands/run.ts            replace: real run (--until, --max-wait, --dry-run, --model-profile)
src/cli/commands/approve.ts        replace: real approve plan | revised-plan --commit
src/cli/commands/reject.ts         replace: real reject plan --reason
README.md                          modify: status and a "Running" section (Task 13)
tests/helpers/run-cli.ts           modify: third parameter for CliOverrides
tests/helpers/engine-fixtures.ts   initWorkspace, testEngine, createGoalBranch, advanceStep, scriptedSteps
tests/engine/transitions.test.ts, budgets.test.ts, engine.test.ts, escalate.test.ts, steps.test.ts,
tests/engine/reconcile.test.ts, recover.test.ts, gates.test.ts, run-loop.test.ts
tests/workspace/open-workspace.test.ts
tests/git/identity.test.ts, tests/git/ops.test.ts (modify: tryRevParse, fastForward)
tests/state/state-schema.test.ts   modify: BUDGET_NAMES/GATE_TYPES (Task 2), in_flight fields (Task 8)
tests/cli/duration.test.ts, run.test.ts, approve.test.ts, scripted-run.test.ts
tests/cli/commands.test.ts         modify: run/approve/reject leave the stub list
tests/cli/main.test.ts             modify: StateBranchDivergedError and GateError mappings
```

---

### Task 1: Goal transition table

**Files:**
- Create: `src/engine/transitions.ts`, `tests/engine/transitions.test.ts`

**Interfaces:**
- Consumes: `GOAL_STATUSES`, `GoalStatus` from `src/state/state-schema.ts` (T02).
- Produces: `TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>>`; `HAPPY_PATH: readonly GoalStatus[]`; `allowedTransitions(from: GoalStatus): readonly GoalStatus[]` (the table entry plus `escalated` for every non-terminal, non-escalated stage); `canTransition(from: GoalStatus, to: GoalStatus): boolean`; `assertTransition(from: GoalStatus, to: GoalStatus): void`; `class IllegalTransitionError extends Error { from: GoalStatus; to: GoalStatus }`.

- [ ] **Step 1: Write the failing tests**

`tests/engine/transitions.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  HAPPY_PATH,
  IllegalTransitionError,
  TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
} from '../../src/engine/transitions.js';
import { GOAL_STATUSES } from '../../src/state/state-schema.js';
import type { GoalStatus } from '../../src/state/state-schema.js';

describe('TRANSITIONS', () => {
  it('has exactly one entry per goal status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...GOAL_STATUSES].sort());
  });

  it('walks the §9 happy path from created to completed', () => {
    expect(HAPPY_PATH[0]).toBe('created');
    expect(HAPPY_PATH[HAPPY_PATH.length - 1]).toBe('completed');
    for (let i = 0; i + 1 < HAPPY_PATH.length; i += 1) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  const cases: Array<[GoalStatus, GoalStatus, boolean]> = [];
  for (const from of GOAL_STATUSES) {
    for (const to of GOAL_STATUSES) {
      const listed = TRANSITIONS[from].includes(to);
      const escalation = to === 'escalated' && from !== 'escalated' && from !== 'completed';
      cases.push([from, to, listed || escalation]);
    }
  }

  it.each(cases)('%s -> %s allowed: %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
    expect(allowedTransitions(from).includes(to)).toBe(expected);
    if (expected) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it('lets every non-terminal stage escalate, but not escalated or completed', () => {
    for (const from of GOAL_STATUSES) {
      const expected = from !== 'escalated' && from !== 'completed';
      expect(canTransition(from, 'escalated'), from).toBe(expected);
    }
  });

  it('routes gates: approval to executing, rejection back to planning or replanning, resolution to replanning', () => {
    expect(canTransition('awaiting_plan_approval', 'executing')).toBe(true);
    expect(canTransition('awaiting_plan_approval', 'planning')).toBe(true);
    expect(canTransition('awaiting_plan_approval', 'replanning')).toBe(true);
    expect(canTransition('escalated', 'replanning')).toBe(true);
    expect(canTransition('replanning', 'awaiting_plan_approval')).toBe(true);
    expect(canTransition('escalated', 'executing')).toBe(false);
  });

  it('makes completed terminal', () => {
    expect(allowedTransitions('completed')).toEqual([]);
  });

  it('names both stages in the error', () => {
    const error = new IllegalTransitionError('completed', 'created');
    expect(error.from).toBe('completed');
    expect(error.to).toBe('created');
    expect(error.message).toBe('illegal goal transition completed -> created; allowed: none');
    expect(new IllegalTransitionError('created', 'completed').message).toBe(
      'illegal goal transition created -> completed; allowed: preparing, escalated',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/transitions.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/transitions.js'".

- [ ] **Step 3: Write the transition table**

`src/engine/transitions.ts`:
```ts
import type { GoalStatus } from '../state/state-schema.js';

/**
 * Forward moves per stage (spec §9 workflow, §24 review and merge loops, §25 escalation). Every stage except
 * `escalated` and `completed` may additionally move to `escalated`; see `allowedTransitions`.
 */
export const TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  created: ['preparing'],
  preparing: ['discovering'],
  discovering: ['baselining'],
  baselining: ['planning'],
  planning: ['awaiting_plan_approval'],
  // approve -> executing; reject at Gate 1 -> planning; reject at Gate 2 -> replanning
  awaiting_plan_approval: ['executing', 'planning', 'replanning'],
  executing: ['final_e2e'],
  final_e2e: ['ai_review'],
  // findings -> fix -> CI -> E2E if invalidated -> review (§22); clean -> qa
  ai_review: ['qa', 'final_e2e'],
  qa: ['awaiting_human_review'],
  awaiting_human_review: ['fixing_review_feedback', 'awaiting_merge'],
  // fix -> CI -> E2E if invalidated -> AI review -> back to human review (§24)
  fixing_review_feedback: ['awaiting_human_review', 'ai_review', 'final_e2e'],
  awaiting_merge: ['releasing', 'completed'],
  releasing: ['awaiting_merge'],
  escalated: ['replanning'],
  replanning: ['awaiting_plan_approval'],
  completed: [],
};

/** The stage sequence of a goal with no findings, no review feedback, and no releases (§9). */
export const HAPPY_PATH: readonly GoalStatus[] = [
  'created',
  'preparing',
  'discovering',
  'baselining',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'final_e2e',
  'ai_review',
  'qa',
  'awaiting_human_review',
  'awaiting_merge',
  'completed',
];

export class IllegalTransitionError extends Error {
  readonly from: GoalStatus;
  readonly to: GoalStatus;

  constructor(from: GoalStatus, to: GoalStatus) {
    const allowed = allowedTransitions(from);
    super(`illegal goal transition ${from} -> ${to}; allowed: ${allowed.length === 0 ? 'none' : allowed.join(', ')}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function allowedTransitions(from: GoalStatus): readonly GoalStatus[] {
  const listed = TRANSITIONS[from];
  if (from === 'escalated' || from === 'completed') return listed;
  return [...listed, 'escalated'];
}

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export function assertTransition(from: GoalStatus, to: GoalStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/transitions.test.ts`
Expected: PASS (289 table-driven cases plus 6 others).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/transitions.ts tests/engine/transitions.test.ts
git commit -m "feat(engine): add the goal status transition table"
```

---

### Task 2: Budget table (§20)

**Files:**
- Create: `src/engine/budgets.ts`, `tests/engine/budgets.test.ts`
- Modify: `src/state/state-schema.ts` (add `BUDGET_NAMES`, `GATE_TYPES` and their types; use `GATE_TYPES` in the gate enum), `tests/state/state-schema.test.ts` (append two cases)

**Interfaces:**
- Consumes: `JanusState`, `createInitialState`, `workPackageStateSchema` (T02); `JanusConfig`, `parseConfig` (T01); `TelemetryEvent` (T02).
- Produces in `state-schema.ts`: `BUDGET_NAMES = ['ci_fix_attempts','e2e_fix_attempts','ai_review_cycles','no_progress_iterations','work_packages_without_green','sync_conflict_attempts','infra_retries'] as const`, `type BudgetName`, `GATE_TYPES = ['plan_approval','revised_plan_approval','pr_review','merge'] as const`, `type GateType`.
- Produces in `budgets.ts`: `interface BudgetContext { state: JanusState; config: JanusConfig; emit(event: TelemetryEvent): unknown }`; `interface GuardrailHit { guardrail: string; value: number; limit: number; detail: string }`; `interface BudgetIncrement { budget: string; value: number; limit: number; exhausted: boolean }`; `BUDGET_LIMIT_KEYS`; `budgetLimit(config, name): number`; `incrementBudget(ctx, name: BudgetName, reason: string): BudgetIncrement`; `resetBudget(ctx, name: BudgetName, reason: string): void`; `checkGuardrail(ctx, name: BudgetName): GuardrailHit | null`; `incrementPolicyViolations(ctx, workPackageId: string, repo: string, reason: string): BudgetIncrement`; `checkPolicyGuardrail(ctx, workPackageId, repo): GuardrailHit | null`; `checkGoalRuntime(ctx, now: Date): GuardrailHit | null`; `budgetSnapshot(state): Record<BudgetName, number>`.

- [ ] **Step 1: Add the schema constants**

In `src/state/state-schema.ts`, after `export type GoalStatus = ...`, add:
```ts
/** The seven counters of `execution.budgets` (spec §20). The per-package `policy_violations` counter lives in work packages. */
export const BUDGET_NAMES = [
  'ci_fix_attempts',
  'e2e_fix_attempts',
  'ai_review_cycles',
  'no_progress_iterations',
  'work_packages_without_green',
  'sync_conflict_attempts',
  'infra_retries',
] as const;

export type BudgetName = (typeof BUDGET_NAMES)[number];

export const GATE_TYPES = ['plan_approval', 'revised_plan_approval', 'pr_review', 'merge'] as const;

export type GateType = (typeof GATE_TYPES)[number];
```
and in the `gate` object replace `type: z.enum(['plan_approval', 'revised_plan_approval', 'pr_review', 'merge']).nullable().default(null),` with `type: z.enum(GATE_TYPES).nullable().default(null),`.

Append to `tests/state/state-schema.test.ts` (inside its top-level `describe`, or as a new `describe` at the end):
```ts
describe('schema constants', () => {
  it('BUDGET_NAMES matches the budgets object', () => {
    expect(Object.keys(initial().execution.budgets).sort()).toEqual([...BUDGET_NAMES].sort());
  });

  it('GATE_TYPES is what the gate enum accepts', () => {
    for (const type of GATE_TYPES) {
      const state = initial();
      state.gate.type = type;
      expect(stateSchema.parse(state).gate.type).toBe(type);
    }
  });
});
```
Add `BUDGET_NAMES` and `GATE_TYPES` to that file's existing import from `../../src/state/state-schema.js`; `initial()` is the helper already defined at the top of the file.

Run: `pnpm vitest run tests/state/state-schema.test.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing budget tests**

`tests/engine/budgets.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/load-config.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import {
  BUDGET_LIMIT_KEYS,
  budgetLimit,
  budgetSnapshot,
  checkGoalRuntime,
  checkGuardrail,
  checkPolicyGuardrail,
  incrementBudget,
  incrementPolicyViolations,
  resetBudget,
} from '../../src/engine/budgets.js';
import type { BudgetContext } from '../../src/engine/budgets.js';
import { BUDGET_NAMES, createInitialState, workPackageStateSchema } from '../../src/state/state-schema.js';
import type { BudgetName } from '../../src/state/state-schema.js';
import type { TelemetryEvent } from '../../src/telemetry/events.js';
import { validGoal } from '../fixtures/valid-goal.js';

const goal = goalSchema.parse(validGoal);

const LIMITS: Record<BudgetName, number> = {
  ci_fix_attempts: 1,
  e2e_fix_attempts: 2,
  ai_review_cycles: 3,
  no_progress_iterations: 4,
  work_packages_without_green: 5,
  sync_conflict_attempts: 6,
  infra_retries: 7,
};

function context(overrides: Record<string, unknown> = {}): BudgetContext & { events: TelemetryEvent[] } {
  const config = parseConfig(
    {
      workflow: { agent_runner: 'fake', ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: {
        max_ci_fix_attempts: 1,
        max_e2e_fix_attempts: 2,
        max_ai_review_cycles: 3,
        max_no_progress_iterations: 4,
        max_work_packages_without_green: 5,
        max_sync_conflict_attempts: 6,
        max_infra_retries: 7,
        max_policy_violations_per_package: 2,
        ...overrides,
      },
    },
    'test-config',
  );
  const state = createInitialState({ goal, stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' }, now: new Date('2026-09-19T10:00:00.000Z') });
  const events: TelemetryEvent[] = [];
  return { state, config, events, emit: (event) => events.push(event) };
}

describe('budget limits', () => {
  it.each(BUDGET_NAMES)('%s is capped by its guardrails key', (name) => {
    const ctx = context();
    expect(BUDGET_LIMIT_KEYS[name]).toBe(`max_${name}`);
    expect(budgetLimit(ctx.config, name)).toBe(LIMITS[name]);
  });
});

describe('incrementBudget / checkGuardrail', () => {
  it.each(BUDGET_NAMES)('%s counts up, emits, and is exhausted at its limit', (name) => {
    const ctx = context();
    const limit = LIMITS[name];
    for (let i = 1; i < limit; i += 1) {
      const result = incrementBudget(ctx, name, `attempt ${i}`);
      expect(result).toEqual({ budget: name, value: i, limit, exhausted: false });
      expect(checkGuardrail(ctx, name)).toBeNull();
    }
    const last = incrementBudget(ctx, name, 'last attempt');
    expect(last).toEqual({ budget: name, value: limit, limit, exhausted: true });
    expect(ctx.state.execution.budgets[name]).toBe(limit);
    expect(checkGuardrail(ctx, name)).toEqual({ guardrail: name, value: limit, limit, detail: `${name} is ${limit} of ${limit}` });
    expect(ctx.events.filter((event) => event.type === 'budget.incremented')).toHaveLength(limit);
    expect(ctx.events[ctx.events.length - 1]).toEqual({ type: 'budget.incremented', budget: name, value: limit, limit, reason: 'last attempt' });
  });

  it('keeps counting past the limit so the caller sees how far it went', () => {
    const ctx = context();
    incrementBudget(ctx, 'ci_fix_attempts', 'one');
    expect(incrementBudget(ctx, 'ci_fix_attempts', 'two').value).toBe(2);
    expect(checkGuardrail(ctx, 'ci_fix_attempts')?.value).toBe(2);
  });
});

describe('resetBudget', () => {
  it('zeroes the counter and emits budget.reset with the previous value', () => {
    const ctx = context();
    incrementBudget(ctx, 'e2e_fix_attempts', 'x');
    incrementBudget(ctx, 'e2e_fix_attempts', 'y');
    resetBudget(ctx, 'e2e_fix_attempts', 'E2E passed');
    expect(ctx.state.execution.budgets.e2e_fix_attempts).toBe(0);
    expect(ctx.events[ctx.events.length - 1]).toEqual({ type: 'budget.reset', budget: 'e2e_fix_attempts', previous: 2, reason: 'E2E passed' });
  });

  it('is silent when the counter is already zero', () => {
    const ctx = context();
    resetBudget(ctx, 'infra_retries', 'build finished');
    expect(ctx.events).toEqual([]);
  });
});

describe('policy violations per package', () => {
  function withPackage(ctx: BudgetContext): void {
    ctx.state.execution.work_packages['wp-01-ui-kit-angular'] = workPackageStateSchema.parse({ repos: { 'ui-kit': {} } });
  }

  it('counts on the work package repo entry and is exhausted at max_policy_violations_per_package', () => {
    const ctx = context();
    withPackage(ctx);
    expect(incrementPolicyViolations(ctx, 'wp-01-ui-kit-angular', 'ui-kit', 'xit( found')).toEqual({ budget: 'policy_violations', value: 1, limit: 2, exhausted: false });
    expect(checkPolicyGuardrail(ctx, 'wp-01-ui-kit-angular', 'ui-kit')).toBeNull();
    expect(incrementPolicyViolations(ctx, 'wp-01-ui-kit-angular', 'ui-kit', 'again').exhausted).toBe(true);
    expect(ctx.state.execution.work_packages['wp-01-ui-kit-angular']?.repos['ui-kit']?.policy_violations).toBe(2);
    expect(checkPolicyGuardrail(ctx, 'wp-01-ui-kit-angular', 'ui-kit')).toEqual({
      guardrail: 'policy_violations',
      value: 2,
      limit: 2,
      detail: 'wp-01-ui-kit-angular/ui-kit policy_violations is 2 of 2',
    });
    expect(ctx.events[0]).toEqual({ type: 'budget.incremented', budget: 'policy_violations', work_package: 'wp-01-ui-kit-angular', repo: 'ui-kit', value: 1, limit: 2, reason: 'xit( found' });
  });

  it('refuses an unknown package or repo', () => {
    const ctx = context();
    withPackage(ctx);
    expect(() => incrementPolicyViolations(ctx, 'wp-99', 'ui-kit', 'x')).toThrow('work package wp-99 has no repo ui-kit');
    expect(() => incrementPolicyViolations(ctx, 'wp-01-ui-kit-angular', 'shell', 'x')).toThrow('work package wp-01-ui-kit-angular has no repo shell');
  });
});

describe('checkGoalRuntime', () => {
  it('is null when max_goal_runtime_hours is null (the default)', () => {
    const ctx = context();
    expect(checkGoalRuntime(ctx, new Date('2030-01-01T00:00:00.000Z'))).toBeNull();
  });

  it('hits once the goal has run for the configured hours', () => {
    const ctx = context({ max_goal_runtime_hours: 2 });
    expect(checkGoalRuntime(ctx, new Date('2026-09-19T11:59:00.000Z'))).toBeNull();
    expect(checkGoalRuntime(ctx, new Date('2026-09-19T12:00:00.000Z'))).toEqual({
      guardrail: 'goal_runtime_hours',
      value: 2,
      limit: 2,
      detail: 'goal started 2026-09-19T10:00:00.000Z',
    });
  });
});

describe('budgetSnapshot', () => {
  it('copies every counter', () => {
    const ctx = context();
    incrementBudget(ctx, 'sync_conflict_attempts', 'x');
    const snapshot = budgetSnapshot(ctx.state);
    expect(snapshot.sync_conflict_attempts).toBe(1);
    expect(Object.keys(snapshot).sort()).toEqual([...BUDGET_NAMES].sort());
    snapshot.sync_conflict_attempts = 99;
    expect(ctx.state.execution.budgets.sync_conflict_attempts).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/budgets.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/budgets.js'".

- [ ] **Step 4: Write the budget module**

`src/engine/budgets.ts`:
```ts
import type { JanusConfig } from '../config/config-schema.js';
import { BUDGET_NAMES } from '../state/state-schema.js';
import type { BudgetName, JanusState } from '../state/state-schema.js';
import type { TelemetryEvent } from '../telemetry/events.js';

export interface BudgetContext {
  state: JanusState;
  config: JanusConfig;
  emit(event: TelemetryEvent): unknown;
}

/** A limit that was reached. `guardrail` is a budget name, `policy_violations`, or `goal_runtime_hours`. */
export interface GuardrailHit {
  guardrail: string;
  value: number;
  limit: number;
  detail: string;
}

export interface BudgetIncrement {
  budget: string;
  value: number;
  limit: number;
  /** `value >= limit`: the next attempt must not be started; escalate instead (spec §20 "escalates at"). */
  exhausted: boolean;
}

type Guardrails = JanusConfig['guardrails'];
type NumericGuardrailKey = { [K in keyof Guardrails]: Guardrails[K] extends number ? K : never }[keyof Guardrails];

/** Spec §20: the config key that caps each counter. */
export const BUDGET_LIMIT_KEYS: Readonly<Record<BudgetName, NumericGuardrailKey>> = {
  ci_fix_attempts: 'max_ci_fix_attempts',
  e2e_fix_attempts: 'max_e2e_fix_attempts',
  ai_review_cycles: 'max_ai_review_cycles',
  no_progress_iterations: 'max_no_progress_iterations',
  work_packages_without_green: 'max_work_packages_without_green',
  sync_conflict_attempts: 'max_sync_conflict_attempts',
  infra_retries: 'max_infra_retries',
};

export function budgetLimit(config: JanusConfig, name: BudgetName): number {
  return config.guardrails[BUDGET_LIMIT_KEYS[name]];
}

export function incrementBudget(ctx: BudgetContext, name: BudgetName, reason: string): BudgetIncrement {
  const value = ctx.state.execution.budgets[name] + 1;
  ctx.state.execution.budgets[name] = value;
  const limit = budgetLimit(ctx.config, name);
  ctx.emit({ type: 'budget.incremented', budget: name, value, limit, reason });
  return { budget: name, value, limit, exhausted: value >= limit };
}

export function resetBudget(ctx: BudgetContext, name: BudgetName, reason: string): void {
  const previous = ctx.state.execution.budgets[name];
  if (previous === 0) return;
  ctx.state.execution.budgets[name] = 0;
  ctx.emit({ type: 'budget.reset', budget: name, previous, reason });
}

/** Null while another attempt may be spent; a hit once the counter reached its limit. */
export function checkGuardrail(ctx: BudgetContext, name: BudgetName): GuardrailHit | null {
  const value = ctx.state.execution.budgets[name];
  const limit = budgetLimit(ctx.config, name);
  if (value < limit) return null;
  return { guardrail: name, value, limit, detail: `${name} is ${value} of ${limit}` };
}

function packageRepo(ctx: BudgetContext, workPackageId: string, repo: string) {
  const entry = ctx.state.execution.work_packages[workPackageId]?.repos[repo];
  if (entry === undefined) throw new Error(`work package ${workPackageId} has no repo ${repo}`);
  return entry;
}

export function incrementPolicyViolations(ctx: BudgetContext, workPackageId: string, repo: string, reason: string): BudgetIncrement {
  const entry = packageRepo(ctx, workPackageId, repo);
  entry.policy_violations += 1;
  const value = entry.policy_violations;
  const limit = ctx.config.guardrails.max_policy_violations_per_package;
  ctx.emit({ type: 'budget.incremented', budget: 'policy_violations', work_package: workPackageId, repo, value, limit, reason });
  return { budget: 'policy_violations', value, limit, exhausted: value >= limit };
}

export function checkPolicyGuardrail(ctx: BudgetContext, workPackageId: string, repo: string): GuardrailHit | null {
  const value = packageRepo(ctx, workPackageId, repo).policy_violations;
  const limit = ctx.config.guardrails.max_policy_violations_per_package;
  if (value < limit) return null;
  return { guardrail: 'policy_violations', value, limit, detail: `${workPackageId}/${repo} policy_violations is ${value} of ${limit}` };
}

/** `max_goal_runtime_hours` (null by default) measured from `telemetry.started_at`. */
export function checkGoalRuntime(ctx: BudgetContext, now: Date): GuardrailHit | null {
  const limit = ctx.config.guardrails.max_goal_runtime_hours;
  const started = ctx.state.telemetry.started_at;
  if (limit === null || started === null) return null;
  const elapsedHours = (now.getTime() - Date.parse(started)) / 3_600_000;
  if (elapsedHours < limit) return null;
  return { guardrail: 'goal_runtime_hours', value: Math.floor(elapsedHours), limit, detail: `goal started ${started}` };
}

export function budgetSnapshot(state: JanusState): Record<BudgetName, number> {
  const snapshot = {} as Record<BudgetName, number>;
  for (const name of BUDGET_NAMES) snapshot[name] = state.execution.budgets[name];
  return snapshot;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/budgets.test.ts tests/state/state-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/budgets.ts src/state/state-schema.ts tests/engine/budgets.test.ts tests/state/state-schema.test.ts
git commit -m "feat(engine): add the budget table with increment, reset, and guardrail checks"
```

---

### Task 3: `openWorkspace`: lock, load, verify, release

**Files:**
- Create: `src/workspace/open-workspace.ts`, `tests/workspace/open-workspace.test.ts`, `tests/helpers/engine-fixtures.ts`

**Interfaces:**
- Consumes: `workspacePaths`, `WorkspacePaths` (T02 layout); `acquireLock`, `releaseLock`, `LockInfo` (T02 lock); `readState` (T02); `loadGoal`, `loadConfig` (T01); `currentBranch` (T02 ops); `runGit` (T02); `stateBranchName`, `stateRemote` (T02 remotes); `STATE_FILE`, `GOAL_FILE`, `CONFIG_FILE` (T02 files); `ConfigError` (T01); test helpers `goalFixture`, `tempDir`, `runCli`.
- Produces: `interface Workspace { paths: WorkspacePaths; state: JanusState; goal: Goal; repoOrder: string[]; config: JanusConfig; stateRemoteUrl: string; reclaimedLock: LockInfo | null; release(): void }`; `isWorkspaceRoot(dir: string): boolean`; `findWorkspaceRoot(cwd: string): string` (nearest ancestor with `.janus/state.yaml`, else `ConfigError`); `openWorkspace(root: string, options?: { now?: Date }): Promise<Workspace>` (throws `WorkspaceLockedError` when a live process holds the lock and `ConfigError` when `.janus/` is not on `janus/<goal-id>` or `origin` is not the configured state remote; the lock is released on every failure). Test helper `initWorkspace(): Promise<{ fixture: GoalFixture; root: string; janusDir: string }>` which runs `janus init --goal` against `goalFixture()`.

- [ ] **Step 1: Write the test helper and the failing tests**

`tests/helpers/engine-fixtures.ts`:
```ts
import { join } from 'node:path';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { tempDir } from './git-fixtures.js';
import { runCli } from './run-cli.js';
import { goalFixture } from './workspace-fixtures.js';
import type { GoalFixture } from './workspace-fixtures.js';

export interface WorkspaceFixture {
  fixture: GoalFixture;
  root: string;
  janusDir: string;
}

/** A freshly initialized workspace (status `created`) built by `janus init --goal` against temp bare remotes. */
export async function initWorkspace(): Promise<WorkspaceFixture> {
  const fixture = await goalFixture();
  const root = join(tempDir(), 'ws');
  const result = await runCli(['init', '--goal', fixture.goalPath, '--workspace', root]);
  if (result.code !== ExitCode.Ok) throw new Error(`janus init failed (${result.code}): ${result.stderr}`);
  return { fixture, root, janusDir: join(root, '.janus') };
}
```

`tests/workspace/open-workspace.test.ts`:
```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { runGit } from '../../src/git/run.js';
import { acquireLock, WorkspaceLockedError } from '../../src/workspace/lock.js';
import { findWorkspaceRoot, isWorkspaceRoot, openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

/** The pid of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync('true');
  if (child.pid === undefined) throw new Error('could not spawn a process');
  return child.pid;
}

describe('findWorkspaceRoot', () => {
  it('finds the root from the root itself and from a nested directory', async () => {
    const ws = await initWorkspace();
    expect(isWorkspaceRoot(ws.root)).toBe(true);
    expect(findWorkspaceRoot(ws.root)).toBe(ws.root);
    expect(findWorkspaceRoot(join(ws.root, 'repos', 'ui-kit'))).toBe(ws.root);
  });

  it('fails outside a workspace', () => {
    const dir = tempDir();
    expect(() => findWorkspaceRoot(dir)).toThrow(ConfigError);
    expect(() => findWorkspaceRoot(dir)).toThrow('not inside a janus workspace');
  });
});

describe('openWorkspace', () => {
  it('locks, loads state, goal, config, and repo order, and releases', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      expect(existsSync(join(ws.root, 'janus.lock'))).toBe(true);
      expect(workspace.paths.root).toBe(ws.root);
      expect(workspace.state.goal.id).toBe(ws.fixture.goalId);
      expect(workspace.goal.id).toBe(ws.fixture.goalId);
      expect(workspace.repoOrder).toEqual(['ui-kit', 'shell']);
      expect(workspace.config.workflow.ci_provider).toBe('fake');
      expect(workspace.stateRemoteUrl).toBe(ws.fixture.stateBare);
      expect(workspace.reclaimedLock).toBeNull();
    } finally {
      workspace.release();
    }
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
    workspace.release(); // idempotent
  });

  it('refuses a workspace held by a live process', async () => {
    const ws = await initWorkspace();
    const first = await openWorkspace(ws.root);
    try {
      await expect(openWorkspace(ws.root)).rejects.toBeInstanceOf(WorkspaceLockedError);
    } finally {
      first.release();
    }
  });

  it('reclaims a stale lock and reports it', async () => {
    const ws = await initWorkspace();
    const pid = deadPid();
    acquireLock(join(ws.root, 'janus.lock'), new Date('2026-09-19T00:00:00.000Z'), pid);
    const workspace = await openWorkspace(ws.root);
    try {
      expect(workspace.reclaimedLock?.pid).toBe(pid);
    } finally {
      workspace.release();
    }
  });

  it('refuses a directory that is not a workspace without leaving a lock behind', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, '.janus'));
    await expect(openWorkspace(dir)).rejects.toThrow('not a janus workspace');
    expect(existsSync(join(dir, 'janus.lock'))).toBe(false);
  });

  it('refuses .janus on the wrong branch and releases the lock', async () => {
    const ws = await initWorkspace();
    await runGit(ws.janusDir, ['checkout', '-q', '-b', 'scratch']);
    await expect(openWorkspace(ws.root)).rejects.toThrow('.janus is on branch scratch, expected janus/angular-15-to-16');
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
  });

  it('refuses .janus whose origin is not the configured state remote', async () => {
    const ws = await initWorkspace();
    await runGit(ws.janusDir, ['remote', 'set-url', 'origin', '/nowhere/state.git']);
    await expect(openWorkspace(ws.root)).rejects.toThrow('.janus origin is /nowhere/state.git, expected the state remote');
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/workspace/open-workspace.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/workspace/open-workspace.js'".

- [ ] **Step 3: Write `openWorkspace`**

`src/workspace/open-workspace.ts`:
```ts
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { JanusConfig } from '../config/config-schema.js';
import { ConfigError } from '../config/errors.js';
import type { Goal } from '../config/goal-schema.js';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import { currentBranch } from '../git/ops.js';
import { runGit } from '../git/run.js';
import { CONFIG_FILE, GOAL_FILE, STATE_FILE } from '../state/files.js';
import type { JanusState } from '../state/state-schema.js';
import { readState } from '../state/state-store.js';
import { workspacePaths } from './layout.js';
import type { WorkspacePaths } from './layout.js';
import { acquireLock, releaseLock } from './lock.js';
import type { LockInfo } from './lock.js';
import { stateBranchName, stateRemote } from './remotes.js';

/** An opened, locked goal workspace. `state` is the live runtime state: mutate it and checkpoint; never re-read it while open. */
export interface Workspace {
  paths: WorkspacePaths;
  state: JanusState;
  goal: Goal;
  repoOrder: string[];
  config: JanusConfig;
  /** Clone URL that `.janus/`'s `origin` points at. */
  stateRemoteUrl: string;
  reclaimedLock: LockInfo | null;
  /** Releases the lock. Safe to call more than once. */
  release(): void;
}

export function isWorkspaceRoot(dir: string): boolean {
  return existsSync(join(dir, '.janus', STATE_FILE));
}

/** The nearest directory at or above `cwd` that holds `.janus/state.yaml`. */
export function findWorkspaceRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (isWorkspaceRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError(cwd, ['not inside a janus workspace (no .janus/state.yaml here or in any parent directory)']);
    }
    dir = parent;
  }
}

export interface OpenWorkspaceOptions {
  now?: Date;
}

/**
 * Locks the workspace and loads everything a command needs, verifying that `.janus/` is the state branch checkout
 * of this goal and that its `origin` is the configured state remote. The caller must `release()`.
 */
export async function openWorkspace(root: string, options: OpenWorkspaceOptions = {}): Promise<Workspace> {
  const paths = workspacePaths(root);
  if (!isWorkspaceRoot(paths.root)) {
    throw new ConfigError(paths.root, ['not a janus workspace: .janus/state.yaml not found']);
  }
  const { reclaimed } = acquireLock(paths.lockFile, options.now ?? new Date());
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseLock(paths.lockFile);
  };
  try {
    const state = readState(paths.janusDir);
    const { goal, repoOrder } = loadGoal(join(paths.janusDir, GOAL_FILE));
    const config = loadConfig(join(paths.janusDir, CONFIG_FILE));
    const issues: string[] = [];
    const expectedBranch = stateBranchName(state.goal.id);
    if (goal.id !== state.goal.id) issues.push(`goal.yaml id ${goal.id} does not match state goal id ${state.goal.id}`);
    if (state.state_branch.name !== expectedBranch) {
      issues.push(`state_branch.name is ${state.state_branch.name}, expected ${expectedBranch}`);
    }
    const branch = await currentBranch(paths.janusDir);
    if (branch !== expectedBranch) issues.push(`.janus is on branch ${branch ?? '(detached HEAD)'}, expected ${expectedBranch}`);
    const originUrl = await runGit(paths.janusDir, ['remote', 'get-url', 'origin']);
    const remote = stateRemote(goal, config);
    if (originUrl !== remote.url) issues.push(`.janus origin is ${originUrl}, expected the state remote ${remote.url}`);
    if (state.state_branch.remote !== remote.remoteName) {
      issues.push(`state_branch.remote is ${state.state_branch.remote}, expected ${remote.remoteName}`);
    }
    if (issues.length > 0) throw new ConfigError(paths.janusDir, issues);
    return { paths, state, goal, repoOrder, config, stateRemoteUrl: originUrl, reclaimedLock: reclaimed, release };
  } catch (error) {
    release();
    throw error;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/workspace/open-workspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/workspace/open-workspace.ts tests/workspace/open-workspace.test.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(workspace): open a locked workspace with verified state branch and remote"
```

---

### Task 4: Engine handle and `enterStage`

**Files:**
- Create: `src/engine/engine.ts`, `tests/engine/engine.test.ts`
- Modify: `tests/helpers/engine-fixtures.ts` (add `testEngine`)

**Interfaces:**
- Consumes: `Workspace`, `openWorkspace` (Task 3); `assertTransition` (Task 1); `checkpoint`, `CheckpointResult` (T02); `DecisionEntry` (T02); `appendEvent`, `readEvents`, `TelemetryEvent`, `RecordedEvent` (T02); `GoalStatus` (T02).
- Produces: `interface Engine { readonly workspace: Workspace; now(): Date; log(line: string): void; warn(line: string): void; emit(event: TelemetryEvent): RecordedEvent; checkpoint(message: string, decision?: DecisionEntry): Promise<CheckpointResult> }`; `createEngine({ workspace, log, warn, now?: () => Date, push?: boolean }): Engine` (`push` defaults to `true`); `interface StageTransition { from: GoalStatus; to: GoalStatus; at: string }`; `enterStage(engine: Engine, to: GoalStatus): StageTransition` (validates through `assertTransition`, emits `stage.exited` then `stage.entered`, plus `goal.completed` when entering `completed`; does not checkpoint). Test helper `testEngine(workspace: Workspace, now?: () => Date): { engine: Engine; lines: string[]; warnings: string[] }`.

- [ ] **Step 1: Add the helper and write the failing tests**

Append to `tests/helpers/engine-fixtures.ts`:
```ts
import { createEngine } from '../../src/engine/engine.js';
import type { Engine } from '../../src/engine/engine.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';

export interface TestEngine {
  engine: Engine;
  lines: string[];
  warnings: string[];
}

/** An engine that pushes to the fixture's bare state remote and captures log output. */
export function testEngine(workspace: Workspace, now?: () => Date): TestEngine {
  const lines: string[] = [];
  const warnings: string[] = [];
  const engine = createEngine({
    workspace,
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...(now === undefined ? {} : { now }),
  });
  return { engine, lines, warnings };
}
```
(Move the new `import` lines to the top of the file with the others.)

`tests/engine/engine.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enterStage } from '../../src/engine/engine.js';
import { IllegalTransitionError } from '../../src/engine/transitions.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';

describe('createEngine', () => {
  it('emits events with the engine clock and checkpoints with push and decision', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const now = new Date('2026-09-19T14:00:00.000Z');
      const { engine, lines, warnings } = testEngine(workspace, () => now);
      engine.log('hello');
      engine.warn('careful');
      expect(lines).toEqual(['hello']);
      expect(warnings).toEqual(['careful']);
      const recorded = engine.emit({ type: 'stage.entered', stage: 'preparing' });
      expect(recorded.timestamp).toBe('2026-09-19T14:00:00.000Z');
      const result = await engine.checkpoint('chore(janus): test checkpoint', {
        at: now.toISOString(),
        by: 'test',
        title: 'Test decision',
        body: 'because',
      });
      expect(result.pushed).toBe(true);
      expect(await revParse(ws.janusDir, 'HEAD')).toBe(result.commit);
      expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.commit);
      expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): test checkpoint');
      expect(readState(ws.janusDir).telemetry.last_updated_at).toBe('2026-09-19T14:00:00.000Z');
      expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Test decision');
      expect(readEvents(ws.janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
      expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toBe('');
    } finally {
      workspace.release();
    }
  });
});

describe('enterStage', () => {
  it('moves the status and records stage.exited then stage.entered', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, () => new Date('2026-09-19T14:00:00.000Z'));
      const transition = enterStage(engine, 'preparing');
      expect(transition).toEqual({ from: 'created', to: 'preparing', at: '2026-09-19T14:00:00.000Z' });
      expect(workspace.state.goal.status).toBe('preparing');
      const events = readEvents(ws.janusDir).slice(1);
      expect(events).toEqual([
        { timestamp: '2026-09-19T14:00:00.000Z', type: 'stage.exited', stage: 'created', to: 'preparing' },
        { timestamp: '2026-09-19T14:00:00.000Z', type: 'stage.entered', stage: 'preparing', from: 'created' },
      ]);
    } finally {
      workspace.release();
    }
  });

  it('adds goal.completed when entering completed', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'awaiting_merge';
      enterStage(engine, 'completed');
      const types = readEvents(ws.janusDir).map((event) => event['type']);
      expect(types.slice(-3)).toEqual(['stage.exited', 'stage.entered', 'goal.completed']);
    } finally {
      workspace.release();
    }
  });

  it('refuses an illegal transition and leaves state and events untouched', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      expect(() => enterStage(engine, 'executing')).toThrow(IllegalTransitionError);
      expect(workspace.state.goal.status).toBe('created');
      expect(readEvents(ws.janusDir)).toHaveLength(1);
    } finally {
      workspace.release();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/engine.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/engine.js'".

- [ ] **Step 3: Write the engine handle**

`src/engine/engine.ts`:
```ts
import { checkpoint } from '../state/checkpoint.js';
import type { CheckpointResult } from '../state/checkpoint.js';
import type { DecisionEntry } from '../state/decisions.js';
import type { GoalStatus } from '../state/state-schema.js';
import { appendEvent } from '../telemetry/events.js';
import type { RecordedEvent, TelemetryEvent } from '../telemetry/events.js';
import type { Workspace } from '../workspace/open-workspace.js';
import { assertTransition } from './transitions.js';

/** Everything a step or gate needs: the live workspace, a clock, output, telemetry, and checkpoints. */
export interface Engine {
  readonly workspace: Workspace;
  now(): Date;
  log(line: string): void;
  warn(line: string): void;
  emit(event: TelemetryEvent): RecordedEvent;
  /** Spec §7: commits state.yaml, handover.md, evidence, and any decision on the state branch and pushes fast-forward. */
  checkpoint(message: string, decision?: DecisionEntry): Promise<CheckpointResult>;
}

export interface CreateEngineInput {
  workspace: Workspace;
  log(line: string): void;
  warn(line: string): void;
  now?: () => Date;
  /** Push every checkpoint (default true). Tests without a reachable state remote may turn it off. */
  push?: boolean;
}

export function createEngine(input: CreateEngineInput): Engine {
  const now = input.now ?? (() => new Date());
  const push = input.push ?? true;
  const { janusDir } = input.workspace.paths;
  return {
    workspace: input.workspace,
    now,
    log: input.log,
    warn: input.warn,
    emit: (event) => appendEvent(janusDir, event, now()),
    checkpoint: (message, decision) =>
      checkpoint({
        janusDir,
        state: input.workspace.state,
        goal: input.workspace.goal,
        message,
        push,
        now: now(),
        ...(decision === undefined ? {} : { decision }),
      }),
  };
}

export interface StageTransition {
  from: GoalStatus;
  to: GoalStatus;
  at: string;
}

/** Moves the goal to `to` (spec §9), refusing illegal moves, and records `stage.exited` / `stage.entered` (§27). Does not checkpoint. */
export function enterStage(engine: Engine, to: GoalStatus): StageTransition {
  const { state } = engine.workspace;
  const from = state.goal.status;
  assertTransition(from, to);
  const at = engine.now().toISOString();
  engine.emit({ type: 'stage.exited', stage: from, to });
  state.goal.status = to;
  engine.emit({ type: 'stage.entered', stage: to, from });
  if (to === 'completed') engine.emit({ type: 'goal.completed', goal_id: state.goal.id });
  return { from, to, at };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(engine): add the engine handle with telemetry, checkpoints, and stage entry"
```

---

### Task 5: Escalation with an `escalation.md` stub

**Files:**
- Create: `src/engine/escalate.ts`, `tests/engine/escalate.test.ts`
- Modify: `src/state/files.ts` (add `ESCALATION_FILE`, `EVIDENCE_DIR`)

**Interfaces:**
- Consumes: `Engine`, `enterStage` (Task 4); `GuardrailHit`, `budgetSnapshot` (Task 2); `BUDGET_NAMES`, `JanusState`, `GoalStatus` (Task 2 / T02); `CheckpointResult` (T02).
- Produces in `files.ts`: `ESCALATION_FILE = 'escalation.md'`, `EVIDENCE_DIR = 'evidence'`. Produces in `escalate.ts`: `interface EscalationInput { reason: string; repo: string | null; guardrail: GuardrailHit | null }`; `interface EscalationResult { from: GoalStatus; file: string; checkpoint: CheckpointResult }`; `escalate(engine: Engine, input: EscalationInput): Promise<EscalationResult>` (emits `guardrail.hit` when a guardrail is given, writes `.janus/escalation.md`, emits `escalation.created`, enters `escalated`, checkpoints with a decision); `renderEscalationStub(state: JanusState, input: EscalationInput, now: Date): string`.

- [ ] **Step 1: Add the file constants and write the failing tests**

Append to `src/state/files.ts`:
```ts
export const ESCALATION_FILE = 'escalation.md';
export const EVIDENCE_DIR = 'evidence';
```

`tests/engine/escalate.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escalate, renderEscalationStub } from '../../src/engine/escalate.js';
import { IllegalTransitionError } from '../../src/engine/transitions.js';
import { remoteHead } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';

describe('escalate', () => {
  it('writes escalation.md, records the events, enters escalated, and checkpoints', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const now = new Date('2026-09-19T15:00:00.000Z');
      const { engine, warnings } = testEngine(workspace, () => now);
      workspace.state.goal.status = 'executing';
      workspace.state.execution.current_work_package = 'wp-01-ui-kit-angular';
      workspace.state.execution.budgets.ci_fix_attempts = 5;
      const result = await escalate(engine, {
        reason: 'ci_fix_attempts exhausted on ui-kit',
        repo: 'ui-kit',
        guardrail: { guardrail: 'ci_fix_attempts', value: 5, limit: 5, detail: 'ci_fix_attempts is 5 of 5' },
      });
      expect(result.from).toBe('executing');
      expect(workspace.state.goal.status).toBe('escalated');
      expect(readState(ws.janusDir).goal.status).toBe('escalated');
      expect(result.file).toBe(join(ws.janusDir, 'escalation.md'));
      const text = readFileSync(result.file, 'utf8');
      expect(text).toContain('# Escalation');
      expect(text).toContain('Created 2026-09-19T15:00:00.000Z from stage `executing`');
      expect(text).toContain('ci_fix_attempts exhausted on ui-kit');
      expect(text).toContain('- Repo: ui-kit');
      expect(text).toContain('- Work package: wp-01-ui-kit-angular');
      expect(text).toContain('- Guardrail: ci_fix_attempts 5/5 (ci_fix_attempts is 5 of 5)');
      expect(text).toContain('| ci_fix_attempts | 5 |');
      expect(text).toContain('janus escalation resolve --direction');
      const events = readEvents(ws.janusDir).map((event) => event['type']);
      expect(events).toEqual(['goal.created', 'guardrail.hit', 'escalation.created', 'stage.exited', 'stage.entered']);
      const created = readEvents(ws.janusDir)[2];
      expect(created).toMatchObject({ type: 'escalation.created', reason: 'ci_fix_attempts exhausted on ui-kit', stage: 'executing', repo: 'ui-kit', work_package: 'wp-01-ui-kit-angular' });
      expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.checkpoint.commit);
      expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): escalate from executing');
      expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Escalated');
      expect(warnings).toEqual(['escalated from executing: ci_fix_attempts exhausted on ui-kit']);
    } finally {
      workspace.release();
    }
  });

  it('records no guardrail.hit for a plain escalation', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'planning';
      await escalate(engine, { reason: 'planning agent failed twice', repo: null, guardrail: null });
      const events = readEvents(ws.janusDir).map((event) => event['type']);
      expect(events).toEqual(['goal.created', 'escalation.created', 'stage.exited', 'stage.entered']);
      expect(readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8')).toContain('- Guardrail: none');
    } finally {
      workspace.release();
    }
  });

  it('cannot escalate an already escalated goal', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'escalated';
      await expect(escalate(engine, { reason: 'again', repo: null, guardrail: null })).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      workspace.release();
    }
  });
});

describe('renderEscalationStub', () => {
  it('renders every budget row', async () => {
    const ws = await initWorkspace();
    const state = readState(ws.janusDir);
    const text = renderEscalationStub(state, { reason: 'r', repo: null, guardrail: null }, new Date('2026-09-19T15:00:00.000Z'));
    for (const name of ['ci_fix_attempts', 'e2e_fix_attempts', 'ai_review_cycles', 'no_progress_iterations', 'work_packages_without_green', 'sync_conflict_attempts', 'infra_retries']) {
      expect(text).toContain(`| ${name} | 0 |`);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/escalate.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/escalate.js'".

- [ ] **Step 3: Write the escalation module**

`src/engine/escalate.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckpointResult } from '../state/checkpoint.js';
import { ESCALATION_FILE } from '../state/files.js';
import { BUDGET_NAMES } from '../state/state-schema.js';
import type { GoalStatus, JanusState } from '../state/state-schema.js';
import type { GuardrailHit } from './budgets.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';

export interface EscalationInput {
  reason: string;
  repo: string | null;
  guardrail: GuardrailHit | null;
}

export interface EscalationResult {
  from: GoalStatus;
  file: string;
  checkpoint: CheckpointResult;
}

/**
 * Spec §25: records the escalation and moves the goal to `escalated`. Writes a stub `escalation.md`; the full
 * package renderer (digests, agent summaries) arrives with T13 and replaces `renderEscalationStub`.
 */
export async function escalate(engine: Engine, input: EscalationInput): Promise<EscalationResult> {
  const { state, paths } = engine.workspace;
  const from = state.goal.status;
  const now = engine.now();
  if (input.guardrail !== null) {
    engine.emit({
      type: 'guardrail.hit',
      guardrail: input.guardrail.guardrail,
      value: input.guardrail.value,
      limit: input.guardrail.limit,
      detail: input.guardrail.detail,
    });
  }
  const file = join(paths.janusDir, ESCALATION_FILE);
  writeFileSync(file, renderEscalationStub(state, input, now));
  engine.emit({
    type: 'escalation.created',
    reason: input.reason,
    stage: from,
    repo: input.repo,
    work_package: state.execution.current_work_package,
  });
  enterStage(engine, 'escalated');
  engine.warn(`escalated from ${from}: ${input.reason}`);
  const result = await engine.checkpoint(`chore(janus): escalate from ${from}`, {
    at: now.toISOString(),
    by: 'janus',
    title: 'Escalated',
    body: `${input.reason}\n\nStage: ${from}. See escalation.md.`,
  });
  return { from, file, checkpoint: result };
}

export function renderEscalationStub(state: JanusState, input: EscalationInput, now: Date): string {
  const guardrail =
    input.guardrail === null
      ? 'none'
      : `${input.guardrail.guardrail} ${input.guardrail.value}/${input.guardrail.limit} (${input.guardrail.detail})`;
  const lines = [
    '# Escalation',
    '',
    `Created ${now.toISOString()} from stage \`${state.goal.status}\` of goal ${state.goal.id}.`,
    '',
    '## Reason',
    '',
    input.reason,
    '',
    '## Context',
    '',
    `- Repo: ${input.repo ?? '-'}`,
    `- Work package: ${state.execution.current_work_package ?? '-'}`,
    `- Verification group: ${state.execution.current_verification_group ?? '-'}`,
    `- Guardrail: ${guardrail}`,
    '',
    '## Budget snapshot',
    '',
    '| Budget | Value |',
    '|---|---|',
    ...BUDGET_NAMES.map((name) => `| ${name} | ${state.execution.budgets[name]} |`),
    '',
    '## Next',
    '',
    'Read the reason above, decide a direction, and run `janus escalation resolve --direction "..."` (planned in T13).',
    'This is a stub package; the full escalation renderer with digests and agent summaries arrives with T13.',
    '',
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/escalate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/escalate.ts src/state/files.ts tests/engine/escalate.test.ts
git commit -m "feat(engine): escalate with a guardrail event and an escalation.md stub"
```

---

### Task 6: Step registry with placeholder steps

**Files:**
- Create: `src/engine/steps.ts`, `tests/engine/steps.test.ts`

**Interfaces:**
- Consumes: `Engine` (Task 4); `GateType`, `GoalStatus`, `GOAL_STATUSES` (Task 2 / T02).
- Produces: `interface StepContext { engine: Engine; maxWaitMs: number; modelProfile: string }`; `type StepOutcome = { kind: 'advance'; to: GoalStatus; summary: string } | { kind: 'stay'; summary: string } | { kind: 'gate'; gate: GateType; summary: string } | { kind: 'wait_exceeded'; summary: string } | { kind: 'escalate'; reason: string; repo: string | null; guardrail: GuardrailHit | null } | { kind: 'not_implemented'; task: string }`; `interface Step { name: string; run(ctx: StepContext): Promise<StepOutcome> }`; `type StepRegistry = Partial<Record<GoalStatus, Step>>`; `placeholderStep(name: string, task: string): Step`; `startStep: Step` (`created` -> `preparing`); `defaultSteps(): StepRegistry`; `STEPLESS_STAGES: readonly GoalStatus[] = ['awaiting_plan_approval', 'escalated', 'completed']`.

- [ ] **Step 1: Write the failing tests**

`tests/engine/steps.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine/engine.js';
import { STEPLESS_STAGES, defaultSteps, placeholderStep, startStep } from '../../src/engine/steps.js';
import type { StepContext } from '../../src/engine/steps.js';
import { GOAL_STATUSES } from '../../src/state/state-schema.js';

// Placeholders never touch the engine, so an empty object is enough here.
const ctx: StepContext = { engine: {} as Engine, maxWaitMs: 0, modelProfile: 'default' };

describe('defaultSteps', () => {
  it('registers a step for every stage except the stepless ones', () => {
    const steps = defaultSteps();
    for (const status of GOAL_STATUSES) {
      const expected = !STEPLESS_STAGES.includes(status);
      expect(steps[status] !== undefined, status).toBe(expected);
    }
  });

  it('starts a created goal by advancing to preparing', async () => {
    expect(defaultSteps().created).toBe(startStep);
    expect(await startStep.run(ctx)).toEqual({ kind: 'advance', to: 'preparing', summary: 'goal started' });
  });

  it('answers not_implemented with a task number for every other stage', async () => {
    const steps = defaultSteps();
    for (const status of GOAL_STATUSES) {
      const step = steps[status];
      if (step === undefined || status === 'created') continue;
      const outcome = await step.run(ctx);
      expect(outcome.kind, status).toBe('not_implemented');
      if (outcome.kind === 'not_implemented') expect(outcome.task).toMatch(/^T\d\d$/);
    }
  });

  it('names the placeholder after its stage step', async () => {
    const step = placeholderStep('prepare', 'T11');
    expect(step.name).toBe('prepare');
    expect(await step.run(ctx)).toEqual({ kind: 'not_implemented', task: 'T11' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/steps.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/steps.js'".

- [ ] **Step 3: Write the step module**

`src/engine/steps.ts`:
```ts
import type { GateType, GoalStatus } from '../state/state-schema.js';
import type { GuardrailHit } from './budgets.js';
import type { Engine } from './engine.js';

export interface StepContext {
  engine: Engine;
  /** `--max-wait` in milliseconds; a waiting step returns `wait_exceeded` once it has waited this long. */
  maxWaitMs: number;
  /** The model profile name for this invocation (`--model-profile` or `workflow_models.profile`). */
  modelProfile: string;
}

export type StepOutcome =
  /** The stage is done; move to `to` and checkpoint. */
  | { kind: 'advance'; to: GoalStatus; summary: string }
  /** Progress was made but the stage continues (for example one work package finished); checkpoint and run the stage step again. */
  | { kind: 'stay'; summary: string }
  /** Checkpoint, then enter the human gate. */
  | { kind: 'gate'; gate: GateType; summary: string }
  /** A blocking wait passed `--max-wait`; checkpoint and stop with exit 11. */
  | { kind: 'wait_exceeded'; summary: string }
  /** Something needs a human; escalate (spec §25). A guardrail hit is passed through so `guardrail.hit` is recorded. */
  | { kind: 'escalate'; reason: string; repo: string | null; guardrail: GuardrailHit | null }
  /** The stage is planned in a later task; stop with exit 3 and no checkpoint. */
  | { kind: 'not_implemented'; task: string };

/**
 * One unit of the run loop. Steps run with `execution.in_flight.step` set to `name`; a step that starts an agent
 * also records `agent_run_id`, `repo`, and `budget` in `in_flight` (and writes state) so a crash can be recovered.
 */
export interface Step {
  name: string;
  run(ctx: StepContext): Promise<StepOutcome>;
}

/** The step to run while the goal is in a given stage. */
export type StepRegistry = Partial<Record<GoalStatus, Step>>;

/** Stages the loop never runs a step for: CLI gates stop it, `escalated` waits for `janus escalation resolve`, `completed` is terminal. */
export const STEPLESS_STAGES: readonly GoalStatus[] = ['awaiting_plan_approval', 'escalated', 'completed'];

export function placeholderStep(name: string, task: string): Step {
  return { name, run: async () => ({ kind: 'not_implemented', task }) };
}

/** Leaves `created` for `preparing` (spec §9). The only real stage step of T03. */
export const startStep: Step = {
  name: 'start',
  run: async () => ({ kind: 'advance', to: 'preparing', summary: 'goal started' }),
};

/** The production registry: every real stage is a placeholder until its task lands. */
export function defaultSteps(): StepRegistry {
  return {
    created: startStep,
    preparing: placeholderStep('prepare', 'T11'),
    discovering: placeholderStep('discovery', 'T11'),
    baselining: placeholderStep('baseline', 'T11'),
    planning: placeholderStep('planning', 'T11'),
    executing: placeholderStep('execute-work-packages', 'T12'),
    final_e2e: placeholderStep('final-e2e', 'T17'),
    ai_review: placeholderStep('ai-review', 'T13'),
    qa: placeholderStep('qa-recommendation', 'T20'),
    awaiting_human_review: placeholderStep('observe-pr-review', 'T13'),
    fixing_review_feedback: placeholderStep('fix-review-feedback', 'T13'),
    awaiting_merge: placeholderStep('observe-merge', 'T13'),
    releasing: placeholderStep('release-and-bump', 'T20'),
    replanning: placeholderStep('replanning', 'T13'),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/steps.ts tests/engine/steps.test.ts
git commit -m "feat(engine): add the step registry with placeholder stage steps"
```

---

### Task 7: Resume reconciliation of repo heads (§7 rule 2)

**Files:**
- Create: `src/engine/reconcile.ts`, `tests/engine/reconcile.test.ts`
- Modify: `src/git/ops.ts` (add `tryRevParse`, `fastForward`), `tests/git/ops.test.ts` (append two cases), `tests/helpers/engine-fixtures.ts` (add `createGoalBranch`)

**Interfaces:**
- Consumes: `Engine` (Task 4); `fetch`, `revParse`, `isAncestor`, `currentBranch`, `checkoutBranch` (T02 ops); `GitError` (T02).
- Produces in `ops.ts`: `tryRevParse(cwd: string, ref: string): Promise<string | null>` (null when the ref does not resolve); `fastForward(cwd: string, ref: string): Promise<void>` (`git merge --ff-only ref`, throws `GitError` otherwise).
- Produces in `reconcile.ts`: `type LocalDrift = 'none' | 'fast_forward' | 'non_fast_forward' | 'missing'`; `type RemoteRelation = 'absent' | 'in_sync' | 'ahead_fast_forwarded' | 'behind' | 'diverged'`; `interface RepoReconciliation { repo: string; recordedHead: string | null; head: string | null; localDrift: LocalDrift; remote: RemoteRelation; baseMoved: boolean; remoteBase: string }`; `interface ReconcileResult { repos: RepoReconciliation[]; escalations: RepoReconciliation[]; changed: boolean }`; `reconcileRepos(engine: Engine): Promise<ReconcileResult>` (mutates `state.repos.<name>.head_commit` for adopted heads; does not checkpoint); `needsEscalation(entry: RepoReconciliation): boolean`; `describeDrift(entry: RepoReconciliation): string`. Test helper `createGoalBranch(ws: WorkspaceFixture, repoName: string): Promise<string>`.

- [ ] **Step 1: Add the git operations with their tests**

Append to `src/git/ops.ts`:
```ts
/** Like `revParse`, but null when `ref` does not resolve to a commit. */
export async function tryRevParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return await revParse(cwd, ref);
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 128) return null;
    throw error;
  }
}

/** Moves the current branch forward to `ref`; fails with GitError when that is not a fast-forward. */
export async function fastForward(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, ['merge', '-q', '--ff-only', ref]);
}
```

Append inside the existing `describe` of `tests/git/ops.test.ts` (add `fastForward`, `tryRevParse` to its import from `../../src/git/ops.js` and `GitError` to the import from `../../src/git/run.js`):
```ts
  it('resolves refs or answers null with tryRevParse', async () => {
    const dir = join(tempDir(), 'repo');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const sha = await commitAll(dir, 'chore: a');
    expect(await tryRevParse(dir, 'main')).toBe(sha);
    expect(await tryRevParse(dir, 'refs/heads/nope')).toBeNull();
  });

  it('fast-forwards the current branch and refuses divergence', async () => {
    const dir = join(tempDir(), 'repo');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const base = await commitAll(dir, 'chore: a');
    await checkoutBranch(dir, 'feature', base);
    const ahead = await commitAll(dir, 'chore: b', { allowEmpty: true });
    await checkoutBranch(dir, 'main');
    await fastForward(dir, 'feature');
    expect(await revParse(dir, 'main')).toBe(ahead);
    await commitAll(dir, 'chore: c', { allowEmpty: true });
    await checkoutBranch(dir, 'feature');
    await commitAll(dir, 'chore: d', { allowEmpty: true });
    await expect(fastForward(dir, 'main')).rejects.toBeInstanceOf(GitError);
  });
```

Run: `pnpm vitest run tests/git/ops.test.ts`
Expected: PASS.

- [ ] **Step 2: Add the goal-branch fixture and write the failing reconcile tests**

Append to `tests/helpers/engine-fixtures.ts` (put the imports at the top of the file):
```ts
import { loadGoal } from '../../src/config/load-goal.js';
import { checkoutBranch, commitAll, push } from '../../src/git/ops.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { GOAL_FILE } from '../../src/state/files.js';
import { readState } from '../../src/state/state-store.js';

/**
 * Creates the goal branch of `repoName` from its base head with one empty commit, pushes it, records it as
 * `head_commit`, and checkpoints. Call before `openWorkspace`, never while a Workspace is open. Returns the sha.
 */
export async function createGoalBranch(ws: WorkspaceFixture, repoName: string): Promise<string> {
  const dir = join(ws.root, 'repos', repoName);
  const goalBranch = `ai/${ws.fixture.goalId}`;
  await checkoutBranch(dir, goalBranch, 'HEAD');
  const head = await commitAll(dir, `feat(${repoName}): start upgrade`, { allowEmpty: true });
  await push(dir, 'origin', goalBranch, { setUpstream: true });
  const state = readState(ws.janusDir);
  const repoState = state.repos[repoName];
  if (!repoState) throw new Error(`state has no repo ${repoName}`);
  repoState.head_commit = head;
  const { goal } = loadGoal(join(ws.janusDir, GOAL_FILE));
  await checkpoint({ janusDir: ws.janusDir, state, goal, message: `chore(janus): record ${repoName} goal branch`, push: true });
  return head;
}
```

`tests/engine/reconcile.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeDrift, reconcileRepos } from '../../src/engine/reconcile.js';
import { checkoutBranch, clone, commitAll, currentBranch, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const goalBranch = 'ai/angular-15-to-16';

async function reconcile(ws: WorkspaceFixture) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await reconcileRepos(engine);
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

function entry(result: Awaited<ReturnType<typeof reconcile>>, repo: string) {
  const found = result.result.repos.find((item) => item.repo === repo);
  if (!found) throw new Error(`no reconciliation entry for ${repo}`);
  return found;
}

describe('reconcileRepos', () => {
  it('reports nothing for a fresh workspace without goal branches', async () => {
    const ws = await initWorkspace();
    const result = await reconcile(ws);
    expect(result.result.changed).toBe(false);
    expect(result.result.escalations).toEqual([]);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: null, head: null, localDrift: 'none', remote: 'absent', baseMoved: false, remoteBase: ws.fixture.uiKit.head });
    expect(result.warnings).toEqual([]);
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'repo.drift')).toBe(false);
  });

  it('is quiet when the local head matches the recorded head and the remote', async () => {
    const ws = await initWorkspace();
    const head = await createGoalBranch(ws, 'ui-kit');
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: head, head, localDrift: 'none', remote: 'in_sync' });
    expect(result.result.changed).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('adopts a local fast-forward of the recorded head and notes the unpushed commits', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    const newer = await commitAll(dir, 'feat(ui-kit): more', { allowEmpty: true });
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: recorded, head: newer, localDrift: 'fast_forward', remote: 'behind' });
    expect(result.state.repos['ui-kit']?.head_commit).toBe(newer);
    expect(result.result.changed).toBe(true);
    expect(result.result.escalations).toEqual([]);
    expect(result.warnings[0]).toContain('ui-kit: local goal branch moved ahead of recorded head');
    const drift = readEvents(ws.janusDir).find((event) => event['type'] === 'repo.drift');
    expect(drift).toMatchObject({ repo: 'ui-kit', local_drift: 'fast_forward', remote: 'behind', base_moved: false, recorded_head: recorded, head: newer });
  });

  it('fast-forwards the local branch when the remote goal branch moved ahead', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.uiKit.bare, other, { branch: goalBranch });
    const remote = await commitAll(other, 'feat(ui-kit): from elsewhere', { allowEmpty: true });
    await push(other, 'origin', goalBranch);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ recordedHead: recorded, head: remote, localDrift: 'none', remote: 'ahead_fast_forwarded' });
    const dir = join(ws.root, 'repos', 'ui-kit');
    expect(await revParse(dir, 'HEAD')).toBe(remote);
    expect(await currentBranch(dir)).toBe(goalBranch);
    expect(result.state.repos['ui-kit']?.head_commit).toBe(remote);
    expect(result.result.changed).toBe(true);
  });

  it('escalates when the local goal branch no longer contains the recorded head', async () => {
    const ws = await initWorkspace();
    const recorded = await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await runGit(dir, ['reset', '-q', '--hard', 'HEAD~1']);
    const rewritten = await commitAll(dir, 'feat(ui-kit): rewritten', { allowEmpty: true });
    const result = await reconcile(ws);
    const uiKit = entry(result, 'ui-kit');
    expect(uiKit.localDrift).toBe('non_fast_forward');
    expect(result.result.escalations).toEqual([uiKit]);
    expect(result.state.repos['ui-kit']?.head_commit).toBe(recorded);
    expect(result.result.changed).toBe(false);
    expect(describeDrift(uiKit)).toContain('non-fast-forward');
    expect(await revParse(dir, 'HEAD')).toBe(rewritten);
  });

  it('escalates when the local goal branch is missing', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await checkoutBranch(dir, 'main');
    await runGit(dir, ['branch', '-q', '-D', goalBranch]);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit').localDrift).toBe('missing');
    expect(result.result.escalations).toHaveLength(1);
  });

  it('escalates when the remote goal branch diverged', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.uiKit.bare, other, { branch: goalBranch });
    await runGit(other, ['reset', '-q', '--hard', 'HEAD~1']);
    await commitAll(other, 'feat(ui-kit): rewritten remotely', { allowEmpty: true });
    await runGit(other, ['push', '-q', '--force', 'origin', goalBranch]);
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ localDrift: 'none', remote: 'diverged' });
    expect(result.result.escalations).toHaveLength(1);
    expect(result.result.changed).toBe(false);
  });

  it('only notes a moved base branch', async () => {
    const ws = await initWorkspace();
    const head = await createGoalBranch(ws, 'ui-kit');
    await runGit(ws.fixture.uiKit.work, ['commit', '-q', '--allow-empty', '-m', 'chore: base moves on']);
    await runGit(ws.fixture.uiKit.work, ['push', '-q', ws.fixture.uiKit.bare, 'main']);
    const movedBase = await revParse(ws.fixture.uiKit.work, 'HEAD');
    const result = await reconcile(ws);
    expect(entry(result, 'ui-kit')).toMatchObject({ head, localDrift: 'none', remote: 'in_sync', baseMoved: true, remoteBase: movedBase });
    expect(result.result.escalations).toEqual([]);
    expect(result.result.changed).toBe(false);
    expect(result.state.repos['ui-kit']?.base_commit).toBe(ws.fixture.uiKit.head);
    expect(result.warnings).toEqual([`ui-kit: base branch moved to ${movedBase.slice(0, 7)} (the sync step will merge it)`]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/reconcile.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/reconcile.js'".

- [ ] **Step 4: Write the reconcile module**

`src/engine/reconcile.ts`:
```ts
import { checkoutBranch, currentBranch, fastForward, fetch, isAncestor, revParse, tryRevParse } from '../git/ops.js';
import type { Engine } from './engine.js';

export type LocalDrift = 'none' | 'fast_forward' | 'non_fast_forward' | 'missing';
export type RemoteRelation = 'absent' | 'in_sync' | 'ahead_fast_forwarded' | 'behind' | 'diverged';

export interface RepoReconciliation {
  repo: string;
  recordedHead: string | null;
  /** The head Janus now considers current (adopted into state unless the entry escalates). */
  head: string | null;
  localDrift: LocalDrift;
  remote: RemoteRelation;
  baseMoved: boolean;
  remoteBase: string;
}

export interface ReconcileResult {
  repos: RepoReconciliation[];
  escalations: RepoReconciliation[];
  /** True when at least one `head_commit` was adopted; the caller checkpoints. */
  changed: boolean;
}

export function needsEscalation(entry: RepoReconciliation): boolean {
  return entry.localDrift === 'non_fast_forward' || entry.localDrift === 'missing' || entry.remote === 'diverged';
}

/**
 * Spec §7 rule 2. For every repo: fetch, compare the local goal branch to `head_commit`, relate it to the remote goal
 * branch, and note base-branch movement. Fast-forwards are adopted; anything else on a goal branch escalates.
 */
export async function reconcileRepos(engine: Engine): Promise<ReconcileResult> {
  const { state, goal, repoOrder, paths } = engine.workspace;
  const reposByName = new Map(goal.repos.map((repo) => [repo.name, repo]));
  const repos: RepoReconciliation[] = [];
  let changed = false;
  for (const name of repoOrder) {
    const repo = reposByName.get(name);
    const repoState = state.repos[name];
    if (!repo || !repoState) continue;
    const dir = paths.repoDir(name);
    await fetch(dir, 'origin');
    const remoteBase = await revParse(dir, `refs/remotes/origin/${repo.base_branch}`);
    const entry: RepoReconciliation = {
      repo: name,
      recordedHead: repoState.head_commit,
      head: repoState.head_commit,
      localDrift: 'none',
      remote: 'absent',
      baseMoved: repoState.base_commit !== null && remoteBase !== repoState.base_commit,
      remoteBase,
    };
    if (repoState.head_commit !== null) {
      const recorded = repoState.head_commit;
      const local = await tryRevParse(dir, `refs/heads/${repoState.goal_branch}`);
      if (local === null) {
        entry.localDrift = 'missing';
      } else {
        if (local !== recorded) {
          entry.localDrift = (await isAncestor(dir, recorded, local)) ? 'fast_forward' : 'non_fast_forward';
        }
        if (entry.localDrift !== 'non_fast_forward') {
          entry.head = local;
          entry.remote = await relateToRemote(dir, repoState.goal_branch, local);
          if (entry.remote === 'ahead_fast_forwarded') entry.head = await revParse(dir, `refs/heads/${repoState.goal_branch}`);
        }
      }
      if (!needsEscalation(entry) && entry.head !== null && entry.head !== recorded) {
        repoState.head_commit = entry.head;
        changed = true;
      }
    }
    const noteworthy = entry.localDrift !== 'none' || entry.baseMoved || entry.remote === 'ahead_fast_forwarded' || entry.remote === 'behind' || entry.remote === 'diverged';
    if (noteworthy) {
      engine.emit({
        type: 'repo.drift',
        repo: name,
        local_drift: entry.localDrift,
        remote: entry.remote,
        base_moved: entry.baseMoved,
        recorded_head: entry.recordedHead,
        head: entry.head,
        remote_base: remoteBase,
      });
      engine.warn(describeDrift(entry));
    }
    repos.push(entry);
  }
  return { repos, escalations: repos.filter(needsEscalation), changed };
}

/** Relates the local goal branch head to `origin/<branch>`, fast-forwarding the local branch when the remote is strictly ahead. */
async function relateToRemote(dir: string, branch: string, local: string): Promise<RemoteRelation> {
  const remote = await tryRevParse(dir, `refs/remotes/origin/${branch}`);
  if (remote === null) return 'absent';
  if (remote === local) return 'in_sync';
  if (await isAncestor(dir, local, remote)) {
    if ((await currentBranch(dir)) !== branch) await checkoutBranch(dir, branch);
    await fastForward(dir, remote);
    return 'ahead_fast_forwarded';
  }
  if (await isAncestor(dir, remote, local)) return 'behind';
  return 'diverged';
}

function short(sha: string | null): string {
  return sha === null ? '-' : sha.slice(0, 7);
}

export function describeDrift(entry: RepoReconciliation): string {
  const parts: string[] = [];
  const recorded = short(entry.recordedHead);
  if (entry.localDrift === 'fast_forward') parts.push(`local goal branch moved ahead of recorded head ${recorded} (fast-forward, adopted ${short(entry.head)})`);
  if (entry.localDrift === 'non_fast_forward') parts.push(`local goal branch no longer contains recorded head ${recorded} (non-fast-forward)`);
  if (entry.localDrift === 'missing') parts.push(`local goal branch is missing (recorded head ${recorded})`);
  if (entry.remote === 'ahead_fast_forwarded') parts.push(`remote goal branch was ahead; local branch fast-forwarded to ${short(entry.head)}`);
  if (entry.remote === 'behind') parts.push('local goal branch has commits the remote does not (unpushed)');
  if (entry.remote === 'diverged') parts.push('remote goal branch diverged from the local one');
  if (entry.baseMoved) parts.push(`base branch moved to ${short(entry.remoteBase)} (the sync step will merge it)`);
  return `${entry.repo}: ${parts.join('; ')}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/reconcile.test.ts tests/git/ops.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/reconcile.ts src/git/ops.ts tests/engine/reconcile.test.ts tests/git/ops.test.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(engine): reconcile repo heads on resume and escalate non-fast-forward drift"
```

---

### Task 8: In-flight crash recovery (§7 rule 3)

**Files:**
- Create: `src/engine/recover.ts`, `tests/engine/recover.test.ts`
- Modify: `src/state/state-schema.ts` (`in_flight.repo`, `in_flight.budget`, `emptyInFlight`), `tests/state/state-schema.test.ts` (append one case)

**Interfaces:**
- Consumes: `Engine` (Task 4); `incrementBudget`, `BudgetIncrement` (Task 2); `workingTreeDiff`, `resetHard` (T02 tree); `EVIDENCE_DIR` (Task 5); `BUDGET_NAMES` (Task 2).
- Produces in `state-schema.ts`: `execution.in_flight` gains `repo: string | null` and `budget: BudgetName | null` (both default null); `emptyInFlight(): JanusState['execution']['in_flight']`; `type InFlight = JanusState['execution']['in_flight']`.
- Produces in `recover.ts`: `interface InFlightRecovery { step: string; kind: 'agent' | 'other'; patchFile: string | null; budget: BudgetIncrement | null }`; `recoverInFlight(engine: Engine): Promise<InFlightRecovery | null>` (null when nothing was in flight; otherwise saves the interrupted patch under `.janus/evidence/agents/<run-id>.interrupted.patch` when the assigned repo is dirty, resets that repo, emits `agent.finished` with `status: 'interrupted'`, increments the recorded budget, clears `in_flight`; does not checkpoint). Test helper `markInFlight(ws: WorkspaceFixture, inFlight: Partial<InFlight>, budgets?: Partial<Record<BudgetName, number>>): void` (simulates a crash by writing `in_flight` and budget values into `state.yaml` on disk without committing).

- [ ] **Step 1: Extend the schema and its test**

In `src/state/state-schema.ts` replace the `in_flight` object with:
```ts
        in_flight: z
          .object({
            step: nullableString.default(null),
            started_at: isoDate.nullable().default(null),
            agent_run_id: nullableString.default(null),
            /** Repo the in-flight agent writes to; its uncommitted diff is saved and reset on recovery (§7 rule 3). */
            repo: nullableString.default(null),
            /** Budget an interrupted agent run counts against (§7 rule 3, §20). */
            budget: z.enum(BUDGET_NAMES).nullable().default(null),
          })
          .strict()
          .default({}),
```
and append after `export type JanusState = ...`:
```ts
export type InFlight = JanusState['execution']['in_flight'];

export function emptyInFlight(): InFlight {
  return { step: null, started_at: null, agent_run_id: null, repo: null, budget: null };
}
```
(`BUDGET_NAMES` is declared above `stateSchema` since Task 2, so the enum can reference it.)

Append to `tests/state/state-schema.test.ts` inside `describe('schema constants', ...)` (add `emptyInFlight` to the import):
```ts
  it('defaults the in_flight repo and budget to null and accepts a budget name', () => {
    const state = initial();
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    state.execution.in_flight = { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-1', repo: 'ui-kit', budget: 'ci_fix_attempts' };
    expect(stateSchema.parse(state).execution.in_flight.budget).toBe('ci_fix_attempts');
    expect(issuesOf({ ...state, execution: { ...state.execution, in_flight: { ...state.execution.in_flight, budget: 'nope' } } })).toEqual([
      expect.stringContaining('execution.in_flight.budget'),
    ]);
  });
```

Run: `pnpm vitest run tests/state`
Expected: PASS.

- [ ] **Step 2: Add the crash-simulation helper and write the failing recovery tests**

Append to `tests/helpers/engine-fixtures.ts` (add `emptyInFlight` and the types to the existing `state-schema` import, and `writeState` to the existing `state-store` import):
```ts
import { emptyInFlight } from '../../src/state/state-schema.js';
import type { BudgetName, InFlight } from '../../src/state/state-schema.js';
import { readState, writeState } from '../../src/state/state-store.js';

/** Simulates a crash: writes `in_flight` (and optional budget values) into state.yaml on disk without committing. Call while no Workspace is open. */
export function markInFlight(ws: WorkspaceFixture, inFlight: Partial<InFlight>, budgets: Partial<Record<BudgetName, number>> = {}): void {
  const state = readState(ws.janusDir);
  state.execution.in_flight = { ...emptyInFlight(), ...inFlight };
  for (const [name, value] of Object.entries(budgets)) {
    if (value !== undefined) state.execution.budgets[name as BudgetName] = value;
  }
  writeState(ws.janusDir, state);
}
```

`tests/engine/recover.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recoverInFlight } from '../../src/engine/recover.js';
import { runGit } from '../../src/git/run.js';
import { emptyInFlight } from '../../src/state/state-schema.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, markInFlight, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

async function recover(ws: WorkspaceFixture) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await recoverInFlight(engine);
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

describe('recoverInFlight', () => {
  it('returns null when nothing was in flight', async () => {
    const ws = await initWorkspace();
    const { result, warnings } = await recover(ws);
    expect(result).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('saves the interrupted patch, resets the repo, counts the budget, and clears in_flight', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    writeFileSync(join(dir, 'README.md'), '# changed by an agent\n');
    writeFileSync(join(dir, 'new-file.txt'), 'untracked\n');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0001', repo: 'ui-kit', budget: 'ci_fix_attempts' });

    const { result, warnings, state } = await recover(ws);
    const patchFile = join(ws.janusDir, 'evidence', 'agents', 'run-0001.interrupted.patch');
    expect(result).toEqual({
      step: 'execute-work-packages',
      kind: 'agent',
      patchFile,
      budget: { budget: 'ci_fix_attempts', value: 1, limit: 5, exhausted: false },
    });
    const patch = readFileSync(patchFile, 'utf8');
    expect(patch).toContain('new-file.txt');
    expect(patch).toContain('changed by an agent');
    expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(false);
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    const events = readEvents(ws.janusDir);
    expect(events.map((event) => event['type'])).toEqual(['goal.created', 'agent.finished', 'budget.incremented']);
    expect(events[1]).toMatchObject({ type: 'agent.finished', run_id: 'run-0001', repo: 'ui-kit', status: 'interrupted', step: 'execute-work-packages', patch: 'evidence/agents/run-0001.interrupted.patch' });
    expect(warnings).toEqual(['previous run died during step "execute-work-packages" (started 2026-09-19T12:00:00.000Z); agent work in ui-kit was saved and discarded; the step will run again']);
  });

  it('records no patch when the repo was clean', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0002', repo: 'ui-kit', budget: null });
    const { result } = await recover(ws);
    expect(result).toEqual({ step: 'execute-work-packages', kind: 'agent', patchFile: null, budget: null });
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-0002.interrupted.patch'))).toBe(false);
    const finished = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.finished');
    expect(finished?.['patch']).toBeNull();
  });

  it('reports exhaustion when the interrupted run was the last allowed attempt', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0003', repo: 'ui-kit', budget: 'ci_fix_attempts' }, { ci_fix_attempts: 4 });
    const { result } = await recover(ws);
    expect(result?.budget).toEqual({ budget: 'ci_fix_attempts', value: 5, limit: 5, exhausted: true });
  });

  it('leaves repos alone for a non-agent step and just clears the marker', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    writeFileSync(join(dir, 'keep.txt'), 'not an agent change\n');
    markInFlight(ws, { step: 'ci-wait', started_at: '2026-09-19T12:00:00.000Z' });
    const { result, warnings, state } = await recover(ws);
    expect(result).toEqual({ step: 'ci-wait', kind: 'other', patchFile: null, budget: null });
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(readEvents(ws.janusDir)).toHaveLength(1);
    expect(warnings).toEqual(['previous run died during step "ci-wait" (started 2026-09-19T12:00:00.000Z); the step will run again']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/recover.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/recover.js'".

- [ ] **Step 4: Write the recovery module**

`src/engine/recover.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resetHard, workingTreeDiff } from '../git/tree.js';
import { EVIDENCE_DIR } from '../state/files.js';
import { emptyInFlight } from '../state/state-schema.js';
import { incrementBudget } from './budgets.js';
import type { BudgetIncrement } from './budgets.js';
import type { Engine } from './engine.js';

export interface InFlightRecovery {
  step: string;
  kind: 'agent' | 'other';
  patchFile: string | null;
  budget: BudgetIncrement | null;
}

/**
 * Spec §7 rule 3. When the previous process died mid-step: an agent run's uncommitted diff is saved as evidence, the
 * repo is reset, and the run counts against its budget; every other step simply runs again (CI and E2E waits resume
 * on the build id recorded in state). Clears `in_flight`; the caller checkpoints.
 */
export async function recoverInFlight(engine: Engine): Promise<InFlightRecovery | null> {
  const { state, paths, config } = engine.workspace;
  const inFlight = state.execution.in_flight;
  if (inFlight.step === null) return null;
  const step = inFlight.step;
  const started = inFlight.started_at ?? 'unknown time';
  let kind: InFlightRecovery['kind'] = 'other';
  let patchFile: string | null = null;
  let budget: BudgetIncrement | null = null;
  let detail = '';
  if (inFlight.agent_run_id !== null) {
    kind = 'agent';
    const runId = inFlight.agent_run_id;
    if (inFlight.repo !== null) {
      const dir = paths.repoDir(inFlight.repo);
      const diff = await workingTreeDiff(dir);
      if (diff.patch !== '') {
        patchFile = join(paths.janusDir, EVIDENCE_DIR, 'agents', `${runId}.interrupted.patch`);
        mkdirSync(dirname(patchFile), { recursive: true });
        writeFileSync(patchFile, diff.patch);
      }
      await resetHard(dir);
      detail = `agent work in ${inFlight.repo} was ${patchFile === null ? 'absent' : 'saved and discarded'}; `;
    }
    engine.emit({
      type: 'agent.finished',
      run_id: runId,
      repo: inFlight.repo,
      status: 'interrupted',
      step,
      patch: patchFile === null ? null : relative(paths.janusDir, patchFile),
    });
    if (inFlight.budget !== null) {
      budget = incrementBudget({ state, config, emit: engine.emit }, inFlight.budget, `agent run ${runId} interrupted during ${step}`);
    }
  }
  engine.warn(`previous run died during step "${step}" (started ${started}); ${detail}the step will run again`);
  state.execution.in_flight = emptyInFlight();
  return { step, kind, patchFile, budget };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/recover.test.ts tests/state`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/recover.ts src/state/state-schema.ts tests/engine/recover.test.ts tests/state/state-schema.test.ts
git commit -m "feat(engine): recover an interrupted step from in_flight with patch evidence and budget charge"
```

---

### Task 9: Gates: enter, approve with a bound commit, reject

**Files:**
- Create: `src/engine/gates.ts`, `src/git/identity.ts`, `tests/engine/gates.test.ts`, `tests/git/identity.test.ts`

**Interfaces:**
- Consumes: `Engine`, `enterStage` (Task 4); `revParse` (T02 ops); `GitError`, `runGit` (T02); `ConfigError` (T01); `GateType`, `GoalStatus` (Task 2 / T02); `CheckpointResult` (T02).
- Produces in `identity.ts`: `interface GitIdentity { name: string; email: string }`; `parseIdent(ident: string): GitIdentity | null`; `formatIdentity(identity: GitIdentity): string` (`Name <email>`); `gitIdentity(cwd: string): Promise<GitIdentity>` from `git var GIT_COMMITTER_IDENT` (throws `ConfigError('git identity', ...)` when git cannot determine one).
- Produces in `gates.ts`: `CLI_GATES: readonly GateType[] = ['plan_approval', 'revised_plan_approval']`; `isCliGate(gate: GateType): boolean`; `gateStage(gate: GateType): GoalStatus`; `gateCommand(gate: GateType): string | null` (`plan`, `revised-plan`, else null); `class GateError extends Error`; `enterGate(engine: Engine, gate: GateType): Promise<CheckpointResult>` (records `gate = { type, status: 'waiting', entered_at, checkpoint_commit: <HEAD before entry> }`, emits `gate.entered`, checkpoints); `interface ApprovePlanInput { gate: 'plan_approval' | 'revised_plan_approval'; commit: string; exceptions: string[]; approver: GitIdentity }`; `interface ApproveResult { commit: string; checkpoint: CheckpointResult; waitedMs: number }`; `approvePlan(engine, input): Promise<ApproveResult>`; `interface RejectPlanInput { reason: string; approver: GitIdentity }`; `interface RejectResult { to: GoalStatus; checkpoint: CheckpointResult; waitedMs: number }`; `rejectPlan(engine, input): Promise<RejectResult>`.

- [ ] **Step 1: Write the failing identity tests**

`tests/git/identity.test.ts`:
```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatIdentity, gitIdentity, parseIdent } from '../../src/git/identity.js';
import { initRepo } from '../../src/git/ops.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('parseIdent', () => {
  it('parses the output of git var', () => {
    expect(parseIdent('Janus Test <janus@test.invalid> 1789000000 +0200')).toEqual({ name: 'Janus Test', email: 'janus@test.invalid' });
    expect(parseIdent('A B C <a@b.c> 1 -0000')).toEqual({ name: 'A B C', email: 'a@b.c' });
  });

  it('rejects malformed or empty identities', () => {
    expect(parseIdent('')).toBeNull();
    expect(parseIdent('nobody')).toBeNull();
    expect(parseIdent(' <a@b.c> 1 +0000')).toBeNull();
    expect(parseIdent('Name <> 1 +0000')).toBeNull();
  });

  it('formats as Name <email>', () => {
    expect(formatIdentity({ name: 'Janus Test', email: 'janus@test.invalid' })).toBe('Janus Test <janus@test.invalid>');
  });
});

describe('gitIdentity', () => {
  it('reads the committer identity git would use in a repo', async () => {
    const dir = join(tempDir(), 'repo');
    mkdirSync(dir);
    await initRepo(dir, 'main');
    expect(await gitIdentity(dir)).toEqual({ name: 'Janus Test', email: 'janus@test.invalid' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/git/identity.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/git/identity.js'".

- [ ] **Step 3: Write the identity module**

`src/git/identity.ts`:
```ts
import { ConfigError } from '../config/errors.js';
import { GitError, runGit } from './run.js';

export interface GitIdentity {
  name: string;
  email: string;
}

/** Parses `Name <email> <timestamp> <tz>` as printed by `git var`. */
export function parseIdent(ident: string): GitIdentity | null {
  const match = /^(.+?) <([^>]+)> \d+ [+-]\d{4}$/.exec(ident);
  if (match === null) return null;
  const [, name = '', email = ''] = match;
  if (name.trim() === '' || email.trim() === '') return null;
  return { name, email };
}

export function formatIdentity(identity: GitIdentity): string {
  return `${identity.name} <${identity.email}>`;
}

/** The committer identity git resolves in `cwd` (user.name/user.email or GIT_COMMITTER_*). Approvals are attributed to it (spec §8). */
export async function gitIdentity(cwd: string): Promise<GitIdentity> {
  let ident: string;
  try {
    ident = await runGit(cwd, ['var', 'GIT_COMMITTER_IDENT']);
  } catch (error) {
    if (error instanceof GitError) {
      throw new ConfigError('git identity', [`git cannot determine who you are (${error.stderr.trim()}); set git config user.name and user.email`]);
    }
    throw error;
  }
  const parsed = parseIdent(ident);
  if (parsed === null) throw new ConfigError('git identity', [`unexpected output from git var GIT_COMMITTER_IDENT: ${ident}`]);
  return parsed;
}
```

Run: `pnpm vitest run tests/git/identity.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing gate tests**

`tests/engine/gates.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateError, approvePlan, enterGate, gateCommand, gateStage, isCliGate, rejectPlan } from '../../src/engine/gates.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const approver = { name: 'Janus Test', email: 'janus@test.invalid' };

interface AtGate {
  ws: WorkspaceFixture;
  workspace: Workspace;
  engine: ReturnType<typeof testEngine>['engine'];
  clock: { now: Date };
  stepCommit: string;
  gateCommit: string;
}

/** A workspace checkpointed at the end of planning and then entered into the given gate. */
async function atGate(gate: 'plan_approval' | 'revised_plan_approval'): Promise<AtGate> {
  const ws = await initWorkspace();
  const workspace = await openWorkspace(ws.root);
  const clock = { now: new Date('2026-09-19T16:00:00.000Z') };
  const { engine } = testEngine(workspace, () => clock.now);
  workspace.state.goal.status = 'awaiting_plan_approval';
  const step = await engine.checkpoint('chore(janus): planning: plan ready');
  const entered = await enterGate(engine, gate);
  return { ws, workspace, engine, clock, stepCommit: step.commit, gateCommit: entered.commit };
}

describe('gate helpers', () => {
  it('classifies gates and maps them to stages and commands', () => {
    expect(isCliGate('plan_approval')).toBe(true);
    expect(isCliGate('revised_plan_approval')).toBe(true);
    expect(isCliGate('pr_review')).toBe(false);
    expect(isCliGate('merge')).toBe(false);
    expect(gateStage('plan_approval')).toBe('awaiting_plan_approval');
    expect(gateStage('revised_plan_approval')).toBe('awaiting_plan_approval');
    expect(gateStage('pr_review')).toBe('awaiting_human_review');
    expect(gateStage('merge')).toBe('awaiting_merge');
    expect(gateCommand('plan_approval')).toBe('plan');
    expect(gateCommand('revised_plan_approval')).toBe('revised-plan');
    expect(gateCommand('merge')).toBeNull();
  });
});

describe('enterGate', () => {
  it('records the pre-entry checkpoint, emits gate.entered, and checkpoints the entry', async () => {
    const at = await atGate('plan_approval');
    try {
      expect(at.workspace.state.gate).toEqual({ type: 'plan_approval', status: 'waiting', entered_at: '2026-09-19T16:00:00.000Z', checkpoint_commit: at.stepCommit });
      expect(await revParse(at.ws.janusDir, 'HEAD')).toBe(at.gateCommit);
      expect(await revParse(at.ws.janusDir, 'HEAD~1')).toBe(at.stepCommit);
      expect(await remoteHead(at.ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(at.gateCommit);
      expect(await runGit(at.ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): enter gate plan_approval');
      const entered = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.entered');
      expect(entered).toMatchObject({ gate: 'plan_approval', checkpoint_commit: at.stepCommit });
      expect(readState(at.ws.janusDir).gate.status).toBe('waiting');
    } finally {
      at.workspace.release();
    }
  });
});

describe('approvePlan', () => {
  it('approves at the exact state-branch head and records the approver', async () => {
    const at = await atGate('plan_approval');
    try {
      at.clock.now = new Date('2026-09-19T16:01:30.000Z');
      const result = await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
      expect(result.waitedMs).toBe(90_000);
      const { state } = at.workspace;
      expect(state.goal.status).toBe('executing');
      expect(state.plan).toEqual({ approved: true, approved_commit: at.gateCommit, approved_at: '2026-09-19T16:01:30.000Z', revision: 0 });
      expect(state.baseline.approved).toBe(true);
      expect(state.gate.status).toBe('passed');
      expect(state.gate.type).toBe('plan_approval');
      const passed = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.passed');
      expect(passed).toMatchObject({ gate: 'plan_approval', approver: 'Janus Test <janus@test.invalid>', commit: at.gateCommit, waited_ms: 90_000 });
      const decisions = readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8');
      expect(decisions).toContain('## Plan approved (2026-09-19T16:01:30.000Z)');
      expect(decisions).toContain('By: Janus Test <janus@test.invalid>');
      expect(decisions).toContain(`Approved state-branch commit ${at.gateCommit}`);
      expect(await revParse(at.ws.janusDir, 'HEAD')).toBe(result.checkpoint.commit);
      expect(await remoteHead(at.ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.checkpoint.commit);
      expect(readState(at.ws.janusDir).goal.status).toBe('executing');
    } finally {
      at.workspace.release();
    }
  });

  it('accepts an abbreviated sha of the head', async () => {
    const at = await atGate('plan_approval');
    try {
      const result = await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit.slice(0, 10), exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
    } finally {
      at.workspace.release();
    }
  });

  it('refuses a commit that is not the head, even an older state-branch commit', async () => {
    const at = await atGate('plan_approval');
    try {
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.stepCommit, exceptions: [], approver })).rejects.toThrow(
        `--commit ${at.stepCommit} resolves to ${at.stepCommit.slice(0, 7)} but the gate was entered at state-branch HEAD ${at.gateCommit.slice(0, 7)}`,
      );
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: 'deadbeef', exceptions: [], approver })).rejects.toThrow(GateError);
      expect(at.workspace.state.goal.status).toBe('awaiting_plan_approval');
      expect(at.workspace.state.plan.approved).toBe(false);
    } finally {
      at.workspace.release();
    }
  });

  it('refuses when no gate is waiting or the other gate is waiting', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const head = await revParse(ws.janusDir, 'HEAD');
      await expect(approvePlan(engine, { gate: 'plan_approval', commit: head, exceptions: [], approver })).rejects.toThrow('no plan_approval gate is waiting (goal status created, gate none)');
    } finally {
      workspace.release();
    }
    const at = await atGate('revised_plan_approval');
    try {
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: [], approver })).rejects.toThrow(
        'gate revised_plan_approval is waiting, not plan_approval; use: janus approve revised-plan --commit <sha>',
      );
      const result = await approvePlan(at.engine, { gate: 'revised_plan_approval', commit: at.gateCommit, exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
      expect(at.workspace.state.goal.status).toBe('executing');
      expect(readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Revised plan approved');
    } finally {
      at.workspace.release();
    }
  });

  it('approves listed baseline exceptions and refuses unknown ids', async () => {
    const at = await atGate('plan_approval');
    try {
      at.workspace.state.baseline.exceptions.push({ id: 'ex-1', repo: 'ui-kit', kind: 'test', identity: 'spec:flaky', reason: 'known flaky', approved_by: null, approved_at: null });
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: ['ex-9'], approver })).rejects.toThrow('unknown baseline exception ex-9');
      await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: ['ex-1'], approver });
      expect(at.workspace.state.baseline.exceptions[0]).toMatchObject({ id: 'ex-1', approved_by: 'Janus Test <janus@test.invalid>', approved_at: '2026-09-19T16:00:00.000Z' });
      expect(readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8')).toContain('Exceptions approved: ex-1');
    } finally {
      at.workspace.release();
    }
  });
});

describe('rejectPlan', () => {
  it('returns Gate 1 to planning with the reason recorded', async () => {
    const at = await atGate('plan_approval');
    try {
      at.clock.now = new Date('2026-09-19T16:00:10.000Z');
      const result = await rejectPlan(at.engine, { reason: 'wrong repo order', approver });
      expect(result.to).toBe('planning');
      expect(result.waitedMs).toBe(10_000);
      expect(at.workspace.state.goal.status).toBe('planning');
      expect(at.workspace.state.gate).toEqual({ type: null, status: 'none', entered_at: null, checkpoint_commit: null });
      expect(at.workspace.state.plan.approved).toBe(false);
      const rejected = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.rejected');
      expect(rejected).toMatchObject({ gate: 'plan_approval', approver: 'Janus Test <janus@test.invalid>', reason: 'wrong repo order', waited_ms: 10_000 });
      const decisions = readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8');
      expect(decisions).toContain('## Plan rejected');
      expect(decisions).toContain('wrong repo order');
      expect(await runGit(at.ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): reject plan_approval');
    } finally {
      at.workspace.release();
    }
  });

  it('returns Gate 2 to replanning', async () => {
    const at = await atGate('revised_plan_approval');
    try {
      const result = await rejectPlan(at.engine, { reason: 'still wrong', approver });
      expect(result.to).toBe('replanning');
      expect(at.workspace.state.goal.status).toBe('replanning');
    } finally {
      at.workspace.release();
    }
  });

  it('refuses when no CLI gate is waiting', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      await expect(rejectPlan(engine, { reason: 'x', approver })).rejects.toThrow('no plan approval gate is waiting');
    } finally {
      workspace.release();
    }
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/gates.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/gates.js'".

- [ ] **Step 6: Write the gates module**

`src/engine/gates.ts`:
```ts
import { formatIdentity } from '../git/identity.js';
import type { GitIdentity } from '../git/identity.js';
import { revParse } from '../git/ops.js';
import { GitError } from '../git/run.js';
import type { CheckpointResult } from '../state/checkpoint.js';
import type { GateType, GoalStatus } from '../state/state-schema.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';

/** Gates passed by `janus approve` (spec §26 gates 1 and 2). The others are observed from the SCM provider. */
export const CLI_GATES: readonly GateType[] = ['plan_approval', 'revised_plan_approval'];

export function isCliGate(gate: GateType): boolean {
  return CLI_GATES.includes(gate);
}

/** The goal status the goal waits in while a gate is open. */
export function gateStage(gate: GateType): GoalStatus {
  switch (gate) {
    case 'plan_approval':
    case 'revised_plan_approval':
      return 'awaiting_plan_approval';
    case 'pr_review':
      return 'awaiting_human_review';
    case 'merge':
      return 'awaiting_merge';
  }
}

/** The `janus approve <subcommand>` that passes the gate, or null for SCM-observed gates. */
export function gateCommand(gate: GateType): string | null {
  switch (gate) {
    case 'plan_approval':
      return 'plan';
    case 'revised_plan_approval':
      return 'revised-plan';
    default:
      return null;
  }
}

/** A gate command that cannot apply: wrong gate, wrong commit, unknown exception. Maps to a usage error. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * Spec §7 rule 1: the checkpoint that exists before entry is recorded in `gate.checkpoint_commit`; the entry itself
 * is one more checkpoint, and `janus approve --commit` must name that entry commit (the state-branch HEAD).
 */
export async function enterGate(engine: Engine, gate: GateType): Promise<CheckpointResult> {
  const { state, paths } = engine.workspace;
  const previous = await revParse(paths.janusDir, 'HEAD');
  state.gate = { type: gate, status: 'waiting', entered_at: engine.now().toISOString(), checkpoint_commit: previous };
  engine.emit({ type: 'gate.entered', gate, checkpoint_commit: previous, stage: state.goal.status });
  return engine.checkpoint(`chore(janus): enter gate ${gate}`);
}

interface WaitingGate {
  type: GateType;
  enteredAt: string;
}

function requireWaitingCliGate(engine: Engine, expected: GateType | null): WaitingGate {
  const { state } = engine.workspace;
  const gate = state.gate;
  if (gate.status !== 'waiting' || gate.type === null || !isCliGate(gate.type)) {
    const name = expected ?? 'plan approval';
    throw new GateError(`no ${name} gate is waiting (goal status ${state.goal.status}, gate ${gate.status})`);
  }
  if (expected !== null && gate.type !== expected) {
    throw new GateError(`gate ${gate.type} is waiting, not ${expected}; use: janus approve ${gateCommand(gate.type) ?? '...'} --commit <sha>`);
  }
  return { type: gate.type, enteredAt: gate.entered_at ?? engine.now().toISOString() };
}

function waitedMs(enteredAt: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(enteredAt));
}

export interface ApprovePlanInput {
  gate: 'plan_approval' | 'revised_plan_approval';
  commit: string;
  exceptions: string[];
  approver: GitIdentity;
}

export interface ApproveResult {
  commit: string;
  checkpoint: CheckpointResult;
  waitedMs: number;
}

/** Spec §8, §12, §32 rule 14: approval is bound to the exact state-branch commit at which the gate was entered. */
export async function approvePlan(engine: Engine, input: ApprovePlanInput): Promise<ApproveResult> {
  const { state, paths } = engine.workspace;
  const waiting = requireWaitingCliGate(engine, input.gate);
  const head = await revParse(paths.janusDir, 'HEAD');
  let resolved: string;
  try {
    resolved = await revParse(paths.janusDir, input.commit);
  } catch (error) {
    if (error instanceof GitError) throw new GateError(`--commit ${input.commit} is not a commit on the state branch`);
    throw error;
  }
  if (resolved !== head) {
    throw new GateError(
      `--commit ${input.commit} resolves to ${resolved.slice(0, 7)} but the gate was entered at state-branch HEAD ${head.slice(0, 7)}; pass ${head}`,
    );
  }
  const now = engine.now();
  const by = formatIdentity(input.approver);
  for (const id of input.exceptions) {
    const exception = state.baseline.exceptions.find((entry) => entry.id === id);
    if (exception === undefined) throw new GateError(`unknown baseline exception ${id}`);
    exception.approved_by = by;
    exception.approved_at = now.toISOString();
  }
  state.plan.approved = true;
  state.plan.approved_commit = head;
  state.plan.approved_at = now.toISOString();
  if (input.gate === 'plan_approval') state.baseline.approved = true;
  state.gate.status = 'passed';
  const waited = waitedMs(waiting.enteredAt, now);
  engine.emit({ type: 'gate.passed', gate: waiting.type, approver: by, commit: head, waited_ms: waited });
  enterStage(engine, 'executing');
  const title = input.gate === 'plan_approval' ? 'Plan approved' : 'Revised plan approved';
  const exceptionsLine = input.exceptions.length === 0 ? '' : `\n\nExceptions approved: ${input.exceptions.join(', ')}.`;
  const checkpoint = await engine.checkpoint(`chore(janus): approve ${waiting.type} at ${head.slice(0, 7)}`, {
    at: now.toISOString(),
    by,
    title,
    body: `Approved state-branch commit ${head}.${exceptionsLine}`,
  });
  return { commit: head, checkpoint, waitedMs: waited };
}

export interface RejectPlanInput {
  reason: string;
  approver: GitIdentity;
}

export interface RejectResult {
  to: GoalStatus;
  checkpoint: CheckpointResult;
  waitedMs: number;
}

/** Sends Gate 1 back to `planning` and Gate 2 back to `replanning`, recording the reason. */
export async function rejectPlan(engine: Engine, input: RejectPlanInput): Promise<RejectResult> {
  const { state } = engine.workspace;
  const waiting = requireWaitingCliGate(engine, null);
  const now = engine.now();
  const by = formatIdentity(input.approver);
  const to: GoalStatus = waiting.type === 'plan_approval' ? 'planning' : 'replanning';
  const waited = waitedMs(waiting.enteredAt, now);
  state.gate = { type: null, status: 'none', entered_at: null, checkpoint_commit: null };
  engine.emit({ type: 'gate.rejected', gate: waiting.type, approver: by, reason: input.reason, waited_ms: waited });
  enterStage(engine, to);
  const checkpoint = await engine.checkpoint(`chore(janus): reject ${waiting.type}`, {
    at: now.toISOString(),
    by,
    title: 'Plan rejected',
    body: `${input.reason}\n\nGate ${waiting.type}; goal returns to ${to}.`,
  });
  return { to, checkpoint, waitedMs: waited };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/gates.test.ts tests/git/identity.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/gates.ts src/git/identity.ts tests/engine/gates.test.ts tests/git/identity.test.ts
git commit -m "feat(engine): enter, approve, and reject human gates bound to the state-branch head"
```

---

### Task 10: The run loop

**Files:**
- Create: `src/engine/run-loop.ts`, `tests/engine/run-loop.test.ts`
- Modify: `tests/helpers/engine-fixtures.ts` (add `advanceStep`, `scriptedSteps`)

**Interfaces:**
- Consumes: `Engine`, `enterStage` (Task 4); `escalate` (Task 5); `Step`, `StepContext`, `StepRegistry`, `startStep`, `defaultSteps` (Task 6); `reconcileRepos`, `describeDrift` (Task 7); `recoverInFlight` (Task 8); `enterGate`, `gateCommand`, `gateStage`, `isCliGate`, `approvePlan` (Task 9); `HAPPY_PATH` (Task 1); `emptyInFlight`, `GoalStatus` (Task 8 / T02); `writeState` (T02); `revParse` (T02); `Workspace` (Task 3); `markInFlight` (Task 8 helper).
- Produces: `type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented'`; `interface RunEngineInput { engine: Engine; steps: StepRegistry; until: GoalStatus | null; maxWaitMs: number; modelProfile: string; maxSteps?: number }`; `interface RunResult { reason: RunStopReason; status: GoalStatus; stateCommit: string; message: string; task: string | null; steps: number }`; `runEngine(input: RunEngineInput): Promise<RunResult>`; `describeNextStep(workspace: Workspace, steps: StepRegistry): string[]`. Test helpers `advanceStep(name: string, to: GoalStatus): Step` and `scriptedSteps(overrides?: StepRegistry): StepRegistry` (every stage advances along the happy path; `planning` returns the `plan_approval` gate).

- [ ] **Step 1: Add the scripted registry helper and write the failing tests**

Append to `tests/helpers/engine-fixtures.ts` (imports at the top):
```ts
import { startStep } from '../../src/engine/steps.js';
import type { Step, StepRegistry } from '../../src/engine/steps.js';
import type { GoalStatus } from '../../src/state/state-schema.js';

export function advanceStep(name: string, to: GoalStatus): Step {
  return { name, run: async () => ({ kind: 'advance', to, summary: `scripted ${name}` }) };
}

/** A registry that walks the §9 happy path with no providers: planning enters Gate 1, review and merge advance directly. */
export function scriptedSteps(overrides: StepRegistry = {}): StepRegistry {
  return {
    created: startStep,
    preparing: advanceStep('prepare', 'discovering'),
    discovering: advanceStep('discovery', 'baselining'),
    baselining: advanceStep('baseline', 'planning'),
    planning: { name: 'planning', run: async () => ({ kind: 'gate', gate: 'plan_approval', summary: 'plan ready' }) },
    executing: advanceStep('execute-work-packages', 'final_e2e'),
    final_e2e: advanceStep('final-e2e', 'ai_review'),
    ai_review: advanceStep('ai-review', 'qa'),
    qa: advanceStep('qa-recommendation', 'awaiting_human_review'),
    awaiting_human_review: advanceStep('observe-pr-review', 'awaiting_merge'),
    awaiting_merge: advanceStep('observe-merge', 'completed'),
    ...overrides,
  };
}
```

`tests/engine/run-loop.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvePlan } from '../../src/engine/gates.js';
import { describeNextStep, runEngine } from '../../src/engine/run-loop.js';
import type { RunEngineInput } from '../../src/engine/run-loop.js';
import { defaultSteps } from '../../src/engine/steps.js';
import type { Step, StepRegistry } from '../../src/engine/steps.js';
import { commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { emptyInFlight } from '../../src/state/state-schema.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, markInFlight, scriptedSteps, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const approver = { name: 'Janus Test', email: 'janus@test.invalid' };

type RunOptions = Partial<Pick<RunEngineInput, 'until' | 'maxWaitMs' | 'maxSteps'>>;

async function run(ws: WorkspaceFixture, steps: StepRegistry, options: RunOptions = {}) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await runEngine({
      engine,
      steps,
      until: options.until ?? null,
      maxWaitMs: options.maxWaitMs ?? 60_000,
      modelProfile: 'default',
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

async function approve(ws: WorkspaceFixture): Promise<void> {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine } = testEngine(workspace);
    const head = await revParse(ws.janusDir, 'HEAD');
    await approvePlan(engine, { gate: 'plan_approval', commit: head, exceptions: [], approver });
  } finally {
    workspace.release();
  }
}

async function subjects(ws: WorkspaceFixture): Promise<string[]> {
  return (await runGit(ws.janusDir, ['log', '--reverse', '--format=%s'])).split('\n');
}

function eventTypes(ws: WorkspaceFixture): string[] {
  return readEvents(ws.janusDir).map((event) => String(event['type']));
}

describe('runEngine', () => {
  it('runs from created to the plan gate, checkpointing every step', async () => {
    const ws = await initWorkspace();
    const { result, state } = await run(ws, scriptedSteps());
    expect(result.reason).toBe('gate');
    expect(result.status).toBe('awaiting_plan_approval');
    expect(result.steps).toBe(5);
    expect(result.task).toBeNull();
    expect(result.stateCommit).toBe(await revParse(ws.janusDir, 'HEAD'));
    expect(result.message).toBe(`waiting at gate plan_approval; approve with: janus approve plan --commit ${result.stateCommit}`);
    expect(await subjects(ws)).toEqual([
      'chore(janus): initialize workspace for angular-15-to-16',
      'chore(janus): start: goal started',
      'chore(janus): prepare: scripted prepare',
      'chore(janus): discovery: scripted discovery',
      'chore(janus): baseline: scripted baseline',
      'chore(janus): planning: plan ready',
      'chore(janus): enter gate plan_approval',
    ]);
    const onDisk = readState(ws.janusDir);
    expect(onDisk.goal.status).toBe('awaiting_plan_approval');
    expect(onDisk.gate).toMatchObject({ type: 'plan_approval', status: 'waiting', checkpoint_commit: await revParse(ws.janusDir, 'HEAD~1') });
    expect(onDisk.execution.in_flight).toEqual(emptyInFlight());
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.stateCommit);
    const types = eventTypes(ws);
    expect(types[1]).toBe('run.started');
    expect(types[types.length - 1]).toBe('run.stopped');
    expect(readEvents(ws.janusDir).filter((event) => event['type'] === 'stage.entered').map((event) => event['stage'])).toEqual([
      'preparing',
      'discovering',
      'baselining',
      'planning',
      'awaiting_plan_approval',
    ]);
    expect(types.filter((type) => type === 'gate.entered')).toHaveLength(1);
  });

  it('stops immediately while the gate waits and continues after approval to completed', async () => {
    const ws = await initWorkspace();
    await run(ws, scriptedSteps());
    const again = await run(ws, scriptedSteps());
    expect(again.result.reason).toBe('gate');
    expect(again.result.steps).toBe(0);
    await approve(ws);
    const done = await run(ws, scriptedSteps());
    expect(done.result.reason).toBe('completed');
    expect(done.result.status).toBe('completed');
    expect(done.result.steps).toBe(6);
    expect(done.result.message).toBe('goal angular-15-to-16 is completed');
    expect(eventTypes(ws).filter((type) => type === 'goal.completed')).toHaveLength(1);
    expect(readFileSync(join(ws.janusDir, 'handover.md'), 'utf8')).toContain('Goal complete');
    const after = await run(ws, scriptedSteps());
    expect(after.result.reason).toBe('completed');
    expect(after.result.steps).toBe(0);
  });

  it('--until stops before running the stage step', async () => {
    const ws = await initWorkspace();
    const { result } = await run(ws, scriptedSteps(), { until: 'baselining' });
    expect(result).toMatchObject({ reason: 'until', status: 'baselining', steps: 3, message: 'reached stage baselining (--until)' });
  });

  it('stops at a placeholder with not_implemented and no extra checkpoint', async () => {
    const ws = await initWorkspace();
    const { result } = await run(ws, defaultSteps());
    expect(result).toMatchObject({ reason: 'not_implemented', status: 'preparing', task: 'T11', steps: 2, message: 'prepare is not implemented yet (planned in T11)' });
    expect(await subjects(ws)).toHaveLength(2);
    expect(readState(ws.janusDir).execution.in_flight).toEqual(emptyInFlight());
    expect(result.stateCommit).toBe(await revParse(ws.janusDir, 'HEAD'));
  });

  it('reports wait_exceeded after a checkpoint', async () => {
    const ws = await initWorkspace();
    const waiting: Step = { name: 'execute-work-packages', run: async ({ maxWaitMs }) => ({ kind: 'wait_exceeded', summary: `CI wait passed ${maxWaitMs} ms` }) };
    await run(ws, scriptedSteps());
    await approve(ws);
    const { result } = await run(ws, scriptedSteps({ executing: waiting }), { maxWaitMs: 1_000 });
    expect(result).toMatchObject({ reason: 'wait_exceeded', status: 'executing', message: 'execute-work-packages: CI wait passed 1000 ms; run janus run again to keep waiting' });
    expect((await subjects(ws)).at(-1)).toBe('chore(janus): execute-work-packages: CI wait passed 1000 ms');
  });

  it('escalates from a step and stays escalated on later runs', async () => {
    const ws = await initWorkspace();
    const failing: Step = { name: 'prepare', run: async () => ({ kind: 'escalate', reason: 'install failed twice', repo: 'ui-kit', guardrail: null }) };
    const { result, warnings } = await run(ws, scriptedSteps({ preparing: failing }));
    expect(result).toMatchObject({ reason: 'escalated', status: 'escalated', steps: 2 });
    expect(result.message).toContain('janus escalation resolve');
    expect(warnings).toContain('escalated from preparing: install failed twice');
    expect(existsSync(join(ws.janusDir, 'escalation.md'))).toBe(true);
    const again = await run(ws, scriptedSteps({ preparing: failing }));
    expect(again.result).toMatchObject({ reason: 'escalated', steps: 0 });
  });

  it('stops at an SCM-observed gate and re-runs its step on the next run', async () => {
    const ws = await initWorkspace();
    let calls = 0;
    const observe: Step = {
      name: 'observe-pr-review',
      run: async () => {
        calls += 1;
        return (calls === 1 ? { kind: 'gate', gate: 'pr_review', summary: 'PRs open' } : { kind: 'advance', to: 'awaiting_merge', summary: 'approved' });
      },
    };
    await run(ws, scriptedSteps());
    await approve(ws);
    const first = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(first.result).toMatchObject({ reason: 'gate', status: 'awaiting_human_review' });
    expect(first.result.message).toContain('waiting at gate pr_review');
    expect(readState(ws.janusDir).gate).toMatchObject({ type: 'pr_review', status: 'waiting' });
    const second = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(second.result.reason).toBe('completed');
    expect(calls).toBe(2);
    expect(eventTypes(ws).filter((type) => type === 'gate.entered')).toHaveLength(2);
  });

  it('recovers an interrupted agent step before running', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    writeFileSync(join(ws.root, 'repos', 'ui-kit', 'half-done.txt'), 'x\n');
    markInFlight(ws, { step: 'prepare', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-7', repo: 'ui-kit', budget: 'ci_fix_attempts' });
    const { result, warnings, state } = await run(ws, scriptedSteps());
    expect(warnings[0]).toContain('previous run died during step "prepare"');
    expect(result.reason).toBe('gate');
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-7.interrupted.patch'))).toBe(true);
    expect(await subjects(ws)).toContain('chore(janus): recover interrupted step prepare');
    expect(await runGit(join(ws.root, 'repos', 'ui-kit'), ['status', '--porcelain'])).toBe('');
  });

  it('escalates non-fast-forward drift before running any step', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await runGit(dir, ['reset', '-q', '--hard', 'HEAD~1']);
    await commitAll(dir, 'feat(ui-kit): rewritten', { allowEmpty: true });
    const { result } = await run(ws, scriptedSteps());
    expect(result).toMatchObject({ reason: 'escalated', status: 'escalated', steps: 0 });
    expect(readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8')).toContain('non-fast-forward');
  });

  it('adopts fast-forward drift with a checkpoint and then runs', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const newer = await commitAll(join(ws.root, 'repos', 'ui-kit'), 'feat(ui-kit): more', { allowEmpty: true });
    const { result, state } = await run(ws, scriptedSteps());
    expect(result.reason).toBe('gate');
    expect(state.repos['ui-kit']?.head_commit).toBe(newer);
    expect(await subjects(ws)).toContain('chore(janus): adopt fast-forwarded goal branch heads');
  });

  it('refuses to loop forever on stay and refuses a stage without a step', async () => {
    const ws = await initWorkspace();
    const stuck: Step = { name: 'prepare', run: async () => ({ kind: 'stay', summary: 'one more package' }) };
    await expect(run(ws, scriptedSteps({ preparing: stuck }), { maxSteps: 3 })).rejects.toThrow('run loop executed 3 steps without stopping');
    const fresh = await initWorkspace();
    await expect(run(fresh, {})).rejects.toThrow('no step registered for stage created');
  });
});

describe('describeNextStep', () => {
  it('names the next step and the stages after it', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      expect(describeNextStep(workspace, defaultSteps())).toEqual([
        'goal angular-15-to-16: created',
        'next step: start',
        'then: preparing -> discovering -> baselining -> planning -> awaiting_plan_approval -> executing -> final_e2e -> ai_review -> qa -> awaiting_human_review -> awaiting_merge -> completed',
      ]);
    } finally {
      workspace.release();
    }
  });

  it('explains a waiting gate, an interrupted step, and terminal states', async () => {
    const ws = await initWorkspace();
    await run(ws, scriptedSteps());
    markInFlight(ws, { step: 'planning', started_at: '2026-09-19T12:00:00.000Z' });
    const workspace = await openWorkspace(ws.root);
    try {
      expect(describeNextStep(workspace, scriptedSteps())).toEqual([
        'goal angular-15-to-16: awaiting_plan_approval',
        'interrupted step "planning" would be recovered first',
        'waiting at gate plan_approval; nothing runs until: janus approve plan --commit <sha>',
      ]);
      workspace.state.execution.in_flight = emptyInFlight();
      workspace.state.goal.status = 'completed';
      expect(describeNextStep(workspace, scriptedSteps())).toEqual(['goal angular-15-to-16: completed', 'nothing to do: the goal is completed']);
      workspace.state.goal.status = 'escalated';
      expect(describeNextStep(workspace, scriptedSteps())[1]).toContain('janus escalation resolve');
    } finally {
      workspace.release();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/engine/run-loop.test.ts`
Expected: FAIL with "Failed to resolve import '../../src/engine/run-loop.js'".

- [ ] **Step 3: Write the run loop**

`src/engine/run-loop.ts`:
```ts
import { revParse } from '../git/ops.js';
import { emptyInFlight } from '../state/state-schema.js';
import type { GoalStatus } from '../state/state-schema.js';
import { writeState } from '../state/state-store.js';
import type { Workspace } from '../workspace/open-workspace.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';
import { escalate } from './escalate.js';
import { enterGate, gateCommand, gateStage, isCliGate } from './gates.js';
import { describeDrift, reconcileRepos } from './reconcile.js';
import { recoverInFlight } from './recover.js';
import type { StepContext, StepRegistry } from './steps.js';
import { HAPPY_PATH } from './transitions.js';

export type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented';

export interface RunEngineInput {
  engine: Engine;
  steps: StepRegistry;
  until: GoalStatus | null;
  maxWaitMs: number;
  modelProfile: string;
  /** Safety net against a step that answers `stay` forever (default 1000). */
  maxSteps?: number;
}

export interface RunResult {
  reason: RunStopReason;
  status: GoalStatus;
  /** State-branch HEAD when the run stopped. */
  stateCommit: string;
  message: string;
  /** The task that will implement the stopping step, for `not_implemented`. */
  task: string | null;
  steps: number;
}

const ESCALATED_MESSAGE = 'goal is escalated; read .janus/escalation.md and run: janus escalation resolve --direction "..."';

/**
 * Spec §8 run model: recover an interrupted step (§7 rule 3), reconcile repo heads (§7 rule 2), then run stage steps,
 * each bracketed by `in_flight` and ended by a checkpoint, until a human gate, an exceeded wait, an escalation,
 * `--until`, a placeholder, or completion.
 */
export async function runEngine(input: RunEngineInput): Promise<RunResult> {
  const { engine, steps } = input;
  const { state, paths } = engine.workspace;
  const maxSteps = input.maxSteps ?? 1000;
  let executed = 0;
  engine.emit({
    type: 'run.started',
    pid: process.pid,
    status: state.goal.status,
    until: input.until,
    max_wait_ms: input.maxWaitMs,
    model_profile: input.modelProfile,
  });
  const stop = async (reason: RunStopReason, message: string, task: string | null = null): Promise<RunResult> => {
    engine.emit({ type: 'run.stopped', reason, status: state.goal.status, steps: executed });
    const stateCommit = await revParse(paths.janusDir, 'HEAD');
    return { reason, status: state.goal.status, stateCommit, message, task, steps: executed };
  };

  const recovery = await recoverInFlight(engine);
  if (recovery !== null) await engine.checkpoint(`chore(janus): recover interrupted step ${recovery.step}`);

  if (state.goal.status !== 'escalated' && state.goal.status !== 'completed') {
    const reconciled = await reconcileRepos(engine);
    const first = reconciled.escalations[0];
    if (first !== undefined) {
      await escalate(engine, {
        reason: `goal branch drift cannot be fast-forwarded: ${reconciled.escalations.map(describeDrift).join('; ')}`,
        repo: first.repo,
        guardrail: null,
      });
      return stop('escalated', ESCALATED_MESSAGE);
    }
    if (reconciled.changed) await engine.checkpoint('chore(janus): adopt fast-forwarded goal branch heads');
  }

  const ctx: StepContext = { engine, maxWaitMs: input.maxWaitMs, modelProfile: input.modelProfile };
  for (;;) {
    const status = state.goal.status;
    if (status === 'completed') return stop('completed', `goal ${state.goal.id} is completed`);
    if (status === 'escalated') return stop('escalated', ESCALATED_MESSAGE);
    if (state.gate.status === 'waiting' && state.gate.type !== null && isCliGate(state.gate.type)) {
      const head = await revParse(paths.janusDir, 'HEAD');
      return stop('gate', `waiting at gate ${state.gate.type}; approve with: janus approve ${gateCommand(state.gate.type) ?? ''} --commit ${head}`);
    }
    if (input.until !== null && status === input.until) return stop('until', `reached stage ${status} (--until)`);
    if (executed >= maxSteps) throw new Error(`run loop executed ${maxSteps} steps without stopping; giving up`);
    const step = steps[status];
    if (step === undefined) throw new Error(`no step registered for stage ${status}`);

    state.execution.in_flight = { ...emptyInFlight(), step: step.name, started_at: engine.now().toISOString() };
    writeState(paths.janusDir, state);
    const outcome = await step.run(ctx);
    executed += 1;
    state.execution.in_flight = emptyInFlight();

    switch (outcome.kind) {
      case 'advance':
        enterStage(engine, outcome.to);
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        break;
      case 'stay':
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        break;
      case 'gate': {
        const stage = gateStage(outcome.gate);
        if (state.goal.status !== stage) enterStage(engine, stage);
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        const alreadyWaiting = state.gate.status === 'waiting' && state.gate.type === outcome.gate;
        if (!alreadyWaiting) await enterGate(engine, outcome.gate);
        if (!isCliGate(outcome.gate)) {
          return stop('gate', `waiting at gate ${outcome.gate}; it is observed from the SCM provider on the next run`);
        }
        break; // the loop head stops with the approve instruction
      }
      case 'wait_exceeded':
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        return stop('wait_exceeded', `${step.name}: ${outcome.summary}; run janus run again to keep waiting`);
      case 'escalate':
        await escalate(engine, { reason: outcome.reason, repo: outcome.repo, guardrail: outcome.guardrail });
        return stop('escalated', ESCALATED_MESSAGE);
      case 'not_implemented':
        writeState(paths.janusDir, state);
        return stop('not_implemented', `${step.name} is not implemented yet (planned in ${outcome.task})`, outcome.task);
    }
  }
}

/** `janus run --dry-run`: what the next run would do, without touching anything. */
export function describeNextStep(workspace: Workspace, steps: StepRegistry): string[] {
  const { state } = workspace;
  const lines = [`goal ${state.goal.id}: ${state.goal.status}`];
  if (state.execution.in_flight.step !== null) lines.push(`interrupted step "${state.execution.in_flight.step}" would be recovered first`);
  if (state.goal.status === 'completed') {
    lines.push('nothing to do: the goal is completed');
    return lines;
  }
  if (state.goal.status === 'escalated') {
    lines.push(ESCALATED_MESSAGE);
    return lines;
  }
  if (state.gate.status === 'waiting' && state.gate.type !== null && isCliGate(state.gate.type)) {
    lines.push(`waiting at gate ${state.gate.type}; nothing runs until: janus approve ${gateCommand(state.gate.type) ?? ''} --commit <sha>`);
    return lines;
  }
  const step = steps[state.goal.status];
  lines.push(`next step: ${step === undefined ? '(none registered)' : step.name}`);
  const index = HAPPY_PATH.indexOf(state.goal.status);
  if (index >= 0 && index + 1 < HAPPY_PATH.length) lines.push(`then: ${HAPPY_PATH.slice(index + 1).join(' -> ')}`);
  return lines;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/engine/run-loop.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

```bash
git add src/engine/run-loop.ts tests/engine/run-loop.test.ts tests/helpers/engine-fixtures.ts
git commit -m "feat(engine): add the run loop with in_flight bracketing, gates, and stop reasons"
```

---

### Task 11: `janus run`

**Files:**
- Create: `src/cli/duration.ts`, `tests/cli/duration.test.ts`, `tests/cli/run.test.ts`
- Modify: `src/cli/context.ts`, `src/cli/main.ts`, `src/cli/commands/run.ts` (replace), `tests/helpers/run-cli.ts`, `tests/cli/commands.test.ts`, `tests/cli/main.test.ts`

**Interfaces:**
- Consumes: `runEngine`, `describeNextStep`, `RunResult` (Task 10); `defaultSteps`, `StepRegistry` (Task 6); `createEngine` (Task 4); `findWorkspaceRoot`, `openWorkspace` (Task 3); `StateBranchDivergedError` (T02); `GOAL_STATUSES`, `GoalStatus` (T02); `ConfigError` (T01); `scriptedSteps`, `initWorkspace`, `createGoalBranch` (helpers); `acquireLock`, `releaseLock` (T02).
- Produces: `parseDuration(value: string, option: string): number` (ms; `ConfigError` on bad input); `interface CliOverrides { steps?: StepRegistry }`; `createContext(io: CliIo, overrides?: CliOverrides): CliContext` where `CliContext` gains `steps?: StepRegistry`; `main(argv: string[], io?: CliIo, overrides?: CliOverrides): Promise<ExitCode>`; `exitCodeForError` prints the reconcile instruction for `StateBranchDivergedError` (exit 1); test helper `runCli(argv, ioOverrides?, ctxOverrides?)`.

- [ ] **Step 1: Write the failing duration tests and the duration parser**

`tests/cli/duration.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/cli/duration.js';
import { ConfigError } from '../../src/config/errors.js';

describe('parseDuration', () => {
  it('parses ms, s, m, and h', () => {
    expect(parseDuration('500ms', '--max-wait')).toBe(500);
    expect(parseDuration('30s', '--max-wait')).toBe(30_000);
    expect(parseDuration('45m', '--max-wait')).toBe(2_700_000);
    expect(parseDuration('2h', '--max-wait')).toBe(7_200_000);
    expect(parseDuration(' 1m ', '--max-wait')).toBe(60_000);
  });

  it('rejects anything else with the option name', () => {
    for (const bad of ['', '45', 'm', '1.5h', '-1m', '1d']) {
      expect(() => parseDuration(bad, '--max-wait')).toThrow(ConfigError);
      expect(() => parseDuration(bad, '--max-wait')).toThrow(`--max-wait: 1 problem(s)`);
    }
  });
});
```

`src/cli/duration.ts`:
```ts
import { ConfigError } from '../config/errors.js';

/** Parses `500ms`, `30s`, `45m`, `2h` into milliseconds. */
export function parseDuration(value: string, option: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined) {
    throw new ConfigError(option, [`invalid duration "${value}"; use a whole number with unit ms, s, m, or h, for example 45m`]);
  }
  switch (unit) {
    case 'ms':
      return Number(amount);
    case 's':
      return Number(amount) * 1_000;
    case 'm':
      return Number(amount) * 60_000;
    default:
      return Number(amount) * 3_600_000;
  }
}
```

Run: `pnpm vitest run tests/cli/duration.test.ts`
Expected: PASS.

- [ ] **Step 2: Let tests inject steps through the CLI context**

Replace `src/cli/context.ts`:
```ts
import type { StepRegistry } from '../engine/steps.js';
import { ExitCode } from './exit-codes.js';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

/** Test seams. `steps` replaces the production step registry of `janus run`. */
export interface CliOverrides {
  steps?: StepRegistry;
}

export interface CliContext extends CliOverrides {
  io: CliIo;
  exitCode: ExitCode;
}

export function defaultIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    env: process.env,
    cwd: process.cwd(),
  };
}

export function createContext(io: CliIo, overrides: CliOverrides = {}): CliContext {
  return { io, exitCode: ExitCode.Ok, ...overrides };
}
```

In `src/cli/main.ts`:
- change the context import to `import type { CliContext, CliIo, CliOverrides } from './context.js';`
- add `import { StateBranchDivergedError } from '../state/checkpoint.js';`
- in `exitCodeForError`, before the `ConfigError` branch, add:
```ts
  if (error instanceof StateBranchDivergedError) {
    io.stderr(`janus: ${error.message}\n`);
    io.stderr(
      'janus: reconcile with: git -C .janus fetch origin && git -C .janus log --oneline HEAD...FETCH_HEAD, then merge (never force-push) so the branch has one line of history, and run janus again\n',
    );
    return ExitCode.UnexpectedError;
  }
```
- change the signature to `export async function main(argv: string[], io: CliIo = defaultIo(), overrides: CliOverrides = {}): Promise<ExitCode>` and the first line of its body to `const ctx = createContext(io, overrides);`.

Replace `tests/helpers/run-cli.ts`:
```ts
import { main } from '../../src/cli/main.js';
import type { CliIo, CliOverrides } from '../../src/cli/context.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(argv: string[], overrides: Partial<CliIo> = {}, ctxOverrides: CliOverrides = {}): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    cwd: process.cwd(),
    ...overrides,
  };
  const code = await main(argv, io, ctxOverrides);
  return { code, stdout, stderr };
}
```

Append to the `describe('exitCodeForError', ...)` block of `tests/cli/main.test.ts` (add `import { StateBranchDivergedError } from '../../src/state/checkpoint.js';`):
```ts
  it('exits 1 with a reconcile instruction when the state branch diverged', () => {
    const io = fakeIo();
    const error = new StateBranchDivergedError('janus/g', 'state-repo');
    expect(exitCodeForError(error, io)).toBe(ExitCode.UnexpectedError);
    expect(io.stderrText).toContain('janus: state branch janus/g on state-repo has moved');
    expect(io.stderrText).toContain('reconcile with: git -C .janus fetch origin');
  });
```

Run: `pnpm vitest run tests/cli/main.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing run command tests**

`tests/cli/run.test.ts`:
```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { Step } from '../../src/engine/steps.js';
import { clone, commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { acquireLock, releaseLock } from '../../src/workspace/lock.js';
import { initWorkspace, scriptedSteps } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

describe('janus run', () => {
  it('exits 2 outside a workspace', async () => {
    const result = await runCli(['run'], { cwd: tempDir() });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('not inside a janus workspace');
  });

  it('starts a fresh goal and stops at the first placeholder with exit 3', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toMatch(/prepare is not implemented yet \(planned in T11\)/);
    expect(result.stdout).toContain('goal angular-15-to-16: preparing');
    expect(readState(ws.janusDir).goal.status).toBe('preparing');
    expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(await revParse(ws.janusDir, 'HEAD'));
    expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): start: goal started');
  });

  it('runs scripted steps to the plan gate with exit 10 and prints the approve command', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run'], { cwd: join(ws.root, 'repos', 'shell') }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.GateWaiting);
    const head = await revParse(ws.janusDir, 'HEAD');
    expect(result.stdout).toContain(`goal angular-15-to-16: awaiting_plan_approval (state branch at ${head.slice(0, 7)}, 5 steps run)`);
    expect(result.stdout).toContain(`waiting at gate plan_approval; approve with: janus approve plan --commit ${head}`);
    expect(result.stderr).toBe('');
  });

  it('honors --until with exit 0', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run', '--until', 'baselining'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('reached stage baselining (--until)');
    expect(readState(ws.janusDir).goal.status).toBe('baselining');
  });

  it('rejects a bad --until, --max-wait, or --model-profile with exit 2 before touching state', async () => {
    const ws = await initWorkspace();
    const until = await runCli(['run', '--until', 'shipping'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(until.code).toBe(ExitCode.UsageError);
    expect(until.stderr).toContain('unknown stage "shipping"');
    const wait = await runCli(['run', '--max-wait', 'soon'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(wait.code).toBe(ExitCode.UsageError);
    expect(wait.stderr).toContain('invalid duration "soon"');
    const profile = await runCli(['run', '--model-profile', 'turbo'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(profile.code).toBe(ExitCode.UsageError);
    expect(profile.stderr).toContain('model profile "turbo" is not defined');
    expect(readState(ws.janusDir).goal.status).toBe('created');
  });

  it('--dry-run prints the next step and changes nothing', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run', '--dry-run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: created');
    expect(result.stdout).toContain('next step: start');
    expect(await runGit(ws.janusDir, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(readState(ws.janusDir).goal.status).toBe('created');
  });

  it('exits 13 while another live process holds the lock', async () => {
    const ws = await initWorkspace();
    const lockFile = join(ws.root, 'janus.lock');
    acquireLock(lockFile);
    try {
      const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
      expect(result.code).toBe(ExitCode.Locked);
      expect(result.stderr).toContain('workspace is locked by pid');
    } finally {
      releaseLock(lockFile);
    }
  });

  it('exits 1 with a reconcile instruction when the state branch moved elsewhere, and releases the lock', async () => {
    const ws = await initWorkspace();
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.stateBare, other, { branch: 'janus/angular-15-to-16' });
    await commitAll(other, 'chore(janus): from another machine', { allowEmpty: true });
    await runGit(other, ['push', '-q', 'origin', 'janus/angular-15-to-16']);
    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stderr).toContain('has moved');
    expect(result.stderr).toContain('reconcile with: git -C .janus fetch origin');
    const again = await runCli(['run', '--dry-run'], { cwd: ws.root });
    expect(again.code).toBe(ExitCode.Ok);
  });

  it('exits 11 when a step reports an exceeded wait and 12 on escalation', async () => {
    const waiting: Step = { name: 'start', run: async () => ({ kind: 'wait_exceeded', summary: 'waited 1m' }) };
    const ws = await initWorkspace();
    const wait = await runCli(['run', '--max-wait', '1m'], { cwd: ws.root }, { steps: scriptedSteps({ created: waiting }) });
    expect(wait.code).toBe(ExitCode.WaitExceeded);
    expect(wait.stdout).toContain('start: waited 1m; run janus run again to keep waiting');
    const failing: Step = { name: 'start', run: async () => ({ kind: 'escalate', reason: 'cannot start', repo: null, guardrail: null }) };
    const other = await initWorkspace();
    const escalated = await runCli(['run'], { cwd: other.root }, { steps: scriptedSteps({ created: failing }) });
    expect(escalated.code).toBe(ExitCode.Escalated);
    expect(escalated.stderr).toContain('janus: warning: escalated from created: cannot start');
    expect(escalated.stdout).toContain('janus escalation resolve');
  });
});
```

In `tests/cli/commands.test.ts` remove the `run`, `approve`, and `reject` rows from `stubbed` (they now need a workspace and are covered by `run.test.ts` and `approve.test.ts`), so the array starts with `['status']` and no longer contains `['run']`, `['run', '--until', ...]`, `['approve', 'plan', '--commit', 'abc123']`, `['approve', 'plan', '--commit', 'abc123', '--exception', 'ex-1', '--exception', 'ex-2']`, `['approve', 'revised-plan', '--commit', 'abc123']`, or `['reject', 'plan', '--reason', 'wrong order']`. The `rejects approve plan without --commit` and `rejects reject plan without --reason` cases stay (commander rejects before the action runs).

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm vitest run tests/cli/run.test.ts`
Expected: FAIL: every case gets exit 3 from the stub.

- [ ] **Step 5: Write the run command**

Replace `src/cli/commands/run.ts`:
```ts
import type { Command } from 'commander';
import { ConfigError } from '../../config/errors.js';
import { createEngine } from '../../engine/engine.js';
import { describeNextStep, runEngine } from '../../engine/run-loop.js';
import type { RunResult } from '../../engine/run-loop.js';
import { defaultSteps } from '../../engine/steps.js';
import { GOAL_STATUSES } from '../../state/state-schema.js';
import type { GoalStatus } from '../../state/state-schema.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { parseDuration } from '../duration.js';
import { ExitCode } from '../exit-codes.js';

interface RunCommandOptions {
  until?: string;
  maxWait?: string;
  dryRun?: boolean;
  modelProfile?: string;
}

export function registerRun(program: Command, ctx: CliContext): void {
  program
    .command('run')
    .description('Advance the goal until the next gate, wait limit, escalation, or completion')
    .option('--until <stage>', 'stop once this stage is reached')
    .option('--max-wait <duration>', 'longest blocking wait before exiting, for example 45m', '45m')
    .option('--dry-run', 'print the next steps without running agents, commits, or CI calls')
    .option('--model-profile <name>', 'model profile override for this invocation')
    .action(async (options: RunCommandOptions) => {
      ctx.exitCode = await runCommand(ctx, options);
    });
}

function parseUntil(value: string | undefined): GoalStatus | null {
  if (value === undefined) return null;
  const known = GOAL_STATUSES as readonly string[];
  if (!known.includes(value)) {
    throw new ConfigError('--until', [`unknown stage "${value}"; expected one of ${GOAL_STATUSES.join(', ')}`]);
  }
  return value as GoalStatus;
}

function exitCodeForRun(result: RunResult): ExitCode {
  switch (result.reason) {
    case 'completed':
    case 'until':
      return ExitCode.Ok;
    case 'gate':
      return ExitCode.GateWaiting;
    case 'wait_exceeded':
      return ExitCode.WaitExceeded;
    case 'escalated':
      return ExitCode.Escalated;
    case 'not_implemented':
      return ExitCode.NotImplemented;
  }
}

async function runCommand(ctx: CliContext, options: RunCommandOptions): Promise<ExitCode> {
  const until = parseUntil(options.until);
  const maxWaitMs = parseDuration(options.maxWait ?? '45m', '--max-wait');
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const modelProfile = options.modelProfile ?? workspace.config.workflow_models.profile;
    if (!(modelProfile in workspace.config.model_profiles)) {
      throw new ConfigError('--model-profile', [`model profile "${modelProfile}" is not defined in config.yaml model_profiles`]);
    }
    const steps = ctx.steps ?? defaultSteps();
    if (options.dryRun) {
      for (const line of describeNextStep(workspace, steps)) ctx.io.stdout(`${line}\n`);
      return ExitCode.Ok;
    }
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await runEngine({ engine, steps, until, maxWaitMs, modelProfile });
    ctx.io.stdout(`goal ${workspace.state.goal.id}: ${result.status} (state branch at ${result.stateCommit.slice(0, 7)}, ${result.steps} steps run)\n`);
    if (result.reason === 'not_implemented') {
      ctx.io.stderr(`janus: ${result.message}\n`);
    } else {
      ctx.io.stdout(`${result.message}\n`);
    }
    return exitCodeForRun(result);
  } finally {
    workspace.release();
  }
}
```

- [ ] **Step 6: Run the CLI tests to verify they pass**

Run: `pnpm vitest run tests/cli`
Expected: PASS (including the trimmed `commands.test.ts`).

- [ ] **Step 7: Typecheck, lint, full suite, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

```bash
git add src/cli/duration.ts src/cli/context.ts src/cli/main.ts src/cli/commands/run.ts tests/helpers/run-cli.ts tests/cli/duration.test.ts tests/cli/run.test.ts tests/cli/commands.test.ts tests/cli/main.test.ts
git commit -m "feat(cli): run the engine with janus run and distinct exit codes per stop reason"
```

---

### Task 12: `janus approve plan | revised-plan --commit` and `janus reject plan --reason`

**Files:**
- Create: `tests/cli/approve.test.ts`
- Modify: `src/cli/commands/approve.ts` (replace), `src/cli/commands/reject.ts` (replace), `src/cli/main.ts` (`GateError` branch), `tests/cli/main.test.ts` (append one case)

**Interfaces:**
- Consumes: `approvePlan`, `rejectPlan`, `GateError` (Task 9); `gitIdentity`, `formatIdentity` (Task 9); `createEngine` (Task 4); `findWorkspaceRoot`, `openWorkspace` (Task 3); `runCli` with `CliOverrides` (Task 11); `scriptedSteps`, `initWorkspace` (helpers); `readState`, `writeState`, `checkpoint`, `loadGoal` (T02/T01).
- Produces: `exitCodeForError` maps `GateError` to `ExitCode.UsageError` with the message on stderr; the two commands print `gate <type> passed at <sha7> by <Name <email>>` / `gate <type> rejected by <Name <email>>` followed by `goal <id>: <status> (checkpoint <sha7>); run janus run to continue`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe('exitCodeForError', ...)` block of `tests/cli/main.test.ts` (add `import { GateError } from '../../src/engine/gates.js';`):
```ts
  it('exits 2 with the message for a GateError', () => {
    const io = fakeIo();
    expect(exitCodeForError(new GateError('no plan_approval gate is waiting'), io)).toBe(ExitCode.UsageError);
    expect(io.stderrText).toBe('janus: no plan_approval gate is waiting\n');
  });
```

`tests/cli/approve.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { initWorkspace, scriptedSteps } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

async function atPlanGate(): Promise<{ ws: WorkspaceFixture; head: string }> {
  const ws = await initWorkspace();
  const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
  if (result.code !== ExitCode.GateWaiting) throw new Error(`expected the plan gate, got ${result.code}: ${result.stderr}`);
  return { ws, head: await revParse(ws.janusDir, 'HEAD') };
}

describe('janus approve plan', () => {
  it('exits 2 outside a workspace and when no gate is waiting', async () => {
    const outside = await runCli(['approve', 'plan', '--commit', 'abc123'], { cwd: tempDir() });
    expect(outside.code).toBe(ExitCode.UsageError);
    expect(outside.stderr).toContain('not inside a janus workspace');
    const ws = await initWorkspace();
    const early = await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    expect(early.code).toBe(ExitCode.UsageError);
    expect(early.stderr).toContain('no plan_approval gate is waiting (goal status created, gate none)');
  });

  it('refuses a commit that is not the state-branch head and leaves the gate waiting', async () => {
    const { ws, head } = await atPlanGate();
    const older = await revParse(ws.janusDir, 'HEAD~1');
    const result = await runCli(['approve', 'plan', '--commit', older], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain(`but the gate was entered at state-branch HEAD ${head.slice(0, 7)}`);
    expect(readState(ws.janusDir).gate.status).toBe('waiting');
    expect(readState(ws.janusDir).goal.status).toBe('awaiting_plan_approval');
  });

  it('passes the gate at the head, records the approver, and lets the next run continue', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['approve', 'plan', '--commit', head], { cwd: ws.root });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(`gate plan_approval passed at ${head.slice(0, 7)} by Janus Test <janus@test.invalid>`);
    expect(result.stdout).toMatch(/goal angular-15-to-16: executing \(checkpoint [0-9a-f]{7}\); run janus run to continue/);
    const state = readState(ws.janusDir);
    expect(state.plan).toMatchObject({ approved: true, approved_commit: head });
    expect(state.baseline.approved).toBe(true);
    expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('By: Janus Test <janus@test.invalid>');
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'gate.passed')).toBe(true);
    expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toBe('');
    const next = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(next.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).goal.status).toBe('completed');
  });

  it('approves listed baseline exceptions', async () => {
    const ws = await initWorkspace();
    const state = readState(ws.janusDir);
    state.baseline.exceptions.push({ id: 'ex-1', repo: 'ui-kit', kind: 'test', identity: 'spec:flaky', reason: 'known flaky', approved_by: null, approved_at: null });
    writeState(ws.janusDir, state);
    await checkpoint({ janusDir: ws.janusDir, state, goal: loadGoal(join(ws.janusDir, 'goal.yaml')).goal, message: 'chore(janus): baseline exception', push: true });
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    const head = await revParse(ws.janusDir, 'HEAD');
    const unknown = await runCli(['approve', 'plan', '--commit', head, '--exception', 'ex-9'], { cwd: ws.root });
    expect(unknown.code).toBe(ExitCode.UsageError);
    expect(unknown.stderr).toContain('unknown baseline exception ex-9');
    const result = await runCli(['approve', 'plan', '--commit', head, '--exception', 'ex-1'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).baseline.exceptions[0]).toMatchObject({ id: 'ex-1', approved_by: 'Janus Test <janus@test.invalid>' });
  });

  it('refuses approve revised-plan while Gate 1 waits', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['approve', 'revised-plan', '--commit', head], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('gate plan_approval is waiting, not revised_plan_approval; use: janus approve plan --commit <sha>');
  });
});

describe('janus reject plan', () => {
  it('returns to planning with the reason and the next run re-enters the gate', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['reject', 'plan', '--reason', 'wrong repo order'], { cwd: ws.root });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('gate plan_approval rejected by Janus Test <janus@test.invalid>');
    expect(result.stdout).toMatch(/goal angular-15-to-16: planning \(checkpoint [0-9a-f]{7}\); run janus run to continue/);
    expect(readState(ws.janusDir).goal.status).toBe('planning');
    expect(readState(ws.janusDir).gate.status).toBe('none');
    expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('wrong repo order');
    const again = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.GateWaiting);
    const newHead = await revParse(ws.janusDir, 'HEAD');
    expect(newHead).not.toBe(head);
    expect(readState(ws.janusDir).gate).toMatchObject({ type: 'plan_approval', status: 'waiting' });
    const stale = await runCli(['approve', 'plan', '--commit', head], { cwd: ws.root });
    expect(stale.code).toBe(ExitCode.UsageError);
    const fresh = await runCli(['approve', 'plan', '--commit', newHead], { cwd: ws.root });
    expect(fresh.code).toBe(ExitCode.Ok);
  });

  it('exits 2 when no gate is waiting', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['reject', 'plan', '--reason', 'x'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('no plan approval gate is waiting');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/cli/approve.test.ts tests/cli/main.test.ts`
Expected: FAIL: approve/reject cases get exit 3 from the stubs; the GateError case gets exit 1.

- [ ] **Step 3: Write the commands and the error mapping**

In `src/cli/main.ts` add `import { GateError } from '../engine/gates.js';` and, next to the `ConfigError` branch of `exitCodeForError`:
```ts
  if (error instanceof GateError) {
    io.stderr(`janus: ${error.message}\n`);
    return ExitCode.UsageError;
  }
```

Replace `src/cli/commands/approve.ts`:
```ts
import type { Command } from 'commander';
import { createEngine } from '../../engine/engine.js';
import { approvePlan } from '../../engine/gates.js';
import { formatIdentity, gitIdentity } from '../../git/identity.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface ApproveOptions {
  commit: string;
  exception?: string[];
}

export function registerApprove(program: Command, ctx: CliContext): void {
  const approve = program.command('approve').description('Pass a human gate');

  approve
    .command('plan')
    .description('Approve the technical plan, baseline, and listed exceptions (Gate 1)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the plan being approved')
    .option('--exception <id...>', 'baseline exception ids to approve')
    .action(async (options: ApproveOptions) => {
      ctx.exitCode = await approveCommand(ctx, 'plan_approval', options);
    });

  approve
    .command('revised-plan')
    .description('Approve a revised plan after an escalation (Gate 2)')
    .requiredOption('--commit <sha>', 'state-branch commit that contains the revised plan')
    .action(async (options: ApproveOptions) => {
      ctx.exitCode = await approveCommand(ctx, 'revised_plan_approval', options);
    });
}

async function approveCommand(ctx: CliContext, gate: 'plan_approval' | 'revised_plan_approval', options: ApproveOptions): Promise<ExitCode> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const approver = await gitIdentity(workspace.paths.janusDir);
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await approvePlan(engine, { gate, commit: options.commit, exceptions: options.exception ?? [], approver });
    ctx.io.stdout(`gate ${gate} passed at ${result.commit.slice(0, 7)} by ${formatIdentity(approver)}\n`);
    ctx.io.stdout(
      `goal ${workspace.state.goal.id}: ${workspace.state.goal.status} (checkpoint ${result.checkpoint.commit.slice(0, 7)}); run janus run to continue\n`,
    );
    return ExitCode.Ok;
  } finally {
    workspace.release();
  }
}
```

Replace `src/cli/commands/reject.ts`:
```ts
import type { Command } from 'commander';
import { createEngine } from '../../engine/engine.js';
import { rejectPlan } from '../../engine/gates.js';
import { formatIdentity, gitIdentity } from '../../git/identity.js';
import { findWorkspaceRoot, openWorkspace } from '../../workspace/open-workspace.js';
import type { CliContext } from '../context.js';
import { ExitCode } from '../exit-codes.js';

interface RejectOptions {
  reason: string;
}

export function registerReject(program: Command, ctx: CliContext): void {
  const reject = program.command('reject').description('Reject a gate with a reason');

  reject
    .command('plan')
    .description('Reject the current plan and send it back to planning')
    .requiredOption('--reason <text>', 'why the plan is rejected')
    .action(async (options: RejectOptions) => {
      ctx.exitCode = await rejectCommand(ctx, options);
    });
}

async function rejectCommand(ctx: CliContext, options: RejectOptions): Promise<ExitCode> {
  const workspace = await openWorkspace(findWorkspaceRoot(ctx.io.cwd));
  try {
    if (workspace.reclaimedLock !== null) {
      ctx.io.stderr(`janus: reclaimed a stale lock held by dead pid ${workspace.reclaimedLock.pid}\n`);
    }
    const approver = await gitIdentity(workspace.paths.janusDir);
    const gate = workspace.state.gate.type;
    const engine = createEngine({
      workspace,
      log: (line) => ctx.io.stdout(`${line}\n`),
      warn: (line) => ctx.io.stderr(`janus: warning: ${line}\n`),
    });
    const result = await rejectPlan(engine, { reason: options.reason, approver });
    ctx.io.stdout(`gate ${gate ?? 'plan_approval'} rejected by ${formatIdentity(approver)}\n`);
    ctx.io.stdout(`goal ${workspace.state.goal.id}: ${result.to} (checkpoint ${result.checkpoint.commit.slice(0, 7)}); run janus run to continue\n`);
    return ExitCode.Ok;
  } finally {
    workspace.release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/cli`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, full suite, commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

```bash
git add src/cli/commands/approve.ts src/cli/commands/reject.ts src/cli/main.ts tests/cli/approve.test.ts tests/cli/main.test.ts
git commit -m "feat(cli): pass or reject plan gates with commit-bound approval and git identity"
```

---

### Task 13: Done-when integration: a scripted run from `created` to `completed`, README

**Files:**
- Create: `tests/cli/scripted-run.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above through the CLI (`runCli` with `scriptedSteps`), `incrementBudget`, `checkGuardrail` (Task 2), `markInFlight`, `createGoalBranch` (helpers), `HAPPY_PATH` (Task 1), `readEvents` (T02).
- Produces: the T03 done-when as an executable test: "unit tests cover every transition, every budget row, every resume case with stubbed steps; a scripted run goes `created` to `completed` with no providers"; README describing `janus run`, `approve`, `reject`, exit codes, and resume behavior.

- [ ] **Step 1: Write the integration test**

`tests/cli/scripted-run.test.ts`:
```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { checkGuardrail, incrementBudget } from '../../src/engine/budgets.js';
import type { Step } from '../../src/engine/steps.js';
import { HAPPY_PATH } from '../../src/engine/transitions.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { createGoalBranch, initWorkspace, markInFlight, scriptedSteps } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

const stateBranch = 'janus/angular-15-to-16';

describe('scripted run with no providers (T03 done-when)', () => {
  it('goes from created to completed through run, approve, run, and resumes elsewhere as completed', async () => {
    const ws = await initWorkspace();

    const first = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(first.code).toBe(ExitCode.GateWaiting);
    const gateHead = await revParse(ws.janusDir, 'HEAD');
    expect(first.stdout).toContain(`janus approve plan --commit ${gateHead}`);

    const approved = await runCli(['approve', 'plan', '--commit', gateHead], { cwd: ws.root });
    expect(approved.code).toBe(ExitCode.Ok);

    const second = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(second.stderr).toBe('');
    expect(second.code).toBe(ExitCode.Ok);
    expect(second.stdout).toContain('goal angular-15-to-16 is completed');

    const state = readState(ws.janusDir);
    expect(state.goal.status).toBe('completed');
    expect(state.plan.approved_commit).toBe(gateHead);
    expect(state.execution.in_flight.step).toBeNull();
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
    expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toMatch(/^( M telemetry\/events.jsonl)?$/);
    expect(await remoteHead(ws.janusDir, 'origin', stateBranch)).toBe(await revParse(ws.janusDir, 'HEAD'));

    const events = readEvents(ws.janusDir);
    const types = events.map((event) => String(event['type']));
    expect(events.filter((event) => event['type'] === 'stage.entered').map((event) => event['stage'])).toEqual(HAPPY_PATH.slice(1));
    expect(types.filter((type) => type === 'gate.entered')).toHaveLength(1);
    expect(types.filter((type) => type === 'gate.passed')).toHaveLength(1);
    expect(types.filter((type) => type === 'goal.completed')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.started')).toHaveLength(2);
    expect(types.filter((type) => type === 'run.stopped')).toHaveLength(2);
    expect(types).not.toContain('escalation.created');

    const elsewhere = join(tempDir(), 'ws2');
    const resumed = await runCli(['init', '--resume', ws.fixture.stateBare, ws.fixture.goalId, '--workspace', elsewhere]);
    expect(resumed.code).toBe(ExitCode.Ok);
    expect(resumed.stdout).toContain('goal angular-15-to-16: status completed');
    const again = await runCli(['run'], { cwd: elsewhere }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.Ok);
    expect(again.stdout).toContain('0 steps run');
  });

  it('recovers from a simulated crash mid-step and charges the budget, then finishes', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    writeFileSync(join(ws.root, 'repos', 'ui-kit', 'agent-was-here.txt'), 'partial work\n');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0042', repo: 'ui-kit', budget: 'ci_fix_attempts' });

    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('previous run died during step "execute-work-packages"');
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-0042.interrupted.patch'))).toBe(true);
    expect(existsSync(join(ws.root, 'repos', 'ui-kit', 'agent-was-here.txt'))).toBe(false);
    const state = readState(ws.janusDir);
    expect(state.goal.status).toBe('completed');
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    expect(await runGit(ws.janusDir, ['log', '--format=%s'])).toContain('chore(janus): recover interrupted step execute-work-packages');
  });

  it('routes a guardrail hit to escalated with exit 12 and an escalation.md, and stays there', async () => {
    const exhaust: Step = {
      name: 'execute-work-packages',
      run: async ({ engine }) => {
        const ctx = { state: engine.workspace.state, config: engine.workspace.config, emit: engine.emit };
        for (let attempt = 1; attempt <= 5; attempt += 1) incrementBudget(ctx, 'ci_fix_attempts', `debug attempt ${attempt} on ui-kit`);
        const hit = checkGuardrail(ctx, 'ci_fix_attempts');
        if (hit === null) throw new Error('expected ci_fix_attempts to be exhausted');
        return ({ kind: 'escalate', reason: 'ui-kit PR build is still red after 5 debug attempts', repo: 'ui-kit', guardrail: hit });
      },
    };
    const ws = await initWorkspace();
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });

    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps({ executing: exhaust }) });
    expect(result.code).toBe(ExitCode.Escalated);
    expect(result.stdout).toContain('janus escalation resolve --direction');
    const escalation = readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8');
    expect(escalation).toContain('ui-kit PR build is still red after 5 debug attempts');
    expect(escalation).toContain('- Guardrail: ci_fix_attempts 5/5');
    expect(escalation).toContain('| ci_fix_attempts | 5 |');
    const types = readEvents(ws.janusDir).map((event) => String(event['type']));
    expect(types.filter((type) => type === 'budget.incremented')).toHaveLength(5);
    expect(types.filter((type) => type === 'guardrail.hit')).toHaveLength(1);
    expect(types.filter((type) => type === 'escalation.created')).toHaveLength(1);
    expect(readState(ws.janusDir).goal.status).toBe('escalated');

    const again = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.Escalated);
    expect(again.stdout).toContain('0 steps run');
    const show = await runCli(['escalation', 'show'], { cwd: ws.root });
    expect(show.code).toBe(ExitCode.NotImplemented);
  });

  it('stops with exit 11 when a wait exceeds --max-wait and finishes with a longer limit', async () => {
    const ciWait: Step = {
      name: 'execute-work-packages',
      run: async ({ maxWaitMs }) =>
        maxWaitMs < 120_000
          ? { kind: 'wait_exceeded', summary: `PR build still running after ${maxWaitMs} ms` }
          : { kind: 'advance', to: 'final_e2e', summary: 'PR builds green' },
    };
    const ws = await initWorkspace();
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    const short = await runCli(['run', '--max-wait', '1m'], { cwd: ws.root }, { steps: scriptedSteps({ executing: ciWait }) });
    expect(short.code).toBe(ExitCode.WaitExceeded);
    expect(readState(ws.janusDir).goal.status).toBe('executing');
    const long = await runCli(['run', '--max-wait', '5m'], { cwd: ws.root }, { steps: scriptedSteps({ executing: ciWait }) });
    expect(long.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).goal.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm vitest run tests/cli/scripted-run.test.ts`
Expected: PASS. If the `git status --porcelain` assertion fails because `telemetry/events.jsonl` is modified after the last checkpoint, that is the documented behavior (the `run.stopped` event lands after the final checkpoint and is committed by the next one); the regex already allows it.

- [ ] **Step 3: Update the README**

In `README.md` replace the `## Status` paragraph with:
```markdown
## Status

Early scaffold. The CLI exists with every command from spec §8. `janus init --goal` creates a goal workspace, `janus init --resume` rebuilds one from the state branch alone, and `janus run` drives the goal state machine: it recovers an interrupted step, reconciles repo heads, runs one step per stage with `in_flight` bracketing and a checkpoint after each, and stops at human gates (`janus approve plan --commit <sha>`, `janus reject plan --reason`), escalations, exceeded waits, or completion. Every real stage step is still a placeholder that reports the task delivering it (T11 onward); the machine is exercised end to end with scripted steps in `tests/cli/scripted-run.test.ts`.
```

Insert after the `## Workspace` section:
```markdown
## Running

`janus run [--until STAGE] [--max-wait 45m] [--dry-run] [--model-profile NAME]` must be run inside a workspace (any directory under it). It takes the workspace lock, loads `.janus/state.yaml`, and:

1. recovers an interrupted step if `execution.in_flight.step` is set: an agent run's uncommitted diff is saved to `.janus/evidence/agents/<run-id>.interrupted.patch`, the repo is reset, and the run counts against its budget (spec §7 rule 3);
2. reconciles every repo: a local goal branch that fast-forwarded past `head_commit` is adopted, a remote goal branch that is ahead is fast-forwarded locally, non-fast-forward drift escalates, and base-branch movement is only noted (§7 rule 2);
3. runs stage steps until it stops.

Exit codes: `0` completed or `--until` reached, `3` the next step is not implemented yet, `10` waiting at a human gate, `11` a wait exceeded `--max-wait`, `12` escalated, `13` another janus process holds the lock, `2` usage error, `1` unexpected error (including a moved remote state branch, which needs a manual reconcile).

Gates 1 and 2 are passed with `janus approve plan --commit <sha> [--exception <id> ...]` and `janus approve revised-plan --commit <sha>`; the sha must be the state-branch commit printed by `janus run` (the commit at which the gate was entered), and the approver is taken from the git identity in `.janus/` and written to `decisions.md`. `janus reject plan --reason "..."` sends the goal back to `planning` (or `replanning` after an escalation). Guardrail hits (spec §20) and step failures write `.janus/escalation.md` and move the goal to `escalated`; `janus escalation resolve` arrives with T13.
```

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green; the suite now has the 151 tests from T01/T02 plus the new engine, workspace, git, and CLI tests, with no `.only` or skipped cases (`grep -rn "\.only\|\.skip" tests` prints nothing).

- [ ] **Step 5: Commit**

```bash
git add tests/cli/scripted-run.test.ts README.md
git commit -m "test(engine): drive a scripted goal from created to completed and document janus run"
```

---

## Self-Review

**Spec coverage for T03 (tasks.md):**
- "explicit `goal.status` machine with allowed transitions and transition log": Task 1 (table, `canTransition`, `assertTransition`, every pair tested) and Task 4 (`enterStage` records `stage.exited`/`stage.entered`, the log being the append-only event stream of §27).
- "step abstraction with `in_flight` bracketing and checkpoint after each step": Task 6 (`Step`, `StepOutcome`, registry) and Task 10 (`in_flight` written to disk before `run`, cleared after, checkpoint per outcome; `not_implemented` deliberately skips the checkpoint so a placeholder does not add commits).
- "`janus run` with `--until`, `--max-wait`, `--dry-run`, lock, exit codes": Task 11 (`parseUntil`, `parseDuration`, `describeNextStep`, `openWorkspace` lock, `exitCodeForRun`); `--model-profile` is validated against `config.model_profiles` and handed to steps via `StepContext.modelProfile` for T05.
- "resume reconciliation per §7: head verification, goal and base branch drift, in-flight recovery per step type": Task 7 (local drift, remote relation, base moved; seven scenarios on real repos), Task 8 (agent vs other; CI/E2E waits re-run their step, which resumes on the recorded build id in T09), wired into the loop in Task 10 (two integration cases) and Task 13.
- "gates: Gate 1 and 2 by `janus approve --commit` (required) and `reject`; Gate 3 and 4 as SCM-observed placeholders": Task 9 (commit bound to HEAD, approver from git identity into `decisions.md`, exceptions), Task 12 (CLI), Task 6 placeholders for `awaiting_human_review`/`awaiting_merge`, Task 10 (SCM gate outcome stops the run and re-runs the observing step next time).
- "budget table per §20 as a single module: increment, reset, escalate hooks; guardrail hit routes to `escalated`": Task 2 (all seven counters, per-package `policy_violations`, `max_goal_runtime_hours`; `checkGuardrail` is the escalate hook) and Task 5 (`escalate` with `guardrail.hit`), exercised end to end in Task 13.
- "telemetry events for stage, gate, budget, guardrail": Tasks 4, 9, 2, 5; plus `escalation.created`, `goal.completed`, `agent.finished` (interrupted), and the flagged extensions `run.started`, `run.stopped`, `gate.rejected`, `repo.drift`.
- Done-when: Task 1 covers every transition, Task 2 every budget row, Tasks 7, 8, 10 every resume case with stubbed steps, Task 13 the scripted `created` to `completed` run with no providers (through the CLI, including resume on another machine).
- §7 rule 4 (moved remote state branch stops the run with a reconcile instruction): Task 11. §7 rule 6 (stale lock reclaimed with a warning): Tasks 3 and 11. §35: `status --json` and `escalation show --json` remain stubs for T14 and T13 and will consume `openWorkspace`.
- Not in this plan by design: the `sync` step for base drift (§16.6, T18), the full escalation package and `escalation resolve` (T13), `status` rendering (T14), agent-driven `in_flight.agent_run_id` population (T05/T12).

**Placeholder scan:** no "TBD", "TODO", "similar to Task N", or "add error handling" steps; every code step carries the code. The word "placeholder" appears only as the name of the deliberate `placeholderStep` design.

**Type consistency:**
- `Workspace` (Task 3) is consumed by `createEngine` (Task 4), `describeNextStep` (Task 10), and the commands (Tasks 11, 12) with the same fields (`paths`, `state`, `goal`, `repoOrder`, `config`, `stateRemoteUrl`, `reclaimedLock`, `release`).
- `Engine` (Task 4) methods `now`, `log`, `warn`, `emit`, `checkpoint(message, decision?)` are used identically in Tasks 5, 7, 8, 9, 10; `emit` is an arrow so `incrementBudget({ state, config, emit: engine.emit }, ...)` in Tasks 8 and 13 is safe.
- `StepOutcome.escalate` carries `{ reason, repo, guardrail }` in Task 6 and is consumed with all three in Task 10 and produced with all three in the Task 10, 11, and 13 tests.
- `BudgetIncrement { budget, value, limit, exhausted }` (Task 2) is what `recoverInFlight` returns in `budget` (Task 8) and what its tests assert.
- `GateType` and `BUDGET_NAMES`/`BudgetName` come from `state-schema.ts` (Task 2) and are imported from there in Tasks 5, 6, 8, 9; `emptyInFlight` (Task 8) is used in Task 10 and its tests.
- `enterGate` returns `CheckpointResult` (Task 9); Task 10 ignores the value, the Task 9 test reads `.commit`.
- `RunResult.task` is `string | null` (never optional) so `exactOptionalPropertyTypes` never bites in the CLI (Task 11).
- Test helpers: `initWorkspace` (Task 3), `testEngine` (Task 4), `createGoalBranch` (Task 7), `markInFlight` (Task 8), `advanceStep`/`scriptedSteps` (Task 10) all live in `tests/helpers/engine-fixtures.ts` and are imported by name in later tasks.
