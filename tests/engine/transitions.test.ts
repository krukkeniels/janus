import { describe, expect, it } from 'vitest';
import {
  HAPPY_PATH,
  IllegalTransitionError,
  TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
} from '../../src/engine/transitions.js';
import { GOAL_STATUSES } from '../../src/state/state-schema.js';
import type { GoalStatus } from '../../src/state/state-schema.js';

describe('TRANSITIONS', () => {
  it('has exactly one entry per goal status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...GOAL_STATUSES].sort());
  });

  it('walks the §9 happy path from created to completed', () => {
    expect(HAPPY_PATH[0]).toBe('created');
    expect(HAPPY_PATH[HAPPY_PATH.length - 1]).toBe('completed');
    for (let i = 0; i + 1 < HAPPY_PATH.length; i += 1) {
      const from = HAPPY_PATH[i];
      const to = HAPPY_PATH[i + 1];
      if (from === undefined || to === undefined) throw new Error('unreachable');
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  const cases: Array<[GoalStatus, GoalStatus, boolean]> = [];
  for (const from of GOAL_STATUSES) {
    for (const to of GOAL_STATUSES) {
      const listed = TRANSITIONS[from].includes(to);
      const escalation = to === 'escalated' && from !== 'escalated' && from !== 'completed';
      cases.push([from, to, listed || escalation]);
    }
  }

  it.each(cases)('%s -> %s allowed: %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
    expect(allowedTransitions(from).includes(to)).toBe(expected);
    if (expected) {
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
    }
  });

  it('lets every non-terminal stage escalate, but not escalated or completed', () => {
    for (const from of GOAL_STATUSES) {
      const expected = from !== 'escalated' && from !== 'completed';
      expect(canTransition(from, 'escalated'), from).toBe(expected);
    }
  });

  it('routes gates: approval to executing, rejection back to planning or replanning, resolution to replanning', () => {
    expect(canTransition('awaiting_plan_approval', 'executing')).toBe(true);
    expect(canTransition('awaiting_plan_approval', 'planning')).toBe(true);
    expect(canTransition('awaiting_plan_approval', 'replanning')).toBe(true);
    expect(canTransition('escalated', 'replanning')).toBe(true);
    expect(canTransition('replanning', 'awaiting_plan_approval')).toBe(true);
    expect(canTransition('escalated', 'executing')).toBe(false);
  });

  it('makes completed terminal', () => {
    expect(allowedTransitions('completed')).toEqual([]);
  });

  it('names both stages in the error', () => {
    const error = new IllegalTransitionError('completed', 'created');
    expect(error.from).toBe('completed');
    expect(error.to).toBe('created');
    expect(error.message).toBe('illegal goal transition completed -> created; allowed: none');
    expect(new IllegalTransitionError('created', 'completed').message).toBe(
      'illegal goal transition created -> completed; allowed: preparing, escalated',
    );
  });
});
