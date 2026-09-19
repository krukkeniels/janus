import type { GoalStatus } from '../state/state-schema.js';

/**
 * Forward moves per stage (spec §9 workflow, §24 review and merge loops, §25 escalation). Every stage except
 * `escalated` and `completed` may additionally move to `escalated`; see `allowedTransitions`.
 */
export const TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  created: ['preparing'],
  preparing: ['discovering'],
  discovering: ['baselining'],
  baselining: ['planning'],
  planning: ['awaiting_plan_approval'],
  // approve -> executing; reject at Gate 1 -> planning; reject at Gate 2 -> replanning
  awaiting_plan_approval: ['executing', 'planning', 'replanning'],
  executing: ['final_e2e'],
  final_e2e: ['ai_review'],
  // findings -> fix -> CI -> E2E if invalidated -> review (§22); clean -> qa
  ai_review: ['qa', 'final_e2e'],
  qa: ['awaiting_human_review'],
  awaiting_human_review: ['fixing_review_feedback', 'awaiting_merge'],
  // fix -> CI -> E2E if invalidated -> AI review -> back to human review (§24)
  fixing_review_feedback: ['awaiting_human_review', 'ai_review', 'final_e2e'],
  awaiting_merge: ['releasing', 'completed'],
  releasing: ['awaiting_merge'],
  escalated: ['replanning'],
  replanning: ['awaiting_plan_approval'],
  completed: [],
};

/** The stage sequence of a goal with no findings, no review feedback, and no releases (§9). */
export const HAPPY_PATH: readonly GoalStatus[] = [
  'created',
  'preparing',
  'discovering',
  'baselining',
  'planning',
  'awaiting_plan_approval',
  'executing',
  'final_e2e',
  'ai_review',
  'qa',
  'awaiting_human_review',
  'awaiting_merge',
  'completed',
];

export class IllegalTransitionError extends Error {
  readonly from: GoalStatus;
  readonly to: GoalStatus;

  constructor(from: GoalStatus, to: GoalStatus) {
    const allowed = allowedTransitions(from);
    super(`illegal goal transition ${from} -> ${to}; allowed: ${allowed.length === 0 ? 'none' : allowed.join(', ')}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function allowedTransitions(from: GoalStatus): readonly GoalStatus[] {
  const listed = TRANSITIONS[from];
  if (from === 'escalated' || from === 'completed') return listed;
  return [...listed, 'escalated'];
}

export function canTransition(from: GoalStatus, to: GoalStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export function assertTransition(from: GoalStatus, to: GoalStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
