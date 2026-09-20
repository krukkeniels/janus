import { checkpoint } from '../state/checkpoint.js';
import type { CheckpointResult } from '../state/checkpoint.js';
import type { DecisionEntry } from '../state/decisions.js';
import type { GoalStatus, InFlight } from '../state/state-schema.js';
import { writeState } from '../state/state-store.js';
import { appendEvent } from '../telemetry/events.js';
import type { RecordedEvent, TelemetryEvent } from '../telemetry/events.js';
import type { Workspace } from '../workspace/open-workspace.js';
import { assertTransition } from './transitions.js';

/** Everything a step or gate needs: the live workspace, a clock, output, telemetry, and checkpoints. */
export interface Engine {
  readonly workspace: Workspace;
  now(): Date;
  log(line: string): void;
  warn(line: string): void;
  emit(event: TelemetryEvent): RecordedEvent;
  /** Spec §7: commits state.yaml, handover.md, evidence, and any decision on the state branch and pushes fast-forward. */
  checkpoint(message: string, decision?: DecisionEntry): Promise<CheckpointResult>;
  /**
   * Spec §7 rule 3: records what the current step has in flight (`agent_run_id`, `repo`, `budget`) and writes
   * `state.yaml` immediately, so a crash before the next checkpoint is recoverable. Steps call this instead of
   * importing `writeState`; the value is merged into the existing `in_flight`.
   */
  markInFlight(patch: Partial<InFlight>): InFlight;
}

export interface CreateEngineInput {
  workspace: Workspace;
  log(line: string): void;
  warn(line: string): void;
  now?: () => Date;
  /** Push every checkpoint (default true). Tests without a reachable state remote may turn it off. */
  push?: boolean;
}

export function createEngine(input: CreateEngineInput): Engine {
  const now = input.now ?? (() => new Date());
  const push = input.push ?? true;
  const { janusDir } = input.workspace.paths;
  return {
    workspace: input.workspace,
    now,
    log: input.log,
    warn: input.warn,
    emit: (event) => appendEvent(janusDir, event, now()),
    checkpoint: (message, decision) =>
      checkpoint({
        janusDir,
        state: input.workspace.state,
        goal: input.workspace.goal,
        message,
        push,
        now: now(),
        ...(decision === undefined ? {} : { decision }),
      }),
    markInFlight: (patch) => {
      const { state } = input.workspace;
      state.execution.in_flight = { ...state.execution.in_flight, ...patch };
      writeState(janusDir, state);
      return state.execution.in_flight;
    },
  };
}

export interface StageTransition {
  from: GoalStatus;
  to: GoalStatus;
  at: string;
}

/** Moves the goal to `to` (spec §9), refusing illegal moves, and records `stage.exited` / `stage.entered` (§27). Does not checkpoint. */
export function enterStage(engine: Engine, to: GoalStatus): StageTransition {
  const { state } = engine.workspace;
  const from = state.goal.status;
  assertTransition(from, to);
  const at = engine.now().toISOString();
  engine.emit({ type: 'stage.exited', stage: from, to });
  state.goal.status = to;
  engine.emit({ type: 'stage.entered', stage: to, from });
  if (to === 'completed') engine.emit({ type: 'goal.completed', goal_id: state.goal.id });
  return { from, to, at };
}
