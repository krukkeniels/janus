/**
 * The §14 policy package's public surface.
 *
 * T11 (plan validation and Gate 1) and T12 (the package loop) import from **this module only** — never from
 * `./checks/*` or from `./flow.js` directly — so the internal file layout can change without touching a stage
 * step. T08 wires no stage step of its own: `src/engine/steps.ts` keeps its `executing` placeholder until T12.
 */
export { analyzeDiff, buildDiffAnalysis, changeSummaryFrom, inlineDiffFrom, DiffAnalysisError } from './diff.js';
export type { DiffAnalysis, DiffFile, DiffHunk, DiffLine } from './diff.js';
export { buildPolicyContext } from './context.js';
export type { BuildPolicyContextInput } from './context.js';
export { matchesAnyGlob, matchesGlob } from './glob.js';
export { ALL_POLICY_CHECKS } from './registry.js';
export {
  policyAttemptId,
  policyEvidencePath,
  policyPatchPath,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from './report.js';
export type { RunPolicyChecksInput } from './report.js';
export { buildCommitMessage, commitAndPush, PushRejectedCommitError } from './commit.js';
export type { CommitAndPushInput, CommitAndPushResult, CommitMessageInput } from './commit.js';
export { runPolicyFlow } from './flow.js';
export type { PolicyFixContext, PolicyFixRecord, PolicyFlowInput, PolicyFlowOutcome } from './flow.js';
export { POLICY_CHECK_IDS } from './types.js';
export type {
  PolicyCheck,
  PolicyCheckContext,
  PolicyCheckId,
  PolicyFinding,
  PolicyReport,
  PolicyReportFile,
  PolicySeverity,
} from './types.js';
