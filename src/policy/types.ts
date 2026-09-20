import type { JanusConfig } from '../config/config-schema.js';
import type { ChangeStatus } from '../git/tree.js';
import type { DiffAnalysis } from './diff.js';

/**
 * Spec §14's policy-check table, one stable id per row, plus the §12 lockfile warning `tasks.md` T08 asks for.
 *
 * The ids are machine-readable and permanent: they land in `evidence/policy/<attempt-id>.yaml`, in the
 * `policy.checked` telemetry event, and in the report a fix agent reads, so `janus telemetry` (T21) can count
 * "how often did scope violations cost us an attempt" across goals. Renaming one is a breaking change to the
 * evidence trail.
 */
export const POLICY_CHECK_IDS = [
  'tests.forbidden_pattern_added',
  'tests.file_removed',
  'tests.count_decreased',
  'paths.forbidden',
  'runner_config.weakened',
  'angular.version_beyond_target',
  'scope.outside_allowed',
  'size.limits',
  'secrets.detected',
  'lockfile.scope',
] as const;

export type PolicyCheckId = (typeof POLICY_CHECK_IDS)[number];

/**
 * A violation blocks the commit and, once the in-place fix attempt has failed, charges `policy_violations`
 * (§20). A warning does neither: it is recorded on the report, printed at commit time, and shown to the fix
 * agent, because §12's lockfile note is worth saying and is not grounds to refuse a diff.
 */
export type PolicySeverity = 'violation' | 'warning';

export interface PolicyFinding {
  check: PolicyCheckId;
  severity: PolicySeverity;
  /** The repo-relative path the finding is about, or null for a whole-diff finding such as `size.limits`. */
  path: string | null;
  /** Line number in the **new** file for an added-line finding, in the old file for a removed-line one; else null. */
  line: number | null;
  detail: string;
  /**
   * The offending source line, when quoting it helps a fix agent. **Always null for `secrets.detected`**
   * (§32 rule 12: secrets never enter evidence) — that finding names the pattern and the location instead.
   */
  evidence: string | null;
}

interface FindingExtras {
  path?: string;
  line?: number;
  evidence?: string;
}

function finding(check: PolicyCheckId, severity: PolicySeverity, detail: string, extras: FindingExtras): PolicyFinding {
  return {
    check,
    severity,
    path: extras.path ?? null,
    line: extras.line ?? null,
    detail,
    evidence: extras.evidence ?? null,
  };
}

export function violation(check: PolicyCheckId, detail: string, extras: FindingExtras = {}): PolicyFinding {
  return finding(check, 'violation', detail, extras);
}

export function warning(check: PolicyCheckId, detail: string, extras: FindingExtras = {}): PolicyFinding {
  return finding(check, 'warning', detail, extras);
}

/** One row of the report's file table; snake_case because it is serialised straight to YAML evidence. */
export interface PolicyReportFile {
  path: string;
  status: ChangeStatus;
  previous_path: string | null;
  added: number;
  removed: number;
  binary: boolean;
  /** §18.2: lockfiles and build output. Listed in CHANGE SUMMARY, never inlined into a prompt. */
  generated: boolean;
}

/**
 * Spec §14 step 4: "writes `evidence/policy/<attempt-id>.yaml`". Written for **every** check run, pass or fail —
 * §31.25 requires that "every diff is policy-checked before commit; violations are evidenced", and a passing
 * report is the only durable proof the check ran at all.
 *
 * snake_case throughout, matching `AgentEvidence` in `src/agents/evidence.ts`, because this shape *is* the YAML.
 */
export interface PolicyReport {
  attempt_id: string;
  work_package: string;
  repo: string;
  /** The code-writing agent run whose diff this is, or null when the orchestrator checked a tree it did not ask for. */
  run_id: string | null;
  /** `initial` is the check after the code-writing agent; `recheck` is the one after the in-place fix agent (§14). */
  phase: 'initial' | 'recheck';
  checked_at: string;
  files: PolicyReportFile[];
  totals: { changed_files: number; added_lines: number; removed_lines: number };
  /** The check ids that actually ran. A check whose inputs were absent (no `allowed_scope` yet) is not listed. */
  checks_run: PolicyCheckId[];
  violations: PolicyFinding[];
  warnings: PolicyFinding[];
  /** `violations.length === 0`. Stored rather than derived so a reader of the YAML does not have to compute it. */
  passed: boolean;
}

/**
 * What one check is allowed to look at.
 *
 * `analysis` is derived from the git tree, never from an agent's `changes_made` — during the T06 prompt spike an
 * agent reported two changed files when the tree had three, and another reported two when the tree had one. A
 * check that trusted a self-report would pass a diff that touches `.github/` because the agent forgot to mention
 * it.
 *
 * `readHead` and `readWorking` are seams so `tests/policy/*.test.ts` can supply fixture file contents without a
 * git repository, the same way `DoctorCheckContext` seams out every process, filesystem and network call.
 */
export interface PolicyCheckContext {
  analysis: DiffAnalysis;
  config: JanusConfig;
  /** `goal.target_version` parsed as a number (§14 "Angular version beyond target"). */
  targetVersion: number;
  /** The work package's `allowed_scope` from `plan.yaml` (§12), or null before a plan is approved. */
  allowedScope: readonly string[] | null;
  /** §14: deleting a test file is a violation "unless the package allows it". Defaults to `policy.allow_test_file_deletion`. */
  allowTestFileDeletion: boolean;
  /** Contents of `path` at HEAD, or null when the file did not exist there. */
  readHead(path: string): Promise<string | null>;
  /** Contents of `path` in the working tree, or null when it was deleted. */
  readWorking(path: string): Promise<string | null>;
}

export interface PolicyCheck {
  id: PolicyCheckId;
  /** One short human-readable line, printed in the report rendering a fix agent reads. */
  title: string;
  /**
   * Returns every finding this check makes, or an empty array. A check that cannot run because its inputs are
   * absent returns `null` so `runPolicyChecks` can leave it out of `checks_run` — "did not run" and "found
   * nothing" are different facts, and an evidence file that conflates them is misleading.
   */
  run(ctx: PolicyCheckContext): Promise<PolicyFinding[] | null>;
}
