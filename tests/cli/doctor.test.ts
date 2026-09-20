import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import type { DoctorCheck } from '../../src/doctor/types.js';
import { runCli } from '../helpers/run-cli.js';

const green: DoctorCheck = {
  id: 'fixture.green',
  title: 'a green fixture check',
  run: async () => [{ id: 'fixture.green', title: 'a green fixture check', status: 'pass', detail: 'all good', remediation: null }],
};

const warn: DoctorCheck = {
  id: 'fixture.warn',
  title: 'a warning fixture check',
  run: async () => [{ id: 'fixture.warn', title: 'a warning fixture check', status: 'warn', detail: 'worth knowing', remediation: 'consider this' }],
};

const red: DoctorCheck = {
  id: 'fixture.red',
  title: 'a failing fixture check',
  run: async () => [{ id: 'fixture.red', title: 'a failing fixture check', status: 'fail', detail: 'it is broken', remediation: 'unbreak it' }],
};

describe('janus doctor', () => {
  it('prints a human report and exits 0 when nothing failed', async () => {
    const result = await runCli(['doctor'], {}, { doctorChecks: [green, warn] });
    expect(result.code).toBe(ExitCode.Ok);
    expect(result.stdout).toContain('[ok]   fixture.green');
    expect(result.stdout).toContain('[warn] fixture.warn');
    expect(result.stdout).toContain('-> consider this');
    expect(result.stdout).toContain('2 checks: 1 ok, 1 warnings, 0 failed, 0 skipped');
    expect(result.stderr).toBe('');
  });

  it('exits 1 when a check failed, and still prints the whole report', async () => {
    const result = await runCli(['doctor'], {}, { doctorChecks: [green, red] });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    expect(result.stdout).toContain('[fail] fixture.red');
    expect(result.stdout).toContain('-> unbreak it');
  });

  it('prints the --json contract and nothing else on stdout', async () => {
    const result = await runCli(['doctor', '--json'], {}, { doctorChecks: [green, red] });
    expect(result.code).toBe(ExitCode.UnexpectedError);
    const report = JSON.parse(result.stdout) as { version: number; summary: Record<string, number>; checks: Array<Record<string, unknown>> };
    expect(report.version).toBe(1);
    expect(report.summary).toEqual({ pass: 1, warn: 0, fail: 1, skip: 0 });
    expect(report.checks.map((check) => check['id'])).toEqual(['fixture.green', 'fixture.red']);
    expect(report.checks[1]).toMatchObject({ status: 'fail', remediation: 'unbreak it' });
  });
});
