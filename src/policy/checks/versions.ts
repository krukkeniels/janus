import { addedLines } from '../diff.js';
import { violation } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

const MANIFEST = /(?:^|\/)package\.json$/u;

/**
 * `"@angular/<name>": "<range>"` with the major extracted from the range.
 *
 * The leading `[\^~>=<v\s]*` swallows a caret, tilde, comparison operator or `v` prefix; the major is whatever
 * digits come next, which is also correct for a prerelease (`17.0.0-next.3` reads as 17). Only the `@angular/`
 * scope is matched: §14 says "any `@angular/*` major above `target_version`", and `@angular-eslint`,
 * `@angular-devkit` and `@angular/cli`'s own peers version independently of the framework.
 *
 * The major is terminated by `(?!\d)` — a non-digit boundary — rather than by requiring a literal `.` after
 * it. npm accepts bare-major and comparator-only ranges (`"18"`, `">=18"`) with no `.` anywhere in the string,
 * and a check whose whole job is catching an over-target major cannot afford to let the two range forms a
 * `package.json` author is most likely to write by hand sail through unmatched.
 */
const ANGULAR_DEPENDENCY = /"(@angular\/[^"]+)"\s*:\s*"[\^~>=<v\s]*(\d+)(?!\d)/gu;

/**
 * Spec §14: "Angular version beyond target — any `@angular/*` major above `target_version`."
 *
 * Added lines of `package.json` files only. The lockfile is not scanned: its `@angular/*` entries are resolved
 * transitive versions, not declared intent, and an upgrade legitimately parks a newer transitive peer there.
 * Returns null when no manifest changed.
 */
export const angularVersionCheck: PolicyCheck = {
  id: 'angular.version_beyond_target',
  title: 'no @angular dependency was raised past the goal target version',
  run: async (ctx) => {
    const manifests = ctx.analysis.files.filter((file) => MANIFEST.test(file.path));
    if (manifests.length === 0) return null;
    const findings: PolicyFinding[] = [];
    for (const file of manifests) {
      for (const line of addedLines(file)) {
        for (const match of line.text.matchAll(ANGULAR_DEPENDENCY)) {
          const name = match[1];
          const major = Number(match[2]);
          if (name === undefined || !Number.isInteger(major) || major <= ctx.targetVersion) continue;
          findings.push(
            violation(
              'angular.version_beyond_target',
              `${file.path}:${line.line} sets ${name} to major ${major}, above the goal target_version ${ctx.targetVersion}`,
              { path: file.path, line: line.line, evidence: line.text.trim() },
            ),
          );
        }
      }
    }
    return findings;
  },
};
