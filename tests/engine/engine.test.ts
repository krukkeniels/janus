import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enterStage } from '../../src/engine/engine.js';
import { IllegalTransitionError } from '../../src/engine/transitions.js';
import { remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';

describe('createEngine', () => {
  it('emits events with the engine clock and checkpoints with push and decision', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const now = new Date('2026-09-19T14:00:00.000Z');
      const { engine, lines, warnings } = testEngine(workspace, () => now);
      engine.log('hello');
      engine.warn('careful');
      expect(lines).toEqual(['hello']);
      expect(warnings).toEqual(['careful']);
      const recorded = engine.emit({ type: 'stage.entered', stage: 'preparing' });
      expect(recorded.timestamp).toBe('2026-09-19T14:00:00.000Z');
      const result = await engine.checkpoint('chore(janus): test checkpoint', {
        at: now.toISOString(),
        by: 'test',
        title: 'Test decision',
        body: 'because',
      });
      expect(result.pushed).toBe(true);
      expect(await revParse(ws.janusDir, 'HEAD')).toBe(result.commit);
      expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.commit);
      expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): test checkpoint');
      expect(readState(ws.janusDir).telemetry.last_updated_at).toBe('2026-09-19T14:00:00.000Z');
      expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Test decision');
      expect(readEvents(ws.janusDir).map((event) => event['type'])).toEqual(['goal.created', 'stage.entered']);
      expect(await runGit(ws.janusDir, ['status', '--porcelain'])).toBe('');
    } finally {
      workspace.release();
    }
  });

  it('markInFlight merges the patch and writes state.yaml before the next checkpoint', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, () => new Date('2026-09-20T09:00:00.000Z'));
      const first = engine.markInFlight({ step: 'execute-work-packages', started_at: '2026-09-20T09:00:00.000Z' });
      expect(first.step).toBe('execute-work-packages');
      expect(readState(ws.janusDir).execution.in_flight.step).toBe('execute-work-packages');

      const second = engine.markInFlight({ agent_run_id: 'run-0001', repo: 'ui-kit', budget: 'ci_fix_attempts' });
      expect(second).toEqual({
        step: 'execute-work-packages',
        started_at: '2026-09-20T09:00:00.000Z',
        agent_run_id: 'run-0001',
        repo: 'ui-kit',
        budget: 'ci_fix_attempts',
      });
      expect(readState(ws.janusDir).execution.in_flight).toEqual(second);
      expect(workspace.state.execution.in_flight).toEqual(second);
    } finally {
      workspace.release();
    }
  });
});

describe('enterStage', () => {
  it('moves the status and records stage.exited then stage.entered', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, () => new Date('2026-09-19T14:00:00.000Z'));
      const transition = enterStage(engine, 'preparing');
      expect(transition).toEqual({ from: 'created', to: 'preparing', at: '2026-09-19T14:00:00.000Z' });
      expect(workspace.state.goal.status).toBe('preparing');
      const events = readEvents(ws.janusDir).slice(1);
      expect(events).toEqual([
        { timestamp: '2026-09-19T14:00:00.000Z', type: 'stage.exited', stage: 'created', to: 'preparing' },
        { timestamp: '2026-09-19T14:00:00.000Z', type: 'stage.entered', stage: 'preparing', from: 'created' },
      ]);
    } finally {
      workspace.release();
    }
  });

  it('adds goal.completed when entering completed', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'awaiting_merge';
      enterStage(engine, 'completed');
      const types = readEvents(ws.janusDir).map((event) => event['type']);
      expect(types.slice(-3)).toEqual(['stage.exited', 'stage.entered', 'goal.completed']);
    } finally {
      workspace.release();
    }
  });

  it('refuses an illegal transition and leaves state and events untouched', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      expect(() => enterStage(engine, 'executing')).toThrow(IllegalTransitionError);
      expect(workspace.state.goal.status).toBe('created');
      expect(readEvents(ws.janusDir)).toHaveLength(1);
    } finally {
      workspace.release();
    }
  });
});
