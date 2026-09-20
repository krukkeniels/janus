import type { JanusConfig } from '../config/config-schema.js';
import { BUDGET_NAMES } from '../state/state-schema.js';
import type { BudgetName, JanusState } from '../state/state-schema.js';
import type { GuardrailName, TelemetryEvent } from '../telemetry/events.js';

export interface BudgetContext {
  state: JanusState;
  config: JanusConfig;
  emit(event: TelemetryEvent): unknown;
}

/** Every counter a guardrail can name: the seven budgets, per-package `policy_violations`, and `goal_runtime_hours`. */
export type { GuardrailName } from '../telemetry/events.js';

/** A limit that was reached. */
export interface GuardrailHit {
  guardrail: GuardrailName;
  value: number;
  limit: number;
  detail: string;
}

export interface BudgetIncrement {
  budget: GuardrailName;
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
