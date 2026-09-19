import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GateError, approvePlan, enterGate, gateCommand, gateStage, isCliGate, rejectPlan } from '../../src/engine/gates.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const approver = { name: 'Janus Test', email: 'janus@test.invalid' };

interface AtGate {
  ws: WorkspaceFixture;
  workspace: Workspace;
  engine: ReturnType<typeof testEngine>['engine'];
  clock: { now: Date };
  stepCommit: string;
  gateCommit: string;
}

/** A workspace checkpointed at the end of planning and then entered into the given gate. */
async function atGate(gate: 'plan_approval' | 'revised_plan_approval'): Promise<AtGate> {
  const ws = await initWorkspace();
  const workspace = await openWorkspace(ws.root);
  const clock = { now: new Date('2026-09-19T16:00:00.000Z') };
  const { engine } = testEngine(workspace, () => clock.now);
  workspace.state.goal.status = 'awaiting_plan_approval';
  const step = await engine.checkpoint('chore(janus): planning: plan ready');
  const entered = await enterGate(engine, gate);
  return { ws, workspace, engine, clock, stepCommit: step.commit, gateCommit: entered.commit };
}

describe('gate helpers', () => {
  it('classifies gates and maps them to stages and commands', () => {
    expect(isCliGate('plan_approval')).toBe(true);
    expect(isCliGate('revised_plan_approval')).toBe(true);
    expect(isCliGate('pr_review')).toBe(false);
    expect(isCliGate('merge')).toBe(false);
    expect(gateStage('plan_approval')).toBe('awaiting_plan_approval');
    expect(gateStage('revised_plan_approval')).toBe('awaiting_plan_approval');
    expect(gateStage('pr_review')).toBe('awaiting_human_review');
    expect(gateStage('merge')).toBe('awaiting_merge');
    expect(gateCommand('plan_approval')).toBe('plan');
    expect(gateCommand('revised_plan_approval')).toBe('revised-plan');
    expect(gateCommand('merge')).toBeNull();
  });
});

describe('enterGate', () => {
  it('records the pre-entry checkpoint, emits gate.entered, and checkpoints the entry', async () => {
    const at = await atGate('plan_approval');
    try {
      expect(at.workspace.state.gate).toEqual({ type: 'plan_approval', status: 'waiting', entered_at: '2026-09-19T16:00:00.000Z', checkpoint_commit: at.stepCommit });
      expect(await revParse(at.ws.janusDir, 'HEAD')).toBe(at.gateCommit);
      expect(await revParse(at.ws.janusDir, 'HEAD~1')).toBe(at.stepCommit);
      expect(await remoteHead(at.ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(at.gateCommit);
      expect(await runGit(at.ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): enter gate plan_approval');
      const entered = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.entered');
      expect(entered).toMatchObject({ gate: 'plan_approval', checkpoint_commit: at.stepCommit });
      expect(readState(at.ws.janusDir).gate.status).toBe('waiting');
    } finally {
      at.workspace.release();
    }
  });
});

describe('approvePlan', () => {
  it('approves at the exact state-branch head and records the approver', async () => {
    const at = await atGate('plan_approval');
    try {
      at.clock.now = new Date('2026-09-19T16:01:30.000Z');
      const result = await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
      expect(result.waitedMs).toBe(90_000);
      const { state } = at.workspace;
      expect(state.goal.status).toBe('executing');
      expect(state.plan).toEqual({ approved: true, approved_commit: at.gateCommit, approved_at: '2026-09-19T16:01:30.000Z', revision: 0 });
      expect(state.baseline.approved).toBe(true);
      expect(state.gate.status).toBe('passed');
      expect(state.gate.type).toBe('plan_approval');
      const passed = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.passed');
      expect(passed).toMatchObject({ gate: 'plan_approval', approver: 'Janus Test <janus@test.invalid>', commit: at.gateCommit, waited_ms: 90_000 });
      const decisions = readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8');
      expect(decisions).toContain('## Plan approved (2026-09-19T16:01:30.000Z)');
      expect(decisions).toContain('By: Janus Test <janus@test.invalid>');
      expect(decisions).toContain(`Approved state-branch commit ${at.gateCommit}`);
      expect(await revParse(at.ws.janusDir, 'HEAD')).toBe(result.checkpoint.commit);
      expect(await remoteHead(at.ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.checkpoint.commit);
      expect(readState(at.ws.janusDir).goal.status).toBe('executing');
    } finally {
      at.workspace.release();
    }
  });

  it('accepts an abbreviated sha of the head', async () => {
    const at = await atGate('plan_approval');
    try {
      const result = await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit.slice(0, 10), exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
    } finally {
      at.workspace.release();
    }
  });

  it('refuses a commit that is not the head, even an older state-branch commit', async () => {
    const at = await atGate('plan_approval');
    try {
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.stepCommit, exceptions: [], approver })).rejects.toThrow(
        `--commit ${at.stepCommit} resolves to ${at.stepCommit.slice(0, 7)} but the gate was entered at state-branch HEAD ${at.gateCommit.slice(0, 7)}`,
      );
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: 'deadbeef', exceptions: [], approver })).rejects.toThrow(GateError);
      expect(at.workspace.state.goal.status).toBe('awaiting_plan_approval');
      expect(at.workspace.state.plan.approved).toBe(false);
    } finally {
      at.workspace.release();
    }
  });

  it('refuses when no gate is waiting or the other gate is waiting', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const head = await revParse(ws.janusDir, 'HEAD');
      await expect(approvePlan(engine, { gate: 'plan_approval', commit: head, exceptions: [], approver })).rejects.toThrow('no plan_approval gate is waiting (goal status created, gate none)');
    } finally {
      workspace.release();
    }
    const at = await atGate('revised_plan_approval');
    try {
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: [], approver })).rejects.toThrow(
        'gate revised_plan_approval is waiting, not plan_approval; use: janus approve revised-plan --commit <sha>',
      );
      const result = await approvePlan(at.engine, { gate: 'revised_plan_approval', commit: at.gateCommit, exceptions: [], approver });
      expect(result.commit).toBe(at.gateCommit);
      expect(at.workspace.state.goal.status).toBe('executing');
      expect(readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Revised plan approved');
    } finally {
      at.workspace.release();
    }
  });

  it('approves listed baseline exceptions and refuses unknown ids', async () => {
    const at = await atGate('plan_approval');
    try {
      at.workspace.state.baseline.exceptions.push({ id: 'ex-1', repo: 'ui-kit', kind: 'test', identity: 'spec:flaky', reason: 'known flaky', approved_by: null, approved_at: null });
      await expect(approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: ['ex-9'], approver })).rejects.toThrow('unknown baseline exception ex-9');
      await approvePlan(at.engine, { gate: 'plan_approval', commit: at.gateCommit, exceptions: ['ex-1'], approver });
      expect(at.workspace.state.baseline.exceptions[0]).toMatchObject({ id: 'ex-1', approved_by: 'Janus Test <janus@test.invalid>', approved_at: '2026-09-19T16:00:00.000Z' });
      expect(readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8')).toContain('Exceptions approved: ex-1');
    } finally {
      at.workspace.release();
    }
  });
});

describe('rejectPlan', () => {
  it('returns Gate 1 to planning with the reason recorded', async () => {
    const at = await atGate('plan_approval');
    try {
      at.clock.now = new Date('2026-09-19T16:00:10.000Z');
      const result = await rejectPlan(at.engine, { reason: 'wrong repo order', approver });
      expect(result.to).toBe('planning');
      expect(result.waitedMs).toBe(10_000);
      expect(at.workspace.state.goal.status).toBe('planning');
      expect(at.workspace.state.gate).toEqual({ type: null, status: 'none', entered_at: null, checkpoint_commit: null });
      expect(at.workspace.state.plan.approved).toBe(false);
      const rejected = readEvents(at.ws.janusDir).find((event) => event['type'] === 'gate.rejected');
      expect(rejected).toMatchObject({ gate: 'plan_approval', approver: 'Janus Test <janus@test.invalid>', reason: 'wrong repo order', waited_ms: 10_000 });
      const decisions = readFileSync(join(at.ws.janusDir, 'decisions.md'), 'utf8');
      expect(decisions).toContain('## Plan rejected');
      expect(decisions).toContain('wrong repo order');
      expect(await runGit(at.ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): reject plan_approval');
    } finally {
      at.workspace.release();
    }
  });

  it('returns Gate 2 to replanning', async () => {
    const at = await atGate('revised_plan_approval');
    try {
      const result = await rejectPlan(at.engine, { reason: 'still wrong', approver });
      expect(result.to).toBe('replanning');
      expect(at.workspace.state.goal.status).toBe('replanning');
    } finally {
      at.workspace.release();
    }
  });

  it('refuses when no CLI gate is waiting', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      await expect(rejectPlan(engine, { reason: 'x', approver })).rejects.toThrow('no plan approval gate is waiting');
    } finally {
      workspace.release();
    }
  });
});
