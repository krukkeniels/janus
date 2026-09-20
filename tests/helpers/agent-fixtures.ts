import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRole } from '../../src/config/config-schema.js';
import type { ContextPackage, ContextPackageInput } from '../../src/agents/context.js';
import { outputSchemaFor } from '../../src/agents/output-schema.js';
import type { AgentResult } from '../../src/agents/output-schema.js';
import { sandboxClassFor } from '../../src/agents/roles.js';
import type { AgentOutcome, AgentTask } from '../../src/agents/types.js';
import { outcomeSummary } from '../../src/agents/types.js';

// TODO(T06): replace with `import { promptVersionFor } from '../../src/agents/prompts/templates.js';` once Task 6 lands.
const promptVersionFor = (role: AgentRole): string => `${role}@1`;

export function contextPackageInputFixture(overrides: Partial<ContextPackageInput> = {}): ContextPackageInput {
  return {
    goal: 'Upgrade ui-kit from Angular 15 to Angular 16',
    repository: 'ui-kit (library), base branch main, no dependencies',
    planSlice: 'wp-01-ui-kit-angular: run ng update for @angular/core and @angular/cli',
    currentState: 'stage executing, work package wp-01-ui-kit-angular, attempt 1',
    changeSummary: [],
    inlineDiff: null,
    verificationEvidence: null,
    previousAttempts: [],
    baselineExceptions: [],
    ...overrides,
  };
}

export function contextPackageFixture(role: AgentRole = 'implementation', overrides: Partial<ContextPackage> = {}): ContextPackage {
  return {
    ...contextPackageInputFixture(),
    role,
    guardrails: ['never run a git write command', 'never edit .teamcity/** or .github/**'],
    angularGuidance: 'Use pnpm. Run ng update with --allow-dirty.',
    budget: 'ci_fix_attempts: 0 of 5',
    outputContract: 'Answer with JSON matching the schema you were given.',
    ...overrides,
  };
}

export function resultFixture(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    status: 'completed',
    summary: 'raised @angular/core to 16.2.12',
    changes_made: ['package.json'],
    findings: [],
    evidence: [],
    new_tasks: [],
    expected_temporary_failure: false,
    predicted_failures: null,
    plan_change_required: false,
    architecture_change_required: false,
    behavior_change_required: false,
    recommended_next_action: 'run the PR build',
    handover: { current_state: 'builds on 16', next_action: 'commit', risks: [] },
    ...overrides,
  };
}

/** A structurally valid §18.1 task. Tasks that need real paths build them with `buildAgentTask` instead. */
export function agentTaskFixture(overrides: Partial<AgentTask> = {}): AgentTask {
  const role = overrides.role ?? 'implementation';
  const repo = overrides.repo === undefined ? 'ui-kit' : overrides.repo;
  const root = join(tmpdir(), 'janus-task-fixture');
  return {
    runId: 'run-0001',
    role,
    sandboxClass: sandboxClassFor(role),
    repo,
    cwd: join(root, 'repos', repo ?? 'ui-kit'),
    writableRoots: [join(root, 'repos', repo ?? 'ui-kit')],
    network: true,
    timeoutMinutes: 60,
    context: contextPackageFixture(role),
    outputSchema: outputSchemaFor(role),
    model: { model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null },
    attempt: 1,
    promptVersion: promptVersionFor(role),
    profile: 'default',
    experimentId: null,
    sandbox: 'workspace-write',
    env: {},
    ...overrides,
  };
}

/** A minimal successful `AgentOutcome`, for tests that need an `AgentRunner` but do not care what it answers. */
export function stubOutcome(task: AgentTask, overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  const result = overrides.result === undefined ? resultFixture() : overrides.result;
  return {
    runId: task.runId,
    status: result?.status ?? 'failed',
    summary: outcomeSummary(result, overrides.failure ?? null),
    result,
    failure: null,
    tokens: null,
    durationMs: 0,
    exitCode: 0,
    signal: null,
    timedOut: false,
    runnerVersion: null,
    ...overrides,
  };
}
