import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { buildAgentTask } from '../../src/agents/task.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { contextPackageInputFixture } from '../helpers/agent-fixtures.js';

const config = configSchema.parse({
  workflow: { ci_provider: 'fake', scm_provider: 'fake' },
  experiment: { id: 'exp-ladder-1' },
  model_profiles: {
    default: {
      '*': { model: 'gpt-5.6-sol', effort: 'high' },
      debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-mini', 'gpt-5.6-sol:xhigh'] },
    },
  },
});

const build = (overrides: Record<string, unknown> = {}) =>
  buildAgentTask({
    runId: 'run-0007',
    role: 'implementation',
    repo: 'ui-kit',
    attempt: 1,
    paths: workspacePaths(tempDir('janus-task-')),
    config,
    profile: 'default',
    globalPnpmStore: null,
    context: contextPackageInputFixture(),
    guardrails: ['files outside src/ are out of scope'],
    budget: 'ci_fix_attempts: 1 of 5',
    ...overrides,
  });

describe('buildAgentTask', () => {
  it('fills the §18.1 contract from the role, the config, and the workspace', () => {
    const paths = workspacePaths(tempDir('janus-task-'));
    const task = buildAgentTask({
      runId: 'run-0007',
      role: 'implementation',
      repo: 'ui-kit',
      attempt: 1,
      paths,
      config,
      profile: 'default',
      globalPnpmStore: null,
      context: contextPackageInputFixture(),
      guardrails: ['files outside src/ are out of scope'],
      budget: 'ci_fix_attempts: 1 of 5',
    });
    expect(task.runId).toBe('run-0007');
    expect(task.sandboxClass).toBe('code-writing');
    expect(task.sandbox).toBe('workspace-write');
    expect(task.network).toBe(true);
    expect(task.timeoutMinutes).toBe(60);
    expect(task.model).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null });
    expect(task.profile).toBe('default');
    expect(task.experimentId).toBe('exp-ladder-1');
    expect(task.promptVersion).toMatch(/^implementation@\d+$/);
    expect(task.outputSchema['title']).toBe('janus-implementation-result');
    expect(task.env['npm_config_store_dir']).toBe(paths.pnpmStoreDir);
  });

  it('always supplies the four fixed context blocks, whatever the caller passed', () => {
    const task = build();
    expect(task.context.guardrails).toEqual(['files outside src/ are out of scope']);
    expect(task.context.angularGuidance).toContain('--allow-dirty');
    expect(task.context.outputContract).toContain('predicted_failures');
    expect(task.context.budget).toBe('ci_fix_attempts: 1 of 5');
    expect(task.context.role).toBe('implementation');
  });

  it('walks the ladder with the attempt number', () => {
    expect(build({ role: 'debug', attempt: 1 }).model).toEqual({ model: 'gpt-5.6-mini', effort: 'high', ladderIndex: 0, ladderLength: 2 });
    expect(build({ role: 'debug', attempt: 2 }).model).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
  });

  it('caps a role timeout at guardrails.max_agent_runtime_minutes', () => {
    // `configSchema` itself rejects a role timeout above the ceiling (Task 1's superRefine), so this exercises the
    // "hand-edited between load and use" case the `Math.min` in `buildAgentTask` guards against: a config that was
    // valid when parsed and then mutated afterwards.
    const capped = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    capped.guardrails.max_agent_runtime_minutes = 20;
    expect(build({ config: capped }).timeoutMinutes).toBe(20);
  });

  it('copies the sandbox plan’s skipGitRepoCheck onto the task', () => {
    const p = workspacePaths(tempDir('janus-task-skipflag-'));
    const cfg = configSchema.parse({ workflow: { ci_provider: 'fake', scm_provider: 'fake' } });
    const common = { attempt: 1, paths: p, config: cfg, profile: 'default', globalPnpmStore: null, guardrails: [], budget: 'n/a' };
    const read = buildAgentTask({ ...common, runId: 'run-a', role: 'review', repo: null, context: contextPackageInputFixture() });
    const write = buildAgentTask({ ...common, runId: 'run-b', role: 'implementation', repo: 'ui-kit', context: contextPackageInputFixture() });
    expect(read.skipGitRepoCheck).toBe(true);
    expect(write.skipGitRepoCheck).toBe(false);
  });
});
