import { describe, expect, it } from 'vitest';
import { lockfileScopeCheck } from '../../src/policy/checks/lockfile.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('lockfileScopeCheck', () => {
  it('does not run before a plan is approved', async () => {
    const ctx = policyContext({ allowedScope: null, files: [{ path: 'package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toBeNull();
  });

  it('does not run when no manifest changed', async () => {
    const ctx = policyContext({ allowedScope: ['src/**'], files: [{ path: 'src/a.ts' }] });
    expect(await lockfileScopeCheck.run(ctx)).toBeNull();
  });

  it('passes when the sibling lockfile is inside the scope', async () => {
    const ctx = policyContext({ allowedScope: ['package.json', 'pnpm-lock.yaml'], files: [{ path: 'package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toEqual([]);
  });

  it('passes when a broad scope covers the lockfile', async () => {
    const ctx = policyContext({ allowedScope: ['**'], files: [{ path: 'projects/ui-kit/package.json' }] });
    expect(await lockfileScopeCheck.run(ctx)).toEqual([]);
  });

  it('warns — not violates — when package.json is in scope but no lockfile is', async () => {
    const ctx = policyContext({ allowedScope: ['package.json', 'src/**'], files: [{ path: 'package.json' }] });
    const findings = await lockfileScopeCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('lockfile.scope');
    expect(findings?.[0]?.severity).toBe('warning');
    expect(findings?.[0]?.path).toBe('package.json');
    expect(findings?.[0]?.detail).toContain('pnpm-lock.yaml');
  });

  it('warns once per manifest, not once per lockfile candidate', async () => {
    const ctx = policyContext({
      allowedScope: ['**/package.json'],
      files: [{ path: 'package.json' }, { path: 'projects/ui-kit/package.json' }],
    });
    expect(await lockfileScopeCheck.run(ctx)).toHaveLength(2);
  });

  it('names the directory the lockfile would sit in for a nested manifest', async () => {
    const ctx = policyContext({ allowedScope: ['projects/**/package.json'], files: [{ path: 'projects/ui-kit/package.json' }] });
    expect((await lockfileScopeCheck.run(ctx))?.[0]?.detail).toContain('projects/ui-kit/pnpm-lock.yaml');
  });
});
