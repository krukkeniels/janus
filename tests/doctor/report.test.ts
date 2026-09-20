import { describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/cli/exit-codes.js';
import { DoctorContractError } from '../../src/doctor/types.js';
import type { DoctorCheck, DoctorObservation } from '../../src/doctor/types.js';
import { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from '../../src/doctor/report.js';
import { doctorContext } from '../helpers/doctor-fixtures.js';

const check = (id: string, observations: DoctorObservation[]): DoctorCheck => ({
  id,
  title: `title of ${id}`,
  run: async () => observations,
});

describe('runDoctor', () => {
  it('stamps a duration on every finding and counts the statuses', async () => {
    const report = await runDoctor(
      [
        check('a', [{ id: 'a', title: 'A', status: 'pass', detail: 'fine', remediation: null }]),
        check('b', [
          { id: 'b.one', title: 'B one', status: 'warn', detail: 'hmm', remediation: 'do the thing' },
          { id: 'b.two', title: 'B two', status: 'skip', detail: 'not applicable', remediation: 'configure it first' },
        ]),
        check('c', [{ id: 'c', title: 'C', status: 'fail', detail: 'broken', remediation: 'fix it' }]),
      ],
      doctorContext({ paths: null }),
    );

    expect(report.version).toBe(1);
    expect(report.generated_at).toBe('2026-09-20T12:00:00.000Z');
    expect(report.workspace).toBeNull();
    expect(report.checks.map((f) => f.id)).toEqual(['a', 'b.one', 'b.two', 'c']);
    expect(report.checks.every((f) => typeof f.duration_ms === 'number')).toBe(true);
    expect(report.summary).toEqual({ pass: 1, warn: 1, fail: 1, skip: 1 });
  });

  it('turns a thrown check into a failed finding instead of losing the whole report', async () => {
    const boom: DoctorCheck = {
      id: 'boom',
      title: 'explodes',
      run: async () => {
        throw new Error('ENOENT: no such file');
      },
    };
    const report = await runDoctor([boom], doctorContext());
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('fail');
    expect(report.checks[0]?.detail).toContain('ENOENT');
    expect(report.checks[0]?.remediation).toContain('janus doctor');
  });

  it('refuses a non-pass finding with no remediation (§10 of the plan; every failure tells the operator what to do)', async () => {
    const bad = check('bad', [{ id: 'bad', title: 'Bad', status: 'fail', detail: 'x', remediation: null }]);
    await expect(runDoctor([bad], doctorContext())).rejects.toBeInstanceOf(DoctorContractError);
  });

  it('refuses two findings with the same id, because --json consumers key on it', async () => {
    const one = check('dup', [{ id: 'dup', title: 'One', status: 'pass', detail: 'a', remediation: null }]);
    const two = check('dup2', [{ id: 'dup', title: 'Two', status: 'pass', detail: 'b', remediation: null }]);
    await expect(runDoctor([one, two], doctorContext())).rejects.toBeInstanceOf(DoctorContractError);
  });
});

describe('doctorExitCode', () => {
  it('fails the command only when a check failed', async () => {
    const failing = await runDoctor([check('c', [{ id: 'c', title: 'C', status: 'fail', detail: 'x', remediation: 'y' }])], doctorContext());
    const warning = await runDoctor([check('w', [{ id: 'w', title: 'W', status: 'warn', detail: 'x', remediation: 'y' }])], doctorContext());
    const skipped = await runDoctor([check('s', [{ id: 's', title: 'S', status: 'skip', detail: 'x', remediation: 'y' }])], doctorContext());
    expect(doctorExitCode(failing)).toBe(ExitCode.UnexpectedError);
    expect(doctorExitCode(warning)).toBe(ExitCode.Ok);
    expect(doctorExitCode(skipped)).toBe(ExitCode.Ok);
  });
});

describe('rendering', () => {
  it('prints one line per check, the remediation under a failure, and a summary line', async () => {
    const report = await runDoctor(
      [
        check('codex.binary', [{ id: 'codex.binary', title: 'codex CLI', status: 'pass', detail: 'codex-cli 0.146.0', remediation: null }]),
        check('pnpm.store', [
          { id: 'pnpm.store', title: 'pnpm store is writable', status: 'fail', detail: 'EACCES', remediation: 'chmod u+w the store directory' },
        ]),
      ],
      doctorContext(),
    );
    const text = renderDoctorHuman(report);
    expect(text).toContain('[ok]   codex.binary');
    expect(text).toContain('[fail] pnpm.store');
    expect(text).toContain('-> chmod u+w the store directory');
    expect(text).toContain('2 checks: 1 ok, 0 warnings, 1 failed, 0 skipped');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('emits a parseable, stable --json document', async () => {
    const report = await runDoctor([check('a', [{ id: 'a', title: 'A', status: 'pass', detail: 'fine', remediation: null }])], doctorContext());
    const parsed = JSON.parse(doctorJson(report)) as Record<string, unknown>;
    expect(parsed['version']).toBe(1);
    expect(parsed['generated_at']).toBe('2026-09-20T12:00:00.000Z');
    expect(Object.keys(parsed).sort()).toEqual(['checks', 'generated_at', 'summary', 'version', 'workspace']);
    expect((parsed['checks'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'a',
      title: 'A',
      status: 'pass',
      detail: 'fine',
      remediation: null,
    });
  });
});
