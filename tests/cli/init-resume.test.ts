import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { checkoutBranch, commitAll, currentBranch, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { stateBranchName } from '../../src/workspace/remotes.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';
import { goalFixture } from '../helpers/workspace-fixtures.js';

describe('janus init --resume', () => {
  it('rebuilds an identical workspace from the state branch alone', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    expect((await runCli(['init', '--goal', fixture.goalPath, '--workspace', first])).code).toBe(ExitCode.Ok);

    // Simulate progress: ui-kit has a goal branch with one commit, recorded in state and checkpointed.
    const goalBranch = `ai/${fixture.goalId}`;
    const uiKitDir = join(first, 'repos', 'ui-kit');
    await checkoutBranch(uiKitDir, goalBranch, 'HEAD');
    writeFileSync(join(uiKitDir, 'upgrade.txt'), 'angular 16\n');
    const head = await commitAll(uiKitDir, 'feat(ui-kit): upgrade');
    await push(uiKitDir, 'origin', goalBranch, { setUpstream: true });
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    const uiKit = state.repos['ui-kit'];
    if (!uiKit) throw new Error('state has no ui-kit');
    uiKit.head_commit = head;
    state.goal.status = 'executing';
    const { goal } = loadGoal(join(janusDir, 'goal.yaml'));
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): progress', push: true });

    const second = join(tempDir(), 'ws2');
    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', second]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(`workspace: ${second}`);

    expect(readFileSync(join(second, '.janus', 'state.yaml'), 'utf8')).toBe(readFileSync(join(janusDir, 'state.yaml'), 'utf8'));
    expect(readFileSync(join(second, '.janus', 'goal.yaml'), 'utf8')).toBe(fixture.goalText);
    expect(await revParse(join(second, 'repos', 'ui-kit'), 'HEAD')).toBe(head);
    expect(await currentBranch(join(second, 'repos', 'ui-kit'))).toBe(goalBranch);
    expect(await revParse(join(second, 'repos', 'shell'), 'HEAD')).toBe(fixture.shell.head);
    expect(await currentBranch(join(second, 'repos', 'shell'))).toBe('main');
    expect(existsSync(join(second, 'janus.lock'))).toBe(false);
  });

  it('warns and checks out the recorded head when a goal branch moved past it', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    await runCli(['init', '--goal', fixture.goalPath, '--workspace', first]);
    const goalBranch = `ai/${fixture.goalId}`;
    const uiKitDir = join(first, 'repos', 'ui-kit');
    await checkoutBranch(uiKitDir, goalBranch, 'HEAD');
    const recorded = await commitAll(uiKitDir, 'feat(ui-kit): one', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch, { setUpstream: true });
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    const uiKit = state.repos['ui-kit'];
    if (!uiKit) throw new Error('state has no ui-kit');
    uiKit.head_commit = recorded;
    const { goal } = loadGoal(join(janusDir, 'goal.yaml'));
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): progress', push: true });
    // The remote goal branch moves ahead of the recorded head, but stays a fast-forward descendant of it.
    await commitAll(uiKitDir, 'feat(ui-kit): two', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch);

    const second = join(tempDir(), 'ws2');
    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', second]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('remote goal branch is ahead');
    expect(await revParse(join(second, 'repos', 'ui-kit'), 'HEAD')).toBe(recorded);
    expect(await currentBranch(join(second, 'repos', 'ui-kit'))).toBe(goalBranch);
  });

  it('checks out the remote head and warns on non-fast-forward drift', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    await runCli(['init', '--goal', fixture.goalPath, '--workspace', first]);
    const goalBranch = `ai/${fixture.goalId}`;
    const uiKitDir = join(first, 'repos', 'ui-kit');
    await checkoutBranch(uiKitDir, goalBranch, 'HEAD');
    const recorded = await commitAll(uiKitDir, 'feat(ui-kit): one', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch, { setUpstream: true });
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    const uiKit = state.repos['ui-kit'];
    if (!uiKit) throw new Error('state has no ui-kit');
    uiKit.head_commit = recorded;
    const { goal } = loadGoal(join(janusDir, 'goal.yaml'));
    await checkpoint({ janusDir, state, goal, message: 'chore(janus): progress', push: true });

    // Rewrite the remote goal branch to a commit built from the base branch, not from `recorded`,
    // so the recorded head is no longer reachable from the new remote tip.
    await checkoutBranch(uiKitDir, 'rewritten', fixture.uiKit.head);
    const divergent = await commitAll(uiKitDir, 'feat(ui-kit): rewritten history', { allowEmpty: true });
    await runGit(uiKitDir, ['push', '-q', '--force', 'origin', `rewritten:${goalBranch}`]);

    const second = join(tempDir(), 'ws2');
    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', second]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('non-fast-forward drift');
    expect(await revParse(join(second, 'repos', 'ui-kit'), 'HEAD')).toBe(divergent);
    expect(await currentBranch(join(second, 'repos', 'ui-kit'))).toBe(goalBranch);
  });

  it('rejects a state branch whose recorded name does not match the derived branch name', async () => {
    const fixture = await goalFixture();
    const first = join(tempDir(), 'ws1');
    await runCli(['init', '--goal', fixture.goalPath, '--workspace', first]);
    const janusDir = join(first, '.janus');
    const state = readState(janusDir);
    state.state_branch.name = 'janus/some-other-goal';
    // Write and push directly (not via checkpoint, which pushes state_branch.name as the local
    // branch name too): the actual git branch stays `janus/<goalId>`; only the recorded field lies.
    writeState(janusDir, state);
    await commitAll(janusDir, 'chore(janus): corrupt state_branch.name', { allowEmpty: true });
    await push(janusDir, 'origin', stateBranchName(fixture.goalId));

    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', join(tempDir(), 'ws2')]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain(`state branch name janus/some-other-goal does not match janus/${fixture.goalId}`);
  });

  it('requires the goal id', async () => {
    const fixture = await goalFixture();
    const result = await runCli(['init', '--resume', fixture.stateBare]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('init --resume requires the goal id');
  });

  it('removes what it created when the state branch cannot be cloned', async () => {
    const fixture = await goalFixture();
    const workspace = join(tempDir(), 'ws');
    const result = await runCli(['init', '--resume', '/nonexistent/state.git', fixture.goalId, '--workspace', workspace]);
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(existsSync(workspace)).toBe(false);
  });
});
