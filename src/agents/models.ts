import { AGENT_EFFORTS } from '../config/config-schema.js';
import type { AgentRole, Effort, JanusConfig } from '../config/config-schema.js';
import type { ResolvedModel } from './types.js';

export class ModelProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProfileError';
  }
}

function isEffort(value: string): value is Effort {
  return (AGENT_EFFORTS as readonly string[]).includes(value);
}

/**
 * Spec §18.6's ladder entries are opaque model strings that may encode a reasoning effort, as in
 * `gpt-5.6-sol:xhigh`.
 *
 * The split is at the **last** colon, and only when what follows it is exactly one of the five efforts. That
 * keeps a namespaced id like `vendor/model:tag` intact, keeps `vendor:model` meaning a model, and still lets
 * `vendor:model:high` mean "model `vendor:model` at high effort". A leading colon leaves an empty prefix, so the
 * whole string is taken as the model.
 */
export function parseLadderEntry(entry: string, fallback: Effort): { model: string; effort: Effort } {
  const colon = entry.lastIndexOf(':');
  if (colon > 0) {
    const suffix = entry.slice(colon + 1);
    if (isEffort(suffix)) return { model: entry.slice(0, colon), effort: suffix };
  }
  return { model: entry, effort: fallback };
}

export interface ResolveModelInput {
  config: JanusConfig;
  /** `--model-profile` or `workflow_models.profile`. */
  profile: string;
  role: AgentRole;
  /** 1-based attempt within the current failure. */
  attempt: number;
}

/**
 * Spec §18.6: "For roles with a ladder, attempt `n` uses ladder entry `min(n, len-1)`."
 *
 * Janus counts attempts 1-based, so `n` here is `attempt - 1`: attempt 1 uses entry 0. Read the other way, entry 0
 * of a two-entry ladder would never run, which would defeat the cheap-first ladder the spec's own example shows.
 */
export function resolveModel(input: ResolveModelInput): ResolvedModel {
  const profile = input.config.model_profiles[input.profile];
  if (profile === undefined) {
    throw new ModelProfileError(`model profile "${input.profile}" is not defined in config.yaml model_profiles`);
  }
  const spec = profile[input.role] ?? profile['*'];
  if (spec === undefined) {
    throw new ModelProfileError(
      `model profile "${input.profile}" has no entry for role "${input.role}" and no "*" entry`,
    );
  }
  const ladder = spec.ladder;
  if (ladder === undefined || ladder.length === 0) {
    return { model: spec.model, effort: spec.effort, ladderIndex: null, ladderLength: null };
  }
  const index = Math.min(Math.max(input.attempt, 1) - 1, ladder.length - 1);
  const entry = ladder[index];
  if (entry === undefined) {
    throw new ModelProfileError(`ladder for role "${input.role}" in profile "${input.profile}" has no entry ${index}`);
  }
  const parsed = parseLadderEntry(entry, spec.effort);
  return { model: parsed.model, effort: parsed.effort, ladderIndex: index, ladderLength: ladder.length };
}

/**
 * Spec §18.6: a ladder step is recorded as `model_switch` "so no-progress detection can distinguish 'same model,
 * same failure' from 'new model, same failure'". Switching never adds budget — nothing in this module or in
 * `runAgent` touches `execution.budgets`.
 */
export function isModelSwitch(previous: ResolvedModel | null, next: ResolvedModel): boolean {
  if (previous === null) return false;
  return previous.model !== next.model || previous.effort !== next.effort;
}
