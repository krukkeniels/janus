import { z } from 'zod';
import { ConfigError, formatZodIssues } from '../config/errors.js';
import { readYamlFile } from '../config/yaml.js';
import type { ContextPackageInput } from './context.js';

const changeSummaryEntrySchema = z
  .object({
    path: z.string().min(1),
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    generated: z.boolean().default(false),
  })
  .strict();

/**
 * The `--task FILE` a human writes for `janus agent run`: the variable half of a §18.2 context package plus the
 * repo, the attempt, and the two blocks that depend on the stage. Everything else — class, sandbox, roots,
 * timeout, model, schema, prompt version, and the fixed guardrail and Angular blocks — is filled in by
 * `buildAgentTask`, so a hand-written task file cannot produce a prompt the engine would not.
 */
export const agentTaskFileSchema = z
  .object({
    repo: z.string().min(1).nullable().default(null),
    attempt: z.number().int().positive().default(1),
    guardrails: z.array(z.string().min(1)).default([]),
    budget: z.string().default('(not tracked for a manual run)'),
    context: z
      .object({
        goal: z.string().min(1),
        repository: z.string().nullable().default(null),
        plan_slice: z.string().nullable().default(null),
        current_state: z.string().nullable().default(null),
        change_summary: z.array(changeSummaryEntrySchema).default([]),
        inline_diff: z.string().nullable().default(null),
        verification_evidence: z.string().nullable().default(null),
        previous_attempts: z.array(z.string()).default([]),
        baseline_exceptions: z.array(z.string()).default([]),
      })
      .strict(),
  })
  .strict();

export type AgentTaskFile = z.infer<typeof agentTaskFileSchema>;

/** The file's snake_case sections, as the camelCase `ContextPackageInput` the builder takes. */
export function contextInputFrom(file: AgentTaskFile): ContextPackageInput {
  return {
    goal: file.context.goal,
    repository: file.context.repository,
    planSlice: file.context.plan_slice,
    currentState: file.context.current_state,
    changeSummary: file.context.change_summary,
    inlineDiff: file.context.inline_diff,
    verificationEvidence: file.context.verification_evidence,
    previousAttempts: file.context.previous_attempts,
    baselineExceptions: file.context.baseline_exceptions,
  };
}

export function loadAgentTaskFile(path: string): AgentTaskFile {
  const parsed = agentTaskFileSchema.safeParse(readYamlFile(path));
  if (!parsed.success) throw new ConfigError(path, formatZodIssues(parsed.error));
  return parsed.data;
}
