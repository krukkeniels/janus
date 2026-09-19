import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escalate, renderEscalationStub } from '../../src/engine/escalate.js';
import { IllegalTransitionError } from '../../src/engine/transitions.js';
import { remoteHead } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readState } from '../../src/state/state-store.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';

describe('escalate', () => {
  it('writes escalation.md, records the events, enters escalated, and checkpoints', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const now = new Date('2026-09-19T15:00:00.000Z');
      const { engine, warnings } = testEngine(workspace, () => now);
      workspace.state.goal.status = 'executing';
      workspace.state.execution.current_work_package = 'wp-01-ui-kit-angular';
      workspace.state.execution.budgets.ci_fix_attempts = 5;
      const result = await escalate(engine, {
        reason: 'ci_fix_attempts exhausted on ui-kit',
        repo: 'ui-kit',
        guardrail: { guardrail: 'ci_fix_attempts', value: 5, limit: 5, detail: 'ci_fix_attempts is 5 of 5' },
      });
      expect(result.from).toBe('executing');
      expect(workspace.state.goal.status).toBe('escalated');
      expect(readState(ws.janusDir).goal.status).toBe('escalated');
      expect(result.file).toBe(join(ws.janusDir, 'escalation.md'));
      const text = readFileSync(result.file, 'utf8');
      expect(text).toContain('# Escalation');
      expect(text).toContain('Created 2026-09-19T15:00:00.000Z from stage `executing`');
      expect(text).toContain('ci_fix_attempts exhausted on ui-kit');
      expect(text).toContain('- Repo: ui-kit');
      expect(text).toContain('- Work package: wp-01-ui-kit-angular');
      expect(text).toContain('- Guardrail: ci_fix_attempts 5/5 (ci_fix_attempts is 5 of 5)');
      expect(text).toContain('| ci_fix_attempts | 5 |');
      expect(text).toContain('janus escalation resolve --direction');
      const events = readEvents(ws.janusDir).map((event) => event['type']);
      expect(events).toEqual(['goal.created', 'guardrail.hit', 'escalation.created', 'stage.exited', 'stage.entered']);
      const created = readEvents(ws.janusDir)[2];
      expect(created).toMatchObject({ type: 'escalation.created', reason: 'ci_fix_attempts exhausted on ui-kit', stage: 'executing', repo: 'ui-kit', work_package: 'wp-01-ui-kit-angular' });
      expect(await remoteHead(ws.janusDir, 'origin', 'janus/angular-15-to-16')).toBe(result.checkpoint.commit);
      expect(await runGit(ws.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): escalate from executing');
      expect(readFileSync(join(ws.janusDir, 'decisions.md'), 'utf8')).toContain('## Escalated');
      expect(warnings).toEqual(['escalated from executing: ci_fix_attempts exhausted on ui-kit']);
    } finally {
      workspace.release();
    }
  });

  it('records no guardrail.hit for a plain escalation', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'planning';
      await escalate(engine, { reason: 'planning agent failed twice', repo: null, guardrail: null });
      const events = readEvents(ws.janusDir).map((event) => event['type']);
      expect(events).toEqual(['goal.created', 'escalation.created', 'stage.exited', 'stage.entered']);
      expect(readFileSync(join(ws.janusDir, 'escalation.md'), 'utf8')).toContain('- Guardrail: none');
    } finally {
      workspace.release();
    }
  });

  it('cannot escalate an already escalated goal', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      workspace.state.goal.status = 'escalated';
      await expect(escalate(engine, { reason: 'again', repo: null, guardrail: null })).rejects.toBeInstanceOf(IllegalTransitionError);
    } finally {
      workspace.release();
    }
  });
});

describe('renderEscalationStub', () => {
  it('renders every budget row', async () => {
    const ws = await initWorkspace();
    const state = readState(ws.janusDir);
    const text = renderEscalationStub(state, { reason: 'r', repo: null, guardrail: null }, new Date('2026-09-19T15:00:00.000Z'));
    for (const name of ['ci_fix_attempts', 'e2e_fix_attempts', 'ai_review_cycles', 'no_progress_iterations', 'work_packages_without_green', 'sync_conflict_attempts', 'infra_retries']) {
      expect(text).toContain(`| ${name} | 0 |`);
    }
  });
});
