import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildAgentTask } from '../../src/agents/task.js';
import { runAgent } from '../../src/agents/run.js';
import { createEngine } from '../../src/engine/engine.js';
import { runGit } from '../../src/git/run.js';
import { readFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import { createHarness, expectNoAgentGitWrites } from './harness/harness.js';

const SPECS = [
  { name: 'ui-kit', kind: 'library' as const },
  { name: 'shell', kind: 'shell' as const, dependsOn: ['ui-kit'] },
];

const PATCH = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # ui-kit',
  '+Upgraded to Angular 16.',
  '',
].join('\n');

const CONTEXT = {
  goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
  repository: 'ui-kit (library), base branch main',
  planSlice: 'wp-01-ui-kit-angular: run ng update',
  currentState: 'stage executing, attempt 1',
  changeSummary: [{ path: 'package.json', added: 12, removed: 3, generated: false }],
  inlineDiff: null,
  verificationEvidence: null,
  previousAttempts: [],
  baselineExceptions: [],
};

describe('an agent run inside the harness', () => {
  it('applies the scripted patch, stamps the evidence, emits the events, and writes no git ref (§31.29)', async () => {
    const harness = await createHarness(SPECS, {
      agents: { implementation: [{ status: 'completed', summary: 'bumped ui-kit to 16', patch: PATCH }] },
      now: () => new Date('2026-09-20T13:00:00.000Z'),
    });
    const repoDir = join(harness.root, 'repos', 'ui-kit');
    const headBefore = await runGit(repoDir, ['rev-parse', 'HEAD']);

    const workspace = await openWorkspace(harness.root);
    try {
      const engine = createEngine({
        workspace,
        log: () => undefined,
        warn: () => undefined,
        now: () => new Date('2026-09-20T13:00:00.000Z'),
      });
      const task = buildAgentTask({
        runId: 'run-0001',
        role: 'implementation',
        repo: 'ui-kit',
        attempt: 1,
        paths: workspace.paths,
        config: workspace.config,
        profile: workspace.config.workflow_models.profile,
        globalPnpmStore: null,
        context: CONTEXT,
        guardrails: ['files outside src/ are out of scope'],
        budget: 'ci_fix_attempts: 0 of 5',
      });
      const record = await runAgent({ engine, runner: harness.providers.agent, task, previousModel: null });

      expect(record.outcome.status).toBe('completed');
      expect(readFileSync(join(repoDir, 'README.md'), 'utf8')).toContain('Upgraded to Angular 16.');
      expect(await runGit(repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
      expect(await runGit(repoDir, ['status', '--porcelain'])).toContain('README.md');

      const evidence = parse(harness.evidence(join('agents', 'run-0001.yaml'))) as Record<string, unknown>;
      expect(evidence['role']).toBe('implementation');
      expect(evidence['class']).toBe('code-writing');
      expect(evidence['sandbox']).toBe('workspace-write');
      expect(evidence['model']).toBe('gpt-5.6-sol');
      expect(evidence['profile']).toBe('default');
      expect(evidence['prompt_version']).toMatch(/^implementation@\d+$/);
      expect(evidence['cwd']).toBe(join('repos', 'ui-kit'));
      expect(evidence['env_keys']).toEqual(['npm_config_store_dir']);

      const types = readEvents(workspace.paths.janusDir).map((event) => event['type']);
      expect(types).toContain('agent.started');
      expect(types).toContain('agent.finished');
      expect(readFakeAgents(harness.fakeDir).calls[0]?.applied_patch).toBe(true);
    } finally {
      workspace.release();
    }

    expectNoAgentGitWrites(harness);
  });

  it('gives a report-writing role its own report directory and no writable repo', async () => {
    const harness = await createHarness(SPECS, {
      agents: { discovery: [{ status: 'completed', summary: 'surveyed ui-kit', reports: { 'deps-and-build.md': '# Deps\n' } }] },
    });
    const workspace = await openWorkspace(harness.root);
    try {
      const engine = createEngine({ workspace, log: () => undefined, warn: () => undefined });
      const task = buildAgentTask({
        runId: 'run-0002',
        role: 'discovery',
        repo: null,
        attempt: 1,
        paths: workspace.paths,
        config: workspace.config,
        profile: 'default',
        globalPnpmStore: null,
        context: { ...CONTEXT, changeSummary: [] },
        guardrails: [],
        budget: '(discovery has no budget)',
      });
      expect(task.cwd).toBe(join(workspace.paths.janusDir, 'reports', 'run-0002'));
      expect(task.writableRoots).toEqual([task.cwd]);
      expect(task.network).toBe(false);

      await runAgent({ engine, runner: harness.providers.agent, task, previousModel: null });
      expect(existsSync(join(task.cwd, 'deps-and-build.md'))).toBe(true);
    } finally {
      workspace.release();
    }

    expectNoAgentGitWrites(harness);
  });
});
