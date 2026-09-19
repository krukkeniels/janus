import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { checkGuardrail, incrementBudget } from '../../src/engine/budgets.js';
import type { Step } from '../../src/engine/steps.js';
import { HAPPY_PATH } from '../../src/engine/transitions.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { createGoalBranch, initWorkspace, markInFlight, scriptedSteps } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { runCli } from '../helpers/run-cli.js';

const stateBranch = 'janus/angular-15-to-16';

describe('scripted run with no providers (T03 done-when)', () => {
  it('goes from created to completed through run, approve, run, and resumes elsewhere as completed', async () => {
    const ws = await initWorkspace();

    const first = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(first.code).toBe(ExitCode.GateWaiting);
    const gateHead = await revParse(ws.janusDir, 'HEAD');
    expect(first.stdout).toContain(`janus approve plan --commit ${gateHead}`);

    const approved = await runCli(['approve', 'plan', '--commit', gateHead], { cwd: ws.root });
    expect(approved.code).toBe(ExitCode.Ok);

    const second = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(second.stderr).toBe('');
    expect(second.code).toBe(ExitCode.Ok);
    expect(second.stdout).toContain('goal angular-15-to-16 is completed');

    const state = readState(ws.janusDir);
    expect(state.goal.status).toBe('completed');
    expect(state.plan.approved_commit).toBe(gateHead);
    expect(state.execution.in_flight.step).toBeNull();
    expect(existsSync(join(ws.root, 'janus.lock'))).toBe(false);
    expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toMatch(/^( M telemetry\/events.jsonl)?$/);
    expect(await remoteHead(ws.janusDir, 'origin', stateBranch)).toBe(await revParse(ws.janusDir, 'HEAD'));

    const events = readEvents(ws.janusDir);
    const types = events.map((event) => String(event['type']));
    expect(events.filter((event) => event['type'] === 'stage.entered').map((event) => event['stage'])).toEqual(HAPPY_PATH.slice(1));
    expect(types.filter((type) => type === 'gate.entered')).toHaveLength(1);
    expect(types.filter((type) => type === 'gate.passed')).toHaveLength(1);
    expect(types.filter((type) => type === 'goal.completed')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.started')).toHaveLength(2);
    expect(types.filter((type) => type === 'run.stopped')).toHaveLength(2);
    expect(types).not.toContain('escalation.created');

    const elsewhere = join(tempDir(), 'ws2');
    const resumed = await runCli(['init', '--resume', ws.fixture.stateBare, ws.fixture.goalId, '--workspace', elsewhere]);
    expect(resumed.code).toBe(ExitCode.Ok);
    expect(resumed.stdout).toContain('goal angular-15-to-16: status completed');
    const again = await runCli(['run'], { cwd: elsewhere }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.Ok);
    expect(again.stdout).toContain('0 steps run');
  });

  it('recovers from a simulated crash mid-step and charges the budget, then finishes', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    writeFileSync(join(ws.root, 'repos', 'ui-kit', 'agent-was-here.txt'), 'partial work\n');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0042', repo: 'ui-kit', budget: 'ci_fix_attempts' });

    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stderr).toContain('previous run died during step "execute-work-packages"');
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-0042.interrupted.patch'))).toBe(true);
    expect(existsSync(join(ws.root, 'repos', 'ui-kit', 'agent-was-here.txt'))).toBe(false);
    const state = readState(ws.janusDir);
    expect(state.goal.status).toBe('completed');
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    expect(await runGit(ws.janusDir, ['log', '--format=%s'])).toContain('chore(janus): recover interrupted step execute-work-packages');
  });

  it('routes a guardrail hit to escalated with exit 12 and an escalation.md, and stays there', async () => {
    const exhaust: Step = {
      name: 'execute-work-packages',
      run: async ({ engine }) => {
        const ctx = { state: engine.workspace.state, config: engine.workspace.config, emit: engine.emit };
        for (let attempt = 1; attempt <= 5; attempt += 1) incrementBudget(ctx, 'ci_fix_attempts', `debug attempt ${attempt} on ui-kit`);
        const hit = checkGuardrail(ctx, 'ci_fix_attempts');
        if (hit === null) throw new Error('expected ci_fix_attempts to be exhausted');
        return ({ kind: 'escalate', reason: 'ui-kit PR build is still red after 5 debug attempts', repo: 'ui-kit', guardrail: hit });
      },
    };
    const ws = await initWorkspace();
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });

    const result = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps({ executing: exhaust }) });
    expect(result.code).toBe(ExitCode.Escalated);
    expect(result.stdout).toContain('janus escalation resolve --direction');
    const escalation = readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8');
    expect(escalation).toContain('ui-kit PR build is still red after 5 debug attempts');
    expect(escalation).toContain('- Guardrail: ci_fix_attempts 5/5');
    expect(escalation).toContain('| ci_fix_attempts | 5 |');
    const types = readEvents(ws.janusDir).map((event) => String(event['type']));
    expect(types.filter((type) => type === 'budget.incremented')).toHaveLength(5);
    expect(types.filter((type) => type === 'guardrail.hit')).toHaveLength(1);
    expect(types.filter((type) => type === 'escalation.created')).toHaveLength(1);
    expect(readState(ws.janusDir).goal.status).toBe('escalated');

    const again = await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    expect(again.code).toBe(ExitCode.Escalated);
    expect(again.stdout).toContain('0 steps run');
    const show = await runCli(['escalation', 'show'], { cwd: ws.root });
    expect(show.code).toBe(ExitCode.NotImplemented);
  });

  it('stops with exit 11 when a wait exceeds --max-wait and finishes with a longer limit', async () => {
    const ciWait: Step = {
      name: 'execute-work-packages',
      run: async ({ maxWaitMs }) =>
        maxWaitMs < 120_000
          ? { kind: 'wait_exceeded', summary: `PR build still running after ${maxWaitMs} ms` }
          : { kind: 'advance', to: 'final_e2e', summary: 'PR builds green' },
    };
    const ws = await initWorkspace();
    await runCli(['run'], { cwd: ws.root }, { steps: scriptedSteps() });
    await runCli(['approve', 'plan', '--commit', await revParse(ws.janusDir, 'HEAD')], { cwd: ws.root });
    const short = await runCli(['run', '--max-wait', '1m'], { cwd: ws.root }, { steps: scriptedSteps({ executing: ciWait }) });
    expect(short.code).toBe(ExitCode.WaitExceeded);
    expect(readState(ws.janusDir).goal.status).toBe('executing');
    const long = await runCli(['run', '--max-wait', '5m'], { cwd: ws.root }, { steps: scriptedSteps({ executing: ciWait }) });
    expect(long.code).toBe(ExitCode.Ok);
    expect(readState(ws.janusDir).goal.status).toBe('completed');
  });
});
