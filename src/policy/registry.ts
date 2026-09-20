import { lockfileScopeCheck } from './checks/lockfile.js';
import { runnerConfigCheck } from './checks/runner-config.js';
import { allowedScopeCheck, diffSizeCheck, forbiddenPathsCheck } from './checks/scope.js';
import { secretsCheck } from './checks/secrets.js';
import { forbiddenTestPatternsCheck, testCountCheck, testFileRemovalCheck } from './checks/tests.js';
import { angularVersionCheck } from './checks/versions.js';
import { POLICY_CHECK_IDS } from './types.js';
import type { PolicyCheck, PolicyCheckId } from './types.js';

/**
 * Spec §14's table, in its order, plus §12's lockfile warning last, keyed by id.
 *
 * This is a `Record<PolicyCheckId, PolicyCheck>`, not an array literal of pre-typed consts, because the latter
 * does not give a working exhaustiveness guard: each check is declared `export const x: PolicyCheck = {...}`,
 * which widens its `id` field from a string literal to the whole `PolicyCheckId` union *at the declaration
 * site*. An array built from such consts therefore has element type `PolicyCheck` regardless of which checks are
 * actually present, so a type derived from "the ids in the array" is always the full union and a missing entry
 * never surfaces as a compile error. A `Record` does not have this problem: TypeScript checks its object literal
 * against the full `Record<PolicyCheckId, PolicyCheck>` index signature, so a missing key is `error TS2741:
 * Property '<id>' is missing in type '{...}' but required in type 'Record<PolicyCheckId, PolicyCheck>'` —
 * verified by temporarily deleting an entry below and confirming `pnpm typecheck` fails with exactly that
 * diagnostic.
 */
export const POLICY_CHECK_REGISTRY: Record<PolicyCheckId, PolicyCheck> = {
  'tests.forbidden_pattern_added': forbiddenTestPatternsCheck,
  'tests.file_removed': testFileRemovalCheck,
  'tests.count_decreased': testCountCheck,
  'paths.forbidden': forbiddenPathsCheck,
  'runner_config.weakened': runnerConfigCheck,
  'angular.version_beyond_target': angularVersionCheck,
  'scope.outside_allowed': allowedScopeCheck,
  'size.limits': diffSizeCheck,
  'secrets.detected': secretsCheck,
  'lockfile.scope': lockfileScopeCheck,
};

/**
 * Every check, in `POLICY_CHECK_IDS` order. `runPolicyChecks` and Tasks 10/11 consume this array, not the
 * `Record` — the `Record` exists only to make the registration itself exhaustiveness-checked.
 *
 * `Record` only guarantees a key is *present*, not that the check filed under it carries that same id (nothing
 * stops `{'secrets.detected': lockfileScopeCheck}` from compiling) — `tests/policy/registry.test.ts` covers that
 * direction at runtime, asserting `POLICY_CHECK_REGISTRY[id].id === id` for every id.
 */
export const ALL_POLICY_CHECKS: readonly PolicyCheck[] = POLICY_CHECK_IDS.map((id) => POLICY_CHECK_REGISTRY[id]);

export const REGISTERED_CHECK_IDS: readonly PolicyCheckId[] = POLICY_CHECK_IDS;
