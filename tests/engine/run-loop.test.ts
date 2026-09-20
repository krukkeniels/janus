import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import type { Engine } from '../../src/engine/engine.js';
import { approvePlan } from '../../src/engine/gates.js';
import { describeNextStep, runEngine } from '../../src/engine/run-loop.js';
import type { RunEngineInput } from '../../src/engine/run-loop.js';
import { defaultSteps } from '../../src/engine/steps.js';
import type { Step, StepRegistry } from '../../src/engine/steps.js';
import { commitAll, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { CONFIG_FILE } from '../../src/state/files.js';
import { emptyInFlight } from '../../src/state/state-schema.js';
import { readState, writeState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, markInFlight, scriptedSteps, testEngine, testProviders } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const approver = { name: 'Janus Test', email: 'janus@test.invalid' };

type RunOptions = Partial<Pick<RunEngineInput, 'until' | 'maxWaitMs' | 'maxSteps'>>;

async function run(ws: WorkspaceFixture, steps: StepRegistry, options: RunOptions = {}) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await runEngine({
      engine,
      steps,
      until: options.until ?? null,
      maxWaitMs: options.maxWaitMs ?? 60_000,
      modelProfile: 'default',
      providers: testProviders(workspace.paths),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

async function approve(ws: WorkspaceFixture): Promise<void> {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine } = testEngine(workspace);
    const head = await revParse(ws.janusDir, 'HEAD');
    await approvePlan(engine, { gate: 'plan_approval', commit: head, exceptions: [], approver });
  } finally {
    workspace.release();
  }
}

async function subjects(ws: WorkspaceFixture): Promise<string[]> {
  return (await runGit(ws.janusDir, ['log', '--reverse', '--format=%s'])).split('\n');
}

function eventTypes(ws: WorkspaceFixture): string[] {
  return readEvents(ws.janusDir).map((event) => String(event['type']));
}

describe('runEngine', () => {
  it('runs from created to the plan gate, checkpointing every step', async () => {
    const ws = await initWorkspace();
    const { result, state } = await run(ws, scriptedSteps());
    expect(result.reason).toBe('gate');
    expect(result.status).toBe('awaiting_plan_approval');
    expect(result.steps).toBe(5);
    expect(result.task).toBeNull();
    expect(result.stateCommit).toBe(await revParse(ws.janusDir, 'HEAD'));
    expect(result.message).toBe(`waiting at gate plan_approval; approve with: janus approve plan --commit ${result.stateCommit}`);
    expect(await subjects(ws)).toEqual([
      'chore(janus): initialize workspace for angular-15-to-16',
      'chore(janus): start: goal started',
      'chore(janus): prepare: scripted prepare',
      'chore(janus): discovery: scripted discovery',
      'chore(janus): baseline: scripted baseline',
      'chore(janus): planning: plan ready',
      'chore(janus): enter gate plan_approval',
    ]);
    const onDisk = readState(ws.janusDir);
    expect(onDisk.goal.status).toBe('awaiting_plan_approval');
    expect(onDisk.gate).toMatchObject({ type: 'plan_approval', status: 'waiting', checkpoint_commit: await revParse(ws.janusDir, 'HEAD~1') });
    expect(onDisk.execution.in_flight).toEqual(emptyInFlight());
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.stateCommit);
    const types = eventTypes(ws);
    expect(types[1]).toBe('run.started');
    expect(types[types.length - 1]).toBe('run.stopped');
    expect(readEvents(ws.janusDir).filter((event) => event['type'] === 'stage.entered').map((event) => event['stage'])).toEqual([
      'preparing',
      'discovering',
      'baselining',
      'planning',
      'awaiting_plan_approval',
    ]);
    expect(types.filter((type) => type === 'gate.entered')).toHaveLength(1);
  });

  it('recovers when a crash lands between the step-outcome checkpoint and gate entry', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    const { engine: realEngine } = testEngine(workspace);
    let checkpoints = 0;
    // Wraps the real engine so the 5th checkpoint (the "planning: plan ready" step-outcome checkpoint, C0) commits
    // for real and then the process "dies" before `enterStage`/`enterGate` run, exactly as a crash would.
    const crashingEngine: Engine = {
      ...realEngine,
      checkpoint: async (message, decision) => {
        const result = await realEngine.checkpoint(message, decision);
        checkpoints += 1;
        if (checkpoints === 5) throw new Error('simulated crash between C0 and gate entry');
        return result;
      },
    };
    await expect(
      runEngine({
        engine: crashingEngine,
        steps: scriptedSteps(),
        until: null,
        maxWaitMs: 60_000,
        modelProfile: 'default',
        providers: testProviders(workspace.paths),
      }),
    ).rejects.toThrow('simulated crash between C0 and gate entry');
    workspace.release();

    const onDisk = readState(ws.janusDir);
    expect(onDisk.goal.status).toBe('planning');
    expect(onDisk.gate).toEqual({ type: null, status: 'none', entered_at: null, checkpoint_commit: null });
    expect(onDisk.execution.in_flight).toEqual(emptyInFlight());

    const { result, state } = await run(ws, scriptedSteps());
    expect(result.reason).toBe('gate');
    expect(result.status).toBe('awaiting_plan_approval');
    expect(state.gate).toMatchObject({ type: 'plan_approval', status: 'waiting' });
    expect(state.gate.checkpoint_commit).toBe(await revParse(ws.janusDir, 'HEAD~1'));
    expect(result.stateCommit).toBe(await revParse(ws.janusDir, 'HEAD'));
  });

  it('stops immediately while the gate waits and continues after approval to completed', async () => {
    const ws = await initWorkspace();
    await run(ws, scriptedSteps());
    const again = await run(ws, scriptedSteps());
    expect(again.result.reason).toBe('gate');
    expect(again.result.steps).toBe(0);
    await approve(ws);
    const done = await run(ws, scriptedSteps());
    expect(done.result.reason).toBe('completed');
    expect(done.result.status).toBe('completed');
    expect(done.result.steps).toBe(6);
    expect(done.result.message).toBe('goal angular-15-to-16 is completed');
    expect(eventTypes(ws).filter((type) => type === 'goal.completed')).toHaveLength(1);
    expect(readFileSync(join(ws.janusDir, 'handover.md'), 'utf8')).toContain('Goal complete');
    const after = await run(ws, scriptedSteps());
    expect(after.result.reason).toBe('completed');
    expect(after.result.steps).toBe(0);
  });

  it('--until stops before running the stage step', async () => {
    const ws = await initWorkspace();
    const { result } = await run(ws, scriptedSteps(), { until: 'baselining' });
    expect(result).toMatchObject({ reason: 'until', status: 'baselining', steps: 3, message: 'reached stage baselining (--until)' });
  });

  it('stops at a placeholder with not_implemented and no extra checkpoint', async () => {
    const ws = await initWorkspace();
    const { result } = await run(ws, defaultSteps());
    expect(result).toMatchObject({ reason: 'not_implemented', status: 'preparing', task: 'T11', steps: 2, message: 'prepare is not implemented yet (planned in T11)' });
    expect(await subjects(ws)).toHaveLength(2);
    expect(readState(ws.janusDir).execution.in_flight).toEqual(emptyInFlight());
    expect(result.stateCommit).toBe(await revParse(ws.janusDir, 'HEAD'));
  });

  it('reports wait_exceeded after a checkpoint', async () => {
    const ws = await initWorkspace();
    const waiting: Step = { name: 'execute-work-packages', run: async ({ maxWaitMs }) => ({ kind: 'wait_exceeded', summary: `CI wait passed ${maxWaitMs} ms` }) };
    await run(ws, scriptedSteps());
    await approve(ws);
    const { result } = await run(ws, scriptedSteps({ executing: waiting }), { maxWaitMs: 1_000 });
    expect(result).toMatchObject({ reason: 'wait_exceeded', status: 'executing', message: 'execute-work-packages: CI wait passed 1000 ms; run janus run again to keep waiting' });
    expect((await subjects(ws)).at(-1)).toBe('chore(janus): execute-work-packages: CI wait passed 1000 ms');
  });

  it('escalates from a step and stays escalated on later runs', async () => {
    const ws = await initWorkspace();
    const failing: Step = { name: 'prepare', run: async () => ({ kind: 'escalate', reason: 'install failed twice', repo: 'ui-kit', guardrail: null }) };
    const { result, warnings } = await run(ws, scriptedSteps({ preparing: failing }));
    expect(result).toMatchObject({ reason: 'escalated', status: 'escalated', steps: 2 });
    expect(result.message).toContain('janus escalation resolve');
    expect(warnings).toContain('escalated from preparing: install failed twice');
    expect(existsSync(join(ws.janusDir, 'escalation.md'))).toBe(true);
    const again = await run(ws, scriptedSteps({ preparing: failing }));
    expect(again.result).toMatchObject({ reason: 'escalated', steps: 0 });
  });

  it('stops at an SCM-observed gate and re-runs its step on the next run', async () => {
    const ws = await initWorkspace();
    let calls = 0;
    const observe: Step = {
      name: 'observe-pr-review',
      run: async () => {
        calls += 1;
        return (calls === 1 ? { kind: 'gate', gate: 'pr_review', summary: 'PRs open' } : { kind: 'advance', to: 'awaiting_merge', summary: 'approved' });
      },
    };
    await run(ws, scriptedSteps());
    await approve(ws);
    const first = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(first.result).toMatchObject({ reason: 'gate', status: 'awaiting_human_review' });
    expect(first.result.message).toContain('waiting at gate pr_review');
    expect(readState(ws.janusDir).gate).toMatchObject({ type: 'pr_review', status: 'waiting' });
    const second = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(second.result.reason).toBe('completed');
    expect(calls).toBe(2);
    expect(eventTypes(ws).filter((type) => type === 'gate.entered')).toHaveLength(2);
  });

  it('does not re-enter an SCM-observed gate that is already waiting', async () => {
    const ws = await initWorkspace();
    const observe: Step = { name: 'observe-pr-review', run: async () => ({ kind: 'gate', gate: 'pr_review', summary: 'PRs still open' }) };
    await run(ws, scriptedSteps());
    await approve(ws);
    const first = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(first.result).toMatchObject({ reason: 'gate', status: 'awaiting_human_review' });
    const enteredAt = readState(ws.janusDir).gate.entered_at;
    const second = await run(ws, scriptedSteps({ awaiting_human_review: observe }));
    expect(second.result).toMatchObject({ reason: 'gate', status: 'awaiting_human_review' });
    // One gate.entered for plan_approval (Gate 1) and one for pr_review; the second run of the still-waiting
    // SCM-observed gate must not add another.
    expect(eventTypes(ws).filter((type) => type === 'gate.entered')).toHaveLength(2);
    expect(readState(ws.janusDir).gate.entered_at).toBe(enteredAt);
  });

  it('recovers an interrupted agent step before running', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    writeFileSync(join(ws.root, 'repos', 'ui-kit', 'half-done.txt'), 'x\n');
    markInFlight(ws, { step: 'prepare', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-7', repo: 'ui-kit', budget: 'ci_fix_attempts' });
    const { result, warnings, state } = await run(ws, scriptedSteps());
    expect(warnings[0]).toContain('previous run died during step "prepare"');
    expect(result.reason).toBe('gate');
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-7.interrupted.patch'))).toBe(true);
    expect(await subjects(ws)).toContain('chore(janus): recover interrupted step prepare');
    expect(await runGit(join(ws.root, 'repos', 'ui-kit'), ['status', '--porcelain'])).toBe('');
  });

  it('escalates non-fast-forward drift before running any step', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    await runGit(dir, ['reset', '-q', '--hard', 'HEAD~1']);
    await commitAll(dir, 'feat(ui-kit): rewritten', { allowEmpty: true });
    const { result } = await run(ws, scriptedSteps());
    expect(result).toMatchObject({ reason: 'escalated', status: 'escalated', steps: 0 });
    expect(readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8')).toContain('non-fast-forward');
  });

  it('adopts fast-forward drift with a checkpoint and then runs', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const newer = await commitAll(join(ws.root, 'repos', 'ui-kit'), 'feat(ui-kit): more', { allowEmpty: true });
    const { result, state } = await run(ws, scriptedSteps());
    expect(result.reason).toBe('gate');
    expect(state.repos['ui-kit']?.head_commit).toBe(newer);
    expect(await subjects(ws)).toContain('chore(janus): adopt fast-forwarded goal branch heads');
  });

  it('escalates when the goal has run longer than max_goal_runtime_hours, before running any step', async () => {
    const ws = await initWorkspace();
    const configPath = join(ws.janusDir, CONFIG_FILE);
    const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['guardrails'] = { ...(config['guardrails'] as Record<string, unknown> | undefined), max_goal_runtime_hours: 1 };
    writeFileSync(configPath, stringify(config));
    const state = readState(ws.janusDir);
    state.telemetry.started_at = '2026-09-19T08:00:00.000Z';
    writeState(ws.janusDir, state);

    const workspace = await openWorkspace(ws.root);
    try {
      const { engine, warnings } = testEngine(workspace, () => new Date('2026-09-19T10:00:00.000Z'));
      const result = await runEngine({
        engine,
        steps: scriptedSteps(),
        until: null,
        maxWaitMs: 60_000,
        modelProfile: 'default',
        providers: testProviders(workspace.paths),
      });
      expect(result.reason).toBe('escalated');
      expect(result.steps).toBe(0);
      expect(warnings[0]).toContain('goal runtime exceeded');
      expect(readState(ws.janusDir).goal.status).toBe('escalated');
      const escalation = readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8');
      expect(escalation).toContain('goal_runtime_hours');
      const guardrailHit = readEvents(ws.janusDir).find((event) => event['type'] === 'guardrail.hit');
      expect(guardrailHit).toMatchObject({ guardrail: 'goal_runtime_hours', value: 2, limit: 1 });
    } finally {
      workspace.release();
    }
  });

  it('refuses to loop forever on stay and refuses a stage without a step', async () => {
    const ws = await initWorkspace();
    const stuck: Step = { name: 'prepare', run: async () => ({ kind: 'stay', summary: 'one more package' }) };
    await expect(run(ws, scriptedSteps({ preparing: stuck }), { maxSteps: 3 })).rejects.toThrow('run loop executed 3 steps without stopping');
    const fresh = await initWorkspace();
    await expect(run(fresh, {})).rejects.toThrow('no step registered for stage created');
  });
});

describe('describeNextStep', () => {
  it('names the next step and the stages after it', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      expect(describeNextStep(workspace, defaultSteps())).toEqual([
        'goal angular-15-to-16: created',
        'next step: start',
        'then: preparing -> discovering -> baselining -> planning -> awaiting_plan_approval -> executing -> final_e2e -> ai_review -> qa -> awaiting_human_review -> awaiting_merge -> completed',
      ]);
    } finally {
      workspace.release();
    }
  });

  it('explains a waiting gate, an interrupted step, and terminal states', async () => {
    const ws = await initWorkspace();
    await run(ws, scriptedSteps());
    markInFlight(ws, { step: 'planning', started_at: '2026-09-19T12:00:00.000Z' });
    const workspace = await openWorkspace(ws.root);
    try {
      expect(describeNextStep(workspace, scriptedSteps())).toEqual([
        'goal angular-15-to-16: awaiting_plan_approval',
        'interrupted step "planning" would be recovered first',
        'waiting at gate plan_approval; nothing runs until: janus approve plan --commit <sha>',
      ]);
      workspace.state.execution.in_flight = emptyInFlight();
      workspace.state.goal.status = 'completed';
      expect(describeNextStep(workspace, scriptedSteps())).toEqual(['goal angular-15-to-16: completed', 'nothing to do: the goal is completed']);
      workspace.state.goal.status = 'escalated';
      expect(describeNextStep(workspace, scriptedSteps())[1]).toContain('janus escalation resolve');
    } finally {
      workspace.release();
    }
  });
});
