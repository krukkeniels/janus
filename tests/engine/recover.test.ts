import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recoverInFlight } from '../../src/engine/recover.js';
import { runGit } from '../../src/git/run.js';
import { emptyInFlight } from '../../src/state/state-schema.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, markInFlight, testEngine } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

async function recover(ws: WorkspaceFixture) {
  const workspace = await openWorkspace(ws.root);
  try {
    const { engine, warnings } = testEngine(workspace);
    const result = await recoverInFlight(engine);
    return { result, warnings, state: workspace.state };
  } finally {
    workspace.release();
  }
}

describe('recoverInFlight', () => {
  it('returns null when nothing was in flight', async () => {
    const ws = await initWorkspace();
    const { result, warnings } = await recover(ws);
    expect(result).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('saves the interrupted patch, resets the repo, counts the budget, and clears in_flight', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    writeFileSync(join(dir, 'README.md'), '# changed by an agent\n');
    writeFileSync(join(dir, 'new-file.txt'), 'untracked\n');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0001', repo: 'ui-kit', budget: 'ci_fix_attempts' });

    const { result, warnings, state } = await recover(ws);
    const patchFile = join(ws.janusDir, 'evidence', 'agents', 'run-0001.interrupted.patch');
    expect(result).toEqual({
      step: 'execute-work-packages',
      kind: 'agent',
      patchFile,
      budget: { budget: 'ci_fix_attempts', value: 1, limit: 5, exhausted: false },
    });
    const patch = readFileSync(patchFile, 'utf8');
    expect(patch).toContain('new-file.txt');
    expect(patch).toContain('changed by an agent');
    expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(dir, 'new-file.txt'))).toBe(false);
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(state.execution.budgets.ci_fix_attempts).toBe(1);
    const events = readEvents(ws.janusDir);
    expect(events.map((event) => event['type'])).toEqual(['goal.created', 'agent.finished', 'budget.incremented']);
    expect(events[1]).toMatchObject({ type: 'agent.finished', run_id: 'run-0001', repo: 'ui-kit', status: 'interrupted', step: 'execute-work-packages', patch: 'evidence/agents/run-0001.interrupted.patch' });
    expect(warnings).toEqual(['previous run died during step "execute-work-packages" (started 2026-09-19T12:00:00.000Z); agent work in ui-kit was saved and discarded; the step will run again']);
  });

  it('records no patch when the repo was clean', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0002', repo: 'ui-kit', budget: null });
    const { result } = await recover(ws);
    expect(result).toEqual({ step: 'execute-work-packages', kind: 'agent', patchFile: null, budget: null });
    expect(existsSync(join(ws.janusDir, 'evidence', 'agents', 'run-0002.interrupted.patch'))).toBe(false);
    const finished = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.finished');
    expect(finished?.['patch']).toBeNull();
  });

  it('reports exhaustion when the interrupted run was the last allowed attempt', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    markInFlight(ws, { step: 'execute-work-packages', started_at: '2026-09-19T12:00:00.000Z', agent_run_id: 'run-0003', repo: 'ui-kit', budget: 'ci_fix_attempts' }, { ci_fix_attempts: 4 });
    const { result } = await recover(ws);
    expect(result?.budget).toEqual({ budget: 'ci_fix_attempts', value: 5, limit: 5, exhausted: true });
  });

  it('leaves repos alone for a non-agent step and just clears the marker', async () => {
    const ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
    const dir = join(ws.root, 'repos', 'ui-kit');
    writeFileSync(join(dir, 'keep.txt'), 'not an agent change\n');
    markInFlight(ws, { step: 'ci-wait', started_at: '2026-09-19T12:00:00.000Z' });
    const { result, warnings, state } = await recover(ws);
    expect(result).toEqual({ step: 'ci-wait', kind: 'other', patchFile: null, budget: null });
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
    expect(state.execution.in_flight).toEqual(emptyInFlight());
    expect(readEvents(ws.janusDir)).toHaveLength(1);
    expect(warnings).toEqual(['previous run died during step "ci-wait" (started 2026-09-19T12:00:00.000Z); the step will run again']);
  });
});
