import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agents/run.js';
import { readEvents } from '../../src/telemetry/events.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { agentTaskFixture, stubOutcome } from '../helpers/agent-fixtures.js';

const clock = () => new Date('2026-09-20T11:00:00.000Z');

function runner(name: 'fake' | 'codex' = 'fake'): AgentRunner {
  return { name, run: async (task) => stubOutcome(task, { promptBytes: 4096, durationMs: 1234 }) };
}

describe('runAgent', () => {
  it('emits agent.started and agent.finished with the §27 dimensions and writes the evidence file', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const task = agentTaskFixture({ runId: 'run-0100', role: 'implementation', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      const record = await runAgent({ engine, runner: runner(), task, previousModel: null });

      expect(record.evidencePath).toBe(join('evidence', 'agents', 'run-0100.yaml'));
      expect(readFileSync(join(ws.janusDir, record.evidencePath), 'utf8')).toContain('run_id: run-0100');

      const events = readEvents(ws.janusDir);
      const started = events.find((event) => event['type'] === 'agent.started');
      const finished = events.find((event) => event['type'] === 'agent.finished');
      expect(started).toMatchObject({
        run_id: 'run-0100',
        role: 'implementation',
        repo: 'ui-kit',
        model: 'gpt-5.6-sol',
        effort: 'high',
        profile: 'default',
        attempt: 1,
        sandbox: 'workspace-write',
      });
      expect(started?.['prompt_version']).toMatch(/^implementation@\d+$/);
      expect(finished).toMatchObject({ run_id: 'run-0100', status: 'completed', duration_ms: 1234, exit_code: 0, failure: null });
      expect(events.indexOf(started as never)).toBeLessThan(events.indexOf(finished as never));
    } finally {
      workspace.release();
    }
  });

  it('records the run in execution.in_flight while it runs and clears it afterwards (§7 rule 3)', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const seen: (string | null)[] = [];
      const watching: AgentRunner = {
        name: 'fake',
        run: async (task) => {
          seen.push(workspace.state.execution.in_flight.agent_run_id);
          return stubOutcome(task);
        },
      };
      const task = agentTaskFixture({ runId: 'run-0101', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      await runAgent({ engine, runner: watching, task, previousModel: null });
      expect(seen).toEqual(['run-0101']);
      expect(workspace.state.execution.in_flight.agent_run_id).toBeNull();
      expect(workspace.state.execution.in_flight.repo).toBeNull();
    } finally {
      workspace.release();
    }
  });

  it('leaves in_flight set when the runner throws, so resume can recover it', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const exploding: AgentRunner = {
        name: 'fake',
        run: async () => {
          throw new Error('the runner died');
        },
      };
      const task = agentTaskFixture({ runId: 'run-0102', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      await expect(runAgent({ engine, runner: exploding, task, previousModel: null })).rejects.toThrow('the runner died');
      expect(workspace.state.execution.in_flight.agent_run_id).toBe('run-0102');
    } finally {
      workspace.release();
    }
  });

  it('emits agent.model_switch before agent.started when the ladder moved, and adds no budget (§18.6)', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const before = { ...workspace.state.execution.budgets };
      const task = agentTaskFixture({
        runId: 'run-0103',
        role: 'debug',
        repo: 'ui-kit',
        cwd: workspace.paths.repoDir('ui-kit'),
        attempt: 2,
        model: { model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 },
      });
      await runAgent({
        engine,
        runner: runner(),
        task,
        previousModel: { model: 'gpt-5.6-mini', effort: 'medium', ladderIndex: 0, ladderLength: 2 },
      });
      const types = readEvents(ws.janusDir).map((event) => event['type']);
      expect(types.indexOf('agent.model_switch')).toBeLessThan(types.indexOf('agent.started'));
      const change = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.model_switch');
      expect(change).toMatchObject({
        from_model: 'gpt-5.6-mini',
        from_effort: 'medium',
        to_model: 'gpt-5.6-sol',
        to_effort: 'xhigh',
        ladder_index: 1,
        budget_added: false,
      });
      expect(workspace.state.execution.budgets).toEqual(before);
    } finally {
      workspace.release();
    }
  });

  it('creates the report-writing role\'s report directory before invoking the runner (§18.4 cwd)', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const reportDir = join(ws.janusDir, 'reports', 'run-0105');
      let existedDuringRun = false;
      const watching: AgentRunner = {
        name: 'fake',
        run: async (task) => {
          existedDuringRun = existsSync(task.cwd);
          return stubOutcome(task);
        },
      };
      const task = agentTaskFixture({
        runId: 'run-0105',
        role: 'discovery',
        sandboxClass: 'report-writing',
        repo: null,
        cwd: reportDir,
        writableRoots: [reportDir],
        network: false,
      });
      expect(existsSync(reportDir)).toBe(false);
      await runAgent({ engine, runner: watching, task, previousModel: null });
      expect(existedDuringRun).toBe(true);
      expect(existsSync(reportDir)).toBe(true);
    } finally {
      workspace.release();
    }
  });

  it('reports a failure kind on agent.finished and still writes evidence', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace, clock);
      const failing: AgentRunner = {
        name: 'codex',
        run: async (task) =>
          stubOutcome(task, {
            status: 'failed',
            result: null,
            failure: { kind: 'timeout', detail: 'killed after 60 minutes' },
            timedOut: true,
            exitCode: null,
            signal: 'SIGKILL',
          }),
      };
      const task = agentTaskFixture({ runId: 'run-0104', repo: 'ui-kit', cwd: workspace.paths.repoDir('ui-kit') });
      const record = await runAgent({ engine, runner: failing, task, previousModel: null });
      expect(record.outcome.status).toBe('failed');
      const finished = readEvents(ws.janusDir).find((event) => event['type'] === 'agent.finished');
      expect(finished).toMatchObject({ status: 'failed', failure: 'timeout' });
      expect(readFileSync(join(ws.janusDir, record.evidencePath), 'utf8')).toContain('kind: timeout');
    } finally {
      workspace.release();
    }
  });
});
