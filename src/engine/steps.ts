import type { Providers } from '../providers/types.js';
import type { GateType, GoalStatus } from '../state/state-schema.js';
import type { GuardrailHit } from './budgets.js';
import type { Engine } from './engine.js';

export interface StepContext {
  engine: Engine;
  /** `--max-wait` in milliseconds; a waiting step returns `wait_exceeded` once it has waited this long. */
  maxWaitMs: number;
  /** The model profile name for this invocation (`--model-profile` or `workflow_models.profile`). */
  modelProfile: string;
  /** The agent runner, CI, and SCM providers for this run, injected by the CLI or the integration harness. */
  providers: Providers;
}

export type StepOutcome =
  /** The stage is done; move to `to` and checkpoint. */
  | { kind: 'advance'; to: GoalStatus; summary: string }
  /** Progress was made but the stage continues (for example one work package finished); checkpoint and run the stage step again. */
  | { kind: 'stay'; summary: string }
  /** Checkpoint, then enter the human gate. */
  | { kind: 'gate'; gate: GateType; summary: string }
  /** A blocking wait passed `--max-wait`; checkpoint and stop with exit 11. */
  | { kind: 'wait_exceeded'; summary: string }
  /** Something needs a human; escalate (spec §25). A guardrail hit is passed through so `guardrail.hit` is recorded. */
  | { kind: 'escalate'; reason: string; repo: string | null; guardrail: GuardrailHit | null }
  /** The stage is planned in a later task; stop with exit 3 and no checkpoint. */
  | { kind: 'not_implemented'; task: string };

/**
 * One unit of the run loop. Steps run with `execution.in_flight.step` set to `name`; a step that starts an agent
 * also records `agent_run_id`, `repo`, and `budget` in `in_flight` (and writes state) so a crash can be recovered.
 */
export interface Step {
  name: string;
  run(ctx: StepContext): Promise<StepOutcome>;
}

/** The step to run while the goal is in a given stage. */
export type StepRegistry = Partial<Record<GoalStatus, Step>>;

/** Stages the loop never runs a step for: CLI gates stop it, `escalated` waits for `janus escalation resolve`, `completed` is terminal. */
export const STEPLESS_STAGES: readonly GoalStatus[] = ['awaiting_plan_approval', 'escalated', 'completed'];

export function placeholderStep(name: string, task: string): Step {
  return { name, run: async () => ({ kind: 'not_implemented', task }) };
}

/** Leaves `created` for `preparing` (spec §9). The only real stage step of T03. */
export const startStep: Step = {
  name: 'start',
  run: async () => ({ kind: 'advance', to: 'preparing', summary: 'goal started' }),
};

/** The production registry: every real stage is a placeholder until its task lands. */
export function defaultSteps(): StepRegistry {
  return {
    created: startStep,
    preparing: placeholderStep('prepare', 'T11'),
    discovering: placeholderStep('discovery', 'T11'),
    baselining: placeholderStep('baseline', 'T11'),
    planning: placeholderStep('planning', 'T11'),
    executing: placeholderStep('execute-work-packages', 'T12'),
    final_e2e: placeholderStep('final-e2e', 'T17'),
    ai_review: placeholderStep('ai-review', 'T13'),
    qa: placeholderStep('qa-recommendation', 'T20'),
    awaiting_human_review: placeholderStep('observe-pr-review', 'T13'),
    fixing_review_feedback: placeholderStep('fix-review-feedback', 'T13'),
    awaiting_merge: placeholderStep('observe-merge', 'T13'),
    releasing: placeholderStep('release-and-bump', 'T20'),
    replanning: placeholderStep('replanning', 'T13'),
  };
}
