import { describe, expect, it } from 'vitest';
import { ALL_CHECKS } from '../../src/doctor/index.js';
import { doctorContext, stubFs } from '../helpers/doctor-fixtures.js';

/** Fails every subprocess and every HTTP probe: the worst case each check has to describe. */
const hostile = () =>
  doctorContext({
    run: async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'simulated failure', timedOut: false, spawnFailed: false, durationMs: 1 }),
    http: async () => ({ ok: false, status: 500, error: null }),
    fs: stubFs({ writableError: 'EROFS: read-only file system' }),
  });

describe('ALL_CHECKS', () => {
  it('covers every check tasks.md T07 names, in report order, with unique ids', () => {
    expect(ALL_CHECKS.map((check) => check.id)).toEqual([
      'codex.binary',
      'codex.login',
      'git.identity',
      'tokens',
      'sandbox.user_namespaces',
      'codex.probe.read_only',
      'codex.probe.workspace_write',
      'codex.probe.ng_update',
      'codex.model',
      'pnpm.store',
      'state.branch_spec',
      'provider.ci',
      'provider.scm',
    ]);
    expect(new Set(ALL_CHECKS.map((check) => check.id)).size).toBe(ALL_CHECKS.length);
    expect(ALL_CHECKS.every((check) => check.title.trim().length > 0)).toBe(true);
  });

  it('gives every non-pass finding a remediation, on the worst-case path, for every check', async () => {
    for (const check of ALL_CHECKS) {
      const findings = await check.run(hostile());
      expect(findings.length, check.id).toBeGreaterThan(0);
      for (const finding of findings) {
        expect(finding.id === check.id || finding.id.startsWith(`${check.id}[`), `${check.id} -> ${finding.id}`).toBe(true);
        expect(finding.title.trim().length, finding.id).toBeGreaterThan(0);
        expect(finding.detail.trim().length, finding.id).toBeGreaterThan(0);
        if (finding.status !== 'pass') {
          expect(finding.remediation, finding.id).not.toBeNull();
          expect((finding.remediation ?? '').trim().length, finding.id).toBeGreaterThan(10);
        }
      }
    }
  });

  it('skips every config-dependent check outside a workspace instead of failing it', async () => {
    const outside = doctorContext({
      config: null,
      goal: null,
      paths: null,
      run: async () => ({ exitCode: 0, signal: null, stdout: 'ok', stderr: '', timedOut: false, spawnFailed: false, durationMs: 1 }),
      http: async () => ({ ok: true, status: 200, error: null }),
    });
    const configDependent = ['tokens', 'codex.model', 'pnpm.store', 'state.branch_spec', 'provider.ci', 'provider.scm'];
    for (const check of ALL_CHECKS.filter((candidate) => configDependent.includes(candidate.id))) {
      const findings = await check.run(outside);
      expect(findings.map((f) => f.status), check.id).toEqual(['skip']);
    }
  });
});
