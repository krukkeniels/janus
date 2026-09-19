import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitError, runGit } from '../../src/git/run.js';
import { tempDir } from '../helpers/git-fixtures.js';

describe('runGit', () => {
  it('returns stdout without the trailing newline', async () => {
    const dir = tempDir();
    await runGit(dir, ['init', '-q', '-b', 'main']);
    expect(await runGit(dir, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });

  it('throws GitError carrying args, cwd, exit code, and stderr', async () => {
    const dir = tempDir();
    try {
      await runGit(dir, ['rev-parse', 'HEAD']);
      expect.unreachable('expected GitError');
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      const gitError = error as GitError;
      expect(gitError.name).toBe('GitError');
      expect(gitError.args).toEqual(['rev-parse', 'HEAD']);
      expect(gitError.cwd).toBe(dir);
      expect(gitError.exitCode).toBe(128);
      expect(gitError.stderr).toContain('not a git repository');
      expect(gitError.message).toContain('git rev-parse HEAD failed');
    }
  });

  it('commits with the hermetic identity from the test environment', async () => {
    const dir = tempDir();
    await runGit(dir, ['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-q', '-m', 'test(git): first']);
    expect(await runGit(dir, ['log', '-1', '--format=%an <%ae>'])).toBe('Janus Test <janus@test.invalid>');
  });
});
