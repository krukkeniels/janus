import { lockfileScopeCheck } from './checks/lockfile.js';
import { runnerConfigCheck } from './checks/runner-config.js';
import { allowedScopeCheck, diffSizeCheck, forbiddenPathsCheck } from './checks/scope.js';
import { secretsCheck } from './checks/secrets.js';
import { forbiddenTestPatternsCheck, testCountCheck, testFileRemovalCheck } from './checks/tests.js';
import { angularVersionCheck } from './checks/versions.js';
import { POLICY_CHECK_IDS } from './types.js';
import type { PolicyCheck, PolicyCheckId } from './types.js';

/**
 * Spec §14's table, in its order, plus §12's lockfile warning last.
 *
 * Order matters only for how a report reads; every check is independent and none may look at another's findings.
 */
export const ALL_POLICY_CHECKS: readonly PolicyCheck[] = [
  forbiddenTestPatternsCheck,
  testFileRemovalCheck,
  testCountCheck,
  forbiddenPathsCheck,
  runnerConfigCheck,
  angularVersionCheck,
  allowedScopeCheck,
  diffSizeCheck,
  secretsCheck,
  lockfileScopeCheck,
];

type RegisteredCheckId = (typeof ALL_POLICY_CHECKS)[number]['id'];
type AssertNever<T extends never> = T;

/**
 * Compile-time proof that every declared id is registered. Adding an id to `POLICY_CHECK_IDS` without adding its
 * check to `ALL_POLICY_CHECKS` fails here, the same way `UnlistedEventType` guards `EVENT_TYPES`.
 *
 * `PolicyCheck.id` is typed as the whole `PolicyCheckId` union, so this catches the "declared but never
 * registered" direction; the runtime test in `tests/policy/registry.test.ts` catches the reverse — a check
 * registered twice, or one whose id is not in the list.
 */
export type UnregisteredPolicyCheck = AssertNever<Exclude<PolicyCheckId, RegisteredCheckId>>;

export const REGISTERED_CHECK_IDS: readonly PolicyCheckId[] = POLICY_CHECK_IDS;
