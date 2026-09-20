import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeAgentRunner, readFakeAgents, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { agentTaskFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T10:00:00.000Z');

describe('createFakeAgentRunner', () => {
  it('answers from the script by role and attempt number and records every call', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, {
      implementation: [
        { status: 'failed', summary: 'first attempt broke the build' },
        { status: 'completed', summary: 'second attempt is green' },
      ],
    });
    const runner = createFakeAgentRunner({ fakeDir, now: clock });

    const first = await runner.run(agentTaskFixture({ runId: 'run-0001', role: 'implementation', repo: 'ui-kit' }));
    expect(first.status).toBe('failed');
    expect(first.summary).toBe('first attempt broke the build');
    expect(first.result?.summary).toBe('first attempt broke the build');
    const second = await runner.run(agentTaskFixture({ runId: 'run-0002', role: 'implementation', repo: 'ui-kit' }));
    expect(second.status).toBe('completed');

    const store = readFakeAgents(fakeDir);
    expect(store.calls).toEqual([
      { run_id: 'run-0001', role: 'implementation', repo: 'ui-kit', at: '2026-09-20T10:00:00.000Z', status: 'failed' },
      { run_id: 'run-0002', role: 'implementation', repo: 'ui-kit', at: '2026-09-20T10:00:00.000Z', status: 'completed' },
    ]);
  });

  it('counts attempts per role and generates a completed answer past the end of the script', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, { review: [{ status: 'blocked', summary: 'needs the plan' }] });
    const runner = createFakeAgentRunner({ fakeDir, now: clock });

    expect((await runner.run(agentTaskFixture({ runId: 'r1', role: 'review', repo: null }))).status).toBe('blocked');
    const second = await runner.run(agentTaskFixture({ runId: 'r2', role: 'review', repo: null }));
    expect(second.status).toBe('completed');
    expect(second.summary).toBe('fake review agent attempt 2 completed');
    // A different role starts at attempt 1 of its own script.
    expect((await runner.run(agentTaskFixture({ runId: 'r3', role: 'planning', repo: null }))).summary).toBe(
      'fake planning agent attempt 1 completed',
    );
  });

  it('continues the script in a second process because the store is on disk', async () => {
    const fakeDir = join(tempDir('janus-fake-'), 'fake');
    seedFakeAgents(fakeDir, {
      debug: [
        { status: 'failed', summary: 'still red' },
        { status: 'completed', summary: 'fixed' },
      ],
    });
    await createFakeAgentRunner({ fakeDir, now: clock }).run(agentTaskFixture({ runId: 'a', role: 'debug', repo: 'shell' }));
    const laterProcess = createFakeAgentRunner({ fakeDir, now: clock });
    expect((await laterProcess.run(agentTaskFixture({ runId: 'b', role: 'debug', repo: 'shell' }))).summary).toBe('fixed');
  });
});
