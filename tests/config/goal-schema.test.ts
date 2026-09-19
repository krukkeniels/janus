import { describe, expect, it } from 'vitest';
import { formatZodIssues } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { validGoal } from '../fixtures/valid-goal.js';

function issuesOf(input: unknown): string[] {
  const result = goalSchema.safeParse(input);
  return result.success ? [] : formatZodIssues(result.error);
}

describe('goalSchema', () => {
  it('accepts a valid goal and fills defaults', () => {
    const goal = goalSchema.parse(validGoal);
    expect(goal.repos[0]?.depends_on).toEqual([]);
    expect(goal.repos[0]?.coupled_with).toEqual([]);
    expect(goal.repos[0]?.loads_remotes).toEqual([]);
    expect(goal.acknowledged_outside_goal).toEqual([]);
    expect(goal.e2e.extra_params).toEqual({});
    expect(goal.e2e.suite_repo_map).toEqual({});
    expect(goal.success_criteria).toEqual([]);
  });

  it('requires target_version to be source_version + 1', () => {
    expect(issuesOf({ ...validGoal, target_version: '17' })).toContain(
      'target_version: must be exactly one major above source_version (expected "16")',
    );
  });

  it('rejects non-numeric versions', () => {
    const issues = issuesOf({ ...validGoal, source_version: 'v15' });
    expect(issues).toContain('source_version: must be a major version number like "16"');
    expect(issues.some((issue) => issue.startsWith('target_version:'))).toBe(false);
  });

  it('rejects an id or repo name that is not kebab-case', () => {
    expect(issuesOf({ ...validGoal, id: 'Angular 15' })).toContain('id: must be kebab-case (lowercase letters, digits, dashes)');
    const repos = [{ ...validGoal.repos[0], name: 'UI Kit' }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos })).toContain('repos.0.name: must be kebab-case (lowercase letters, digits, dashes)');
  });

  it('requires at least one repo and a pr_build_type_id per repo', () => {
    expect(issuesOf({ ...validGoal, repos: [] })).toContain('repos: Array must contain at least 1 element(s)');
    const repos = [{ ...validGoal.repos[0], ci: {} }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos })).toContain('repos.0.ci.pr_build_type_id: Required');
  });

  it('rejects an unknown repo kind and unknown keys', () => {
    const repos = [{ ...validGoal.repos[0], kind: 'service' }, ...validGoal.repos.slice(1)];
    expect(issuesOf({ ...validGoal, repos }).some((issue) => issue.startsWith('repos.0.kind:'))).toBe(true);
    expect(issuesOf({ ...validGoal, extra: true }).some((issue) => issue.startsWith('<root>: Unrecognized key'))).toBe(true);
  });
});
