import { join } from 'node:path';
import { loadConfig } from '../config/load-config.js';
import { loadGoal } from '../config/load-goal.js';
import type { JanusConfig } from '../config/config-schema.js';
import type { Goal } from '../config/goal-schema.js';
import { CONFIG_FILE, GOAL_FILE } from '../state/files.js';
import { workspacePaths } from '../workspace/layout.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { findWorkspaceRoot } from '../workspace/open-workspace.js';
import { codexBinaryCheck, codexLoginCheck, codexModelsCheck } from './checks/codex.js';
import { pnpmStoreCheck } from './checks/pnpm.js';
import { ciReachabilityCheck, scmReachabilityCheck } from './checks/providers.js';
import { branchSpecCheck, gitIdentityCheck, tokensCheck } from './checks/repo.js';
import { codexReadOnlyProbe, codexWorkspaceWriteProbe, ngUpdateProbe, userNamespacesCheck } from './checks/sandbox.js';
import { runCommand } from './exec.js';
import { nodeFs } from './fs.js';
import { fetchProbe } from './http.js';
import type { DoctorCheck, DoctorCheckContext } from './types.js';

/**
 * `tasks.md` T07's list, in the order the report prints them: cheap local observations first, then the sandbox,
 * then the three §18.4 probes and the model probes (the expensive ones), then configuration. An operator reading
 * a red report top to bottom meets the cause before the symptom — a missing login explains a failed probe, and a
 * dead sandbox explains a failed install.
 */
export const ALL_CHECKS: readonly DoctorCheck[] = [
  codexBinaryCheck,
  codexLoginCheck,
  gitIdentityCheck,
  tokensCheck,
  userNamespacesCheck,
  codexReadOnlyProbe,
  codexWorkspaceWriteProbe,
  ngUpdateProbe,
  codexModelsCheck,
  pnpmStoreCheck,
  branchSpecCheck,
  ciReachabilityCheck,
  scmReachabilityCheck,
];

export interface BuildDoctorContextInput {
  cwd: string;
  env: Record<string, string | undefined>;
  now(): Date;
}

/**
 * Builds the real context. Two deliberate choices:
 *
 * 1. **No workspace lock.** Doctor calls `findWorkspaceRoot` + `loadConfig` + `loadGoal` rather than
 *    `openWorkspace`, so it works while a `janus run` holds `janus.lock` and while the workspace is mid-reconcile.
 *    That also means doctor never reads `state.yaml` and never verifies the state branch — `janus status` owns that.
 * 2. **A missing workspace is fine; a broken one is not.** Not being inside a workspace leaves `config`, `goal`
 *    and `paths` null, and the config-dependent checks skip (§35 runs doctor before `janus init`). A workspace
 *    whose `config.yaml` or `goal.yaml` does not parse throws `ConfigError`, which `main` already maps to exit 2
 *    with the offending field named — the same behaviour every other command has.
 */
export function buildDoctorContext(input: BuildDoctorContextInput): DoctorCheckContext {
  let paths: WorkspacePaths | null;
  try {
    paths = workspacePaths(findWorkspaceRoot(input.cwd));
  } catch {
    paths = null;
  }
  let config: JanusConfig | null = null;
  let goal: Goal | null = null;
  if (paths !== null) {
    config = loadConfig(join(paths.janusDir, CONFIG_FILE));
    goal = loadGoal(join(paths.janusDir, GOAL_FILE)).goal;
  }
  return { config, goal, paths, env: input.env, run: runCommand, http: fetchProbe, fs: nodeFs, now: input.now };
}

export type { DoctorCheck, DoctorCheckContext, DoctorFinding, DoctorObservation, DoctorStatus } from './types.js';
export { doctorExitCode, doctorJson, renderDoctorHuman, runDoctor } from './report.js';
export type { DoctorReport } from './report.js';
