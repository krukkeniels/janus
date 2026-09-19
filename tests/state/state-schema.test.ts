import { describe, expect, it } from 'vitest';
import { formatZodIssues } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { createInitialState, GOAL_STATUSES, stateSchema } from '../../src/state/state-schema.js';
import { validGoal } from '../fixtures/valid-goal.js';

const now = new Date('2026-09-19T12:00:00.000Z');

function initial() {
  return createInitialState({
    goal: goalSchema.parse(validGoal),
    stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' },
    now,
  });
}

function issuesOf(input: unknown): string[] {
  const result = stateSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('createInitialState', () => {
  it('builds a version 2 state with one entry per repo and every default filled', () => {
    const state = initial();
    expect(state.version).toBe(2);
    expect(state.goal).toEqual({ id: 'angular-15-to-16', status: 'created' });
    expect(state.state_branch).toEqual({ name: 'janus/angular-15-to-16', remote: 'state-repo' });
    expect(Object.keys(state.repos)).toEqual(['ui-kit', 'shell', 'orders-remote']);
    expect(state.repos['ui-kit']).toEqual({
      goal_branch: 'ai/angular-15-to-16',
      base_commit: null,
      head_commit: null,
      pr: { id: null, url: null, state: null, version: null, approved: false },
      last_build: { id: null, status: 'unknown', classification: null, revision: null, explicit_trigger: false },
      prerelease_version: null,
      release_version: null,
      merged: false,
      merge_commit: null,
    });
    expect(state.plan).toEqual({ approved: false, approved_commit: null, approved_at: null, revision: 0 });
    expect(state.execution.budgets).toEqual({
      ci_fix_attempts: 0,
      e2e_fix_attempts: 0,
      ai_review_cycles: 0,
      no_progress_iterations: 0,
      work_packages_without_green: 0,
      sync_conflict_attempts: 0,
      infra_retries: 0,
    });
    expect(state.execution.work_packages).toEqual({});
    expect(state.execution.in_flight).toEqual({ step: null, started_at: null, agent_run_id: null });
    expect(state.verification.e2e.status).toBe('not_run');
    expect(state.gate).toEqual({ type: null, status: 'none', entered_at: null, checkpoint_commit: null });
    expect(state.release).toEqual({ order: [], done: [] });
    expect(state.telemetry).toEqual({ started_at: now.toISOString(), last_updated_at: now.toISOString() });
  });

  it('round-trips through the schema unchanged', () => {
    const state = initial();
    expect(stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });
});

describe('stateSchema', () => {
  it('lists every goal status from the spec', () => {
    expect(GOAL_STATUSES).toEqual([
      'created', 'preparing', 'discovering', 'baselining', 'planning', 'awaiting_plan_approval',
      'executing', 'final_e2e', 'ai_review', 'qa', 'awaiting_human_review', 'fixing_review_feedback',
      'awaiting_merge', 'releasing', 'escalated', 'replanning', 'completed',
    ]);
  });

  it('rejects another version, unknown keys, and malformed shas', () => {
    const state = JSON.parse(JSON.stringify(initial())) as Record<string, unknown>;
    expect(issuesOf({ ...state, version: 1 }).some((issue) => issue.startsWith('version:'))).toBe(true);
    expect(issuesOf({ ...state, extra: true }).some((issue) => issue.startsWith('<root>: Unrecognized key'))).toBe(true);
    const repos = state['repos'] as Record<string, Record<string, unknown>>;
    const broken = { ...state, repos: { ...repos, 'ui-kit': { ...repos['ui-kit'], head_commit: 'abc' } } };
    expect(issuesOf(broken)).toContain('repos.ui-kit.head_commit: must be a full 40-character commit sha');
  });

  it('accepts a work package block with nested defaults', () => {
    const state = JSON.parse(JSON.stringify(initial())) as Record<string, unknown>;
    const execution = { ...(state['execution'] as object), work_packages: { 'wp-01': { repos: { 'ui-kit': {} } } } };
    const parsed = stateSchema.parse({ ...state, execution });
    expect(parsed.execution.work_packages['wp-01']).toEqual({
      status: 'pending',
      repos: { 'ui-kit': { commits: [], builds: [], attempts: 0, policy_violations: 0, last_failure_signature: null } },
      publish: { version: null, build_id: null },
      checkpoint: { outcome: null, run_id: null },
      regroups: [],
    });
  });
});
