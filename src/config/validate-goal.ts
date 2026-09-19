import { ConfigError } from './errors.js';
import type { Goal, GoalRepo } from './goal-schema.js';

export interface ValidatedGoal {
  goal: Goal;
  repoOrder: string[];
}

export function validateGoal(goal: Goal, source = 'goal.yaml'): ValidatedGoal {
  const issues: string[] = [];
  const names = goal.repos.map((repo) => repo.name);
  const known = new Set<string>();
  for (const name of names) {
    if (known.has(name)) issues.push(`repos: duplicate repo name "${name}"`);
    known.add(name);
  }
  const acknowledged = new Set(goal.acknowledged_outside_goal.map((entry) => entry.repo));

  for (const repo of goal.repos) {
    checkRefs(repo, 'depends_on', repo.depends_on, known, issues);
    checkRefs(repo, 'coupled_with', repo.coupled_with, known, issues);
    for (const remote of repo.loads_remotes) {
      if (!known.has(remote) && !acknowledged.has(remote)) {
        issues.push(
          `repos.${repo.name}.loads_remotes: "${remote}" is neither in repos nor in acknowledged_outside_goal`,
        );
      }
    }
  }

  for (const entry of goal.acknowledged_outside_goal) {
    if (known.has(entry.repo)) {
      issues.push(
        `acknowledged_outside_goal: "${entry.repo}" is part of the goal and cannot be acknowledged as outside it`,
      );
    }
  }

  for (const name of Object.keys(goal.e2e.branch_params)) {
    if (!known.has(name)) issues.push(`e2e.branch_params: unknown repo "${name}"`);
  }

  const order = topologicalOrder(goal.repos, known);
  if (order.cycle.length > 0) {
    issues.push(`repos: dependency cycle among ${[...order.cycle].sort().join(', ')}`);
  }

  if (issues.length > 0) {
    throw new ConfigError(source, issues);
  }

  return { goal: normalizeCoupling(goal), repoOrder: order.sorted };
}

function checkRefs(
  repo: GoalRepo,
  field: 'depends_on' | 'coupled_with',
  refs: string[],
  known: Set<string>,
  issues: string[],
): void {
  for (const ref of refs) {
    if (ref === repo.name) {
      const verb = field === 'depends_on' ? 'depend on' : 'be coupled with';
      issues.push(`repos.${repo.name}.${field}: a repo cannot ${verb} itself`);
    } else if (!known.has(ref)) {
      issues.push(`repos.${repo.name}.${field}: unknown repo "${ref}"`);
    }
  }
}

/** Kahn's algorithm; declaration order breaks ties. Repos left over are in a cycle. */
function topologicalOrder(repos: GoalRepo[], known: Set<string>): { sorted: string[]; cycle: string[] } {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const repo of repos) {
    indegree.set(repo.name, 0);
    dependents.set(repo.name, []);
  }
  for (const repo of repos) {
    for (const dep of repo.depends_on) {
      if (!known.has(dep) || dep === repo.name) continue;
      indegree.set(repo.name, (indegree.get(repo.name) ?? 0) + 1);
      dependents.get(dep)?.push(repo.name);
    }
  }
  const sorted: string[] = [];
  const ready = repos.map((repo) => repo.name).filter((name) => indegree.get(name) === 0);
  while (ready.length > 0) {
    const next = ready.shift()!;
    sorted.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((a, b) => declarationIndex(repos, a) - declarationIndex(repos, b));
      }
    }
  }
  const leftover = repos.map((repo) => repo.name).filter((name) => !sorted.includes(name));
  return { sorted, cycle: cycleMembers(repos, leftover) };
}

/** Among the nodes Kahn's algorithm could not order, keep those that can reach themselves. */
function cycleMembers(repos: GoalRepo[], leftover: string[]): string[] {
  const leftoverSet = new Set(leftover);
  const edges = new Map<string, string[]>();
  for (const repo of repos) {
    if (!leftoverSet.has(repo.name)) continue;
    edges.set(repo.name, repo.depends_on.filter((dep) => leftoverSet.has(dep) && dep !== repo.name));
  }
  const reachesSelf = (start: string): boolean => {
    const stack = [...(edges.get(start) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === start) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(edges.get(node) ?? []));
    }
    return false;
  };
  return leftover.filter(reachesSelf);
}

function declarationIndex(repos: GoalRepo[], name: string): number {
  return repos.findIndex((repo) => repo.name === name);
}

function normalizeCoupling(goal: Goal): Goal {
  const coupling = new Map<string, Set<string>>();
  for (const repo of goal.repos) coupling.set(repo.name, new Set(repo.coupled_with));
  for (const repo of goal.repos) {
    for (const peer of repo.coupled_with) coupling.get(peer)?.add(repo.name);
  }
  return {
    ...goal,
    repos: goal.repos.map((repo) => ({
      ...repo,
      coupled_with: [...(coupling.get(repo.name) ?? [])].sort(),
    })),
  };
}
