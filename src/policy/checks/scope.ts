import type { DiffFile } from '../diff.js';
import { matchesAnyGlob } from '../glob.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/**
 * Every name a file is known by in this diff.
 *
 * A rename carries two: moving `src/a.ts` to `.github/a.ts` is a forbidden-path violation only if the *new* name
 * is judged, and moving `.github/ci.yml` out of the forbidden tree is one only if the *old* name is. Judging one
 * name would leave the other half of that pair as a hole big enough to relocate a CI config through.
 */
export function pathsOf(file: DiffFile): string[] {
  return file.previousPath === null ? [file.path] : [file.previousPath, file.path];
}

/**
 * Spec §14: "forbidden paths — `.teamcity/**`, `.github/**`, other CI paths as configured."
 *
 * Runner configs are deliberately not here: §14 says they "may change", and what is forbidden in them —
 * lowering a coverage threshold, excluding tests — is `runner_config.weakened`'s job.
 */
export const forbiddenPathsCheck: PolicyCheck = {
  id: 'paths.forbidden',
  title: 'no file under a forbidden path was changed',
  run: async (ctx) => {
    const patterns = ctx.config.policy.forbidden_paths;
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const path of pathsOf(file)) {
        if (!matchesAnyGlob(patterns, path)) continue;
        findings.push(
          violation('paths.forbidden', `${path} is under a forbidden path (policy.forbidden_paths: ${patterns.join(', ')})`, {
            path,
          }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14: "scope — files outside `allowed_scope`", where `allowed_scope` comes from the approved `plan.yaml`
 * (§12).
 *
 * Returns null — "did not run" — when no plan slice is in hand, which is the case for any diff produced before
 * Gate 1. §12's measured footprint is why the *plan* is where a too-tight scope must be caught: a scope that
 * lists `package.json` without the lockfile manufactures a violation out of an ordinary `ng update`, and
 * `lockfile.scope` warns about exactly that.
 */
export const allowedScopeCheck: PolicyCheck = {
  id: 'scope.outside_allowed',
  title: 'every changed file is inside the package allowed_scope',
  run: async (ctx) => {
    const scope = ctx.allowedScope;
    if (scope === null) return null;
    const patterns = [...scope];
    const findings: PolicyFinding[] = [];
    for (const file of ctx.analysis.files) {
      for (const path of pathsOf(file)) {
        if (matchesAnyGlob(patterns, path)) continue;
        findings.push(
          violation('scope.outside_allowed', `${path} is outside the package allowed_scope (${patterns.join(', ')})`, { path }),
        );
      }
    }
    return findings;
  },
};

/**
 * Spec §14 "diff size", bounded by §20's `max_changed_files` and `max_diff_lines`. Both are null by default, so
 * this check ordinarily does not run at all.
 */
export const diffSizeCheck: PolicyCheck = {
  id: 'size.limits',
  title: 'the diff is within the configured size caps',
  run: async (ctx) => {
    const { max_changed_files: maxFiles, max_diff_lines: maxLines } = ctx.config.guardrails;
    if (maxFiles === null && maxLines === null) return null;
    const findings: PolicyFinding[] = [];
    const { changedFiles, addedLines, removedLines } = ctx.analysis.totals;
    if (maxFiles !== null && changedFiles > maxFiles) {
      findings.push(
        violation('size.limits', `the diff changes ${changedFiles} files, over guardrails.max_changed_files (${maxFiles})`),
      );
    }
    const lines = addedLines + removedLines;
    if (maxLines !== null && lines > maxLines) {
      findings.push(
        violation('size.limits', `the diff has ${lines} changed lines, over guardrails.max_diff_lines (${maxLines})`),
      );
    }
    return findings;
  },
};
