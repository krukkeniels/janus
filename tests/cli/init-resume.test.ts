import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { checkoutBranch, commitAll, currentBranch, push, revParse } from '../../src/git/ops.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { readState } from '../../src/state/state-store.js';
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

  it('warns when a goal branch moved past the recorded head', async () => {
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
    await commitAll(uiKitDir, 'feat(ui-kit): two', { allowEmpty: true });
    await push(uiKitDir, 'origin', goalBranch);

    const result = await runCli(['init', '--resume', fixture.stateBare, fixture.goalId, '--workspace', join(tempDir(), 'ws2')]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('ui-kit: goal branch head');
    expect(result.stderr).toContain('differs from recorded');
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
