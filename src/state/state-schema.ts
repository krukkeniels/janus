import { z } from 'zod';
import type { Goal } from '../config/goal-schema.js';

export const GOAL_STATUSES = [
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
  'fixing_review_feedback',
  'awaiting_merge',
  'releasing',
  'escalated',
  'replanning',
  'completed',
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

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

const sha = z.string().regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit sha');
const nullableSha = sha.nullable();
const isoDate = z.string().datetime();
const nullableString = z.string().nullable();
const nonNegativeInt = z.number().int().nonnegative();

const prSchema = z
  .object({
    id: z.number().int().nullable().default(null),
    url: nullableString.default(null),
    state: z.enum(['OPEN', 'MERGED', 'DECLINED']).nullable().default(null),
    version: z.number().int().nullable().default(null),
    approved: z.boolean().default(false),
  })
  .strict()
  .default({});

const lastBuildSchema = z
  .object({
    id: nullableString.default(null),
    status: z.enum(['unknown', 'queued', 'running', 'finished']).default('unknown'),
    classification: z.enum(['success', 'tests_failed', 'build_failed', 'infra']).nullable().default(null),
    revision: nullableSha.default(null),
    explicit_trigger: z.boolean().default(false),
  })
  .strict()
  .default({});

export const repoStateSchema = z
  .object({
    goal_branch: z.string().min(1),
    base_commit: nullableSha.default(null),
    head_commit: nullableSha.default(null),
    pr: prSchema,
    last_build: lastBuildSchema,
    prerelease_version: nullableString.default(null),
    release_version: nullableString.default(null),
    merged: z.boolean().default(false),
    merge_commit: nullableSha.default(null),
  })
  .strict();

export type RepoState = z.infer<typeof repoStateSchema>;

const workPackageRepoSchema = z
  .object({
    commits: z.array(sha).default([]),
    builds: z.array(z.string()).default([]),
    attempts: nonNegativeInt.default(0),
    policy_violations: nonNegativeInt.default(0),
    last_failure_signature: nullableString.default(null),
  })
  .strict();

export const workPackageStateSchema = z
  .object({
    status: z.enum(['pending', 'in_progress', 'expected_red', 'green', 'done', 'skipped']).default('pending'),
    repos: z.record(z.string(), workPackageRepoSchema).default({}),
    publish: z
      .object({ version: nullableString.default(null), build_id: nullableString.default(null) })
      .strict()
      .default({}),
    checkpoint: z
      .object({
        outcome: z.enum(['PASS', 'CONTINUE_WITH_REFINED_TASKS', 'REGROUP_VERIFICATION', 'ESCALATE']).nullable().default(null),
        run_id: nullableString.default(null),
      })
      .strict()
      .default({}),
    regroups: z.array(z.string()).default([]),
  })
  .strict();

const baselineRepoSchema = z
  .object({
    commit: nullableSha.default(null),
    local: z.record(z.string(), z.enum(['pass', 'fail', 'skipped'])).default({}),
    pr_build: z
      .object({
        id: nullableString.default(null),
        status: z.enum(['unknown', 'success', 'tests_failed', 'build_failed', 'infra']).default('unknown'),
      })
      .strict()
      .default({}),
  })
  .strict();

const baselineExceptionSchema = z
  .object({
    id: z.string().min(1),
    repo: z.string().min(1),
    kind: z.enum(['test', 'build', 'e2e']),
    identity: z.string().min(1),
    reason: z.string().default(''),
    approved_by: nullableString.default(null),
    approved_at: isoDate.nullable().default(null),
  })
  .strict();

const openCommentSchema = z
  .object({
    repo: z.string().min(1),
    comment_id: z.string().min(1),
    author: z.string().min(1),
    path: nullableString.default(null),
    line: z.number().int().nullable().default(null),
    text: z.string(),
    status: z.enum(['open', 'fixed', 'answered']).default('open'),
  })
  .strict();

export const stateSchema = z
  .object({
    version: z.literal(2),
    goal: z.object({ id: z.string().min(1), status: z.enum(GOAL_STATUSES) }).strict(),
    state_branch: z.object({ name: z.string().min(1), remote: z.string().min(1) }).strict(),
    repos: z.record(z.string(), repoStateSchema),
    plan: z
      .object({
        approved: z.boolean().default(false),
        approved_commit: nullableSha.default(null),
        approved_at: isoDate.nullable().default(null),
        revision: nonNegativeInt.default(0),
      })
      .strict()
      .default({}),
    baseline: z
      .object({
        approved: z.boolean().default(false),
        repos: z.record(z.string(), baselineRepoSchema).default({}),
        e2e: z
          .object({
            id: nullableString.default(null),
            status: z.enum(['not_run', 'running', 'passed', 'failed']).default('not_run'),
            branches: z.record(z.string(), z.string()).default({}),
          })
          .strict()
          .default({}),
        exceptions: z.array(baselineExceptionSchema).default([]),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        current_work_package: nullableString.default(null),
        current_verification_group: nullableString.default(null),
        work_packages: z.record(z.string(), workPackageStateSchema).default({}),
        in_flight: z
          .object({
            step: nullableString.default(null),
            started_at: isoDate.nullable().default(null),
            agent_run_id: nullableString.default(null),
          })
          .strict()
          .default({}),
        budgets: z
          .object({
            ci_fix_attempts: nonNegativeInt.default(0),
            e2e_fix_attempts: nonNegativeInt.default(0),
            ai_review_cycles: nonNegativeInt.default(0),
            no_progress_iterations: nonNegativeInt.default(0),
            work_packages_without_green: nonNegativeInt.default(0),
            sync_conflict_attempts: nonNegativeInt.default(0),
            infra_retries: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    verification: z
      .object({
        e2e: z
          .object({
            status: z.enum(['not_run', 'running', 'passed', 'failed', 'invalidated']).default('not_run'),
            build_id: nullableString.default(null),
            heads: z.record(z.string(), sha).default({}),
            reruns: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
        ai_review: z
          .object({
            status: z.enum(['not_run', 'running', 'passed', 'findings']).default('not_run'),
            run_id: nullableString.default(null),
            findings_open: nonNegativeInt.default(0),
          })
          .strict()
          .default({}),
        qa_recommendation: z
          .object({
            status: z.enum(['not_run', 'running', 'done']).default('not_run'),
            run_id: nullableString.default(null),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    gate: z
      .object({
        type: z.enum(GATE_TYPES).nullable().default(null),
        status: z.enum(['none', 'waiting', 'passed']).default('none'),
        entered_at: isoDate.nullable().default(null),
        checkpoint_commit: nullableSha.default(null),
      })
      .strict()
      .default({}),
    review_loop: z
      .object({
        activity_cursor: z.record(z.string(), z.string()).default({}),
        open_comments: z.array(openCommentSchema).default([]),
      })
      .strict()
      .default({}),
    release: z
      .object({ order: z.array(z.string()).default([]), done: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    telemetry: z
      .object({ started_at: isoDate.nullable().default(null), last_updated_at: isoDate.nullable().default(null) })
      .strict()
      .default({}),
  })
  .strict();

export type JanusState = z.infer<typeof stateSchema>;

export interface InitialStateInput {
  goal: Goal;
  stateBranch: { name: string; remote: string };
  now: Date;
}

/** The state of a freshly created goal: status `created`, one repo entry per goal repo, everything else at its default. */
export function createInitialState(input: InitialStateInput): JanusState {
  const repos: Record<string, { goal_branch: string }> = {};
  for (const repo of input.goal.repos) {
    repos[repo.name] = { goal_branch: `ai/${input.goal.id}` };
  }
  const timestamp = input.now.toISOString();
  return stateSchema.parse({
    version: 2,
    goal: { id: input.goal.id, status: 'created' },
    state_branch: input.stateBranch,
    repos,
    telemetry: { started_at: timestamp, last_updated_at: timestamp },
  });
}
