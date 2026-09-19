import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/config/errors.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import type { Goal } from '../../src/config/goal-schema.js';
import { validateGoal } from '../../src/config/validate-goal.js';
import { validGoal } from '../fixtures/valid-goal.js';

function goalWith(mutate: (goal: Goal) => void): Goal {
  const goal = goalSchema.parse(validGoal);
  mutate(goal);
  return goal;
}

function issuesOf(goal: Goal): string[] {
  try {
    validateGoal(goal);
    return [];
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
}

describe('validateGoal', () => {
  it('returns dependency order with dependencies first and declaration order as tiebreak', () => {
    const result = validateGoal(goalSchema.parse(validGoal));
    expect(result.repoOrder).toEqual(['ui-kit', 'shell', 'orders-remote']);
  });

  it('normalizes coupled_with to be symmetric and sorted', () => {
    const result = validateGoal(goalSchema.parse(validGoal));
    const shell = result.goal.repos.find((repo) => repo.name === 'shell');
    const orders = result.goal.repos.find((repo) => repo.name === 'orders-remote');
    expect(shell?.coupled_with).toEqual(['orders-remote']);
    expect(orders?.coupled_with).toEqual(['shell']);
  });

  it('rejects duplicate repo names', () => {
    const goal = goalWith((g) => {
      g.repos.push({ ...g.repos[0]!, name: 'ui-kit' });
    });
    expect(issuesOf(goal)).toContain('repos: duplicate repo name "ui-kit"');
  });

  it('rejects unknown references in depends_on and coupled_with', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.depends_on = ['ghost'];
      g.repos[2]!.coupled_with = ['phantom'];
    });
    const issues = issuesOf(goal);
    expect(issues).toContain('repos.shell.depends_on: unknown repo "ghost"');
    expect(issues).toContain('repos.orders-remote.coupled_with: unknown repo "phantom"');
  });

  it('rejects self references', () => {
    const goal = goalWith((g) => {
      g.repos[0]!.depends_on = ['ui-kit'];
    });
    expect(issuesOf(goal)).toContain('repos.ui-kit.depends_on: a repo cannot depend on itself');
  });

  it('rejects dependency cycles and names the members', () => {
    const goal = goalWith((g) => {
      g.repos[0]!.depends_on = ['shell'];
    });
    expect(issuesOf(goal)).toContain('repos: dependency cycle among shell, ui-kit');
  });

  it('requires every loaded remote to be in the goal or acknowledged', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.loads_remotes = ['orders-remote', 'billing-remote'];
    });
    expect(issuesOf(goal)).toContain(
      'repos.shell.loads_remotes: "billing-remote" is neither in repos nor in acknowledged_outside_goal',
    );
    const acknowledged = goalWith((g) => {
      g.repos[1]!.loads_remotes = ['orders-remote', 'billing-remote'];
      g.acknowledged_outside_goal = [{ repo: 'billing-remote', reason: 'retired next quarter' }];
    });
    expect(issuesOf(acknowledged)).toEqual([]);
  });

  it('rejects an acknowledged repo that is also in the goal', () => {
    const goal = goalWith((g) => {
      g.acknowledged_outside_goal = [{ repo: 'shell', reason: 'x' }];
    });
    expect(issuesOf(goal)).toContain('acknowledged_outside_goal: "shell" is part of the goal and cannot be acknowledged as outside it');
  });

  it('rejects e2e.branch_params for unknown repos', () => {
    const goal = goalWith((g) => {
      g.e2e.branch_params = { ...g.e2e.branch_params, nowhere: 'env.X' };
    });
    expect(issuesOf(goal)).toContain('e2e.branch_params: unknown repo "nowhere"');
  });

  it('collects every issue in one error', () => {
    const goal = goalWith((g) => {
      g.repos[1]!.depends_on = ['ghost'];
      g.e2e.branch_params = { nowhere: 'env.X' };
    });
    expect(issuesOf(goal)).toHaveLength(2);
  });
});
