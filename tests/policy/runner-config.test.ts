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
  it('reads the coverage keys and returns all values, sorted ascending', () => {
    expect(thresholdsIn('statements: 80,\nbranches: 70,\nstatements: 90,')).toEqual(
      new Map([
        ['statements', [80, 90]],
        ['branches', [70]],
      ]),
    );
  });

  it('reads quoted and decimal values', () => {
    expect(thresholdsIn('"lines": 77.5,')).toEqual(new Map([['lines', [77.5]]]));
  });

  it('is empty for source with no threshold', () => {
    expect(thresholdsIn('const x = 1;')).toEqual(new Map());
  });

  it('strips comments before matching', () => {
    expect(thresholdsIn('// statements: 80,\nstatements: 90,')).toEqual(new Map([['statements', [90]]]));
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
      head: { 'karma.conf.js': "// config\n    require('karma-jasmine')," },
      working: { 'karma.conf.js': "// config\n    require('karma-jasmine'),\n    require('@angular-devkit/build-angular/plugins/karma')," },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a single lowered coverage threshold', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      statements: 80,'], added: ['      statements: 40,'] }],
      head: { 'jest.config.js': 'statements: 80,' },
      working: { 'jest.config.js': 'statements: 40,' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('jest.config.js');
    expect(findings?.[0]?.detail).toContain('statements');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('flags a lowered threshold among multiple when a higher decoy was added (case 1)', async () => {
    // [80] -> [40, 99]: must flag 80->40, not mask it with 99
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["statements: 80,"], added: ["statements: 40,", "'./scratch/**': { statements: 99 },"] }],
      head: { 'jest.config.js': 'statements: 80,' },
      working: { 'jest.config.js': "statements: 40,\n'./scratch/**': { statements: 99 }," },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('40');
    expect(findings?.[0]?.detail).toContain('80');
  });

  it('flags a lowered global threshold with multiple levels (case 2)', async () => {
    // [20, 80] -> [20, 40]: must flag 80->40, not mask it
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["global: { statements: 80 }", "override: { statements: 20 }"], added: ["global: { statements: 40 }", "override: { statements: 20 }"] }],
      head: { 'jest.config.js': 'global: { statements: 80 }\noverride: { statements: 20 }' },
      working: { 'jest.config.js': 'global: { statements: 40 }\noverride: { statements: 20 }' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('allows a raised coverage threshold', async () => {
    // [50] -> [80]: no flag
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      lines: 50,'], added: ['      lines: 80,'] }],
      head: { 'jest.config.js': 'lines: 50,' },
      working: { 'jest.config.js': 'lines: 80,' },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('allows a no-op threshold reformat', async () => {
    // [80] -> [80]: no flag, even if the line is reformatted
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['statements: 80'], added: ['statements  :  80'] }],
      head: { 'jest.config.js': 'statements: 80' },
      working: { 'jest.config.js': 'statements  :  80' },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a new lenient override alongside an existing stricter one (case 5)', async () => {
    // [80] -> [20, 80]: adding a new lower override is a violation
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["'./legacy/**': { statements: 20 }"] }],
      head: { 'jest.config.js': 'global: { statements: 80 }' },
      working: { 'jest.config.js': "global: { statements: 80 }\n'./legacy/**': { statements: 20 }" },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('statements');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('20');
  });

  it('allows removal of a lenient override when the global threshold stays strict (case 6)', async () => {
    // [20, 80] -> [80]: removing the lower override is a strengthening, no flag
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["'./legacy/**': { statements: 20 }"] }],
      head: { 'jest.config.js': "global: { statements: 80 }\n'./legacy/**': { statements: 20 }" },
      working: { 'jest.config.js': 'global: { statements: 80 }' },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a coverage threshold that was removed entirely', async () => {
    // [80] -> []: must flag removed
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ['      branches: 60,'] }],
      head: { 'jest.config.js': 'branches: 60,' },
      working: { 'jest.config.js': '' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('jest.config.js');
    expect(findings?.[0]?.detail).toContain('removed');
    expect(findings?.[0]?.detail).toContain('branches');
  });

  it('flags an added exclusion pattern (new key in HEAD)', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["  testPathIgnorePatterns: ['<rootDir>/src/legacy/'],"] }],
      head: { 'jest.config.js': 'module.exports = { /* no exclusions */ };' },
      working: { 'jest.config.js': "module.exports = { testPathIgnorePatterns: ['<rootDir>/src/legacy/'] };" },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('jest.config.js');
    expect(findings?.[0]?.detail).toContain('testPathIgnorePatterns');
    expect(findings?.[0]?.evidence).toContain('legacy');
  });

  it('flags an added exclusion pattern in the exclusion key', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["  testPathIgnorePatterns: ['<rootDir>/src/new-legacy/'],"] }],
      head: { 'jest.config.js': "testPathIgnorePatterns: ['<rootDir>/src/legacy/']" },
      working: { 'jest.config.js': "testPathIgnorePatterns: ['<rootDir>/src/legacy/', '<rootDir>/src/new-legacy/']" },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('testPathIgnorePatterns');
    expect(findings?.[0]?.detail).toContain('new-legacy');
  });

  it('allows narrowing an exclusion list (removing patterns)', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["  testPathIgnorePatterns: ['<rootDir>/src/legacy/', '<rootDir>/src/old.spec.ts'],"], added: ["  testPathIgnorePatterns: ['<rootDir>/src/legacy/'],"] }],
      head: { 'jest.config.js': "testPathIgnorePatterns: ['<rootDir>/src/legacy/', '<rootDir>/src/old.spec.ts']" },
      working: { 'jest.config.js': "testPathIgnorePatterns: ['<rootDir>/src/legacy/']" },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('allows reformatting an exclusion list', async () => {
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["testPathIgnorePatterns: ['<rootDir>/src/legacy/'],"], added: ["testPathIgnorePatterns: [\n'<rootDir>/src/legacy/',\n],"] }],
      head: { 'jest.config.js': "testPathIgnorePatterns: ['<rootDir>/src/legacy/']," },
      working: { 'jest.config.js': "testPathIgnorePatterns: [\n'<rootDir>/src/legacy/',\n]," },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('flags a karma exclude block', async () => {
    const ctx = policyContext({
      files: [{ path: 'karma.conf.js', added: ["      exclude: ['**/flaky.spec.ts'],"] }],
      head: { 'karma.conf.js': 'module.exports = {};' },
      working: { 'karma.conf.js': "module.exports = { exclude: ['**/flaky.spec.ts'] };" },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.path).toBe('karma.conf.js');
    expect(findings?.[0]?.detail).toContain('exclude');
  });

  it('flags a lowered threshold with descending alignment ([20, 80] -> [40])', async () => {
    // [20, 80] -> [40]: Ascending would compare 20 vs 40 (no flag), but descending catches 80 vs 40
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["global: { statements: 80 }", "override: { statements: 20 }"], added: ["global: { statements: 40 }"] }],
      head: { 'jest.config.js': 'global: { statements: 80 }\noverride: { statements: 20 }' },
      working: { 'jest.config.js': 'global: { statements: 40 }' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('statements');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('flags a middle value lowering with triple nesting ([10, 50, 80] -> [10, 40, 80])', async () => {
    // [10, 50, 80] -> [10, 40, 80]: Middle value dropped from 50 to 40
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["override1: { statements: 10 }", "override2: { statements: 40 }", "global: { statements: 80 }"] }],
      head: { 'jest.config.js': 'override1: { statements: 10 }\noverride2: { statements: 50 }\nglobal: { statements: 80 }' },
      working: { 'jest.config.js': 'override1: { statements: 10 }\noverride2: { statements: 40 }\nglobal: { statements: 80 }' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('50');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('allows deduped values ([50, 50] -> [50])', async () => {
    // [50, 50] -> [50]: Removing a duplicate is not a lowering
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', removed: ["override: { statements: 50 }"] }],
      head: { 'jest.config.js': 'global: { statements: 50 }\noverride: { statements: 50 }' },
      working: { 'jest.config.js': 'global: { statements: 50 }' },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('allows adding a stricter override ([80] -> [80, 90])', async () => {
    // [80] -> [80, 90]: Adding a stricter override (90%) is not a lowering
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["override: { statements: 90 }"] }],
      head: { 'jest.config.js': 'global: { statements: 80 }' },
      working: { 'jest.config.js': 'global: { statements: 80 }\noverride: { statements: 90 }' },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });

  it('ignores a threshold change in a file that is not a runner config', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/app.ts', removed: ['statements: 80,'], added: ['statements: 10,'] }],
    });
    expect(await runnerConfigCheck.run(ctx)).toBeNull();
  });

  it('judges a rename out of runner-config naming by the old path too (git mv to .disabled)', async () => {
    // IMPORTANT 4 repro: filtering on isRunnerConfig(file.path) alone made `git mv karma.conf.js
    // karma.conf.js.disabled` invisible to this check — 0 findings AND absent from checks_run — even though the
    // rename disables the config exactly as effectively as deleting it. The check must run (and catch a
    // threshold lowered in the same diff) whichever name — new or old — is a runner config.
    const ctx = policyContext({
      files: [
        {
          path: 'karma.conf.js.disabled',
          status: 'R',
          previousPath: 'karma.conf.js',
          removed: ['statements: 80,'],
          added: ['statements: 40,'],
        },
      ],
      head: { 'karma.conf.js': 'statements: 80,' },
      working: { 'karma.conf.js.disabled': 'statements: 40,' },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).not.toBeNull();
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('80');
    expect(findings?.[0]?.detail).toContain('40');
  });

  it('flags moving an existing HEAD pattern from an inclusion key into an exclusion key', async () => {
    // IMPORTANT 5 repro: headPatterns used to be built from every quoted literal in the whole HEAD file, under
    // any key. HEAD already has an exclusion key (testPathIgnorePatterns, with only 'node_modules' excluded) and
    // separately quotes 'src/app/calc.spec.ts' under testRegex (an inclusion key). Once the exclusion key exists
    // in HEAD at all, the old code compared a newly-added exclusion literal against every literal in the whole
    // file — so adding 'src/app/calc.spec.ts' to the exclusion list read as "already in HEAD" and was invisible,
    // even though it was never excluded there. Only literals that were themselves under an exclusion key in
    // HEAD may count as "already excluded".
    const ctx = policyContext({
      files: [
        {
          path: 'jest.config.js',
          removed: ["  testPathIgnorePatterns: ['node_modules'],"],
          added: ["  testPathIgnorePatterns: ['node_modules', 'src/app/calc.spec.ts'],"],
        },
      ],
      head: { 'jest.config.js': "testRegex: 'src/app/calc.spec.ts',\n  testPathIgnorePatterns: ['node_modules']," },
      working: {
        'jest.config.js': "testRegex: 'src/app/calc.spec.ts',\n  testPathIgnorePatterns: ['node_modules', 'src/app/calc.spec.ts'],",
      },
    });
    const findings = await runnerConfigCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('runner_config.weakened');
    expect(findings?.[0]?.detail).toContain('testPathIgnorePatterns');
    expect(findings?.[0]?.detail).toContain('calc.spec.ts');
  });

  it('still allows a literal that is genuinely already under the same exclusion key', async () => {
    // Companion to the move-detection test above: reformatting or duplicating an already-excluded pattern must
    // not start flagging once headPatterns is scoped to exclusion-key lines only.
    const ctx = policyContext({
      files: [{ path: 'jest.config.js', added: ["  testPathIgnorePatterns: ['node_modules', 'node_modules'],"] }],
      head: { 'jest.config.js': "testPathIgnorePatterns: ['node_modules']," },
      working: { 'jest.config.js': "testPathIgnorePatterns: ['node_modules', 'node_modules']," },
    });
    expect(await runnerConfigCheck.run(ctx)).toEqual([]);
  });
});
