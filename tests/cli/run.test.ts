import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { Step } from '../../src/engine/steps.js';
import { clone, commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { acquireLock, releaseLock } from '../../src/workspace/lock.js';
import { initWorkspace, scriptedSteps } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

describe('janus run', () => {
  it('exits 2 outside a workspace', async () => {
    const result = await runCli(['run'], { cwd: tempDir() });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('not inside a janus workspace');
  });

  it('starts a fresh goal and stops at the first placeholder with exit 3', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.NotImplemented);
    expect(result.stderr).toMatch(/prepare is not implemented yet \(planned in T11\)/);
    expect(result.stdout).toContain('goal angular-15-to-16: preparing');
    expect(readState(ws.janusDir).goal.status).toBe('preparing');
    expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(await revParse(ws.janusDir, 'HEAD'));
    expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): start: goal started');
  });

  it('runs scripted steps to the plan gate with exit 10 and prints the approve command', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run'], { cwd: join(ws.root, 'repos', 'shell') }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.GateWaiting);
    const head = await revParse(ws.janusDir, 'HEAD');
    expect(result.stdout).toContain(`goal angular-15-to-16: awaiting_plan_approval (state branch at ${head.slice(0, 7)}, 5 steps run)`);
    expect(result.stdout).toContain(`waiting at gate plan_approval; approve with: janus approve plan --commit ${head}`);
    expect(result.stderr).toBe('');
  });

  it('honors --until with exit 0', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run', '--until', 'baselining'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('reached stage baselining (--until)');
    expect(readState(ws.janusDir).goal.status).toBe('baselining');
  });

  it('rejects a bad --until, --max-wait, or --model-profile with exit 2 before touching state', async () => {
    const ws = await initWorkspace();
    const until = await runCli(['run', '--until', 'shipping'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(until.code).toBe(ExitCode.UsageError);
    expect(until.stderr).toContain('unknown stage "shipping"');
    const wait = await runCli(['run', '--max-wait', 'soon'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(wait.code).toBe(ExitCode.UsageError);
    expect(wait.stderr).toContain('invalid duration "soon"');
    const profile = await runCli(['run', '--model-profile', 'turbo'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(profile.code).toBe(ExitCode.UsageError);
    expect(profile.stderr).toContain('model profile "turbo" is not defined');
    expect(readState(ws.janusDir).goal.status).toBe('created');
  });

  it('--dry-run prints the next step and changes nothing', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['run', '--dry-run'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: created');
    expect(result.stdout).toContain('next step: start');
    expect(await runGit(ws.janusDir, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(readState(ws.janusDir).goal.status).toBe('created');
  });

  it('exits 13 while another live process holds the lock', async () => {
    const ws = await initWorkspace();
    const lockFile = join(ws.root, 'janus.lock');
    acquireLock(lockFile);
    try {
      const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
      expect(result.code).toBe(ExitCode.Locked);
      expect(result.stderr).toContain('workspace is locked by pid');
    } finally {
      releaseLock(lockFile);
    }
  });

  it('exits 1 with a reconcile instruction when the state branch moved elsewhere, and releases the lock', async () => {
    const ws = await initWorkspace();
    const other = join(tempDir(), 'other');
    await clone(ws.fixture.stateBare, other, { branch: 'janus/angular-15-to-16' });
    await commitAll(other, 'chore(janus): from another machine', { allowEmpty: true });
    await runGit(other, ['push', '-q', 'origin', 'janus/angular-15-to-16']);
    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stderr).toContain('has moved');
    expect(result.stderr).toContain('reconcile with: git -C .janus fetch origin');
    const again = await runCli(['run', '--dry-run'], { cwd: ws.root });
    expect(again.code).toBe(ExitCode.Ok);
  });

  it('exits 11 when a step reports an exceeded wait and 12 on escalation', async () => {
    const waiting: Step = { name: 'start', run: async () => ({ kind: 'wait_exceeded', summary: 'waited 1m' }) };
    const ws = await initWorkspace();
    const wait = await runCli(['run', '--max-wait', '1m'], { cwd: ws.root }, { steps: scriptedSteps({ created: waiting }) });
    expect(wait.code).toBe(ExitCode.WaitExceeded);
    expect(wait.stdout).toContain('start: waited 1m; run janus run again to keep waiting');
    const failing: Step = { name: 'start', run: async () => ({ kind: 'escalate', reason: 'cannot start', repo: null, guardrail: null }) };
    const other = await initWorkspace();
    const escalated = await runCli(['run'], { cwd: other.root }, { steps: scriptedSteps({ created: failing }) });
    expect(escalated.code).toBe(ExitCode.Escalated);
    expect(escalated.stderr).toContain('janus: warning: escalated from created: cannot start');
    expect(escalated.stdout).toContain('janus escalation resolve');
  });
});
