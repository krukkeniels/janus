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
 * Extracts all quoted string literals from comment-stripped source.
 *
 * Recognizes both single- and double-quoted strings. Returns a Set of the literal values
 * (without quotes), so patterns can be compared.
 */
function quotedLiterals(source: string): Set<string> {
  const literals = new Set<string>();
  const stripped = stripComments(source);
  // Match both single and double quoted strings, capturing the content
  for (const match of stripped.matchAll(/['"]([^'"]*)['"]/gu)) {
    const literal = match[1];
    if (literal !== undefined) {
      literals.add(literal);
    }
  }
  return literals;
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
    const configs = ctx.analysis.files.filter((file) => isRunnerConfig(file.path));
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
            }),
          );
          continue;
        }
        // Compare pairwise: check up to the shorter length
        const minLen = Math.min(beforeValues.length, afterValues.length);
        for (let i = 0; i < minLen; i++) {
          const before_i = beforeValues[i];
          const after_i = afterValues[i];
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

      // Check for new exclusions
      const headPatterns = headSource === null ? new Set<string>() : quotedLiterals(headSource);
      const workingStripped = workingSource === null ? '' : stripComments(workingSource);

      // Check if the exclusion key itself appears in HEAD
      const exclusionKeyInHead =
        headSource === null ? false : /["']?\b(?:exclude|testPathIgnorePatterns|coveragePathIgnorePatterns)\b["']?\s*:/u.test(headSource);

      for (const line of workingStripped.split('\n')) {
        const match = EXCLUSION_KEY.exec(line);
        if (match === null) continue;

        const keyName = match[1];
        if (keyName === undefined) continue;

        // If the exclusion key doesn't appear in HEAD, this is a new exclusion mechanism → violation
        if (!exclusionKeyInHead) {
          findings.push(
            violation('runner_config.weakened', `${file.path} adds a test exclusion (${keyName})`, {
              path: file.path,
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
