import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { commitAll } from '../../src/git/ops.js';
import { readFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { createHarness, expectNoAgentGitWrites, expectStatePushed } from './harness/harness.js';

const SPECS = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit'] },
];

describe('createHarness', () => {
  it('initializes a workspace, seeds the agent script, and audits every repository', async () => {
    const harness = await createHarness(SPECS, {
      agents: { discovery: [{ status: 'completed', summary: 'scripted discovery' }] },
      now: () => new Date('2026-09-20T13:00:00.000Z'),
    });

    expect(harness.state().goal.status).toBe('created');
    expect(existsSync(harness.fakeDir)).toBe(true);
    expect(harness.auditTargets.map((target) => target.label).sort()).toEqual(
      ['.janus', 'remote:shell', 'remote:ui-kit', 'repos/shell', 'repos/ui-kit', 'state-remote'].sort(),
    );

    const outcome = await harness.providers.agent.run({ runId: 'run-0001', role: 'discovery', repo: 'ui-kit' });
    expect(outcome.summary).toBe('scripted discovery');
    expect(readFakeAgents(harness.fakeDir).calls).toHaveLength(1);
    expectNoAgentGitWrites(harness);
  });

  it('runs the CLI in the workspace with the audited providers injected', async () => {
    const harness = await createHarness(SPECS);
    const result = await harness.run(['run', '--dry-run']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('goal angular-15-to-16: created');
  });

  it('explains which evidence files exist when one is missing', async () => {
    const harness = await createHarness(SPECS);
    expect(() => harness.evidence('agents/run-9999.yaml')).toThrow('no evidence file agents/run-9999.yaml');
  });

  it('removes every temp directory it created', async () => {
    const harness = await createHarness(SPECS);
    const root = harness.root;
    const bare = harness.fixture.repos['ui-kit']?.bare;
    if (bare === undefined) throw new Error('expected a ui-kit remote');
    harness.cleanup();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(bare)).toBe(false);
    expect(existsSync(join(harness.fixture.dir, 'goal.yaml'))).toBe(false);
  });

  it('builds and audits cleanly when a product repo is named "state"', async () => {
    const harness = await createHarness([{ name: 'state', kind: 'library' as const }]);
    expect(harness.auditTargets.map((target) => target.label).sort()).toEqual(
      ['.janus', 'repos/state', 'remote:state', 'state-remote'].sort(),
    );
    expectNoAgentGitWrites(harness);
  });
});

describe('expectStatePushed', () => {
  it('resolves when the state checkout and its bare remote are at the same commit', async () => {
    const harness = await createHarness(SPECS);
    await expect(expectStatePushed(harness)).resolves.toBeUndefined();
  });

  it('rejects with the branch, the local HEAD, and the remote sha when they diverge', async () => {
    const harness = await createHarness(SPECS);
    const sha = await commitAll(harness.janusDir, 'chore(test): local-only checkpoint', { allowEmpty: true });
    await expect(expectStatePushed(harness)).rejects.toThrow(
      `state branch ${harness.stateBranch}: local HEAD ${sha} but remote `,
    );
  });
});
