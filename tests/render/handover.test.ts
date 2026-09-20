import { describe, expect, it } from 'vitest';
import { goalSchema } from '../../src/config/goal-schema.js';
import { renderHandover } from '../../src/render/handover.js';
import { createInitialState } from '../../src/state/state-schema.js';
import { validGoal } from '../fixtures/valid-goal.js';

const now = new Date('2026-09-19T12:00:00.000Z');
const goal = goalSchema.parse(validGoal);

function state() {
  return createInitialState({ goal, stateBranch: { name: 'janus/angular-15-to-16', remote: 'state-repo' }, now });
}

describe('renderHandover', () => {
  it('summarizes goal, status, repos, and the next action', () => {
    const current = state();
    const uiKit = current.repos['ui-kit'];
    if (uiKit) uiKit.base_commit = 'a'.repeat(40);
    const text = renderHandover(current, goal, now);
    expect(text).toContain('# Handover: Upgrade Angular 15 to 16');
    expect(text).toContain('Generated 2026-09-19T12:00:00.000Z');
    expect(text).toContain('- Status: created');
    expect(text).toContain('- State branch: janus/angular-15-to-16 on state-repo');
    expect(text).toContain('| ui-kit | ai/angular-15-to-16 | aaaaaaa | - | - | no |');
    expect(text).toContain('| shell | ai/angular-15-to-16 | - | - | - | no |');
    expect(text).toContain('Run `janus run` to start prepare and discovery.');
  });

  it('points at the plan approval command when waiting at gate 1', () => {
    const current = state();
    current.goal.status = 'awaiting_plan_approval';
    current.gate.type = 'plan_approval';
    current.gate.status = 'waiting';
    const text = renderHandover(current, goal, now);
    expect(text).toContain('- Gate: plan_approval (waiting)');
    expect(text).toContain('janus approve plan --commit <sha>');
  });

  it('records that agents run unsandboxed, because §18.4 wants it in every checkpoint', () => {
    const current = state();
    const text = renderHandover(current, goal, now, { allowUnsandboxed: true });
    expect(text).toContain('danger-full-access');
    expect(renderHandover(current, goal, now)).not.toContain('danger-full-access');
  });
});
