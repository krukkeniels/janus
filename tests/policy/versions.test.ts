import { describe, expect, it } from 'vitest';
import { angularVersionCheck } from '../../src/policy/checks/versions.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('angularVersionCheck', () => {
  it('does not run when no manifest changed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await angularVersionCheck.run(ctx)).toBeNull();
  });

  it('passes when every @angular dependency is at the target major', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [
        {
          path: 'package.json',
          added: ['    "@angular/core": "^16.2.0",', '    "@angular/cli": "~16.2.1",', '    "@angular/common": "16.2.0"'],
        },
      ],
    });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });

  it('passes when a dependency is below the target major', async () => {
    const ctx = policyContext({ targetVersion: 16, files: [{ path: 'package.json', added: ['"@angular/core": "^15.2.0",'] }] });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });

  it('flags a major above the target', async () => {
    const ctx = policyContext({ targetVersion: 16, files: [{ path: 'package.json', added: ['    "@angular/core": "^17.0.0",'] }] });
    const findings = await angularVersionCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('angular.version_beyond_target');
    expect(findings?.[0]?.detail).toContain('@angular/core');
    expect(findings?.[0]?.detail).toContain('17');
    expect(findings?.[0]?.detail).toContain('16');
  });

  it('reads a prerelease spec', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [{ path: 'package.json', added: ['"@angular/core": "17.0.0-next.3",'] }],
    });
    expect(await angularVersionCheck.run(ctx)).toHaveLength(1);
  });

  it('only looks at package.json files', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [
        { path: 'README.md', added: ['upgrade to "@angular/core": "^18.0.0" one day'] },
        { path: 'projects/ui-kit/package.json', added: ['"@angular/core": "^18.0.0"'] },
      ],
    });
    const findings = await angularVersionCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.path).toBe('projects/ui-kit/package.json');
  });

  it('ignores non-@angular scopes', async () => {
    const ctx = policyContext({
      targetVersion: 16,
      files: [{ path: 'package.json', added: ['"@angular-eslint/builder": "^17.0.0",', '"rxjs": "^7.8.0"'] }],
    });
    expect(await angularVersionCheck.run(ctx)).toEqual([]);
  });
});
