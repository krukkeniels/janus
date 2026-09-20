import { matchesAnyGlob } from '../glob.js';
import { warning } from '../types.js';
import type { PolicyCheck, PolicyFinding } from '../types.js';

/** The lockfiles `isGeneratedPath` already knows about, in the order a manifest's sibling is looked for. */
export const LOCKFILE_NAMES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'npm-shrinkwrap.json'] as const;

const MANIFEST = /(?:^|\/)package\.json$/u;

/**
 * Spec §12, applied at diff time: "the validator warns when `package.json` is in scope but the lockfile is not."
 *
 * `tasks.md` T08 asks for a **warning**, and a warning is what this is: it never blocks a commit and never
 * charges `policy_violations`. Its job is to explain the `scope.outside_allowed` violation that is about to
 * happen — T06 measured an `ng update @angular/core@16 @angular/cli@16 --allow-dirty` that changed exactly two
 * files, `package.json` and the lockfile, so a scope covering the first and not the second manufactures a
 * violation out of the most ordinary operation in the entire goal.
 *
 * T11 owns the same warning at `plan.yaml` validation time, where it is cheaper to act on. This one is the
 * backstop for a plan that was approved anyway.
 */
export const lockfileScopeCheck: PolicyCheck = {
  id: 'lockfile.scope',
  title: 'a changed package.json has its lockfile inside the package allowed_scope',
  run: async (ctx) => {
    const scope = ctx.allowedScope;
    if (scope === null) return null;
    const manifests = ctx.analysis.files.filter((file) => MANIFEST.test(file.path));
    if (manifests.length === 0) return null;
    const patterns = [...scope];
    const findings: PolicyFinding[] = [];
    for (const file of manifests) {
      const dir = file.path.slice(0, Math.max(file.path.lastIndexOf('/'), 0));
      const candidates = LOCKFILE_NAMES.map((name) => (dir === '' ? name : `${dir}/${name}`));
      if (candidates.some((candidate) => matchesAnyGlob(patterns, candidate))) continue;
      findings.push(
        warning(
          'lockfile.scope',
          `${file.path} is inside allowed_scope but none of ${candidates.join(', ')} is; an \`ng update\` writes the ` +
            'lockfile, and the scope check will then report it as out of scope (§12)',
          { path: file.path },
        ),
      );
    }
    return findings;
  },
};
