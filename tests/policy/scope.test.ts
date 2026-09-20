import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import { allowedScopeCheck, diffSizeCheck, forbiddenPathsCheck } from '../../src/policy/checks/scope.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('forbiddenPathsCheck', () => {
  it('passes when nothing touches a forbidden path', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await forbiddenPathsCheck.run(ctx)).toEqual([]);
  });

  it('flags a file under a configured forbidden path', async () => {
    const ctx = policyContext({ files: [{ path: '.github/workflows/ci.yml', added: ['on: push'] }] });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('paths.forbidden');
    expect(findings?.[0]?.severity).toBe('violation');
    expect(findings?.[0]?.path).toBe('.github/workflows/ci.yml');
    expect(findings?.[0]?.detail).toContain('.github/**');
  });

  it('flags a rename that moves a file INTO a forbidden path', async () => {
    const ctx = policyContext({
      files: [{ path: '.teamcity/settings.kts', status: 'R', previousPath: 'settings.kts' }],
    });
    expect(await forbiddenPathsCheck.run(ctx)).toHaveLength(1);
  });

  it('flags a rename that moves a file OUT of a forbidden path', async () => {
    const ctx = policyContext({
      files: [{ path: 'settings.kts', status: 'R', previousPath: '.teamcity/settings.kts' }],
    });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.path).toBe('.teamcity/settings.kts');
  });

  it('honours a configured forbidden-path list that is not the default', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { forbidden_paths: ['infra/**'] },
    });
    const ctx = policyContext({ config, files: [{ path: '.github/workflows/ci.yml' }, { path: 'infra/main.tf' }] });
    const findings = await forbiddenPathsCheck.run(ctx);
    expect(findings?.map((f) => f.path)).toEqual(['infra/main.tf']);
  });
});

describe('allowedScopeCheck', () => {
  it('does not run before a plan is approved', async () => {
    const ctx = policyContext({ allowedScope: null, files: [{ path: 'anything.ts' }] });
    expect(await allowedScopeCheck.run(ctx)).toBeNull();
  });

  it('passes when every path is inside the scope', async () => {
    const ctx = policyContext({
      allowedScope: ['package.json', 'pnpm-lock.yaml', 'src/**'],
      files: [{ path: 'package.json' }, { path: 'pnpm-lock.yaml' }, { path: 'src/app/a.ts' }],
    });
    expect(await allowedScopeCheck.run(ctx)).toEqual([]);
  });

  it('flags a file outside the scope and names the scope it was judged against', async () => {
    const ctx = policyContext({ allowedScope: ['src/**'], files: [{ path: 'angular.json' }] });
    const findings = await allowedScopeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('scope.outside_allowed');
    expect(findings?.[0]?.path).toBe('angular.json');
    expect(findings?.[0]?.detail).toContain('src/**');
  });

  it('requires both names of a rename to be in scope', async () => {
    const ctx = policyContext({
      allowedScope: ['src/**'],
      files: [{ path: 'src/b.ts', status: 'R', previousPath: 'lib/a.ts' }],
    });
    const findings = await allowedScopeCheck.run(ctx);
    expect(findings?.map((f) => f.path)).toEqual(['lib/a.ts']);
  });

  it('reports one finding per file, not one per unmatched pattern', async () => {
    const ctx = policyContext({ allowedScope: ['src/**', 'projects/**'], files: [{ path: 'angular.json' }] });
    expect(await allowedScopeCheck.run(ctx)).toHaveLength(1);
  });
});

describe('diffSizeCheck', () => {
  it('does not run when neither cap is configured', async () => {
    const ctx = policyContext({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    expect(await diffSizeCheck.run(ctx)).toBeNull();
  });

  it('flags a diff over max_changed_files', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_changed_files: 1 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    const findings = await diffSizeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('size.limits');
    expect(findings?.[0]?.path).toBeNull();
    expect(findings?.[0]?.detail).toContain('max_changed_files');
    expect(findings?.[0]?.detail).toContain('2');
  });

  it('flags a diff over max_diff_lines, counting added and removed together', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_diff_lines: 3 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts', added: ['x', 'y'], removed: ['z', 'w'] }] });
    const findings = await diffSizeCheck.run(ctx);
    expect(findings?.[0]?.detail).toContain('max_diff_lines');
    expect(findings?.[0]?.detail).toContain('4');
  });

  it('passes when both caps are satisfied', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      guardrails: { max_changed_files: 10, max_diff_lines: 100 },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.ts', added: ['x'] }] });
    expect(await diffSizeCheck.run(ctx)).toEqual([]);
  });
});
