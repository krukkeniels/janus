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
 */
const ANGULAR_DEPENDENCY = /"(@angular\/[^"]+)"\s*:\s*"[\^~>=<v\s]*(\d+)\./gu;

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
