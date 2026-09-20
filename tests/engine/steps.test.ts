import { describe, expect, it } from 'vitest';
import type { Engine } from '../../src/engine/engine.js';
import { STEPLESS_STAGES, defaultSteps, placeholderStep, startStep } from '../../src/engine/steps.js';
import type { StepContext } from '../../src/engine/steps.js';
import type { Providers } from '../../src/providers/types.js';
import { GOAL_STATUSES } from '../../src/state/state-schema.js';

// Placeholders never touch the engine, so an empty object is enough here.
const providers: Providers = {
  agent: { name: 'fake', run: async (request) => ({ runId: request.runId, status: 'completed', summary: 'unused' }) },
  ci: { name: 'fake', findBuild: async () => null },
  scm: { name: 'fake', currentUser: async () => 'janus-fake', ensureBranch: async () => undefined },
};
const ctx: StepContext = { engine: {} as Engine, maxWaitMs: 0, modelProfile: 'default', providers };

describe('defaultSteps', () => {
  it('registers a step for every stage except the stepless ones', () => {
    const steps = defaultSteps();
    for (const status of GOAL_STATUSES) {
      const expected = !STEPLESS_STAGES.includes(status);
      expect(steps[status] !== undefined, status).toBe(expected);
    }
  });

  it('starts a created goal by advancing to preparing', async () => {
    expect(defaultSteps().created).toBe(startStep);
    expect(await startStep.run(ctx)).toEqual({ kind: 'advance', to: 'preparing', summary: 'goal started' });
  });

  it('answers not_implemented with a task number for every other stage', async () => {
    const steps = defaultSteps();
    for (const status of GOAL_STATUSES) {
      const step = steps[status];
      if (step === undefined || status === 'created') continue;
      const outcome = await step.run(ctx);
      expect(outcome.kind, status).toBe('not_implemented');
      if (outcome.kind === 'not_implemented') expect(outcome.task).toMatch(/^T\d\d$/);
    }
  });

  it('names the placeholder after its stage step', async () => {
    const step = placeholderStep('prepare', 'T11');
    expect(step.name).toBe('prepare');
    expect(await step.run(ctx)).toEqual({ kind: 'not_implemented', task: 'T11' });
  });
});
