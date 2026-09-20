import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { goalSchema } from '../../src/config/goal-schema.js';
import { isModelSwitch, ModelProfileError, parseLadderEntry, resolveModel } from '../../src/agents/models.js';
import { createInitialState } from '../../src/state/state-schema.js';

const config = configSchema.parse({
  workflow: { ci_provider: 'fake', scm_provider: 'fake' },
  model_profiles: {
    default: {
      '*': { model: 'gpt-5.6-sol', effort: 'high' },
      implementation: { model: 'gpt-5.6-sol', effort: 'xhigh' },
      debug: { model: 'gpt-5.6-sol', effort: 'high', ladder: ['gpt-5.6-sol', 'gpt-5.6-sol:xhigh'] },
    },
    'fast-first': {
      '*': { model: 'gpt-5.6-mini', effort: 'medium' },
      debug: { model: 'gpt-5.6-mini', effort: 'medium', ladder: ['gpt-5.6-mini', 'gpt-5.6-sol', 'gpt-5.6-sol:xhigh'] },
    },
  },
});

const resolve = (role: Parameters<typeof resolveModel>[0]['role'], attempt: number, profile = 'default') =>
  resolveModel({ config, profile, role, attempt });

describe('parseLadderEntry', () => {
  it('reads an effort suffix after the last colon when it names an effort', () => {
    expect(parseLadderEntry('gpt-5.6-sol:xhigh', 'high')).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(parseLadderEntry('vendor:model:minimal', 'high')).toEqual({ model: 'vendor:model', effort: 'minimal' });
  });

  it('falls back to the spec effort when there is no suffix or the suffix is not an effort', () => {
    expect(parseLadderEntry('gpt-5.6-sol', 'medium')).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
    expect(parseLadderEntry('vendor:model', 'medium')).toEqual({ model: 'vendor:model', effort: 'medium' });
    expect(parseLadderEntry('gpt-5.6-sol:turbo', 'low')).toEqual({ model: 'gpt-5.6-sol:turbo', effort: 'low' });
  });

  it('treats a leading colon as part of the model name, not an empty model', () => {
    expect(parseLadderEntry(':high', 'low')).toEqual({ model: ':high', effort: 'low' });
  });
});

describe('resolveModel', () => {
  it('uses the role entry when the profile has one and the "*" entry otherwise', () => {
    expect(resolve('implementation', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: null, ladderLength: null });
    expect(resolve('qa', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: null, ladderLength: null });
  });

  it('walks the ladder one step per attempt and then holds at the last entry (§18.6)', () => {
    expect(resolve('debug', 1)).toEqual({ model: 'gpt-5.6-sol', effort: 'high', ladderIndex: 0, ladderLength: 2 });
    expect(resolve('debug', 2)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
    expect(resolve('debug', 3)).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 1, ladderLength: 2 });
    expect(resolve('debug', 99).ladderIndex).toBe(1);
  });

  it('walks a three-entry ladder from a different profile', () => {
    expect(resolve('debug', 1, 'fast-first').model).toBe('gpt-5.6-mini');
    expect(resolve('debug', 2, 'fast-first')).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', ladderIndex: 1, ladderLength: 3 });
    expect(resolve('debug', 3, 'fast-first')).toEqual({ model: 'gpt-5.6-sol', effort: 'xhigh', ladderIndex: 2, ladderLength: 3 });
  });

  it('clamps an attempt below 1 to the first ladder entry', () => {
    expect(resolve('debug', 0).ladderIndex).toBe(0);
  });

  it('names the profile that does not exist', () => {
    expect(() => resolveModel({ config, profile: 'nope', role: 'debug', attempt: 1 })).toThrow(ModelProfileError);
    expect(() => resolveModel({ config, profile: 'nope', role: 'debug', attempt: 1 })).toThrow(
      'model profile "nope" is not defined in config.yaml model_profiles',
    );
  });
});

describe('isModelSwitch', () => {
  it('is false for the first attempt and for an unchanged model', () => {
    expect(isModelSwitch(null, resolve('debug', 1))).toBe(false);
    expect(isModelSwitch(resolve('debug', 2), resolve('debug', 3))).toBe(false);
  });

  it('is true when the model or the effort changes', () => {
    expect(isModelSwitch(resolve('debug', 1), resolve('debug', 2))).toBe(true);
    expect(isModelSwitch(resolve('debug', 1, 'fast-first'), resolve('debug', 2, 'fast-first'))).toBe(true);
  });
});

describe('budget accounting stays out of model resolution', () => {
  it('leaves state.execution.budgets untouched across a two-attempt ladder run', () => {
    const goal = goalSchema.parse({
      id: 'upgrade-16',
      source_version: '15',
      target_version: '16',
      title: 'Upgrade to Angular 16',
      repos: [
        {
          name: 'ui-kit',
          kind: 'library',
          scm: { project: 'PROJ', slug: 'ui-kit' },
          base_branch: 'main',
          ci: { pr_build_type_id: 'UiKit_Pr' },
        },
      ],
      e2e: { build_type_id: 'E2E_Build' },
    });
    const state = createInitialState({
      goal,
      stateBranch: { name: 'janus-state', remote: 'origin' },
      now: new Date('2026-09-20T00:00:00.000Z'),
    });
    const before = { ...state.execution.budgets };

    // Spec §18.6 / controller ruling: a ladder step never adds budget. `resolveModel` does not take `state` at
    // all, so walking the whole ladder cannot touch `execution.budgets` — this test pins that as a regression
    // guard, alongside the static rule that nothing in `src/agents/**` imports `incrementBudget`.
    resolve('debug', 1);
    resolve('debug', 2);

    expect(state.execution.budgets).toEqual(before);
    expect(Object.values(state.execution.budgets).every((value) => value === 0)).toBe(true);
  });
});
