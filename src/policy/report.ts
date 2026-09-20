import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { stringify } from 'yaml';
import { POLICY_EVIDENCE_DIR } from '../state/files.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { ALL_POLICY_CHECKS } from './registry.js';
import type { PolicyCheck, PolicyCheckContext, PolicyCheckId, PolicyFinding, PolicyReport, PolicyReportFile } from './types.js';

/**
 * The basename of `evidence/policy/<attempt-id>.yaml` and of the patch beside it.
 *
 * Work package ids and repo names are kebab-case by schema (`src/config/goal-schema.ts`, §12), so the result is
 * always a safe filename with no escaping.
 */
export function policyAttemptId(workPackageId: string, repo: string, attempt: number): string {
  return `${workPackageId}-${repo}-a${attempt}`;
}

export function policyEvidencePath(janusDir: string, attemptId: string): string {
  return join(janusDir, POLICY_EVIDENCE_DIR, `${attemptId}.yaml`);
}

/** Spec §14: "the tree is reset, the diff is saved as a patch". It lives beside the report it belongs to. */
export function policyPatchPath(janusDir: string, attemptId: string): string {
  return join(janusDir, POLICY_EVIDENCE_DIR, `${attemptId}.patch`);
}

export interface RunPolicyChecksInput {
  ctx: PolicyCheckContext;
  attemptId: string;
  workPackageId: string;
  repo: string;
  /** The code-writing agent run whose diff this is, or null. */
  runId: string | null;
  phase: PolicyReport['phase'];
  now: Date;
  /** Defaults to `ALL_POLICY_CHECKS`; narrowed only by tests. */
  checks?: readonly PolicyCheck[];
}

/**
 * Spec §14 step 2: "runs policy checks".
 *
 * Every check runs, even after an earlier one has already produced a violation: a fix agent that is told about
 * one violation and then trips the next one on its second attempt has cost the goal two attempts for one diff.
 * A check that returns `null` — its inputs were absent — is left out of `checks_run`, so the evidence file never
 * claims a check ran that did not.
 *
 * That guarantee covers *violations*, not *exceptions*. A check that throws aborts the whole run — deliberately,
 * not by omission — and no evidence file is written for this attempt: whether the diff is safe is unknown when a
 * check crashes, and a policy gate that cannot finish evaluating a diff must not let it through by continuing
 * past the failure. The `catch` below exists only to name which check threw before rethrowing; it does not
 * swallow the error or let the loop continue.
 */
export async function runPolicyChecks(input: RunPolicyChecksInput): Promise<PolicyReport> {
  const checks = input.checks ?? ALL_POLICY_CHECKS;
  const checksRun: PolicyCheckId[] = [];
  const violations: PolicyFinding[] = [];
  const warnings: PolicyFinding[] = [];
  for (const check of checks) {
    let findings: PolicyFinding[] | null;
    try {
      findings = await check.run(input.ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`policy check "${check.id}" threw while running: ${message}`, { cause: error });
    }
    if (findings === null) continue;
    checksRun.push(check.id);
    for (const finding of findings) {
      if (finding.severity === 'violation') violations.push(finding);
      else warnings.push(finding);
    }
  }
  const files: PolicyReportFile[] = input.ctx.analysis.files.map((file) => ({
    path: file.path,
    status: file.status,
    previous_path: file.previousPath,
    added: file.added,
    removed: file.removed,
    binary: file.binary,
    generated: file.generated,
  }));
  const { changedFiles, addedLines, removedLines } = input.ctx.analysis.totals;
  return {
    attempt_id: input.attemptId,
    work_package: input.workPackageId,
    repo: input.repo,
    run_id: input.runId,
    phase: input.phase,
    checked_at: input.now.toISOString(),
    files,
    totals: { changed_files: changedFiles, added_lines: addedLines, removed_lines: removedLines },
    checks_run: checksRun,
    violations,
    warnings,
    passed: violations.length === 0,
  };
}

/**
 * Spec §14 step 4 and §31.25. Written on every check, pass or fail: a passing report is the only durable proof
 * that "every diff is policy-checked before commit" actually happened for this diff.
 *
 * Returns the `.janus`-relative path, which is what state, telemetry and the commit trailer reference — the same
 * convention `writeAgentEvidence` uses, so nothing on the state branch ever carries an absolute home path.
 */
export function writePolicyEvidence(paths: WorkspacePaths, report: PolicyReport): string {
  const path = policyEvidencePath(paths.janusDir, report.attempt_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(report));
  return relative(paths.janusDir, path);
}

/** The whole working-tree patch, generated files included: this one is for a human to re-apply, not for a prompt. */
export function writePolicyPatch(paths: WorkspacePaths, attemptId: string, patch: string): string {
  const path = policyPatchPath(paths.janusDir, attemptId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, patch.endsWith('\n') ? patch : `${patch}\n`);
  return relative(paths.janusDir, path);
}

function renderFinding(finding: PolicyFinding): string {
  const where = finding.path === null ? '' : ` ${finding.path}${finding.line === null ? '' : `:${finding.line}`}`;
  const quote = finding.evidence === null ? '' : `\n    ${finding.evidence}`;
  const prefix = finding.severity === 'warning' ? 'WARNING' : 'VIOLATION';
  return `- ${prefix} [${finding.check}]${where}: ${finding.detail}${quote}`;
}

/**
 * The report as the §14 in-place fix agent sees it, carried in the §18.2 LATEST VERIFICATION EVIDENCE section.
 *
 * It names the check id for every finding so the agent can tell "this is a scope problem" from "this is a test
 * problem" without inferring it from prose, and it states the rule the agent is under: fix the violations, change
 * nothing else.
 */
export function renderPolicyReportForAgent(report: PolicyReport): string {
  const lines = [
    `POLICY REPORT ${report.attempt_id} (${report.phase}) for work package ${report.work_package} in ${report.repo}`,
    `${report.totals.changed_files} changed file(s), +${report.totals.added_lines} -${report.totals.removed_lines} lines`,
    '',
  ];
  if (report.violations.length === 0) {
    lines.push('The diff has no violations.');
  } else {
    lines.push(`${report.violations.length} violation(s) must be removed:`);
    lines.push(...report.violations.map(renderFinding));
  }
  if (report.warnings.length > 0) {
    lines.push('', `${report.warnings.length} warning(s), which do not block the commit:`);
    lines.push(...report.warnings.map(renderFinding));
  }
  lines.push(
    '',
    'Resolve every violation by changing the working tree in place. Do not revert unrelated work, do not run any ' +
      'git command that writes, and do not commit: Janus commits once the re-check passes.',
  );
  return lines.join('\n');
}
