import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitError extends Error {
  readonly args: string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], cwd: string, exitCode: number | null, stderr: string) {
    const redactedArgs = args.map((arg) => arg.replace(/(:\/\/)[^/@\s]+@/g, '$1<redacted>@'));
    super(`git ${redactedArgs.join(' ')} failed in ${cwd} (exit ${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  env?: Record<string, string | undefined>;
}

/** Runs `git <args>` in `cwd` and returns stdout without its trailing newline. Non-zero exit throws GitError. */
export async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', ...options.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.replace(/\n$/, '');
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; message: string };
    const exitCode = typeof failure.code === 'number' ? failure.code : null;
    throw new GitError(args, cwd, exitCode, failure.stderr ?? failure.message);
  }
}
