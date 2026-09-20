import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  policyAttemptId,
  policyEvidencePath,
  policyPatchPath,
  renderPolicyReportForAgent,
  runPolicyChecks,
  writePolicyEvidence,
  writePolicyPatch,
} from '../../src/policy/report.js';
import type { PolicyCheck, PolicyReport } from '../../src/policy/types.js';
import { workspacePaths } from '../../src/workspace/layout.js';
import { tempDir } from '../helpers/git-fixtures.js';
import { policyContext, policyReportFixture } from '../helpers/policy-fixtures.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');

function inputs(overrides: Partial<Parameters<typeof runPolicyChecks>[0]> = {}): Parameters<typeof runPolicyChecks>[0] {
  return {
    ctx: policyContext(),
    attemptId: 'wp-01-ui-kit-a1',
    workPackageId: 'wp-01',
    repo: 'ui-kit',
    runId: 'run-0001',
    phase: 'initial',
    now: NOW,
    ...overrides,
  };
}

describe('policyAttemptId', () => {
  it('names the package, the repo and the attempt', () => {
    expect(policyAttemptId('wp-01-ui-kit-angular', 'ui-kit', 2)).toBe('wp-01-ui-kit-angular-ui-kit-a2');
  });
});

describe('runPolicyChecks', () => {
  it('passes a clean diff and records exactly the checks that ran, in registry order', async () => {
    const report = await runPolicyChecks(
      inputs({ ctx: policyContext({ allowedScope: ['src/**'], files: [{ path: 'src/a.ts', added: ['const a = 1;'] }] }) }),
    );
    expect(report.passed).toBe(true);
    expect(report.violations).toEqual([]);
    // Only these five apply to a single non-manifest, non-runner-config file with a scope configured; the other
    // five (tests.count_decreased, runner_config.weakened, angular.version_beyond_target, size.limits,
    // lockfile.scope) all return null here and must be absent, not merely unchecked.
    expect(report.checks_run).toEqual([
      'tests.forbidden_pattern_added',
      'tests.file_removed',
      'paths.forbidden',
      'scope.outside_allowed',
      'secrets.detected',
    ]);
    expect(report.checked_at).toBe('2026-09-20T12:00:00.000Z');
  });

  it('leaves a check that could not run out of checks_run', async () => {
    const report = await runPolicyChecks(inputs({ ctx: policyContext({ allowedScope: null, files: [{ path: 'src/a.ts' }] }) }));
    expect(report.checks_run).not.toContain('scope.outside_allowed');
    expect(report.checks_run).not.toContain('lockfile.scope');
    expect(report.checks_run).toContain('paths.forbidden');
  });

  it('splits violations from warnings and fails only on violations', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          allowedScope: ['package.json', '.github/**'],
          files: [{ path: 'package.json', added: ['  "x": 1'] }, { path: '.github/ci.yml', added: ['on: push'] }],
        }),
      }),
    );
    expect(report.violations.map((finding) => finding.check)).toEqual(['paths.forbidden']);
    expect(report.warnings.map((finding) => finding.check)).toEqual(['lockfile.scope']);
    expect(report.passed).toBe(false);
  });

  it('passes when the only finding is a warning: lockfile.scope alone never blocks the commit', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          allowedScope: ['package.json'],
          files: [{ path: 'package.json', added: ['  "x": 1'] }],
        }),
      }),
    );
    expect(report.violations).toEqual([]);
    expect(report.warnings.map((finding) => finding.check)).toEqual(['lockfile.scope']);
    expect(report.passed).toBe(true);
  });

  it('describes every changed file with its counts', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          files: [
            { path: 'src/a.ts', added: ['one', 'two'], removed: ['old'] },
            { path: 'pnpm-lock.yaml', generated: true, added: ['x'] },
            { path: 'src/b.ts', status: 'R', previousPath: 'src/old.ts' },
          ],
        }),
      }),
    );
    expect(report.files).toContainEqual({
      path: 'src/a.ts',
      status: 'M',
      previous_path: null,
      added: 2,
      removed: 1,
      binary: false,
      generated: false,
    });
    expect(report.files.find((file) => file.path === 'pnpm-lock.yaml')?.generated).toBe(true);
    expect(report.files.find((file) => file.path === 'src/b.ts')?.previous_path).toBe('src/old.ts');
    expect(report.totals).toEqual({ changed_files: 3, added_lines: 3, removed_lines: 1 });
  });

  it('describes an added file, a deleted file and a binary file with every report field', async () => {
    const report = await runPolicyChecks(
      inputs({
        ctx: policyContext({
          files: [
            { path: 'src/new.ts', status: 'A', added: ['export const a = 1;'] },
            { path: 'src/old.ts', status: 'D', removed: ['export const b = 1;'] },
            { path: 'assets/logo.png', status: 'M', binary: true },
          ],
        }),
      }),
    );
    expect(report.files).toContainEqual({
      path: 'src/new.ts',
      status: 'A',
      previous_path: null,
      added: 1,
      removed: 0,
      binary: false,
      generated: false,
    });
    expect(report.files).toContainEqual({
      path: 'src/old.ts',
      status: 'D',
      previous_path: null,
      added: 0,
      removed: 1,
      binary: false,
      generated: false,
    });
    expect(report.files).toContainEqual({
      path: 'assets/logo.png',
      status: 'M',
      previous_path: null,
      added: 0,
      removed: 0,
      binary: true,
      generated: false,
    });
  });

  it('carries the identifying fields onto the report', async () => {
    const report = await runPolicyChecks(inputs({ phase: 'recheck', runId: null }));
    expect(report.attempt_id).toBe('wp-01-ui-kit-a1');
    expect(report.work_package).toBe('wp-01');
    expect(report.repo).toBe('ui-kit');
    expect(report.phase).toBe('recheck');
    expect(report.run_id).toBeNull();
  });

  it('runs only the checks it was given, when a caller narrows the set', async () => {
    const report = await runPolicyChecks(
      inputs({ checks: [], ctx: policyContext({ files: [{ path: '.github/ci.yml' }] }) }),
    );
    expect(report.checks_run).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('names which check threw, and aborts the run rather than continuing past it', async () => {
    const throwingCheck: PolicyCheck = {
      id: 'secrets.detected',
      title: 'a check that always throws',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    await expect(runPolicyChecks(inputs({ checks: [throwingCheck] }))).rejects.toThrow(
      'policy check "secrets.detected" threw while running: kaboom',
    );
  });
});

describe('writePolicyEvidence and writePolicyPatch', () => {
  it('writes the report as YAML and returns its .janus-relative path', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    const report: PolicyReport = policyReportFixture({ passed: false, violations: [
      { check: 'paths.forbidden', severity: 'violation', path: '.github/ci.yml', line: null, detail: 'forbidden', evidence: null },
    ] });
    const relative = writePolicyEvidence(paths, report);
    expect(relative).toBe('evidence/policy/wp-01-ui-kit-a1.yaml');
    const parsed = parse(readFileSync(policyEvidencePath(paths.janusDir, 'wp-01-ui-kit-a1'), 'utf8')) as PolicyReport;
    expect(parsed.violations[0]?.check).toBe('paths.forbidden');
    expect(parsed.passed).toBe(false);
  });

  it('serialises file fields as snake_case in the raw YAML, never camelCase', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    const report: PolicyReport = policyReportFixture({
      files: [
        { path: 'src/b.ts', status: 'R', previous_path: 'src/old.ts', added: 1, removed: 0, binary: false, generated: false },
      ],
    });
    writePolicyEvidence(paths, report);
    const raw = readFileSync(policyEvidencePath(paths.janusDir, report.attempt_id), 'utf8');
    expect(raw).toContain('previous_path');
    expect(raw).not.toContain('previousPath');
  });

  it('writes the patch beside the report', () => {
    const paths = workspacePaths(join(tempDir(), 'ws'));
    const relative = writePolicyPatch(paths, 'wp-01-ui-kit-a1', 'diff --git a/a b/a\n');
    expect(relative).toBe('evidence/policy/wp-01-ui-kit-a1.patch');
    expect(readFileSync(policyPatchPath(paths.janusDir, 'wp-01-ui-kit-a1'), 'utf8')).toContain('diff --git');
  });
});

describe('renderPolicyReportForAgent', () => {
  it('names each violation with its check id, path and detail', () => {
    const text = renderPolicyReportForAgent(
      policyReportFixture({
        passed: false,
        violations: [
          { check: 'scope.outside_allowed', severity: 'violation', path: 'angular.json', line: null, detail: 'outside scope', evidence: null },
          { check: 'tests.forbidden_pattern_added', severity: 'violation', path: 'a.spec.ts', line: 12, detail: 'adds xit(', evidence: "xit('x')" },
        ],
        warnings: [{ check: 'lockfile.scope', severity: 'warning', path: 'package.json', line: null, detail: 'no lockfile in scope', evidence: null }],
      }),
    );
    expect(text).toContain('scope.outside_allowed');
    expect(text).toContain('angular.json');
    expect(text).toContain('a.spec.ts:12');
    expect(text).toContain("xit('x')");
    expect(text).toContain('WARNING');
    expect(text).toContain('lockfile.scope');
  });

  it('says so plainly when the report passed', () => {
    expect(renderPolicyReportForAgent(policyReportFixture())).toContain('no violations');
  });
});
