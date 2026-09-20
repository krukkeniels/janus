import { z } from 'zod';
import { AGENT_ROLES } from '../config/config-schema.js';
import type { AgentRole } from '../config/config-schema.js';
import { formatZodIssues } from '../config/errors.js';
import { toCodexJsonSchema } from './json-schema.js';
import type { JsonSchema } from './json-schema.js';

/**
 * Spec §18.3: the minimum shape every role answers with. Every property is required — §14: "Codex strict schemas
 * require every property to be present, so role schemas list all fields as required and use `null` for 'not
 * applicable'". That is why nothing here uses `.optional()` or `.default()`: a missing property must be a
 * validation failure (one failed attempt, §18.3), never a silently filled-in value.
 *
 * `predicted_failures` is the one nullable field in the base shape, because §18.3 marks it conditional: "test
 * identities, when `expected_temporary_failure` is true".
 */
export const baseResultSchema = z
  .object({
    status: z.enum(['completed', 'blocked', 'failed']),
    summary: z.string(),
    changes_made: z.array(z.string()),
    findings: z.array(z.string()),
    evidence: z.array(z.string()),
    new_tasks: z.array(z.string()),
    expected_temporary_failure: z.boolean(),
    predicted_failures: z.array(z.string()).nullable(),
    plan_change_required: z.boolean(),
    architecture_change_required: z.boolean(),
    behavior_change_required: z.boolean(),
    recommended_next_action: z.string(),
    handover: z
      .object({ current_state: z.string(), next_action: z.string(), risks: z.array(z.string()) })
      .strict(),
  })
  .strict();

export type AgentResult = z.infer<typeof baseResultSchema>;

/**
 * Spec §22: "Findings are structured (repo, file, severity, category, description, suggested action)."
 * §22 names `severity` but not its vocabulary; the four values below are this task's placeholder, not a spec
 * quote. T13 owns the review-findings loop and will confirm (or replace) them when it lands.
 */
const reviewFindingSchema = z
  .object({
    repo: z.string(),
    file: z.string(),
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    category: z.string(),
    description: z.string(),
    suggested_action: z.string(),
  })
  .strict();

/**
 * Role schemas: the base shape plus the fields the spec names for that role's stage.
 *
 * This is a full `Record`, not a partial one with a `??` fallback: every one of the twelve `AGENT_ROLES` (task 1,
 * `003cb68`) is listed explicitly, the eight roles without extra fields spelled out as `baseResultSchema`. That
 * makes the mapping exhaustive by type — a thirteenth role added to `AGENT_ROLES` fails to compile here rather than
 * silently falling back to the base shape, mirroring `ROLE_CLASSES` in `./roles.js`.
 *
 * T13 owns the review-findings loop and the fix agent's `no_change_needed` reply; T05 only fixes their shape so
 * the stage that consumes them does not have to renegotiate the contract with the model.
 */
export const ROLE_RESULT_SCHEMAS: Readonly<Record<AgentRole, z.ZodObject<z.ZodRawShape>>> = {
  discovery: baseResultSchema,
  integration_discovery: baseResultSchema,
  planning: baseResultSchema,
  replanning: baseResultSchema,
  implementation: baseResultSchema,
  debug: baseResultSchema,
  /** §24: "the fix agent may answer `no_change_needed` with a rationale". The rationale is `summary`. */
  fix: baseResultSchema.extend({ no_change_needed: z.boolean() }),
  sync_conflict: baseResultSchema,
  /** §21: the AI checkpoint's four outcomes, mirrored by `execution.work_packages.*.checkpoint.outcome`. */
  checkpoint: baseResultSchema.extend({
    outcome: z.enum(['PASS', 'CONTINUE_WITH_REFINED_TASKS', 'REGROUP_VERIFICATION', 'ESCALATE']),
  }),
  /** §22: structured findings instead of free-text lines. */
  review: baseResultSchema.extend({ findings: z.array(reviewFindingSchema) }),
  /** §17: "returns the most likely repo and a rationale" and is escalated when confidence is below medium. */
  triage: baseResultSchema.extend({
    suspect_repo: z.string().nullable(),
    confidence: z.enum(['low', 'medium', 'high']),
    rationale: z.string(),
  }),
  qa: baseResultSchema,
};

export function resultSchemaFor(role: AgentRole): z.ZodObject<z.ZodRawShape> {
  return ROLE_RESULT_SCHEMAS[role];
}

/** The JSON Schema for `codex exec --output-schema`, generated from the zod schema so the two cannot drift. */
export function outputSchemaFor(role: AgentRole): JsonSchema {
  return toCodexJsonSchema(resultSchemaFor(role), `janus-${role}-result`);
}

export type ValidationOutcome = { ok: true; result: AgentResult } | { ok: false; errors: string[] };

/**
 * Spec §18.3: "Invalid output is one failed attempt; the validation error is included in the retry context."
 * The `errors` strings are what the caller puts into PREVIOUS ATTEMPTS on the next try.
 */
export function validateAgentResult(role: AgentRole, raw: unknown): ValidationOutcome {
  const parsed = resultSchemaFor(role).safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatZodIssues(parsed.error) };
  return { ok: true, result: parsed.data as AgentResult };
}

/** §24: the `fix` role's extra field. Declared as a type so callers of the fix flow do not hand-roll a cast. */
export interface FixAgentResult extends AgentResult {
  no_change_needed: boolean;
}

/**
 * Narrows a validated result to the `fix` shape, or null when it is not one.
 *
 * `runAgent` returns `AgentResult`, which is the base §18.3 shape; the fix role's schema is the one that adds
 * `no_change_needed`, so the only honest way back to it is to re-validate against that schema. Cheap, and it
 * means a fake runner that was scripted with the wrong shape is caught here rather than read as `false`.
 */
export function asFixResult(result: AgentResult | null): FixAgentResult | null {
  if (result === null) return null;
  const parsed = ROLE_RESULT_SCHEMAS.fix.safeParse(result);
  return parsed.success ? (parsed.data as FixAgentResult) : null;
}

/** Every role has a schema that converts; called by the tests and by `janus doctor` (T07). */
export function allOutputSchemas(): Record<AgentRole, JsonSchema> {
  const out = {} as Record<AgentRole, JsonSchema>;
  for (const role of AGENT_ROLES) out[role] = outputSchemaFor(role);
  return out;
}
