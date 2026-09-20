import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import type { FixAgentResult } from '../../src/agents/output-schema.js';
import { checkoutBranch, push, remoteHead, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { createEngine } from '../../src/engine/engine.js';
import { runPolicyFlow } from '../../src/policy/index.js';
import type { PolicyFixContext, PolicyReport } from '../../src/policy/index.js';
import { seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';
import type { Workspace } from '../../src/workspace/open-workspace.js';
import { createHarness, expectNoAgentGitWrites } from './harness/harness.js';
import type { Harness } from './harness/harness.js';

const SPECS = [{ name: 'ui-kit', kind: 'library' as const }];

const FIX_CONTEXT: PolicyFixContext = {
  goal: 'upgrade ui-kit to Angular 16',
  repository: 'ui-kit (library)',
  planSlice: 'wp-01: upgrade ui-kit',
  currentState: 'implementation finished',
  previousAttempts: [],
  baselineExceptions: [],
  guardrails: ['allowed_scope: src/**, a.spec.ts'],
  budget: 'policy_violations 0 of 2',
};

/** Puts `ui-kit` on its goal branch with a work-package block, and returns the open workspace. */
async function prepare(harness: Harness): Promise<Workspace> {
  const dir = join(harness.root, 'repos', 'ui-kit');
  const branch = `ai/${harness.fixture.goalId}`;
  await checkoutBranch(dir, branch, 'HEAD');
  await push(dir, 'origin', branch, { setUpstream: true });
  const workspace = await openWorkspace(harness.root);
  const repoState = workspace.state.repos['ui-kit'];
  if (repoState === undefined) throw new Error('state has no ui-kit');
  repoState.goal_branch = branch;
  workspace.state.execution.work_packages['wp-01'] = {
    status: 'in_progress',
    repos: { 'ui-kit': { commits: [], builds: [], attempts: 1, policy_violations: 0, last_failure_signature: null } },
    publish: { version: null, build_id: null },
    checkpoint: { outcome: null, run_id: null },
    regroups: [],
  };
  return workspace;
}

function engineFor(workspace: Workspace) {
  return createEngine({ workspace, log: () => {}, warn: () => {}, push: false });
}

function flowInput(workspace: Workspace, harness: Harness, overrides: Record<string, unknown> = {}) {
  return {
    engine: engineFor(workspace),
    providers: harness.providers,
    repo: 'ui-kit',
    workPackageId: 'wp-01',
    attempt: 1,
    runId: 'run-0001',
    fixRunId: 'run-0002',
    allowedScope: ['src/**', 'a.spec.ts'],
    commitType: 'feat',
    commitSubject: 'upgrade ui-kit',
    fixContext: FIX_CONTEXT,
    globalPnpmStore: null,
    profile: 'default',
    ...overrides,
  } as Parameters<typeof runPolicyFlow>[0];
}

describe('policy flow in the harness', () => {
  it('pass: commits a clean diff, pushes it, and leaves passing evidence', async () => {
    const harness = await createHarness(SPECS);
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'src-feature.ts'), 'export const feature = 1;\n');
      // Left untracked on purpose: `workingTreeDiff` registers it with `add --intent-to-add`,
      // so it must surface as an `A` record without the test staging it.

      const outcome = await runPolicyFlow(flowInput(workspace, harness, { allowedScope: ['**'] }));
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');

      expect(await remoteHead(dir, 'origin', `ai/${harness.fixture.goalId}`)).toBe(outcome.commit);
      const report = parse(readFileSync(join(workspace.paths.janusDir, outcome.evidence), 'utf8')) as PolicyReport;
      expect(report.passed).toBe(true);
      expect(report.files.map((file) => file.path)).toEqual(['src-feature.ts']);
      expect(harness.events().some((event) => event['type'] === 'push.completed')).toBe(true);
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('fix-in-place: one fix agent removes the violation and the diff is committed', async () => {
    const harness = await createHarness(SPECS);
    // §14 deliberately never reads `changes_made`/`no_change_needed`: the check reruns against the tree.
    // Hoisted out of the object literal below: `FakeAgentScriptEntry.result` is `Partial<AgentResult>`, and
    // `no_change_needed` is a `fix`-role extension the fake merges in and re-validates at runtime, so writing it
    // inline would trip the excess-property check on an object literal assigned to that field.
    const fixResult: Partial<FixAgentResult> = { no_change_needed: false, changes_made: [] };
    seedFakeAgents(harness.fakeDir, {
      fix: [
        {
          status: 'completed',
          summary: 'removed the skipped test',
          patch: [
            'diff --git a/a.spec.ts b/a.spec.ts',
            '--- a/a.spec.ts',
            '+++ b/a.spec.ts',
            '@@ -1 +1 @@',
            "-xit('skipped', () => {});",
            "+it('runs', () => {});",
            '',
          ].join('\n'),
          result: fixResult,
        },
      ],
    });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      // HEAD must be clean: `tests.forbidden_pattern_added` fires on ADDED lines, so the
      // forbidden pattern has to arrive in the diff, not already sit in the seed commit.
      writeFileSync(join(dir, 'a.spec.ts'), "it('placeholder', () => {});\n");
      await runGit(dir, ['add', '-A']);
      await runGit(dir, ['commit', '-q', '-m', 'feat(ui-kit): seed a spec file']);
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      const outcome = await runPolicyFlow(flowInput(workspace, harness));
      expect(outcome.kind).toBe('committed');
      if (outcome.kind !== 'committed') throw new Error('expected committed');
      expect(outcome.fix?.runId).toBe('run-0002');
      expect(readFileSync(join(dir, 'a.spec.ts'), 'utf8')).toContain("it('runs'");
      expect(harness.evidence(`agents/run-0002.yaml`)).toContain('role: fix');
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('reset after limit: the tree goes back, the patch is exported, and the counter hits its limit', async () => {
    const harness = await createHarness(SPECS);
    // The fix agent changes nothing, so the recheck fails exactly as the first check did.
    const noChangeResult: Partial<FixAgentResult> = { no_change_needed: true };
    const noChangeEntry = { status: 'completed' as const, summary: 'nothing to do', result: noChangeResult };
    // `attempt: 2` below selects the fake's script by index `attempt - 1`: index 1 must carry the answer.
    seedFakeAgents(harness.fakeDir, { fix: [noChangeEntry, noChangeEntry] });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      const head = await revParse(dir, 'HEAD');
      const entry = workspace.state.execution.work_packages['wp-01']?.repos['ui-kit'];
      if (entry === undefined) throw new Error('missing work package repo block');
      entry.policy_violations = 1;

      writeFileSync(join(dir, 'forbidden.ts'), 'export const x = 1;\n');

      const outcome = await runPolicyFlow(flowInput(workspace, harness, { attempt: 2, allowedScope: ['src/**'] }));
      expect(outcome.kind).toBe('reset');
      if (outcome.kind !== 'reset') throw new Error('expected reset');

      expect(outcome.increment?.value).toBe(2);
      expect(outcome.increment?.exhausted).toBe(true);
      expect(outcome.guardrail?.guardrail).toBe('policy_violations');
      expect(outcome.fix?.noChangeNeeded).toBe(true);

      expect(await revParse(dir, 'HEAD')).toBe(head);
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      expect(existsSync(join(dir, 'forbidden.ts'))).toBe(false);
      expect(outcome.patchWithheld).toBe(false);
      if (outcome.patch === null) throw new Error('expected a patch');
      const patch = readFileSync(join(workspace.paths.janusDir, outcome.patch), 'utf8');
      expect(patch).toContain('forbidden.ts');

      const hits = harness.events().filter((event) => event['type'] === 'guardrail.hit');
      expect(hits.length).toBe(0); // the flow reports the hit; escalating on it is T12's job
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });

  it('no agent process moves a ref across the whole flow (§31.29, §32 rule 11)', async () => {
    const harness = await createHarness(SPECS);
    const fixedResult: Partial<FixAgentResult> = { no_change_needed: false, changes_made: [] };
    seedFakeAgents(harness.fakeDir, {
      fix: [
        {
          status: 'completed',
          summary: 'fixed',
          patch: [
            'diff --git a/a.spec.ts b/a.spec.ts',
            '--- a/a.spec.ts',
            '+++ b/a.spec.ts',
            '@@ -1 +1 @@',
            "-xit('skipped', () => {});",
            "+it('runs', () => {});",
            '',
          ].join('\n'),
          result: fixedResult,
        },
      ],
    });
    const workspace = await prepare(harness);
    try {
      const dir = workspace.paths.repoDir('ui-kit');
      writeFileSync(join(dir, 'a.spec.ts'), "it('placeholder', () => {});\n");
      await runGit(dir, ['add', '-A']);
      await runGit(dir, ['commit', '-q', '-m', 'feat(ui-kit): seed a spec file']);
      writeFileSync(join(dir, 'a.spec.ts'), "xit('skipped', () => {});\n");

      await runPolicyFlow(flowInput(workspace, harness));

      // The audit wrapper brackets every `AgentRunner.run()`; a commit, push or reset inside that window would
      // appear here. Every git write in this flow happens in the orchestrator, outside the window.
      expect(harness.agentGitWrites).toEqual([]);
      expectNoAgentGitWrites(harness);
    } finally {
      workspace.release();
    }
  });
});
