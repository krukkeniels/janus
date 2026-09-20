import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentRole } from '../config/config-schema.js';
import { EVENTS_FILE } from '../state/files.js';
import type { BudgetName, GateType, GoalStatus } from '../state/state-schema.js';

/**
 * Spec §27's event list, as a union discriminated on `type`.
 *
 * **Adding an event type in a later task takes three edits, all in this file:** declare an exported interface whose
 * `type` is a string literal, add it to the `TelemetryEvent` union below, and add its literal to `EVENT_TYPES`.
 * `UnlistedEventType` fails to compile if the third edit is forgotten. Never widen a member with an index
 * signature: that would defeat the discriminant for every other member.
 */

/** Why `janus run` stopped. Declared here rather than in `run-loop.ts` so `run.stopped` and the run loop cannot drift. */
export type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented';

/** Every counter a guardrail can name (spec §20): the seven budgets, per-package `policy_violations`, and the goal runtime. */
export type GuardrailName = BudgetName | 'policy_violations' | 'goal_runtime_hours';

/** Codex `turn.completed.usage` (§18.4), normalized. `reasoning` is null when the model did not report it. */
export interface AgentTokenUsage {
  input: number;
  cached_input: number;
  output: number;
  reasoning: number | null;
  total: number;
}

export interface RunStartedEvent {
  type: 'run.started';
  pid: number;
  status: GoalStatus;
  until: GoalStatus | null;
  max_wait_ms: number;
  model_profile: string;
}

export interface RunStoppedEvent {
  type: 'run.stopped';
  reason: RunStopReason;
  status: GoalStatus;
  steps: number;
}

export interface GoalCreatedEvent {
  type: 'goal.created';
  goal_id: string;
  repos: string[];
}

export interface GoalCompletedEvent {
  type: 'goal.completed';
  goal_id: string;
}

export interface StageEnteredEvent {
  type: 'stage.entered';
  stage: GoalStatus;
  from: GoalStatus;
}

export interface StageExitedEvent {
  type: 'stage.exited';
  stage: GoalStatus;
  to: GoalStatus;
}

/** Spec §27: role, repo, run_id, model, effort, prompt_version, profile, experiment_id, tokens, duration, status. */
export interface AgentStartedEvent {
  type: 'agent.started';
  run_id: string;
  role: AgentRole;
  repo: string | null;
  model: string;
  effort: string;
  prompt_version: string;
  profile: string;
  experiment_id: string | null;
  /** 1-based attempt within the current failure; drives the §18.6 ladder. */
  attempt: number;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  network: boolean;
}

/**
 * Every dimension is present; the ones an interrupted run never learned are `null`.
 *
 * `status: 'interrupted'` is emitted by `recoverInFlight` (§7 rule 3) for a run whose process died with the
 * orchestrator; it is not a §18.3 status, which is why the field is widened rather than `AgentResult['status']`.
 */
export interface AgentFinishedEvent {
  type: 'agent.finished';
  run_id: string;
  role: AgentRole | null;
  repo: string | null;
  status: 'completed' | 'blocked' | 'failed' | 'interrupted';
  model: string | null;
  effort: string | null;
  prompt_version: string | null;
  profile: string | null;
  experiment_id: string | null;
  tokens: AgentTokenUsage | null;
  duration_ms: number | null;
  /** Process exit code; null for a signal, a spawn failure, an interrupted run, or the fake runner. Without this
   * a non-zero exit alongside a still-valid answer (§18.3: not a failure) is invisible in the event stream and
   * survives only in the evidence YAML. */
  exit_code: number | null;
  /** §18.4 adapter failure kind; null when the run produced a valid §18.3 result. */
  failure: 'timeout' | 'nonzero_exit' | 'invalid_output' | 'spawn_failed' | 'interrupted' | null;
  /** Interrupted runs only: the step that was in flight and the `.janus`-relative saved patch. */
  step: string | null;
  patch: string | null;
}

/** Spec §18.6: a ladder step, so no-progress detection can tell "same model, same failure" from "new model, same failure". */
export interface AgentModelSwitchEvent {
  type: 'agent.model_switch';
  run_id: string;
  role: AgentRole;
  repo: string | null;
  attempt: number;
  from_model: string;
  from_effort: string;
  to_model: string;
  to_effort: string;
  ladder_index: number;
  profile: string;
  experiment_id: string | null;
  /** §18.6: "Switching models never adds budget." Recorded in the log so the guarantee is auditable. */
  budget_added: false;
}

export interface BudgetIncrementedEvent {
  type: 'budget.incremented';
  budget: GuardrailName;
  value: number;
  limit: number;
  reason: string;
  /** Present only for the per-package `policy_violations` counter. */
  work_package?: string;
  repo?: string;
}

export interface BudgetResetEvent {
  type: 'budget.reset';
  budget: BudgetName;
  previous: number;
  reason: string;
}

export interface GuardrailHitEvent {
  type: 'guardrail.hit';
  guardrail: GuardrailName;
  value: number;
  limit: number;
  detail: string;
}

export interface GateEnteredEvent {
  type: 'gate.entered';
  gate: GateType;
  checkpoint_commit: string;
  stage: GoalStatus;
}

export interface GatePassedEvent {
  type: 'gate.passed';
  gate: GateType;
  approver: string;
  commit: string;
  waited_ms: number;
}

/**
 * `gate` is nullable because `escalate` clears a waiting gate whose `state.gate.type` is typed `GateType | null`;
 * making the field non-null would force a guard there that could leave a gate stuck in `waiting`.
 */
export interface GateRejectedEvent {
  type: 'gate.rejected';
  gate: GateType | null;
  reason: string;
  waited_ms: number;
  approver?: string;
}

export interface EscalationCreatedEvent {
  type: 'escalation.created';
  reason: string;
  stage: GoalStatus;
  repo: string | null;
  work_package: string | null;
}

export interface RepoDriftEvent {
  type: 'repo.drift';
  repo: string;
  local_drift: 'none' | 'fast_forward' | 'non_fast_forward' | 'missing';
  remote: 'absent' | 'in_sync' | 'ahead_fast_forwarded' | 'behind' | 'diverged';
  base_moved: boolean;
  recorded_head: string | null;
  head: string | null;
  remote_base: string;
}

export type TelemetryEvent =
  | RunStartedEvent
  | RunStoppedEvent
  | GoalCreatedEvent
  | GoalCompletedEvent
  | StageEnteredEvent
  | StageExitedEvent
  | AgentStartedEvent
  | AgentFinishedEvent
  | AgentModelSwitchEvent
  | BudgetIncrementedEvent
  | BudgetResetEvent
  | GuardrailHitEvent
  | GateEnteredEvent
  | GatePassedEvent
  | GateRejectedEvent
  | EscalationCreatedEvent
  | RepoDriftEvent;

export type EventType = TelemetryEvent['type'];

/**
 * Every type this version can emit. `janus doctor` (T07) and `janus telemetry` (T21) read it instead of a literal
 * list. `as const satisfies` is load-bearing: `as const` keeps the element type a union of literals so
 * `UnlistedEventType` below can compare it against the union, and `satisfies` still rejects a typo'd name.
 */
export const EVENT_TYPES = [
  'run.started',
  'run.stopped',
  'goal.created',
  'goal.completed',
  'stage.entered',
  'stage.exited',
  'agent.started',
  'agent.finished',
  'agent.model_switch',
  'budget.incremented',
  'budget.reset',
  'guardrail.hit',
  'gate.entered',
  'gate.passed',
  'gate.rejected',
  'escalation.created',
  'repo.drift',
] as const satisfies readonly EventType[];

type AssertNever<T extends never> = T;

/** Compile-time proof that `EVENT_TYPES` lists every union member. Adding a member without listing it fails here. */
export type UnlistedEventType = AssertNever<Exclude<EventType, (typeof EVENT_TYPES)[number]>>;

export type RecordedEvent = TelemetryEvent & { timestamp: string };

/** Appends one event as a JSON line under `.janus/telemetry/`. Telemetry never controls correctness (spec §27). */
export function appendEvent(janusDir: string, event: TelemetryEvent, now: Date = new Date()): RecordedEvent {
  const path = join(janusDir, EVENTS_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const recorded = { timestamp: now.toISOString(), ...event } as RecordedEvent;
  appendFileSync(path, `${JSON.stringify(recorded)}\n`);
  return recorded;
}

/**
 * Reads the log back. The cast is deliberate and unchecked: a log written by a newer Janus may hold a `type` this
 * version does not know, and telemetry must never be the reason a run fails. Consumers narrow on `type` and ignore
 * what they do not recognize.
 */
export function readEvents(janusDir: string): RecordedEvent[] {
  const path = join(janusDir, EVENTS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedEvent);
}
