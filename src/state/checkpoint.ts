import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Goal } from '../config/goal-schema.js';
import { commitAll, push, PushRejectedError } from '../git/ops.js';
import { renderHandover } from '../render/handover.js';
import { appendDecision } from './decisions.js';
import type { DecisionEntry } from './decisions.js';
import { HANDOVER_FILE } from './files.js';
import type { JanusState } from './state-schema.js';
import { writeState } from './state-store.js';

export class StateBranchDivergedError extends Error {
  constructor(branch: string, remote: string) {
    super(`state branch ${branch} on ${remote} has moved; fetch and reconcile .janus/ before running again`);
    this.name = 'StateBranchDivergedError';
  }
}

export interface CheckpointInput {
  janusDir: string;
  state: JanusState;
  goal: Goal;
  message: string;
  push: boolean;
  decision?: DecisionEntry;
  now?: Date;
}

export interface CheckpointResult {
  commit: string;
  pushed: boolean;
}

/**
 * Spec §7: writes state.yaml and handover.md, appends any decision, commits on the state branch, and pushes fast-forward only.
 *
 * Mutates `input.state` in place (sets `telemetry.last_updated_at`) so the caller's object stays identical to what was
 * written; the in-memory state is the live runtime state, never a snapshot.
 */
export async function checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
  const now = input.now ?? new Date();
  input.state.telemetry.last_updated_at = now.toISOString();
  writeState(input.janusDir, input.state);
  writeFileSync(join(input.janusDir, HANDOVER_FILE), renderHandover(input.state, input.goal, now));
  if (input.decision) {
    appendDecision(input.janusDir, input.decision);
  }
  // allowEmpty: a checkpoint is a durable "we were here" marker even when nothing but the timestamp changed.
  const commit = await commitAll(input.janusDir, input.message, { allowEmpty: true });
  if (!input.push) {
    return { commit, pushed: false };
  }
  try {
    // Always the git remote `origin`; `state_branch.remote` is the human-facing label recorded in state.yaml.
    await push(input.janusDir, 'origin', input.state.state_branch.name, { setUpstream: true });
  } catch (error) {
    if (error instanceof PushRejectedError) {
      throw new StateBranchDivergedError(input.state.state_branch.name, input.state.state_branch.remote);
    }
    throw error;
  }
  return { commit, pushed: true };
}
