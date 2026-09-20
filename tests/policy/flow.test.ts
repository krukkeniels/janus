import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask } from '../../src/agents/types.js';
import { outcomeSummary } from '../../src/agents/types.js';
import { revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { runPolicyFlow } from '../../src/policy/flow.js';
import type { PolicyFixContext } from '../../src/policy/flow.js';
import type { PolicyReport } from '../../src/policy/types.js';
import type { AgentRunner, Providers } from '../../src/providers/types.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, testEngine, testProviders } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';

const FIX_CONTEXT: PolicyFixContext = {
  goal: 'upgrade ui-kit to Angular 16',
  repository: 'ui-kit (library)',
  planSlice: 'wp-01: upgrade ui-kit',
  currentState: 'implementation done, policy failed',
  previousAttempts: [],
  baselineExceptions: [],
  guardrails: ['allowed_scope: src/**'],
  budget: 'policy_violations 0 of 2',
};

/** A runner that edits the tree the way a scripted fix agent would, then reports whatever it was told to. */
function fixRunner(edit: (repoDir: string) => void, changesMade: string[] = []): AgentRunner {
  return {
    name: 'fake',
    run: async (task: AgentTask): Promise<AgentOutcome> => {
      edit(task.cwd);
      const result = {
        status: 'completed' as const,
        summary: 'removed the violation',
        changes_made: changesMade,
        findings: [],
        evidence: [],
        new_tasks: [],
        expected_temporary_failure: false,
        predicted_failures: null,
        plan_change_required: false,
        architecture_change_required: false,
        behavior_change_required: false,
        recommended_next_action: 'commit',
        handover: { current_state: 'fixed', next_action: 'commit', risks: [] },
        no_change_needed: false,
      };
      return {
        runId: task.runId,
        status: 'completed',
        summary: outcomeSummary(result, null),
        result,
        failure: null,
        tokens: null,
        durationMs: 0,
        exitCode: 0,
        signal: null,
        timedOut: false,
        runnerVersion: null,
        jsonlTruncated: false,
        stderrTruncated: false,
      };
    },
  };
}

function providersWith(runner: AgentRunner, workspace: Workspace): Providers {
  return { ...testProviders(workspace.paths), agent: runner };
}

function seedWorkPackage(workspace: Workspace, repo: string): void {
  workspace.state.execution.work_packages['wp-01'] = {
    status: 'in_progress',
    repos: { [repo]: { commits: [], builds: [], attempts: 1, policy_violations: 0, last_failure_signature: null } },
    publish: { version: null, build_id: null },
    checkpoint: { outcome: null, run_id: null },
    regroups: [],
  };
}

describe('runPolicyFlow', () => {
  let ws: WorkspaceFixture;

  beforeEach(async () => {
    ws = await initWorkspace();
    await createGoalBranch(ws, 'ui-kit');
  });

  it('reports a clean tree without committing anything', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const before = await revParse(workspace.paths.repoDir('ui-kit'), 'HEAD');
      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'nothing to do',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });
      expect(outcome.kind).toBe('clean');
      expect(await revParse(workspace.paths.repoDir('ui-kit'), 'HEAD')).toBe(before);
    } finally {
      workspace.release();
    }
  });

  it('commits and pushes a diff that passes every check, and writes passing evidence', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'src-new.ts'), 'export const added = 1;\n');

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a file',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.pushed).toBe(true);
      expect(outcome.fix).toBeNull();
      expect(outcome.commit).toBe(await revParse(dir, 'HEAD'));
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('feat(ui-kit): add a file');
      expect(await runGit(dir, ['log', '-1', '--format=%b'])).toContain('Work-Package: wp-01');

      const report = parse(readFileSync(join(workspace.paths.janusDir, outcome.evidence), 'utf8')) as PolicyReport;
      expect(report.passed).toBe(true);
      expect(report.phase).toBe('initial');
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked).toHaveLength(1);
      expect(checked[0]?.['passed']).toBe(true);
    } finally {
      workspace.release();
    }
  });

  it('runs one fix agent in place, re-checks, and commits when the fix worked', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(
          fixRunner((repoDir) => {
            writeFileSync(join(repoDir, 'a.spec.ts'), "it('runs', () => {});\n");
          }),
          workspace,
        ),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.fix?.runId).toBe('run-0002');
      expect(outcome.fix?.noChangeNeeded).toBe(false);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(0);
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked.map((event) => event['phase'])).toEqual(['initial', 'recheck']);
    } finally {
      workspace.release();
    }
  });

  it('resets the tree, exports the patch, and charges the budget when the fix failed', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.increment?.value).toBe(1);
      expect(outcome.increment?.exhausted).toBe(false);
      expect(outcome.guardrail).toBeNull();
      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(join(dir, 'a.spec.ts'))).toBe(false);
      const patch = readFileSync(join(workspace.paths.janusDir, outcome.patch), 'utf8');
      expect(patch).toContain('a.spec.ts');
      expect(patch).toContain("xit('skipped'");
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(1);
    } finally {
      workspace.release();
    }
  });

  it('skips the fix agent entirely once the per-package limit is already reached', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const entry = workspace.state.execution.work_packages['wp-01']?.repos['ui-kit'];
      if (entry === undefined) throw new Error('missing work package repo block');
      entry.policy_violations = 2; // max_policy_violations_per_package
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      let fixRuns = 0;
      const counting: AgentRunner = {
        name: 'fake',
        run: async (task) => {
          fixRuns += 1;
          return fixRunner(() => {}).run(task, { text: '', version: 'fix@3', bytes: 0, truncations: [] });
        },
      };

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(counting, workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 3,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(fixRuns).toBe(0);
      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.fix).toBeNull();
      expect(outcome.increment).toBeNull();
      expect(outcome.guardrail?.guardrail).toBe('policy_violations');
      expect(outcome.guardrail?.value).toBe(2);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(2);
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked).toHaveLength(1);
    } finally {
      workspace.release();
    }
  });

  it('sees every file the tree changed even when the fix agent under-reports its own work', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(
          // Removes the violation it was told about, quietly adds a forbidden path, and claims one file.
          fixRunner((repoDir) => {
            writeFileSync(join(repoDir, 'a.spec.ts'), "it('runs', () => {});\n");
            writeFileSync(join(repoDir, 'ci.yml.tmp'), 'x\n');
          }, ['a.spec.ts']),
          workspace,
        ),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['a.spec.ts'],
        commitType: 'feat',
        commitSubject: 'add a spec',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.report.violations.map((finding) => finding.check)).toContain('scope.outside_allowed');
      expect(outcome.report.files.map((file) => file.path)).toContain('ci.yml.tmp');
      expect(outcome.fix?.runId).toBe('run-0002');
    } finally {
      workspace.release();
    }
  });
});
