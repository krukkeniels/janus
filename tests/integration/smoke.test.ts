import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { defaultSteps } from '../../src/engine/steps.js';
import type { Step } from '../../src/engine/steps.js';
import { commitAll, currentBranch, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { readFakeAgents } from '../../src/providers/fake/agent-runner.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { EVIDENCE_DIR } from '../../src/state/files.js';
import { createHarness, expectNoAgentGitWrites, expectStatePushed } from './harness/harness.js';

/** A three-repo dependency graph: a library, a Module Federation remote that uses it, and the shell that loads both. */
const GRAPH = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'orders-remote', kind: 'remote' as const, dependsOn: ['ui-kit'] },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit', 'orders-remote'], loadsRemotes: ['orders-remote'] },
];

describe('T04 smoke: init and one checkpoint through the harness', () => {
  it('clones the graph in dependency order and pushes the first checkpoint', async () => {
    const harness = await createHarness(GRAPH);

    const state = harness.state();
    expect(Object.keys(state.repos)).toEqual(['ui-kit', 'orders-remote', 'shell']);
    expect(state.goal.status).toBe('created');
    for (const name of ['ui-kit', 'orders-remote', 'shell']) {
      const dir = join(harness.root, 'repos', name);
      expect(await currentBranch(dir)).toBe('main');
      expect(state.repos[name]?.base_commit).toBe(await revParse(dir, 'HEAD'));
      expect(state.repos[name]?.goal_branch).toBe('ai/angular-15-to-16');
    }
    await expectStatePushed(harness);
    expect(harness.events().map((event) => event['type'])).toEqual(['goal.created']);
    expectNoAgentGitWrites(harness);
  });

  it('advances one stage and leaves exactly one new checkpoint on the state branch', async () => {
    const harness = await createHarness(GRAPH);
    const before = await runGit(harness.janusDir, ['rev-list', '--count', 'HEAD']);

    const result = await harness.run(['run', '--until', 'preparing']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('reached stage preparing (--until)');

    const after = await runGit(harness.janusDir, ['rev-list', '--count', 'HEAD']);
    expect(Number(after) - Number(before)).toBe(1);
    expect(await runGit(harness.janusDir, ['log', '-1', '--format=%s'])).toBe('chore(janus): start: goal started');
    expect(harness.state().goal.status).toBe('preparing');
    expect(harness.state().execution.in_flight.step).toBeNull();
    await expectStatePushed(harness);
    expect(harness.events().map((event) => event['type'])).toContain('stage.entered');
    expectNoAgentGitWrites(harness);
  });

  it('runs a scripted agent step that persists to fake/agents.json and writes evidence, with no git writes', async () => {
    const harness = await createHarness(GRAPH, {
      agents: { discovery: [{ status: 'completed', summary: 'discovery found 3 repos' }] },
      now: () => new Date('2026-09-20T14:00:00.000Z'),
    });

    const discoveryStep: Step = {
      name: 'prepare',
      run: async ({ engine, providers }) => {
        engine.markInFlight({ agent_run_id: 'run-0001', repo: 'ui-kit' });
        const outcome = await providers.agent.run({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' });
        const path = join(engine.workspace.paths.janusDir, EVIDENCE_DIR, 'agents', `${outcome.runId}.yaml`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `run_id: ${outcome.runId}\nstatus: ${outcome.status}\nsummary: ${outcome.summary}\n`);
        engine.emit({ type: 'agent.finished', run_id: outcome.runId, repo: 'ui-kit', status: outcome.status, step: 'prepare' });
        return { kind: 'advance', to: 'discovering', summary: outcome.summary };
      },
    };

    const result = await harness.run(['run', '--until', 'discovering'], {
      steps: { ...defaultSteps(), preparing: discoveryStep },
    });
    expect(result.code).toBe(ExitCode.Ok);
    expect(harness.state().goal.status).toBe('discovering');

    expect(harness.evidence('agents/run-0001.yaml')).toContain('summary: discovery found 3 repos');
    const agents = readFakeAgents(harness.fakeDir);
    expect(agents.calls).toEqual([
      { run_id: 'run-0001', role: 'discovery', repo: 'ui-kit', at: '2026-09-20T14:00:00.000Z', status: 'completed' },
    ]);
    expect(harness.events().some((event) => event['type'] === 'agent.finished')).toBe(true);
    await expectStatePushed(harness);
    expectNoAgentGitWrites(harness);
  });

  it('fails the run when an agent performs a git write (spec §31.29)', async () => {
    // The runner is built before the harness exists, so it reads the repo path from a binding the harness fills in.
    let repoDir = '';
    const naughty: AgentRunner = {
      name: 'fake',
      run: async (request) => {
        await commitAll(repoDir, 'feat(ui-kit): agent committed', { allowEmpty: true });
        return { runId: request.runId, status: 'completed', summary: 'committed, which agents must never do' };
      },
    };
    const harness = await createHarness(GRAPH, { agentRunner: naughty });
    repoDir = join(harness.root, 'repos', 'ui-kit');

    await harness.providers.agent.run({ runId: 'run-0042', role: 'implementation', repo: 'ui-kit' });

    expect(harness.agentGitWrites.length).toBeGreaterThan(0);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/spec §31.29 violated/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/repos\/ui-kit/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/agent committed/);
    expect(() => expectNoAgentGitWrites(harness)).toThrow(/during agent run run-0042, role implementation/);
  });
});
