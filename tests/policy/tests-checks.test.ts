import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/config-schema.js';
import {
  countTestDeclarations,
  forbiddenTestPatternsCheck,
  isTautologicalExpectation,
  isTestFile,
  testCountCheck,
  testFileRemovalCheck,
} from '../../src/policy/checks/tests.js';
import { policyContext } from '../helpers/policy-fixtures.js';

describe('isTestFile', () => {
  it('recognises the spec and test suffixes in every JS/TS flavour', () => {
    for (const path of ['a.spec.ts', 'src/app/a.spec.ts', 'b.test.js', 'c.spec.tsx', 'd.test.mjs']) {
      expect(isTestFile(path)).toBe(true);
    }
  });

  it('recognises a __tests__ directory', () => {
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
  });

  it('does not claim ordinary source', () => {
    for (const path of ['src/app.ts', 'spec.ts', 'src/spectrum.ts', 'src/testing/harness.ts']) {
      expect(isTestFile(path)).toBe(false);
    }
  });
});

describe('forbiddenTestPatternsCheck', () => {
  it('passes a diff that adds an ordinary test', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', added: ["it('works', () => expect(sum(1, 2)).toBe(3));"] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('flags every configured pattern when it is ADDED', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["xit('skipped', () => {});", "describe.only('focus', () => {});"] }],
    });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings?.map((f) => f.detail.includes('xit(')).filter(Boolean)).toHaveLength(1);
    expect(findings?.map((f) => f.detail.includes('.only(')).filter(Boolean)).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.forbidden_pattern_added');
    expect(findings?.[0]?.line).toBe(1);
    expect(findings?.[0]?.evidence).toContain('xit(');
  });

  it('does not flag a pattern that was REMOVED', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', removed: ["xit('was skipped', () => {});"] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('flags a forbidden pattern added outside a test file too', async () => {
    const ctx = policyContext({ files: [{ path: 'karma.conf.js', added: ['  // fdescribe( left behind'] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toHaveLength(1);
  });

  it('flags a tautological expectation', async () => {
    const ctx = policyContext({
      files: [
        {
          path: 'a.spec.ts',
          added: ['    expect(true).toBe(true);', '    expect(result).toEqual(result);', '    expect(1).toBe(1);'],
        },
      ],
    });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings).toHaveLength(3);
    expect(findings?.every((f) => f.detail.includes('tautological'))).toBe(true);
  });

  it('does not call a real expectation tautological', async () => {
    const ctx = policyContext({ files: [{ path: 'a.spec.ts', added: ['expect(actual).toBe(expected);'] }] });
    expect(await forbiddenTestPatternsCheck.run(ctx)).toEqual([]);
  });

  it('honours a configured pattern list', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { forbidden_test_patterns: ['pending('] },
    });
    const ctx = policyContext({ config, files: [{ path: 'a.spec.ts', added: ["xit('x', () => {});", 'pending();'] }] });
    const findings = await forbiddenTestPatternsCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.detail).toContain('pending(');
  });
});

describe('isTautologicalExpectation', () => {
  it('finds a literal compared to itself', () => {
    expect(isTautologicalExpectation('expect(false).toBe(false);')).toBe('expect(false).toBe(false)');
  });

  it('finds an expression compared to itself', () => {
    expect(isTautologicalExpectation('expect(user.id).toStrictEqual(user.id)')).not.toBeNull();
  });

  it('finds expect(true).toBeTruthy()', () => {
    expect(isTautologicalExpectation('expect(true).toBeTruthy();')).not.toBeNull();
  });

  it('returns null for a real assertion', () => {
    expect(isTautologicalExpectation('expect(a).toBe(b)')).toBeNull();
    expect(isTautologicalExpectation('const x = 1;')).toBeNull();
  });
});

describe('testFileRemovalCheck', () => {
  it('passes when no test file was removed', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', status: 'D' }] });
    expect(await testFileRemovalCheck.run(ctx)).toEqual([]);
  });

  it('flags a deleted test file', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.spec.ts', status: 'D' }] });
    const findings = await testFileRemovalCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.file_removed');
    expect(findings?.[0]?.path).toBe('src/a.spec.ts');
  });

  it('flags a renamed test file by its old name', async () => {
    const ctx = policyContext({
      files: [{ path: 'src/a.spec.disabled.ts', status: 'R', previousPath: 'src/a.spec.ts' }],
    });
    const findings = await testFileRemovalCheck.run(ctx);
    expect(findings?.[0]?.path).toBe('src/a.spec.ts');
    expect(findings?.[0]?.detail).toContain('src/a.spec.disabled.ts');
  });

  it('allows the removal when the package allows it', async () => {
    const ctx = policyContext({ allowTestFileDeletion: true, files: [{ path: 'src/a.spec.ts', status: 'D' }] });
    expect(await testFileRemovalCheck.run(ctx)).toEqual([]);
  });
});

describe('countTestDeclarations', () => {
  it('counts it and test calls, including modifiers', () => {
    const source = [
      "describe('suite', () => {",
      "  it('one', () => {});",
      "  it.each([1])('two', () => {});",
      "  test('three', () => {});",
      '});',
    ].join('\n');
    expect(countTestDeclarations(source)).toBe(3);
  });

  it('does not count a method call that merely ends in it', () => {
    expect(countTestDeclarations('await page.submit();\nconst x = unit(1);\nfoo.it(2);')).toBe(0);
  });

  it('counts a declaration at the start of a line', () => {
    expect(countTestDeclarations("it('one', () => {});")).toBe(1);
  });
});

describe('testCountCheck', () => {
  it('does not run when the diff touches no test file', async () => {
    const ctx = policyContext({ files: [{ path: 'src/a.ts', added: ['const a = 1;'] }] });
    expect(await testCountCheck.run(ctx)).toBeNull();
  });

  it('passes when the count is unchanged', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["it('renamed', () => {});"], removed: ["it('old', () => {});"] }],
      head: { 'a.spec.ts': "it('old', () => {});\nit('other', () => {});" },
      working: { 'a.spec.ts': "it('renamed', () => {});\nit('other', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('passes when the count grows', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', added: ["it('extra', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});\nit('extra', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('flags any decrease at the default threshold of zero percent', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', removed: ["it('two', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});" },
    });
    const findings = await testCountCheck.run(ctx);
    expect(findings).toHaveLength(1);
    expect(findings?.[0]?.check).toBe('tests.count_decreased');
    expect(findings?.[0]?.detail).toContain('2');
    expect(findings?.[0]?.detail).toContain('1');
    expect(findings?.[0]?.detail).toContain('50');
  });

  it('allows a decrease inside a configured threshold', async () => {
    const config = configSchema.parse({
      workflow: { ci_provider: 'fake', scm_provider: 'fake' },
      policy: { max_test_count_decrease_percent: 50 },
    });
    const ctx = policyContext({
      config,
      files: [{ path: 'a.spec.ts', removed: ["it('two', () => {});"] }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: { 'a.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('counts a deleted test file as zero afterwards', async () => {
    const ctx = policyContext({
      files: [{ path: 'a.spec.ts', status: 'D' }],
      head: { 'a.spec.ts': "it('one', () => {});\nit('two', () => {});" },
      working: {},
    });
    expect(await testCountCheck.run(ctx)).toHaveLength(1);
  });

  it('reads a renamed test file from its old name at HEAD', async () => {
    const ctx = policyContext({
      files: [{ path: 'b.spec.ts', status: 'R', previousPath: 'a.spec.ts' }],
      head: { 'a.spec.ts': "it('one', () => {});" },
      working: { 'b.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });

  it('does not divide by zero when the diff only adds new test files', async () => {
    const ctx = policyContext({
      files: [{ path: 'fresh.spec.ts', status: 'A', added: ["it('one', () => {});"] }],
      head: {},
      working: { 'fresh.spec.ts': "it('one', () => {});" },
    });
    expect(await testCountCheck.run(ctx)).toEqual([]);
  });
});
