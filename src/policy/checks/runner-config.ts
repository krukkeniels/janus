import { stripComments } from '../source.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/**
 * The test-runner configuration files §14 names, plus vitest, which is the same family and is what a modern
 * Angular workspace may use instead of karma. `jest.setup.ts` and `src/karma.ts` are deliberately excluded: they
 * are ordinary source that happens to mention the runner.
 */
const RUNNER_CONFIG = /(?:^|\/)(?:karma\.conf\.[cm]?[jt]s|jest\.config\.(?:[cm]?[jt]s|json)|vitest\.config\.[cm]?[jt]s)$/u;

export function isRunnerConfig(path: string): boolean {
  return RUNNER_CONFIG.test(path);
}

/** The coverage keys whose value is a percentage floor in both karma-coverage and jest. */
const THRESHOLD_KEY = /["']?\b(statements|branches|functions|lines)\b["']?\s*:\s*(\d+(?:\.\d+)?)/gu;

/**
 * Extracts all coverage threshold values from the comment-stripped source, organized by key.
 *
 * Returns a map where each key (statements, branches, functions, lines) maps to an array of all
 * values found for that key, sorted ascending. This preserves the structure needed to detect when
 * a threshold is lowered, even when multiple overrides exist at different levels (e.g., global
 * and per-path in jest).
 */
export function thresholdsIn(source: string): Map<string, number[]> {
  const thresholds = new Map<string, number[]>();
  const stripped = stripComments(source);
  for (const match of stripped.matchAll(THRESHOLD_KEY)) {
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    const value = Number(raw);
    const existing = thresholds.get(key);
    if (existing === undefined) {
      thresholds.set(key, [value]);
    } else {
      existing.push(value);
    }
  }
  // Sort each array ascending so pairwise comparison works correctly
  for (const values of thresholds.values()) {
    values.sort((a, b) => a - b);
  }
  return thresholds;
}

/**
 * Keys whose appearance on an ADDED line means tests stopped running.
 *
 * `testMatch` and `testRegex` are deliberately absent: narrowing them can exclude tests, but changing them is
 * also the ordinary way to adopt a new file-naming convention during an upgrade, and a check that fires on the
 * legitimate case teaches an operator to wave the real one through.
 */
const EXCLUSION_KEY = /["']?\b(exclude|testPathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*:/u;

/**
 * Extracts the quoted string literals that appear on a line carrying one of the exclusion keys, from
 * comment-stripped source.
 *
 * Deliberately narrower than "every quoted literal in the file": a pattern quoted under `include` or
 * `testRegex` is not a pattern the file excludes, and comparing against the whole file's literals (as an
 * earlier version of this check did) makes it invisible to move an existing glob from an inclusion key into an
 * exclusion one — the pattern was already "in HEAD", just under a key that has nothing to do with exclusion.
 */
function exclusionPatternsIn(source: string): Set<string> {
  const patterns = new Set<string>();
  const stripped = stripComments(source);
  for (const line of stripped.split('\n')) {
    if (!EXCLUSION_KEY.test(line)) continue;
    for (const match of line.matchAll(/['"]([^'"]*)['"]/gu)) {
      const literal = match[1];
      if (literal !== undefined) {
        patterns.add(literal);
      }
    }
  }
  return patterns;
}

/**
 * Spec §14: "Runner configs (`karma.conf.js`, `jest.config.*`) may change, but lowering coverage thresholds or
 * excluding tests in them is a violation."
 *
 * Returns null when the diff touches no runner config, so the evidence file distinguishes "not applicable" from
 * "checked and clean".
 *
 * **Limitation:** Exclusion patterns added as bare array elements on lines without the exclusion key itself
 * will not be detected. This class of subtle exclusions belongs to spec §21's AI checkpoint, the same treatment
 * `countTestDeclarations` gives its string-literal gap.
 */
export const runnerConfigCheck: PolicyCheck = {
  id: 'runner_config.weakened',
  title: 'no runner config lowered a coverage threshold or excluded tests',
  run: async (ctx) => {
    // A rename is judged by either name, the same as every sibling check (`scope.ts`'s `pathsOf`,
    // `testFileRemovalCheck` and `testCountCheck` in `tests.ts`): `git mv karma.conf.js karma.conf.js.disabled`
    // has a new path that is no longer a runner config, and filtering on the new path alone would let a config
    // that was quietly disabled by rename skip this check entirely, with no finding and no entry in `checks_run`.
    const configs = ctx.analysis.files.filter(
      (file) => isRunnerConfig(file.path) || (file.previousPath !== null && isRunnerConfig(file.previousPath)),
    );
    if (configs.length === 0) return null;
    const findings: PolicyFinding[] = [];
    for (const file of configs) {
      const headPath = file.previousPath ?? file.path;
      const headSource = file.status === 'A' ? null : await ctx.readHead(headPath);
      const workingSource = file.status === 'D' ? null : await ctx.readWorking(file.path);

      // Check coverage threshold changes
      const before = headSource === null ? new Map<string, number[]>() : thresholdsIn(headSource);
      const after = workingSource === null ? new Map<string, number[]>() : thresholdsIn(workingSource);

      for (const [key, beforeValues] of before) {
        const afterValues = after.get(key);
        if (afterValues === undefined || afterValues.length === 0) {
          // Threshold removed entirely
          const before_0 = beforeValues[0];
          if (before_0 === undefined) continue;
          findings.push(
            violation('runner_config.weakened', `${file.path} removed the ${key} coverage threshold, which was ${before_0}`, {
              path: file.path,
              // line is null here: the threshold was in HEAD, but we cannot reliably report which line in the file it was on
            }),
          );
          continue;
        }

        // Dual alignment: compare both ascending and descending to catch all lowering cases
        const minLen = Math.min(beforeValues.length, afterValues.length);
        let flagged = false;

        // Ascending comparison
        for (let i = 0; i < minLen; i++) {
          const before_i = beforeValues[i];
          const after_i = afterValues[i];
          if (before_i !== undefined && after_i !== undefined && after_i < before_i) {
            findings.push(
              violation('runner_config.weakened', `${file.path} lowered the ${key} coverage threshold from ${before_i} to ${after_i}`, {
                path: file.path,
              }),
            );
            flagged = true;
            break;
          }
        }

        // Descending comparison (only if ascending didn't find a violation)
        if (!flagged) {
          const beforeDesc = [...beforeValues].sort((a, b) => b - a);
          const afterDesc = [...afterValues].sort((a, b) => b - a);
          for (let i = 0; i < minLen; i++) {
            const before_i = beforeDesc[i];
            const after_i = afterDesc[i];
            if (before_i !== undefined && after_i !== undefined && after_i < before_i) {
              findings.push(
                violation('runner_config.weakened', `${file.path} lowered the ${key} coverage threshold from ${before_i} to ${after_i}`, {
                  path: file.path,
                }),
              );
              break;
            }
          }
        }
      }

      // Check for new exclusions
      const headPatterns = headSource === null ? new Set<string>() : exclusionPatternsIn(headSource);
      const workingStripped = workingSource === null ? '' : stripComments(workingSource);

      // Check if the exclusion key itself appears in HEAD
      const exclusionKeyInHead =
        headSource === null ? false : /["']?\b(?:exclude|testPathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*:/u.test(headSource);

      const workingLines = workingStripped.split('\n');
      for (let lineIndex = 0; lineIndex < workingLines.length; lineIndex++) {
        const line = workingLines[lineIndex];
        if (line === undefined) continue;
        const match = EXCLUSION_KEY.exec(line);
        if (match === null) continue;

        const keyName = match[1];
        if (keyName === undefined) continue;

        // Working tree line number (1-based)
        const lineNum = lineIndex + 1;

        // If the exclusion key doesn't appear in HEAD, this is a new exclusion mechanism → violation
        if (!exclusionKeyInHead) {
          findings.push(
            violation('runner_config.weakened', `${file.path} adds a test exclusion (${keyName})`, {
              path: file.path,
              line: lineNum,
              evidence: line.trim(),
            }),
          );
          continue;
        }

        // Extract quoted literals from this line
        const linePatterns = new Set<string>();
        for (const lit of line.matchAll(/['"]([^'"]*)['"]/gu)) {
          const literal = lit[1];
          if (literal !== undefined) {
            linePatterns.add(literal);
          }
        }

        // Check if any pattern is new (not in HEAD)
        for (const pattern of linePatterns) {
          if (!headPatterns.has(pattern)) {
            findings.push(
              violation('runner_config.weakened', `${file.path} adds a test exclusion (${keyName}) with pattern ${pattern}`, {
                path: file.path,
                line: lineNum,
                evidence: line.trim(),
              }),
            );
            break;
          }
        }
      }
    }
    return findings;
  },
};
