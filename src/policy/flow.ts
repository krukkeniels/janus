import { asFixResult } from '../agents/output-schema.js';
import { runAgent } from '../agents/run.js';
import { buildAgentTask } from '../agents/task.js';
import type { AgentResult } from '../agents/output-schema.js';
import { checkPolicyGuardrail, incrementPolicyViolations } from '../engine/budgets.js';
import type { BudgetIncrement, GuardrailHit } from '../engine/budgets.js';
import type { Engine } from '../engine/engine.js';
import { resetHard } from '../git/tree.js';
import type { Providers } from '../providers/types.js';
import { buildCommitMessage, commitAndPush, PushRejectedCommitError } from './commit.js';
import { buildPolicyContext } from './context.js';
import { analyzeDiff, changeSummaryFrom, inlineDiffFrom } from './diff.js';
import type { DiffAnalysis } from './diff.js';
import {
  policyAttemptId,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from './report.js';
import type { PolicyReport } from './types.js';

/** The §18.2 sections only the stage step knows; the rest of the fix agent's context comes from the diff. */
export interface PolicyFixContext {
  goal: string;
  repository: string | null;
  planSlice: string | null;
  currentState: string | null;
  previousAttempts: string[];
  baselineExceptions: string[];
  guardrails: string[];
  budget: string;
}

export interface PolicyFlowInput {
  engine: Engine;
  /** §3.2: the injected provider bag; `providers.agent` runs the in-place fix. Never a module singleton. */
  providers: Providers;
  repo: string;
  workPackageId: string;
  /** 1-based policy attempt for this (package, repo); names the evidence files. */
  attempt: number;
  /** The code-writing run whose diff this is, recorded on the report and in the commit trailer. */
  runId: string | null;
  /** The run id to give the in-place fix agent if one is needed. */
  fixRunId: string;
  /** The work package's `allowed_scope` from `plan.yaml` (§12), or null. */
  allowedScope: readonly string[] | null;
  /** §14: "violation unless the package allows it". Defaults to `policy.allow_test_file_deletion`. */
  allowTestFileDeletion?: boolean;
  /** Conventional-commit type: `feat` for implementation, `fix` for debug and review-fix commits. */
  commitType: string;
  commitSubject: string;
  fixContext: PolicyFixContext;
  /** `pnpm store path`, needed only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  /** Default true; false for a caller that pushes later. */
  push?: boolean;
}

export interface PolicyFixRecord {
  runId: string;
  status: AgentResult['status'];
  /** §24: the fix agent may answer "nothing to change here". Recorded so T12 can escalate instead of looping. */
  noChangeNeeded: boolean;
  /** `.janus`-relative path of `evidence/agents/<run-id>.yaml`. */
  evidencePath: string;
}

export type PolicyFlowOutcome =
  /** The tree had nothing to commit — before the fix agent ran, or because the fix agent reverted everything. */
  | { kind: 'clean'; stage: 'before_fix' | 'after_fix'; fix: PolicyFixRecord | null }
  /** §14 step 3: checks passed, the diff is committed and pushed. */
  | { kind: 'committed'; commit: string; pushed: boolean; report: PolicyReport; evidence: string; fix: PolicyFixRecord | null }
  /** The commit exists but the remote branch moved; §16.6 base sync owns this, and the commit must not be reset. */
  | { kind: 'push_rejected'; commit: string; report: PolicyReport; evidence: string; fix: PolicyFixRecord | null }
  /** §14 step 4: the tree was reset, the diff was saved as a patch, and the attempt counted. */
  | {
      kind: 'reset';
      report: PolicyReport;
      evidence: string;
      /** `.janus`-relative path of the exported patch. */
      patch: string;
      /** The increment this reset charged, or null when the counter was already at its limit. */
      increment: BudgetIncrement | null;
      /** Set when `policy_violations` is at `max_policy_violations_per_package`; T12 escalates on it (§20). */
      guardrail: GuardrailHit | null;
      fix: PolicyFixRecord | null;
    };

/**
 * Spec §14, the whole commit model, for one repository's working tree.
 *
 * 1. collect the diff — from the git tree only. `AgentResult.changes_made` is never consulted: the T06 spike
 *    showed agents mis-reporting their own file list in both directions, so a check built on a self-report can be
 *    talked out of firing.
 * 2. run the checks, write `evidence/policy/<attempt-id>.yaml`, emit `policy.checked`
 * 3. on pass: commit with a conventional message referencing package and run id, then push
 * 4. on violation: run one fresh fix agent with the report and the diff kept in place; if the re-check still
 *    fails, reset the tree, save the diff as a patch, and charge `policy_violations`
 *
 * The one exception to step 4 is §20's ceiling: when `policy_violations` is *already* at
 * `max_policy_violations_per_package`, the fix attempt cannot change what happens next, so it is skipped and the
 * tree is reset directly. That is §14's "or `max_policy_violations_per_package` is reached".
 *
 * §32 rule 11 holds throughout: every git write here — `commit`, `push`, `reset --hard` — runs in the
 * orchestrator process. The agent is handed a working tree and nothing else.
 *
 * This function writes **no** state beyond the `policy_violations` counter (which §20 requires and
 * `src/engine/budgets.ts` owns). Recording the commit sha on `state.repos.<repo>.head_commit` and on the work
 * package's `commits` array, and checkpointing, belong to the calling stage step (T12).
 *
 * `commitAndPush` stages the entire working tree with `git add -A` and documents that its caller must invoke it
 * immediately after the policy check with no intervening writes to `repoDir`. This function is that caller: the
 * check and the commit run in one uninterrupted sequence (`check` then `commitPass`, with nothing else touching
 * the tree in between), which is what makes that contract hold. Do not insert a post-commit re-verification —
 * a check that aborts after the commit already landed is worse than the gap it would close.
 */
export async function runPolicyFlow(input: PolicyFlowInput): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths, state } = engine.workspace;
  const repoDir = paths.repoDir(repo);
  const attemptId = policyAttemptId(input.workPackageId, repo, input.attempt);

  const analysis = await analyzeDiff(repoDir);
  if (analysis.files.length === 0) return { kind: 'clean', stage: 'before_fix', fix: null };

  const first = await check(input, analysis, attemptId, 'initial');
  if (first.report.passed) return commitPass(input, analysis, first, null);

  const budgetCtx = { state, config: engine.workspace.config, emit: engine.emit };
  const already = checkPolicyGuardrail(budgetCtx, input.workPackageId, repo);
  if (already !== null) {
    engine.warn(
      `policy violations in ${repo} are already ${already.value} of ${already.limit}; resetting without a fix attempt`,
    );
    return reset(input, analysis, first, null, null, already);
  }

  const fix = await runFixAgent(input, analysis, first.report);

  const after = await analyzeDiff(repoDir);
  if (after.files.length === 0) return { kind: 'clean', stage: 'after_fix', fix };

  const attemptIdRecheck = `${attemptId}-recheck`;
  const second = await check(input, after, attemptIdRecheck, 'recheck');
  if (second.report.passed) return commitPass(input, after, second, fix);

  const increment = incrementPolicyViolations(
    budgetCtx,
    input.workPackageId,
    repo,
    `policy check still failed after the in-place fix attempt (${second.report.violations.length} violation(s))`,
  );
  const guardrail = checkPolicyGuardrail(budgetCtx, input.workPackageId, repo);
  return reset(input, after, second, fix, increment, guardrail);
}

interface CheckResult {
  report: PolicyReport;
  evidence: string;
}

async function check(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  attemptId: string,
  phase: PolicyReport['phase'],
): Promise<CheckResult> {
  const { engine, repo } = input;
  const { paths, config, goal } = engine.workspace;
  const ctx = buildPolicyContext({
    cwd: paths.repoDir(repo),
    analysis,
    config,
    targetVersion: Number(goal.target_version),
    allowedScope: input.allowedScope,
    ...(input.allowTestFileDeletion === undefined ? {} : { allowTestFileDeletion: input.allowTestFileDeletion }),
  });
  const report = await runPolicyChecks({
    ctx,
    attemptId,
    workPackageId: input.workPackageId,
    repo,
    runId: input.runId,
    phase,
    now: engine.now(),
  });
  const evidence = writePolicyEvidence(paths, report);
  engine.emit({
    type: 'policy.checked',
    work_package: input.workPackageId,
    repo,
    attempt_id: attemptId,
    run_id: input.runId,
    phase,
    passed: report.passed,
    changed_files: report.totals.changed_files,
    violations: report.violations.length,
    warnings: report.warnings.length,
    violated_checks: [...new Set(report.violations.map((finding) => finding.check))],
    evidence,
  });
  for (const finding of report.warnings) engine.warn(`policy warning [${finding.check}]: ${finding.detail}`);
  return { report, evidence };
}

async function commitPass(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  checked: CheckResult,
  fix: PolicyFixRecord | null,
): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths, state } = engine.workspace;
  const repoState = state.repos[repo];
  if (repoState === undefined) throw new Error(`state has no repo ${repo}`);
  const message = buildCommitMessage({
    type: input.commitType,
    repo,
    subject: input.commitSubject,
    workPackageId: input.workPackageId,
    goalId: state.goal.id,
    runId: input.runId,
    policyEvidence: checked.evidence,
  });
  try {
    const result = await commitAndPush({
      engine,
      repoDir: paths.repoDir(repo),
      repo,
      branch: repoState.goal_branch,
      message,
      workPackageId: input.workPackageId,
      changedFiles: analysis.totals.changedFiles,
      ...(input.push === undefined ? {} : { push: input.push }),
    });
    return {
      kind: 'committed',
      commit: result.commit,
      pushed: result.pushed,
      report: checked.report,
      evidence: checked.evidence,
      fix,
    };
  } catch (error) {
    if (error instanceof PushRejectedCommitError) {
      // The commit exists. §16.6 owns the base-branch sync that resolves this; resetting here would throw the
      // work away for a reason that has nothing to do with the diff's content.
      engine.warn(`push of ${repoState.goal_branch} in ${repo} was rejected; the commit is kept for base sync (§16.6)`);
      return {
        kind: 'push_rejected',
        commit: error.commit,
        report: checked.report,
        evidence: checked.evidence,
        fix,
      };
    }
    throw error;
  }
}

/**
 * §14 step 4: "one fresh 'remove the violation' fix agent with the report and the diff kept in place".
 *
 * Fresh: a new run id, no previous model, and no previous agent's reasoning in the context (§18.2). The report
 * travels in LATEST VERIFICATION EVIDENCE — §18.2's thirteen sections are fixed and T08 adds none, and that is
 * the section whose job is "what the last check said about this diff".
 *
 * The inline diff excludes generated files (`inlineDiffFrom`): `renderContextPackage` refuses a diff containing
 * a lockfile, and an `ng update` diff always contains one.
 */
async function runFixAgent(input: PolicyFlowInput, analysis: DiffAnalysis, report: PolicyReport): Promise<PolicyFixRecord> {
  const { engine } = input;
  const { paths, config } = engine.workspace;
  const task = buildAgentTask({
    runId: input.fixRunId,
    role: 'fix',
    repo: input.repo,
    attempt: input.attempt,
    paths,
    config,
    profile: input.profile,
    globalPnpmStore: input.globalPnpmStore,
    context: {
      goal: input.fixContext.goal,
      repository: input.fixContext.repository,
      planSlice: input.fixContext.planSlice,
      currentState: input.fixContext.currentState,
      changeSummary: changeSummaryFrom(analysis),
      inlineDiff: inlineDiffFrom(analysis),
      verificationEvidence: renderPolicyReportForAgent(report),
      previousAttempts: input.fixContext.previousAttempts,
      baselineExceptions: input.fixContext.baselineExceptions,
    },
    guardrails: input.fixContext.guardrails,
    budget: input.fixContext.budget,
  });
  const record = await runAgent({ engine, runner: input.providers.agent, task, previousModel: null });
  return {
    runId: task.runId,
    status: record.outcome.status,
    noChangeNeeded: asFixResult(record.outcome.result)?.no_change_needed === true,
    evidencePath: record.evidencePath,
  };
}

/** §14 step 4: "the tree is reset, the diff is saved as a patch, and the attempt counts against the role budget". */
async function reset(
  input: PolicyFlowInput,
  analysis: DiffAnalysis,
  checked: CheckResult,
  fix: PolicyFixRecord | null,
  increment: BudgetIncrement | null,
  guardrail: GuardrailHit | null,
): Promise<PolicyFlowOutcome> {
  const { engine, repo } = input;
  const { paths } = engine.workspace;
  // The patch is written BEFORE the reset, and carries generated files too: it exists for a human to re-apply.
  const patch = writePolicyPatch(paths, checked.report.attempt_id, analysis.patch);
  await resetHard(paths.repoDir(repo));
  engine.warn(
    `policy check ${checked.report.attempt_id} failed with ${checked.report.violations.length} violation(s); ` +
      `${repo} was reset and the diff saved to ${patch}`,
  );
  return { kind: 'reset', report: checked.report, evidence: checked.evidence, patch, increment, guardrail, fix };
}
