import { describe, expect, it } from 'vitest';
import { isRunnerConfig, runnerConfigCheck, thresholdsIn } from '../../src/policy/checks/runner-config.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('isRunnerConfig', () => {
  it('recognises karma, jest and vitest configs in every extension', () => {
    for (const path of [
      'karma.conf.js',
      'karma.conf.ts',
      'projects/ui-kit/karma.conf.js',
      'jest.config.js',
      'jest.config.mjs',
      'jest.config.ts',
      'jest.config.json',
      'vitest.config.ts',
    ]) {
      expect(isRunnerConfig(path)).toBe(true);
    }
  });

  it('does not claim ordinary config', () => {
    for (const path of ['angular.json', 'tsconfig.json', 'src/karma.ts', 'jest.setup.ts']) {
      expect(isRunnerConfig(path)).toBe(false);
    }
  });
});

describe('thresholdsIn', () => {
  it('reads the coverage keys and keeps the highest value per key', () => {
    expect(thresholdsIn(['statements: 80,', 'branches: 70,', 'statements: 90,'])).toEqual(
      new Map([
        ['statements', 90],
        ['branches', 70],
      ]),
    );
  });

  it('reads quoted and decimal values', () => {
    expect(thresholdsIn(['"lines": 77.5,'])).toEqual(new Map([['lines', 77.5]]));
  });

  it('is empty for lines with no threshold', () => {
    expect(thresholdsIn(['const x = 1;'])).toEqual(new Map());
  });
});

describe('runnerConfigCheck', () => {
  it('does not run when no runner config changed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', added: ['const a = 1;'] }] });
    expect(await runnerConfigCheck.run(ctx)).toBeNull();
  });

  it('allows a runner config to change without touching thresholds or exclusions', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'karma.conf.js',
          removed: ["    require('karma-jasmine'),"],
          added: ["    require('karma-jasmine'),", "    require('@angular-devkit/build-angular/plugins/karma'),"],
        },
      ],
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a lowered coverage threshold', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      statements: 80,'], added: ['      statements: 40,'] }],
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('jest.config.js');
    expect(findings?.[0]?.detail).toContain('statements');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('flags a coverage threshold that was removed entirely', async () => {
    const ctx = policyContext({ files: [{ path: 'jest.config.js', removed: ['      branches: 60,'] }] });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings?.[0]?.detail).toContain('removed');
    expect(findings?.[0]?.detail).toContain('branches');
  });

  it('allows a raised coverage threshold', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      lines: 70,'], added: ['      lines: 85,'] }],
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags an added exclusion', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["  testPathIgnorePatterns: ['<rootDir>/src/legacy/'],"] }],
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('testPathIgnorePatterns');
    expect(findings?.[0]?.evidence).toContain('legacy');
  });

  it('flags a karma exclude block', async () => {
    const ctx = policyContext({ files: [{ path: 'karma.conf.js', added: ["      exclude: ['**/flaky.spec.ts'],"] }] });
    expect(await runnerConfigCheck.run(ctx)).toHaveLength(1);
  });

  it('ignores a threshold change in a file that is not a runner config', async () => {
    const ctx = policyContext({ files: [{ path: 'src/app.ts', removed: ['statements: 80,'], added: ['statements: 10,'] }] });
    expect(await runnerConfigCheck.run(ctx)).toBeNull();
  });
});
