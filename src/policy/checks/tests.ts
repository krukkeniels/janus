import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyCheckContext, PolicyFinding } from '../types.js';

/**
 * What counts as a test file: the `.spec.` / `.test.` suffix in any JS or TS flavour, or anything under a
 * `__tests__` directory. Deliberately narrow — `src/testing/harness.ts` is test *infrastructure*, not a test, and
 * flagging its deletion would train an operator to override the check.
 */
const TEST_FILE_SUFFIX = /\.(?:spec|test)\.[cm]?[jt]sx?$/u;
const TEST_DIRECTORY = /(?:^|\/)__tests__\//u;

export function isTestFile(path: string): boolean {
  return TEST_FILE_SUFFIX.test(path) || TEST_DIRECTORY.test(path);
}

/**
 * One `it(...)` / `test(...)` declaration, with or without a modifier (`it.each`, `it.skip`).
 *
 * `(?:^|[^\w.$])` keeps `unit(` and `page.it(` out: the first would match a bare substring search, the second is
 * a method call on some object. The `m` flag is what makes the `^` alternative mean "start of a line".
 */
const TEST_DECLARATION = /(?:^|[^\w.$])(?:it|test)\s*(?:\.\s*\w+\s*)?\(/gmu;

export function countTestDeclarations(source: string): number {
  return source.match(TEST_DECLARATION)?.length ?? 0;
}

// No `.not.` alternation on purpose: `expect(x).not.toBe(x)` always *fails*, so it is a broken test rather than
// a vacuous one, and calling it tautological in the finding would send a fix agent looking for the wrong thing.
const EXPECT_PAIR =
  /expect\(\s*([^()]*(?:\([^()]*\)[^()]*)*?)\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\(\s*([^()]*(?:\([^()]*\)[^()]*)*?)\s*\)/u;
const EXPECT_TRUTHY = /expect\(\s*(true|false|1|0|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBeTruthy|toBeFalsy|toBeDefined)\(\s*\)/u;

/**
 * Spec §14's "tautological expectations" row.
 *
 * Two shapes, both of which pass no matter what the code does: comparing an expression to itself
 * (`expect(x).toBe(x)`, `expect(true).toBe(true)`) and asserting a literal's truthiness
 * (`expect(true).toBeTruthy()`). Returns the offending text so the finding can quote it; null when the line is
 * fine. Textual, by design: this runs on diff lines, not on a parsed AST, and §21 leaves the subtler
 * "is this assertion weaker than it was" judgment to the AI checkpoint.
 */
export function isTautologicalExpectation(line: string): string | null {
  const truthy = EXPECT_TRUTHY.exec(line);
  if (truthy !== null) return truthy[0];
  const pair = EXPECT_PAIR.exec(line);
  if (pair === null) return null;
  const [, left, , right] = pair;
  if (left === undefined || right === undefined || left === '') return null;
  return left === right ? pair[0] : null;
}

/**
 * Spec §14: "forbidden test patterns added — `xit(`, `xdescribe(`, `fit(`, `fdescribe(`, `.skip(`, `.only(`,
 * `it.todo(`, tautological expectations".
 *
 * Only **added** lines are examined: removing an `xit(` is a repair, and flagging it would make the check fight
 * the fix it is supposed to produce. Every file is examined, not only test files — a `.only(` left in a
 * `karma.conf.js` narrows the suite just as effectively.
 */
export const forbiddenTestPatternsCheck: PolicyCheck = {
  id: 'tests.forbidden_pattern_added',
  title: 'no skipped, focused or tautological test was added',
  run: async (ctx) => {
    const patterns = ctx.config.policy.forbidden_test_patterns;
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const line of addedLines(file)) {
        for (const pattern of patterns) {
          if (!line.text.includes(pattern)) continue;
          findings.push(
            violation(
              'tests.forbidden_pattern_added',
              `${file.path}:${line.line} adds the forbidden test pattern "${pattern}"`,
              { path: file.path, line: line.line, evidence: line.text.trim() },
            ),
          );
        }
        const tautology = isTautologicalExpectation(line.text);
        if (tautology !== null) {
          findings.push(
            violation(
              'tests.forbidden_pattern_added',
              `${file.path}:${line.line} adds the tautological expectation ${tautology}`,
              { path: file.path, line: line.line, evidence: line.text.trim() },
            ),
          );
        }
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "deleted or renamed test files — violation unless the package allows it."
 *
 * A rename is judged by its **old** name, because that is the test file that stopped existing; the detail names
 * where it went so a reviewer can tell a legitimate move from a quiet disabling (`a.spec.ts` to
 * `a.spec.disabled.ts` renames the file *and* takes it out of the runner's glob).
 */
export const testFileRemovalCheck: PolicyCheck = {
  id: 'tests.file_removed',
  title: 'no test file was deleted or renamed',
  run: async (ctx) => {
    if (ctx.allowTestFileDeletion) return [];
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      if (file.status === 'D' && isTestFile(file.path)) {
        findings.push(violation('tests.file_removed', `the test file ${file.path} was deleted`, { path: file.path }));
        continue;
      }
      if (file.status === 'R' && file.previousPath !== null && isTestFile(file.previousPath)) {
        findings.push(
          violation('tests.file_removed', `the test file ${file.previousPath} was renamed to ${file.path}`, {
            path: file.previousPath,
          }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "net decrease in test count — threshold per repo, default 0 percent"
 * (`policy.max_test_count_decrease_percent`).
 *
 * The denominator is the test count of the **files this diff touches**, read at HEAD through `readHead` and in
 * the working tree through `readWorking`. A diff-local delta could not produce a percentage at all, and a
 * repository-wide count would need to read every test file in the repo on every check. At the default threshold
 * of 0 the two are equivalent — any decrease is a violation — and above it this is deliberately the stricter
 * reading: one test removed from a two-test file is a real regression that a repo-wide denominator rounds away.
 *
 * Returns null when the diff touches no test file, so "nothing to measure" is not recorded as "measured, fine".
 */
export const testCountCheck: PolicyCheck = {
  id: 'tests.count_decreased',
  title: 'the number of tests did not fall beyond the configured threshold',
  run: async (ctx) => {
    const touched = ctx.analysis.files.filter(
      (file) => isTestFile(file.path) || (file.previousPath !== null && isTestFile(file.previousPath)),
    );
    if (touched.length === 0) return null;
    let before = 0;
    let after = 0;
    for (const file of touched) {
      const headPath = file.previousPath ?? file.path;
      const headSource = file.status === 'A' ? null : await ctx.readHead(headPath);
      const workingSource = file.status === 'D' ? null : await ctx.readWorking(file.path);
      before += headSource === null ? 0 : countTestDeclarations(headSource);
      after += workingSource === null ? 0 : countTestDeclarations(workingSource);
    }
    if (before === 0 || after >= before) return [];
    const decreasePercent = ((before - after) / before) * 100;
    const threshold = ctx.config.policy.max_test_count_decrease_percent;
    if (decreasePercent <= threshold) return [];
    return [
      violation(
        'tests.count_decreased',
        `the changed test files declared ${before} tests and now declare ${after}: a ${decreasePercent.toFixed(1)}% ` +
          `decrease, over policy.max_test_count_decrease_percent (${threshold}%)`,
      ),
    ];
  },
};

/** Exported for the registry's exhaustiveness assertion and for tests; not part of the public surface. */
export type { PolicyCheckContext };
