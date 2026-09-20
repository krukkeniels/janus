import { revParse } from '../git/ops.js';
import type { Providers } from '../providers/types.js';
import { emptyInFlight } from '../state/state-schema.js';
import type { GoalStatus } from '../state/state-schema.js';
import type { Workspace } from '../workspace/open-workspace.js';
import { checkGoalRuntime } from './budgets.js';
import { enterStage } from './engine.js';
import type { Engine } from './engine.js';
import { escalate } from './escalate.js';
import { enterGate, gateCommand, gateStage, isCliGate } from './gates.js';
import { describeDrift, reconcileRepos } from './reconcile.js';
import { recoverInFlight } from './recover.js';
import type { StepContext, StepRegistry } from './steps.js';
import { HAPPY_PATH } from './transitions.js';

export type RunStopReason = 'completed' | 'gate' | 'wait_exceeded' | 'escalated' | 'until' | 'not_implemented';

export interface RunEngineInput {
  engine: Engine;
  steps: StepRegistry;
  until: GoalStatus | null;
  maxWaitMs: number;
  modelProfile: string;
  providers: Providers;
  /** Safety net against a step that answers `stay` forever (default 1000). */
  maxSteps?: number;
}

export interface RunResult {
  reason: RunStopReason;
  status: GoalStatus;
  /** State-branch HEAD when the run stopped. */
  stateCommit: string;
  message: string;
  /** The task that will implement the stopping step, for `not_implemented`. */
  task: string | null;
  steps: number;
}

const ESCALATED_MESSAGE = 'goal is escalated; read .janus/escalation.md and run: janus escalation resolve --direction "..."';

/**
 * Spec §8 run model: recover an interrupted step (§7 rule 3), reconcile repo heads (§7 rule 2), then run stage steps,
 * each bracketed by `in_flight` and ended by a checkpoint, until a human gate, an exceeded wait, an escalation,
 * `--until`, a placeholder, or completion.
 */
export async function runEngine(input: RunEngineInput): Promise<RunResult> {
  const { engine, steps } = input;
  const { state, paths } = engine.workspace;
  const maxSteps = input.maxSteps ?? 1000;
  let executed = 0;
  engine.emit({
    type: 'run.started',
    pid: process.pid,
    status: state.goal.status,
    until: input.until,
    max_wait_ms: input.maxWaitMs,
    model_profile: input.modelProfile,
  });
  const stop = async (reason: RunStopReason, message: string, task: string | null = null): Promise<RunResult> => {
    engine.emit({ type: 'run.stopped', reason, status: state.goal.status, steps: executed });
    const stateCommit = await revParse(paths.janusDir, 'HEAD');
    return { reason, status: state.goal.status, stateCommit, message, task, steps: executed };
  };

  const recovery = await recoverInFlight(engine);
  if (recovery !== null) await engine.checkpoint(`chore(janus): recover interrupted step ${recovery.step}`);

  if (state.goal.status !== 'escalated' && state.goal.status !== 'completed') {
    const reconciled = await reconcileRepos(engine);
    const first = reconciled.escalations[0];
    if (first !== undefined) {
      await escalate(engine, {
        reason: `goal branch drift cannot be fast-forwarded: ${reconciled.escalations.map(describeDrift).join('; ')}`,
        repo: first.repo,
        guardrail: null,
      });
      return stop('escalated', ESCALATED_MESSAGE);
    }
    if (reconciled.changed) await engine.checkpoint('chore(janus): adopt fast-forwarded goal branch heads');
  }

  const ctx: StepContext = { engine, maxWaitMs: input.maxWaitMs, modelProfile: input.modelProfile, providers: input.providers };
  for (;;) {
    const status = state.goal.status;
    if (status === 'completed') return stop('completed', `goal ${state.goal.id} is completed`);
    if (status === 'escalated') return stop('escalated', ESCALATED_MESSAGE);
    const runtimeHit = checkGoalRuntime({ state, config: engine.workspace.config, emit: engine.emit }, engine.now());
    if (runtimeHit !== null) {
      await escalate(engine, { reason: `goal runtime exceeded: ${runtimeHit.detail}`, repo: null, guardrail: runtimeHit });
      return stop('escalated', ESCALATED_MESSAGE);
    }
    if (state.gate.status === 'waiting' && state.gate.type !== null && isCliGate(state.gate.type)) {
      const head = await revParse(paths.janusDir, 'HEAD');
      return stop('gate', `waiting at gate ${state.gate.type}; approve with: janus approve ${gateCommand(state.gate.type) ?? ''} --commit ${head}`);
    }
    if (input.until !== null && status === input.until) return stop('until', `reached stage ${status} (--until)`);
    if (executed >= maxSteps) throw new Error(`run loop executed ${maxSteps} steps without stopping; giving up`);
    const step = steps[status];
    if (step === undefined) throw new Error(`no step registered for stage ${status}`);

    engine.markInFlight({ ...emptyInFlight(), step: step.name, started_at: engine.now().toISOString() });
    const outcome = await step.run(ctx);
    executed += 1;
    state.execution.in_flight = emptyInFlight();

    switch (outcome.kind) {
      case 'advance':
        enterStage(engine, outcome.to);
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        break;
      case 'stay':
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        break;
      case 'gate': {
        // Spec §7 rule 1 / crash safety: checkpoint the step outcome first with the goal status still the stage
        // that produced the gate (C0), then enter the gate stage and the gate itself as one further checkpoint
        // (C1). A crash between C0 and C1 leaves a consistent, re-runnable state: the stage step just runs again.
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        const stage = gateStage(outcome.gate);
        if (state.goal.status !== stage) enterStage(engine, stage);
        const alreadyWaiting = state.gate.status === 'waiting' && state.gate.type === outcome.gate;
        if (!alreadyWaiting) await enterGate(engine, outcome.gate);
        if (!isCliGate(outcome.gate)) {
          return stop('gate', `waiting at gate ${outcome.gate}; it is observed from the SCM provider on the next run`);
        }
        break; // the loop head stops with the approve instruction
      }
      case 'wait_exceeded':
        await engine.checkpoint(`chore(janus): ${step.name}: ${outcome.summary}`);
        return stop('wait_exceeded', `${step.name}: ${outcome.summary}; run janus run again to keep waiting`);
      case 'escalate':
        await escalate(engine, { reason: outcome.reason, repo: outcome.repo, guardrail: outcome.guardrail });
        return stop('escalated', ESCALATED_MESSAGE);
      case 'not_implemented':
        engine.markInFlight(emptyInFlight());
        return stop('not_implemented', `${step.name} is not implemented yet (planned in ${outcome.task})`, outcome.task);
    }
  }
}

/** `janus run --dry-run`: what the next run would do, without touching anything. */
export function describeNextStep(workspace: Workspace, steps: StepRegistry): string[] {
  const { state } = workspace;
  const lines = [`goal ${state.goal.id}: ${state.goal.status}`];
  if (state.execution.in_flight.step !== null) lines.push(`interrupted step "${state.execution.in_flight.step}" would be recovered first`);
  if (state.goal.status === 'completed') {
    lines.push('nothing to do: the goal is completed');
    return lines;
  }
  if (state.goal.status === 'escalated') {
    lines.push(ESCALATED_MESSAGE);
    return lines;
  }
  if (state.gate.status === 'waiting' && state.gate.type !== null && isCliGate(state.gate.type)) {
    lines.push(`waiting at gate ${state.gate.type}; nothing runs until: janus approve ${gateCommand(state.gate.type) ?? ''} --commit <sha>`);
    return lines;
  }
  const step = steps[state.goal.status];
  lines.push(`next step: ${step === undefined ? '(none registered)' : step.name}`);
  const index = HAPPY_PATH.indexOf(state.goal.status);
  if (index >= 0 && index + 1 < HAPPY_PATH.length) lines.push(`then: ${HAPPY_PATH.slice(index + 1).join(' -> ')}`);
  return lines;
}
