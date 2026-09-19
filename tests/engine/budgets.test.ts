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
