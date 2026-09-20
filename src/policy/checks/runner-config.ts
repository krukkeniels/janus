import { addedLines, removedLines } from '../diff.js';
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
 * The highest value each coverage key takes across a set of lines.
 *
 * Highest, not first: a jest config carries a `global` block and may carry per-path overrides, and the strictest
 * number is the one a weakening has to get past. Taking the lowest would let "add a lenient per-path override"
 * read as a threshold that did not move.
 */
export function thresholdsIn(lines: readonly string[]): Map<string, number> {
  const thresholds = new Map<string, number>();
  for (const line of lines) {
    for (const match of line.matchAll(THRESHOLD_KEY)) {
      const key = match[1];
      const raw = match[2];
      if (key === undefined || raw === undefined) continue;
      const value = Number(raw);
      const previous = thresholds.get(key);
      if (previous === undefined || value > previous) thresholds.set(key, value);
    }
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
 * Spec §14: "Runner configs (`karma.conf.js`, `jest.config.*`) may change, but lowering coverage thresholds or
 * excluding tests in them is a violation."
 *
 * Returns null when the diff touches no runner config, so the evidence file distinguishes "not applicable" from
 * "checked and clean".
 */
export const runnerConfigCheck: PolicyCheck = {
  id: 'runner_config.weakened',
  title: 'no runner config lowered a coverage threshold or excluded tests',
  run: async (ctx) => {
    const configs = ctx.analysis.files.filter((file) => isRunnerConfig(file.path));
    if (configs.length === 0) return null;
    const findings: PolicyFinding[] = [];
    for (const file of configs) {
      const before = thresholdsIn(removedLines(file).map((line) => line.text));
      const after = thresholdsIn(addedLines(file).map((line) => line.text));
      for (const [key, was] of before) {
        const now = after.get(key);
        if (now === undefined) {
          findings.push(
            violation('runner_config.weakened', `${file.path} removed the ${key} coverage threshold, which was ${was}`, {
              path: file.path,
            }),
          );
          continue;
        }
        if (now < was) {
          findings.push(
            violation('runner_config.weakened', `${file.path} lowered the ${key} coverage threshold from ${was} to ${now}`, {
              path: file.path,
            }),
          );
        }
      }
      for (const line of addedLines(file)) {
        const match = EXCLUSION_KEY.exec(line.text);
        if (match === null) continue;
        findings.push(
          violation('runner_config.weakened', `${file.path}:${line.line} adds a test exclusion (${match[1]})`, {
            path: file.path,
            line: line.line,
            evidence: line.text.trim(),
          }),
        );
      }
    }
    return findings;
  },
};
