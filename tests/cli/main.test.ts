import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import type { CliIo } from '../../src/cli/context.js';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { exitCodeForError } from '../../src/cli/main.js';
import { VERSION } from '../../src/cli/version.js';
import { ConfigError } from '../../src/config/errors.js';
import { runCli } from '../helpers/run-cli.js';

function fakeIo(): CliIo & { stderrText: string } {
  const io = {
    stderrText: '',
    stdout: () => {},
    stderr(text: string) {
      this.stderrText += text;
    },
    env: {},
    cwd: process.cwd(),
  };
  return io;
}

describe('janus cli', () => {
  it('prints help and exits 0 with --help', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('Usage: janus');
  });

  it('prints the version with --version', async () => {
    const result = await runCli(['--version']);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('exits 2 on an unknown command', async () => {
    const result = await runCli(['frobnicate']);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain('error:');
  });

  it('prints help and exits 0 when called with no arguments', async () => {
    const result = await runCli([]);
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('Usage: janus');
  });
});

describe('exitCodeForError', () => {
  it('exits 0 for a commander help/version exit', () => {
    const io = fakeIo();
    const error = new CommanderError(0, 'commander.helpDisplayed', 'help');
    expect(exitCodeForError(error, io)).toBe(ExitCode.Ok);
  });

  it('exits 2 with the error message for a ConfigError', () => {
    const io = fakeIo();
    const error = new ConfigError('x.yaml', ['a: b']);
    expect(exitCodeForError(error, io)).toBe(ExitCode.UsageError);
    expect(io.stderrText).toContain('janus: x.yaml');
  });

  it('exits 1 with a prefixed message for an unexpected error', () => {
    const io = fakeIo();
    const error = new Error('kaboom');
    expect(exitCodeForError(error, io)).toBe(ExitCode.UnexpectedError);
    expect(io.stderrText).toBe('janus: kaboom\n');
  });
});
