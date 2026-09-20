import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeAgentRunner, readFakeAgents, seedFakeAgents } from '../../src/providers/fake/agent-runner.js';
import { runGit } from '../../src/git/run.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { agentTaskFixture } from '../helpers/agent-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';

const clock = () => new Date('2026-09-20T10:00:00.000Z');

/** A workspace with one real git repository holding one committed file, so `git apply` has something to patch. */
async function workspace() {
  const paths = workspacePaths(tempDir('janus-fake-ws-'));
  const repo = paths.repoDir('ui-kit');
  mkdirSync(repo, { recursive: true });
  mkdirSync(paths.janusDir, { recursive: true });
  await runGit(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'version.txt'), 'fifteen\n');
  await runGit(repo, ['add', 'version.txt']);
  await runGit(repo, ['commit', '-q', '-m', 'seed']);
  return { paths, repo };
}

const PATCH = [
  'diff --git a/version.txt b/version.txt',
  'index 0000000..1111111 100644',
  '--- a/version.txt',
  '+++ b/version.txt',
  '@@ -1 +1 @@',
  '-fifteen',
  '+sixteen',
  '',
].join('\n');

describe('createFakeAgentRunner', () => {
  it('answers from the script by role and attempt number (§18.5)', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [
        { status: 'failed', summary: 'first attempt broke the build' },
        { status: 'completed', summary: 'second attempt is green' },
      ],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    const first = await runner.run(agentTaskFixture({ runId: 'run-0001', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(first.status).toBe('failed');
    expect(first.summary).toBe('first attempt broke the build');

    const second = await runner.run(agentTaskFixture({ runId: 'run-0002', role: 'implementation', repo: 'ui-kit', attempt: 2 }));
    expect(second.status).toBe('completed');
    expect(second.summary).toBe('second attempt is green');
  });

  it('generates a completed answer past the end of a role script, per role', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, { review: [{ status: 'blocked', summary: 'needs the plan' }] });
    const runner = createFakeAgentRunner({ paths, now: clock });

    expect((await runner.run(agentTaskFixture({ runId: 'r1', role: 'review', repo: null, attempt: 1 }))).status).toBe('blocked');
    const past = await runner.run(agentTaskFixture({ runId: 'r2', role: 'review', repo: null, attempt: 2 }));
    expect(past.status).toBe('completed');
    expect(past.summary).toBe('fake review agent attempt 2 completed');
    const other = await runner.run(agentTaskFixture({ runId: 'r3', role: 'planning', repo: null, attempt: 1 }));
    expect(other.summary).toBe('fake planning agent attempt 1 completed');
  });

  it('applies a prepared patch to the assigned repo working tree without touching any ref (§18.5, §32 rule 11)', async () => {
    const { paths, repo } = await workspace();
    const before = await runGit(repo, ['rev-parse', 'HEAD']);
    seedFakeAgents(paths.fakeDir, { implementation: [{ status: 'completed', summary: 'bumped', patch: PATCH }] });
    const runner = createFakeAgentRunner({ paths, now: clock });

    await runner.run(agentTaskFixture({ runId: 'run-0010', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(readFileSync(join(repo, 'version.txt'), 'utf8')).toBe('sixteen\n');
    expect(await runGit(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await runGit(repo, ['status', '--porcelain'])).toContain('version.txt');
    expect(readFakeAgents(paths.fakeDir).calls[0]?.applied_patch).toBe(true);
  });

  it('writes prepared reports under .janus/reports/<run-id>/ for a report-writing role', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      discovery: [{ status: 'completed', summary: 'surveyed', reports: { 'deps-and-build.md': '# Deps\n\nAngular 15.2.10\n' } }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    await runner.run(agentTaskFixture({ runId: 'run-0011', role: 'discovery', repo: null, attempt: 1 }));
    const path = join(paths.janusDir, 'reports', 'run-0011', 'deps-and-build.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('Angular 15.2.10');
    expect(readFakeAgents(paths.fakeDir).calls[0]?.wrote_reports).toEqual(['deps-and-build.md']);
  });

  it('returns a prepared §18.3 result, merged over the generated base', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [
        {
          status: 'completed',
          summary: 'coupled red expected',
          result: { expected_temporary_failure: true, predicted_failures: ['ButtonComponent > renders'] },
          tokens: { input: 10, cached_input: 2, output: 3, reasoning: null, total: 13 },
          durationMs: 4_000,
        },
      ],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });

    const outcome = await runner.run(agentTaskFixture({ runId: 'run-0012', role: 'implementation', repo: 'ui-kit', attempt: 1 }));
    expect(outcome.result?.expected_temporary_failure).toBe(true);
    expect(outcome.result?.predicted_failures).toEqual(['ButtonComponent > renders']);
    expect(outcome.result?.summary).toBe('coupled red expected');
    expect(outcome.tokens?.total).toBe(13);
    expect(outcome.durationMs).toBe(4_000);
  });

  it('can script an adapter failure, so a harness scenario can exercise a timeout', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      debug: [{ status: 'failed', summary: 'killed', failure: { kind: 'timeout', detail: 'killed after 45 minutes' } }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });
    const outcome = await runner.run(agentTaskFixture({ runId: 'run-0013', role: 'debug', repo: 'ui-kit', attempt: 1 }));
    expect(outcome.status).toBe('failed');
    expect(outcome.result).toBeNull();
    expect(outcome.failure).toEqual({ kind: 'timeout', detail: 'killed after 45 minutes' });
    expect(outcome.timedOut).toBe(true);
  });

  it('keeps a scripted result alongside a scripted failure, matching the real adapter (commit 4a6e3e7)', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      debug: [
        {
          status: 'failed',
          summary: 'timed out mid-fix',
          failure: { kind: 'timeout', detail: 'killed after 45 minutes' },
          result: { changes_made: ['src/widget.ts'], recommended_next_action: 'resume the fix on retry' },
        },
      ],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });
    const outcome = await runner.run(agentTaskFixture({ runId: 'run-0016', role: 'debug', repo: 'ui-kit', attempt: 1 }));
    expect(outcome.status).toBe('failed');
    expect(outcome.failure).toEqual({ kind: 'timeout', detail: 'killed after 45 minutes' });
    expect(outcome.result?.changes_made).toEqual(['src/widget.ts']);
    expect(outcome.result?.recommended_next_action).toBe('resume the fix on retry');
  });

  it('refuses a scripted result the real output schema would reject', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      implementation: [{ status: 'completed', summary: 's', result: { summary: 42 } as never }],
    });
    const runner = createFakeAgentRunner({ paths, now: clock });
    await expect(
      runner.run(agentTaskFixture({ runId: 'run-0014', role: 'implementation', repo: 'ui-kit', attempt: 1 })),
    ).rejects.toThrow('fake agent script for role implementation attempt 1 is not a valid implementation result');
  });

  it('reads the script from disk in a second process and keeps appending to the call log', async () => {
    const { paths } = await workspace();
    seedFakeAgents(paths.fakeDir, {
      debug: [
        { status: 'failed', summary: 'still red' },
        { status: 'completed', summary: 'fixed' },
      ],
    });
    await createFakeAgentRunner({ paths, now: clock }).run(agentTaskFixture({ runId: 'a', role: 'debug', repo: 'ui-kit', attempt: 1 }));
    const laterProcess = createFakeAgentRunner({ paths, now: clock });
    const second = await laterProcess.run(agentTaskFixture({ runId: 'b', role: 'debug', repo: 'ui-kit', attempt: 2 }));
    expect(second.summary).toBe('fixed');
    expect(readFakeAgents(paths.fakeDir).calls.map((call) => call.run_id)).toEqual(['a', 'b']);
    expect(readFakeAgents(paths.fakeDir).calls.map((call) => call.attempt)).toEqual([1, 2]);
  });
});
