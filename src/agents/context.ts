import type { AgentRole } from '../config/config-schema.js';

/**
 * One line of the §18.2 CHANGE SUMMARY: "file list with added/removed line counts; lockfiles and generated files
 * listed but never inlined".
 *
 * T08 (diff analysis) produces these from the working-tree diff and sets `generated` for lockfiles and build
 * output; T05 only renders them and refuses an inline diff that still contains a generated file.
 */
export interface ChangeSummaryEntry {
  path: string;
  added: number;
  removed: number;
  generated: boolean;
}

/**
 * The variable half of a §18.2 context package: what the caller knows about this particular task. The fixed
 * blocks (guardrails, Angular guidance, budget, output contract) are filled in by `buildAgentTask` so a caller
 * cannot accidentally ship a prompt without them.
 *
 * Every field is required so a caller must decide; `null` means "this section has nothing to say" and renders as
 * a `(none)` body, which is information the model needs.
 */
export interface ContextPackageInput {
  /** §18.2 GOAL. */
  goal: string;
  /** §18.2 REPOSITORY: name, kind, dependencies, coupled repos, base branch, prerelease versions to pin. */
  repository: string | null;
  /** §18.2 APPROVED PLAN SLICE. */
  planSlice: string | null;
  /** §18.2 CURRENT STATE (relevant subset only — never the whole `state.yaml`). */
  currentState: string | null;
  /** §18.2 CHANGE SUMMARY. */
  changeSummary: ChangeSummaryEntry[];
  /** §18.2 INLINE DIFF. Ignored for every class but code-writing. Must not contain generated files. */
  inlineDiff: string | null;
  /** §18.2 LATEST VERIFICATION EVIDENCE (digest or build refs). Produced by T09. */
  verificationEvidence: string | null;
  /** §18.2 PREVIOUS ATTEMPTS: "summaries only" — one paragraph each (§16.4), never a previous agent's reasoning. */
  previousAttempts: string[];
  /** §18.2 KNOWN BASELINE EXCEPTIONS. */
  baselineExceptions: string[];
}

/** A complete §18.2 context package: the caller's input plus the blocks Janus always supplies. */
export interface ContextPackage extends ContextPackageInput {
  role: AgentRole;
  /** §18.2 GUARDRAILS AND FORBIDDEN ACTIONS: §19's "may not" list plus the repo's configured limits. */
  guardrails: string[];
  /** §18.2 ANGULAR GUIDANCE (package manager, `ng update` flags, migration expectations). */
  angularGuidance: string;
  /** §18.2 BUDGET: the counters and limits this attempt runs under (§20). */
  budget: string;
  /** §18.2 OUTPUT CONTRACT: the role's result fields, rendered from its schema. */
  outputContract: string;
}
