import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { VERSION } from '../../src/cli/version.js';
import { runCli } from '../helpers/run-cli.js';

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
