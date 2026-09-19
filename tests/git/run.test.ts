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

  it('runs git in the C locale regardless of the caller environment', async () => {
    const dir = tempDir();
    await runGit(dir, ['init', '-q', '-b', 'main']);
    process.env['LANG'] = 'de_DE.UTF-8';
    try {
      await runGit(dir, ['rev-parse', 'HEAD']);
      expect.unreachable('expected GitError');
    } catch (error) {
      expect((error as GitError).stderr).toContain('ambiguous argument');
    } finally {
      delete process.env['LANG'];
    }
  });

  it('disables git terminal prompts by default', async () => {
    const dir = tempDir();
    expect(await runGit(dir, ['-c', 'alias.env=!env', 'env'])).toContain('GIT_TERMINAL_PROMPT=0');
  });
});

describe('GitError', () => {
  it('redacts credentials embedded in a url arg but keeps the originals in .args', () => {
    const error = new GitError(['clone', 'https://user:token@host/x.git', 'dir'], '/tmp', 128, 'boom');
    expect(error.message).toContain('https://<redacted>@host/x.git');
    expect(error.message).not.toContain('token');
    expect(error.args).toEqual(['clone', 'https://user:token@host/x.git', 'dir']);
  });
});
