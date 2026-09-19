import { formatIdentity } from '../git/identity.js';
import type { GitIdentity } from '../git/identity.js';
import { revParse } from '../git/ops.js';
import { GitError } from '../git/run.js';
import type { CheckpointResult } from '../state/checkpoint.js';
import type { GateType, GoalStatus } from '../state/state-schema.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';

/** Gates passed by `janus approve` (spec §26 gates 1 and 2). The others are observed from the SCM provider. */
export const CLI_GATES: readonly GateType[] = ['plan_approval', 'revised_plan_approval'];

export function isCliGate(gate: GateType): boolean {
  return CLI_GATES.includes(gate);
}

/** The goal status the goal waits in while a gate is open. */
export function gateStage(gate: GateType): GoalStatus {
  switch (gate) {
    case 'plan_approval':
    case 'revised_plan_approval':
      return 'awaiting_plan_approval';
    case 'pr_review':
      return 'awaiting_human_review';
    case 'merge':
      return 'awaiting_merge';
  }
}

/** The `janus approve <subcommand>` that passes the gate, or null for SCM-observed gates. */
export function gateCommand(gate: GateType): string | null {
  switch (gate) {
    case 'plan_approval':
      return 'plan';
    case 'revised_plan_approval':
      return 'revised-plan';
    default:
      return null;
  }
}

/** A gate command that cannot apply: wrong gate, wrong commit, unknown exception. Maps to a usage error. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * Spec §7 rule 1: the checkpoint that exists before entry is recorded in `gate.checkpoint_commit`; the entry itself
 * is one more checkpoint, and `janus approve --commit` must name that entry commit (the state-branch HEAD).
 */
export async function enterGate(engine: Engine, gate: GateType): Promise<CheckpointResult> {
  const { state, paths } = engine.workspace;
  const previous = await revParse(paths.janusDir, 'HEAD');
  state.gate = { type: gate, status: 'waiting', entered_at: engine.now().toISOString(), checkpoint_commit: previous };
  engine.emit({ type: 'gate.entered', gate, checkpoint_commit: previous, stage: state.goal.status });
  return engine.checkpoint(`chore(janus): enter gate ${gate}`);
}

interface WaitingGate {
  type: GateType;
  enteredAt: string;
}

function requireWaitingCliGate(engine: Engine, expected: GateType | null): WaitingGate {
  const { state } = engine.workspace;
  const gate = state.gate;
  if (gate.status !== 'waiting' || gate.type === null || !isCliGate(gate.type)) {
    const name = expected ?? 'plan approval';
    throw new GateError(`no ${name} gate is waiting (goal status ${state.goal.status}, gate ${gate.status})`);
  }
  if (expected !== null && gate.type !== expected) {
    throw new GateError(`gate ${gate.type} is waiting, not ${expected}; use: janus approve ${gateCommand(gate.type) ?? '...'} --commit <sha>`);
  }
  return { type: gate.type, enteredAt: gate.entered_at ?? engine.now().toISOString() };
}

function waitedMs(enteredAt: string, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(enteredAt));
}

export interface ApprovePlanInput {
  gate: 'plan_approval' | 'revised_plan_approval';
  commit: string;
  exceptions: string[];
  approver: GitIdentity;
}

export interface ApproveResult {
  commit: string;
  checkpoint: CheckpointResult;
  waitedMs: number;
}

/** Spec §8, §12, §32 rule 14: approval is bound to the exact state-branch commit at which the gate was entered. */
export async function approvePlan(engine: Engine, input: ApprovePlanInput): Promise<ApproveResult> {
  const { state, paths } = engine.workspace;
  const waiting = requireWaitingCliGate(engine, input.gate);
  const head = await revParse(paths.janusDir, 'HEAD');
  let resolved: string;
  try {
    resolved = await revParse(paths.janusDir, input.commit);
  } catch (error) {
    if (error instanceof GitError) throw new GateError(`--commit ${input.commit} is not a commit on the state branch`);
    throw error;
  }
  if (resolved !== head) {
    throw new GateError(
      `--commit ${input.commit} resolves to ${resolved.slice(0, 7)} but the gate was entered at state-branch HEAD ${head.slice(0, 7)}; pass ${head}`,
    );
  }
  const now = engine.now();
  const by = formatIdentity(input.approver);
  for (const id of input.exceptions) {
    const exception = state.baseline.exceptions.find((entry) => entry.id === id);
    if (exception === undefined) throw new GateError(`unknown baseline exception ${id}`);
    exception.approved_by = by;
    exception.approved_at = now.toISOString();
  }
  state.plan.approved = true;
  state.plan.approved_commit = head;
  state.plan.approved_at = now.toISOString();
  if (input.gate === 'plan_approval') state.baseline.approved = true;
  state.gate.status = 'passed';
  const waited = waitedMs(waiting.enteredAt, now);
  engine.emit({ type: 'gate.passed', gate: waiting.type, approver: by, commit: head, waited_ms: waited });
  enterStage(engine, 'executing');
  const title = input.gate === 'plan_approval' ? 'Plan approved' : 'Revised plan approved';
  const exceptionsLine = input.exceptions.length === 0 ? '' : `\n\nExceptions approved: ${input.exceptions.join(', ')}.`;
  const checkpoint = await engine.checkpoint(`chore(janus): approve ${waiting.type} at ${head.slice(0, 7)}`, {
    at: now.toISOString(),
    by,
    title,
    body: `Approved state-branch commit ${head}.${exceptionsLine}`,
  });
  return { commit: head, checkpoint, waitedMs: waited };
}

export interface RejectPlanInput {
  reason: string;
  approver: GitIdentity;
}

export interface RejectResult {
  to: GoalStatus;
  checkpoint: CheckpointResult;
  waitedMs: number;
}

/** Sends Gate 1 back to `planning` and Gate 2 back to `replanning`, recording the reason. */
export async function rejectPlan(engine: Engine, input: RejectPlanInput): Promise<RejectResult> {
  const { state } = engine.workspace;
  const waiting = requireWaitingCliGate(engine, null);
  const now = engine.now();
  const by = formatIdentity(input.approver);
  const to: GoalStatus = waiting.type === 'plan_approval' ? 'planning' : 'replanning';
  const waited = waitedMs(waiting.enteredAt, now);
  state.gate = { type: null, status: 'none', entered_at: null, checkpoint_commit: null };
  engine.emit({ type: 'gate.rejected', gate: waiting.type, approver: by, reason: input.reason, waited_ms: waited });
  enterStage(engine, to);
  const checkpoint = await engine.checkpoint(`chore(janus): reject ${waiting.type}`, {
    at: now.toISOString(),
    by,
    title: 'Plan rejected',
    body: `${input.reason}\n\nGate ${waiting.type}; goal returns to ${to}.`,
  });
  return { to, checkpoint, waitedMs: waited };
}
