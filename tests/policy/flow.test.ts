import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentOutcome, AgentTask } from '../../src/agents/types.js';
import { outcomeSummary } from '../../src/agents/types.js';
import { clone, commitAll, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { runPolicyFlow } from '../../src/policy/flow.js';
import type { PolicyFixContext } from '../../src/policy/flow.js';
import { policyPatchPath, renderPolicyReportForAgent } from '../../src/policy/report.js';
import type { PolicyReport } from '../../src/policy/types.js';
import type { AgentRunner, Providers } from '../../src/providers/types.js';
import { readEvents } from '../../src/telemetry/events.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { createGoalBranch, initWorkspace, testEngine, testProviders } from '../helpers/engine-fixtures.js';
import type { WorkspaceFixture } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

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
function fixRunner(edit: (repoDir: string) => void, changesMade: string[] = [], noChangeNeeded = false): AgentRunner {
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
        no_change_needed: noChangeNeeded,
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
      let fixRuns = 0;
      const counting: AgentRunner = {
        name: 'fake',
        run: async (task, prompt) => {
          fixRuns += 1;
          return fixRunner(() => {}).run(task, prompt);
        },
      };
      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(counting, workspace),
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
      if (outcome.kind !== 'clean') throw new Error('expected clean');
      expect(outcome.stage).toBe('before_fix');
      expect(outcome.fix).toBeNull();
      // The check never ran at all — the fix agent must not have either, and nothing should have been written.
      expect(fixRuns).toBe(0);
      expect(await revParse(workspace.paths.repoDir('ui-kit'), 'HEAD')).toBe(before);
      const checked = readEvents(workspace.paths.janusDir).filter((event) => event['type'] === 'policy.checked');
      expect(checked).toHaveLength(0);
      expect(existsSync(join(workspace.paths.janusDir, 'evidence', 'policy'))).toBe(false);
    } finally {
      workspace.release();
    }
  });

  it('reports a clean tree after the fix agent reverts everything, without a patch or a budget charge', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        providers: providersWith(
          // A fix agent that "resolves" the violation by deleting the file outright, rather than fixing it.
          fixRunner((repoDir) => {
            unlinkSync(join(repoDir, 'a.spec.ts'));
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

      expect(outcome.kind).toBe('clean');
      if (outcome.kind !== 'clean') throw new Error('expected clean');
      expect(outcome.stage).toBe('after_fix');
      expect(outcome.fix?.runId).toBe('run-0002');
      // Nothing was committed, nothing was reset, no patch exported, and the counter did not move.
      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(policyPatchPath(workspace.paths.janusDir, 'wp-01-ui-kit-a1'))).toBe(false);
      expect(existsSync(policyPatchPath(workspace.paths.janusDir, 'wp-01-ui-kit-a1-recheck'))).toBe(false);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(0);
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

  it('keeps the commit and does not reset when the push is rejected', async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      const goalBranch = `ai/${ws.fixture.goalId}`;

      // Diverge the remote: a second clone of the same bare repo commits and pushes to the goal branch first, so
      // the flow's own push (after its commit lands locally) is a real non-fast-forward rejection from git.
      const other = join(tempDir(), 'other-ui-kit');
      await clone(ws.fixture.uiKit.bare, other, { branch: goalBranch });
      writeFileSync(join(other, 'other.ts'), 'export const other = 1;\n');
      await commitAll(other, 'feat(ui-kit): diverge');
      await push(other, 'origin', goalBranch);

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

      expect(outcome.kind).toBe('push_rejected');
      if (outcome.kind !== 'push_rejected') throw new Error('expected push_rejected');
      // The commit sha the flow returned must still resolve locally — it was not thrown away.
      expect(await revParse(dir, 'HEAD')).toBe(outcome.commit);
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('feat(ui-kit): add a file');
      // No reset: nothing was reverted, no patch was exported, and the violation counter did not move.
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(policyPatchPath(workspace.paths.janusDir, 'wp-01-ui-kit-a1'))).toBe(false);
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(0);
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
      expect(outcome.patchWithheld).toBe(false);
      if (outcome.patch === null) throw new Error('expected a patch');
      const patch = readFileSync(join(workspace.paths.janusDir, outcome.patch), 'utf8');
      expect(patch).toContain('a.spec.ts');
      expect(patch).toContain("xit('skipped'");
      expect(workspace.state.execution.work_packages['wp-01']?.repos['ui-kit']?.policy_violations).toBe(1);
    } finally {
      workspace.release();
    }
  });

  it("records the fix agent's no_change_needed answer on the reset outcome", async () => {
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow({
        engine,
        // Makes no edit and says so; the every-runner default (`no_change_needed: false`) would mask this field
        // never being read, so this is the one case that pins it to `true`.
        providers: providersWith(fixRunner(() => {}, [], true), workspace),
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
      expect(outcome.fix?.runId).toBe('run-0002');
      expect(outcome.fix?.noChangeNeeded).toBe(true);
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

  it('never lets a detected secret reach evidence, the agent report, or an exported patch (§32 rule 12)', async () => {
    // PROMOTED regression: earlier controller verification checked only the two artefacts someone thought of
    // (evidence YAML, the fix agent's rendered report) and missed a third — the exported .patch, which is
    // `git diff HEAD -M` verbatim and is committed and pushed alongside `.janus`. This test drives a realistic
    // token through the whole flow and checks all three places at once, plus that the patch simply does not
    // exist (Critical 2's fix: it must be withheld entirely, not merely redacted).
    const SECRET = 'AKIAABCDEFGHIJKLMNOP'; // AWS access key id shape: AKIA + 16 alnum
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine, warnings } = testEngine(workspace);
      seedWorkPackage(workspace, 'ui-kit');
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      writeFileSync(join(dir, 'config.ts'), `export const key = '${SECRET}';\n`);

      const outcome = await runPolicyFlow({
        engine,
        // A fix agent that makes no edit: the secret survives the recheck, forcing a reset.
        providers: providersWith(fixRunner(() => {}), workspace),
        repo: 'ui-kit',
        workPackageId: 'wp-01',
        attempt: 1,
        runId: 'run-0001',
        fixRunId: 'run-0002',
        allowedScope: ['**'],
        commitType: 'feat',
        commitSubject: 'add config',
        fixContext: FIX_CONTEXT,
        globalPnpmStore: null,
        profile: 'default',
      });

      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');
      expect(outcome.report.violations.map((finding) => finding.check)).toContain('secrets.detected');
      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');

      // 1. The patch was withheld, not merely redacted: no path is recorded, and nothing was written to disk.
      expect(outcome.patchWithheld).toBe(true);
      expect(outcome.patch).toBeNull();
      expect(existsSync(policyPatchPath(workspace.paths.janusDir, outcome.report.attempt_id))).toBe(false);

      // 2. The YAML evidence file never carries the secret.
      const evidenceYaml = readFileSync(join(workspace.paths.janusDir, outcome.evidence), 'utf8');
      expect(evidenceYaml).not.toContain(SECRET);

      // 3. The report as the fix agent reads it never carries the secret either.
      const renderedForAgent = renderPolicyReportForAgent(outcome.report);
      expect(renderedForAgent).not.toContain(SECRET);

      // A human must still be able to find the withheld attempt from the warning line.
      expect(warnings.some((line) => line.includes(outcome.report.attempt_id) && line.includes('withheld'))).toBe(true);
    } finally {
      workspace.release();
    }
  });
});
