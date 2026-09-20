import { describe, expect, it } from 'vitest';
import { outcomeSummary } from '../../src/agents/types.js';
import { agentTaskFixture, resultFixture } from '../helpers/agent-fixtures.js';

describe('agent task and outcome', () => {
  it('carries the §18.1 contract fields', () => {
    const task = agentTaskFixture({ role: 'implementation', repo: 'ui-kit' });
    expect(task.sandboxClass).toBe('code-writing');
    expect(task.writableRoots.length).toBeGreaterThan(0);
    expect(task.network).toBe(true);
    expect(task.timeoutMinutes).toBe(60);
    expect(task.outputSchema['title']).toBe('janus-implementation-result');
    expect(task.attempt).toBe(1);
    expect(task.promptVersion).toMatch(/^implementation@\d+$/);
  });

  it('summarizes a successful run from the result and a failed one from the failure', () => {
    expect(outcomeSummary(resultFixture({ summary: 'raised @angular/core to 16' }), null)).toBe('raised @angular/core to 16');
    expect(outcomeSummary(null, { kind: 'timeout', detail: 'killed after 45 minutes' })).toBe(
      'agent run failed (timeout): killed after 45 minutes',
    );
    expect(outcomeSummary(null, null)).toBe('agent run produced no result and reported no failure');
  });

  it('prefers the failure text even when a validating result was also produced', () => {
    expect(
      outcomeSummary(resultFixture({ summary: 'raised @angular/core to 16' }), { kind: 'timeout', detail: 'killed after 60 minutes' }),
    ).toBe('agent run failed (timeout): killed after 60 minutes');
  });
});
