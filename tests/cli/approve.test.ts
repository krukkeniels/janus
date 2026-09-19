import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { loadGoal } from '../../src/config/load-goal.js';
import { revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { checkpoint } from '../../src/state/checkpoint.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { initWorkspace, scriptedSteps } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

async function atPlanGate(): Promise<{ ws: WorkspaceFixture; head: string }> {
  const ws = await initWorkspace();
  const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
  if (result.code !== ExitCode.GateWaiting) throw new Error(`expected the plan gate, got ${result.code}: ${result.stderr}`);
  return { ws, head: await revParse(ws.janusDir, 'HEAD') };
}

describe('janus approve plan', () => {
  it('exits 2 outside a workspace and when no gate is waiting', async () => {
    const outside = await runCli(['approve', 'plan', '--commit', 'abc123'], { cwd: tempDir() });
    expect(outside.code).toBe(ExitCode.UsageError);
    expect(outside.stderr).toContain('not inside a janus workspace');
    const ws = await initWorkspace();
    const early = await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    expect(early.code).toBe(ExitCode.UsageError);
    expect(early.stderr).toContain('no plan_approval gate is waiting (goal status created, gate none)');
  });

  it('refuses a commit that is not the state-branch head and leaves the gate waiting', async () => {
    const { ws, head } = await atPlanGate();
    const older = await revParse(ws.janusDir, 'HEAD~1');
    const result = await runCli(['approve', 'plan', '--commit', older], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain(`but the gate was entered at state-branch HEAD ${head.slice(0, 7)}`);
    expect(readState(ws.janusDir).gate.status).toBe('waiting');
    expect(readState(ws.janusDir).goal.status).toBe('awaiting_plan_approval');
  });

  it('passes the gate at the head, records the approver, and lets the next run continue', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['approve', 'plan', '--commit', head], { cwd: ws.root });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain(`gate plan_approval passed at ${head.slice(0, 7)} by Janus Test <janus@test.invalid>`);
    expect(result.stdout).toMatch(/goal angular-15-to-16: executing \(checkpoint [0-9a-f]{7}\); run janus run to continue/);
    const state = readState(ws.janusDir);
    expect(state.plan).toMatchObject({ approved: true, approved_commit: head });
    expect(state.baseline.approved).toBe(true);
    expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('By: Janus Test <janus@test.invalid>');
    expect(readEvents(ws.janusDir).some((event) => event['type'] === 'gate.passed')).toBe(true);
    expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toBe('');
    const next = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(next.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).goal.status).toBe('completed');
  });

  it('approves listed baseline exceptions', async () => {
    const ws = await initWorkspace();
    const state = readState(ws.janusDir);
    state.baseline.exceptions.push({ id: 'ex-1', repo: 'ui-kit', kind: 'test', identity: 'spec:flaky', reason: 'known flaky', approved_by: null, approved_at: null });
    writeState(ws.janusDir, state);
    await checkpoint({ janusDir: ws.janusDir, state, goal: loadGoal(join(ws.janusDir, 'goal.yaml')).goal, message: 'chore(janus): baseline exception', push: true });
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    const head = await revParse(ws.janusDir, 'HEAD');
    const unknown = await runCli(['approve', 'plan', '--commit', head, '--exception', 'ex-9'], { cwd: ws.root });
    expect(unknown.code).toBe(ExitCode.UsageError);
    expect(unknown.stderr).toContain('unknown baseline exception ex-9');
    const result = await runCli(['approve', 'plan', '--commit', head, '--exception', 'ex-1'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).baseline.exceptions[0]).toMatchObject({ id: 'ex-1', approved_by: 'Janus Test <janus@test.invalid>' });
  });

  it('refuses approve revised-plan while Gate 1 waits', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['approve', 'revised-plan', '--commit', head], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('gate plan_approval is waiting, not revised_plan_approval; use: janus approve plan --commit <sha>');
  });
});

describe('janus reject plan', () => {
  it('returns to planning with the reason and the next run re-enters the gate', async () => {
    const { ws, head } = await atPlanGate();
    const result = await runCli(['reject', 'plan', '--reason', 'wrong repo order'], { cwd: ws.root });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('gate plan_approval rejected by Janus Test <janus@test.invalid>');
    expect(result.stdout).toMatch(/goal angular-15-to-16: planning \(checkpoint [0-9a-f]{7}\); run janus run to continue/);
    expect(readState(ws.janusDir).goal.status).toBe('planning');
    expect(readState(ws.janusDir).gate.status).toBe('none');
    expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('wrong repo order');
    const again = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.GateWaiting);
    const newHead = await revParse(ws.janusDir, 'HEAD');
    expect(newHead).not.toBe(head);
    expect(readState(ws.janusDir).gate).toMatchObject({ type: 'plan_approval', status: 'waiting' });
    const stale = await runCli(['approve', 'plan', '--commit', head], { cwd: ws.root });
    expect(stale.code).toBe(ExitCode.UsageError);
    const fresh = await runCli(['approve', 'plan', '--commit', newHead], { cwd: ws.root });
    expect(fresh.code).toBe(ExitCode.Ok);
  });

  it('exits 2 when no gate is waiting', async () => {
    const ws = await initWorkspace();
    const result = await runCli(['reject', 'plan', '--reason', 'x'], { cwd: ws.root });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('no plan approval gate is waiting');
  });
});
