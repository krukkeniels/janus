import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PushRejectedError } from '../../src/git/ops.js';
import { checkoutBranch, clone, commitAll, initBare, initRepo, push, revParse } from '../../src/git/ops.js';
import { runGit } from '../../src/git/run.js';
import { buildCommitMessage, commitAndPush } from '../../src/policy/commit.js';
import { initWorkspace, testEngine } from '../helpers/engine-fixtures.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { openWorkspace } from '../../src/workspace/open-workspace.js';

describe('buildCommitMessage', () => {
  const input = {
    type: 'feat',
    repo: 'ui-kit',
    subject: 'upgrade ui-kit to Angular 16',
    workPackageId: 'wp-01-ui-kit-angular',
    goalId: 'angular-15-to-16',
    runId: 'run-0007',
    policyEvidence: 'evidence/policy/wp-01-ui-kit-angular-ui-kit-a1.yaml',
  };

  it('writes a conventional subject scoped to the repository', () => {
    expect(buildCommitMessage(input).split('\n')[0]).toBe('feat(ui-kit): upgrade ui-kit to Angular 16');
  });

  it('references the package and the run id in trailers, as §14 requires', () => {
    const message = buildCommitMessage(input);
    expect(message).toContain('\n\nWork-Package: wp-01-ui-kit-angular');
    expect(message).toContain('Run-Id: run-0007');
    expect(message).toContain('Goal: angular-15-to-16');
    expect(message).toContain('Janus-Policy: evidence/policy/wp-01-ui-kit-angular-ui-kit-a1.yaml');
  });

  it('writes "none" for a commit with no agent run behind it', () => {
    expect(buildCommitMessage({ ...input, runId: null })).toContain('Run-Id: none');
  });

  it('collapses a multi-line subject into one line and drops a trailing period', () => {
    const message = buildCommitMessage({ ...input, subject: 'upgrade\n  the  library.' });
    expect(message.split('\n')[0]).toBe('feat(ui-kit): upgrade the library');
  });

  it('truncates a very long subject so the header line stays readable', () => {
    const message = buildCommitMessage({ ...input, subject: 'x'.repeat(200) });
    const header = message.split('\n')[0] ?? '';
    expect(header.length).toBeLessThanOrEqual(72);
    expect(header.endsWith('...')).toBe(true);
  });

  it('falls back to a usable subject when the caller supplies an empty one', () => {
    expect(buildCommitMessage({ ...input, subject: '   ' }).split('\n')[0]).toBe(
      'feat(ui-kit): apply work package wp-01-ui-kit-angular',
    );
  });
});

describe('commitAndPush', () => {
  it('commits every change, pushes fast-forward, and emits both §27 events', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const repo = workspace.state.repos['ui-kit'] === undefined ? 'shell' : 'ui-kit';
      const dir = workspace.paths.repoDir(repo);
      const branch = `ai/${ws.fixture.goalId}`;
      await checkoutBranch(dir, branch, 'HEAD');
      writeFileSync(join(dir, 'new-file.ts'), 'export const x = 1;\n');

      const result = await commitAndPush({
        engine,
        repoDir: dir,
        repo,
        branch,
        message: buildCommitMessage({
          type: 'feat',
          repo,
          subject: 'add a file',
          workPackageId: 'wp-01',
          goalId: ws.fixture.goalId,
          runId: 'run-0001',
          policyEvidence: 'evidence/policy/wp-01-a1.yaml',
        }),
        workPackageId: 'wp-01',
        changedFiles: 1,
      });

      expect(result.pushed).toBe(true);
      expect(result.commit).toBe(await revParse(dir, 'HEAD'));
      expect(await runGit(dir, ['status', '--porcelain'])).toBe('');
      const types = engine.workspace.paths.janusDir;
      const events = (await import('../../src/telemetry/events.js')).readEvents(types);
      expect(events.map((event) => event['type'])).toEqual(
        expect.arrayContaining(['commit.created', 'push.completed']),
      );
      const created = events.find((event) => event['type'] === 'commit.created');
      expect(created?.['sha']).toBe(result.commit);
      expect(created?.['subject']).toBe(`feat(${repo}): add a file`);
    } finally {
      workspace.release();
    }
  });

  it('can commit without pushing', async () => {
    const ws = await initWorkspace();
    const workspace = await openWorkspace(ws.root);
    try {
      const { engine } = testEngine(workspace);
      const repo = Object.keys(workspace.state.repos)[0] ?? 'ui-kit';
      const dir = workspace.paths.repoDir(repo);
      writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
      const result = await commitAndPush({
        engine,
        repoDir: dir,
        repo,
        branch: 'main',
        message: 'feat(x): local only',
        workPackageId: 'wp-01',
        changedFiles: 1,
        push: false,
      });
      expect(result.pushed).toBe(false);
      const events = (await import('../../src/telemetry/events.js')).readEvents(workspace.paths.janusDir);
      expect(events.some((event) => event['type'] === 'push.completed')).toBe(false);
    } finally {
      workspace.release();
    }
  });

  it('lets a rejected push surface as PushRejectedError', async () => {
    const parent = tempDir();
    const bare = join(parent, 'bare.git');
    mkdirSync(bare, { recursive: true });
    await initBare(bare, 'main');
    const seed = join(parent, 'seed');
    mkdirSync(seed);
    await initRepo(seed, 'main');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    await commitAll(seed, 'feat(seed): base');
    await runGit(seed, ['remote', 'add', 'origin', bare]);
    await push(seed, 'origin', 'main');

    const other = join(parent, 'other');
    await clone(bare, other, { branch: 'main' });
    writeFileSync(join(other, 'b.txt'), 'b\n');
    await commitAll(other, 'feat(other): diverge');
    await push(other, 'origin', 'main');

    writeFileSync(join(seed, 'c.txt'), 'c\n');
    await expect(
      (async () => {
        await commitAll(seed, 'feat(seed): local');
        await push(seed, 'origin', 'main');
      })(),
    ).rejects.toBeInstanceOf(PushRejectedError);
  });
});
