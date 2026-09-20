import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commitAll, initRepo } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import type { AgentRunner } from '../../src/providers/types.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { auditAgentRunner, captureRefLogs, diffRefLogs, formatGitWrites } from './harness/git-audit.js';
import type { AgentGitWrite } from './harness/git-audit.js';

async function repo(name: string): Promise<string> {
  const dir = join(tempDir(`janus-audit-${name}-`), name);
  mkdirSync(dir, { recursive: true });
  await initRepo(dir, 'main');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  await commitAll(dir, 'chore(init): initial commit');
  return dir;
}

const quiet: AgentRunner = {
  name: 'fake',
  run: async (request) => ({ runId: request.runId, status: 'completed', summary: 'wrote a file, touched no git' }),
};

describe('captureRefLogs and diffRefLogs', () => {
  it('reports nothing when no ref moved', async () => {
    const dir = await repo('quiet');
    const targets = [{ label: 'repos/quiet', dir }];
    const before = await captureRefLogs(targets);
    writeFileSync(join(dir, 'note.txt'), 'an agent may write files\n');
    expect(diffRefLogs(before, await captureRefLogs(targets))).toEqual([]);
  });

  it('reports a commit, a branch creation, and a push', async () => {
    const dir = await repo('busy');
    const bare = join(tempDir('janus-audit-bare-'), 'busy.git');
    await runGit(tempDir('janus-audit-init-'), ['init', '-q', '--bare', '-b', 'main', bare]);
    await runGit(bare, ['config', 'core.logAllRefUpdates', 'true']);
    await runGit(dir, ['remote', 'add', 'origin', bare]);
    const targets = [
      { label: 'repos/busy', dir },
      { label: 'remote:busy', dir: bare },
    ];

    const before = await captureRefLogs(targets);
    await runGit(dir, ['checkout', '-q', '-b', 'ai/goal']);
    const sha = await commitAll(dir, 'feat(busy): agent wrote this', { allowEmpty: true });
    await runGit(dir, ['push', '-q', 'origin', 'ai/goal:ai/goal']);
    const writes = diffRefLogs(before, await captureRefLogs(targets));

    expect(writes.map((write) => `${write.label} ${write.ref}`)).toEqual(
      expect.arrayContaining([
        'repos/busy HEAD',
        'repos/busy refs/heads/ai/goal',
        'repos/busy refs/remotes/origin/ai/goal',
        'remote:busy refs/heads/ai/goal',
      ]),
    );
    expect(writes.some((write) => write.sha === sha && write.subject.includes('agent wrote this'))).toBe(true);
  });

  it('reports a deleted ref, since deleting it also erases its reflog', async () => {
    const dir = await repo('deleting');
    await runGit(dir, ['checkout', '-q', '-b', 'ai/scratch']);
    await runGit(dir, ['checkout', '-q', 'main']);
    const targets = [{ label: 'repos/deleting', dir }];

    const before = await captureRefLogs(targets);
    await runGit(dir, ['branch', '-D', 'ai/scratch']);
    const writes = diffRefLogs(before, await captureRefLogs(targets));

    expect(writes).toEqual(
      expect.arrayContaining([
        { label: 'repos/deleting', ref: 'refs/heads/ai/scratch', sha: '', subject: 'ref deleted' },
      ]),
    );
  });
});

describe('auditAgentRunner', () => {
  it('records nothing for an agent that only writes files', async () => {
    const dir = await repo('clean');
    const sink: AgentGitWrite[] = [];
    const runner = auditAgentRunner(quiet, [{ label: 'repos/clean', dir }], sink);
    const outcome = await runner.run({ runId: 'run-0001', role: 'implementation', repo: 'clean' });
    expect(outcome.status).toBe('completed');
    expect(sink).toEqual([]);
  });

  it('records a git write made inside the agent window and formats it for the failure message', async () => {
    const dir = await repo('naughty');
    const sink: AgentGitWrite[] = [];
    const committing: AgentRunner = {
      name: 'fake',
      run: async (request) => {
        await commitAll(dir, 'feat(naughty): commit: agent wrote this', { allowEmpty: true });
        return { runId: request.runId, status: 'completed', summary: 'committed, which it must not do' };
      },
    };
    const runner = auditAgentRunner(committing, [{ label: 'repos/naughty', dir }], sink);
    await runner.run({ runId: 'run-0007', role: 'implementation', repo: 'naughty' });

    expect(sink.length).toBeGreaterThan(0);
    expect(sink.every((write) => write.runId === 'run-0007' && write.role === 'implementation')).toBe(true);
    expect(sink.map((write) => write.ref)).toContain('refs/heads/main');
    const message = formatGitWrites(sink);
    expect(message).toContain('repos/naughty');
    expect(message).toContain('agent wrote this');
    expect(message).toContain('(during agent run run-0007, role implementation)');
  });

  it('still records the writes when the agent throws', async () => {
    const dir = await repo('throwing');
    const sink: AgentGitWrite[] = [];
    const runner = auditAgentRunner(
      {
        name: 'fake',
        run: async () => {
          await commitAll(dir, 'feat(throwing): sneaky', { allowEmpty: true });
          throw new Error('agent crashed');
        },
      },
      [{ label: 'repos/throwing', dir }],
      sink,
    );
    await expect(runner.run({ runId: 'run-0008', role: 'debug', repo: 'throwing' })).rejects.toThrow('agent crashed');
    expect(sink.length).toBeGreaterThan(0);
  });
});
