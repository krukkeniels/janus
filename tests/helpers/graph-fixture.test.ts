import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGoal } from '../../src/config/load-goal.js';
import { runGit } from '../../src/git/run.js';
import { goalFixture, graphFixture } from './workspace-fixtures.js';

describe('graphFixture', () => {
  it('writes a goal.yaml the real loader accepts and orders topologically', async () => {
    const fixture = await graphFixture([
      { name: 'ui-kit', kind: 'library' },
      { name: 'orders-remote', kind: 'remote', dependsOn: ['ui-kit'] },
      { name: 'shell', kind: 'shell', dependsOn: ['ui-kit', 'orders-remote'], loadsRemotes: ['orders-remote'] },
    ]);

    const { goal, repoOrder } = loadGoal(fixture.goalPath);
    expect(repoOrder).toEqual(['ui-kit', 'orders-remote', 'shell']);
    expect(goal.repos.map((repo) => repo.depends_on)).toEqual([[], ['ui-kit'], ['ui-kit', 'orders-remote']]);
    expect(goal.repos[2]?.loads_remotes).toEqual(['orders-remote']);
    expect(goal.repos[0]?.clone_url).toBe(fixture.repos['ui-kit']?.bare);
    expect(goal.e2e.branch_params).toEqual({ shell: 'env.SHELL_BRANCH' });
    expect(goal.repos[1]?.ci.pr_build_type_id).toBe('Fe_OrdersRemote_Build');
  });

  it('omits empty relation lists and logs every ref update, tags included, on every bare remote', async () => {
    const fixture = await graphFixture([{ name: 'ui-kit', kind: 'library' }]);
    expect(readFileSync(fixture.goalPath, 'utf8')).not.toContain('depends_on');
    expect(readFileSync(fixture.goalPath, 'utf8')).not.toContain('coupled_with');
    const bare = fixture.repos['ui-kit']?.bare;
    if (bare === undefined) throw new Error('expected a ui-kit remote');
    // `always`, not `true`: `true` would leave a pushed tag with no reflog in the receiving bare repository.
    expect(await runGit(bare, ['config', '--get', 'core.logAllRefUpdates'])).toBe('always');
    expect(await runGit(fixture.stateBare, ['config', '--get', 'core.logAllRefUpdates'])).toBe('always');
    expect(fixture.tempRoots.length).toBeGreaterThanOrEqual(3);
  });
});

describe('goalFixture', () => {
  it('still produces the two-repo ui-kit/shell goal the existing tests rely on', async () => {
    const fixture = await goalFixture();
    const { goal, repoOrder } = loadGoal(fixture.goalPath);
    expect(repoOrder).toEqual(['ui-kit', 'shell']);
    expect(goal.id).toBe('angular-15-to-16');
    expect(fixture.goalText).toContain(`clone_url: ${fixture.uiKit.bare}`);
    expect(goal.e2e.branch_params).toEqual({ shell: 'env.SHELL_BRANCH' });
  });
});
