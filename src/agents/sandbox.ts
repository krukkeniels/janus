import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentRole, JanusConfig } from '../config/config-schema.js';
import { REPORTS_DIR } from '../state/files.js';
import type { WorkspacePaths } from '../workspace/layout.js';
import { sandboxClassFor } from './roles.js';

const execFileAsync = promisify(execFile);

/** A run id must stay a single path segment: it is joined straight into `.janus/reports/<run-id>/` (§18.4). */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class SandboxPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPlanError';
  }
}

export interface SandboxPlan {
  /** The `-s` value §18.4 passes to `codex exec`. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** `-c sandbox_workspace_write.network_access=<bool>`; only meaningful for `workspace-write`. */
  network: boolean;
  /**
   * Spec §18.4 as amended by T06 probe R2. Real `codex exec` refuses to start outside a git work tree
   * (`Not inside a trusted directory and --skip-git-repo-check was not specified.`), and §3.3 puts the read-only
   * class's cwd at the workspace root, which `src/workspace/layout.ts` deliberately does not `git init`. Under the
   * `read-only` sandbox the run has an **empty** writable-root list and cannot write anything wherever it starts,
   * so the flag's protective purpose — keep a write-capable agent inside a known repository — does not apply to
   * it. When `agents.allow_unsandboxed` turns this same role's sandbox into `danger-full-access` (below), the
   * flag still adds no capability: the git check only decides whether the process starts, and containment for
   * that configuration comes from the `allow_unsandboxed` gate itself, recorded in every checkpoint and
   * backstopped by the §31 reflog audit — not from the writable-root list. True for the read-only class and for
   * nothing else; the code-writing class starts in a repo and the report-writing class starts inside `.janus/`,
   * which is itself a git checkout.
   */
  skipGitRepoCheck: boolean;
  cwd: string;
  /** Absolute paths passed as `--add-dir`. */
  writableRoots: string[];
  /** Environment additions for the child. Never holds a secret; §32 rule 12. */
  env: Record<string, string>;
}

export interface PlanSandboxInput {
  role: AgentRole;
  runId: string;
  repo: string | null;
  paths: WorkspacePaths;
  config: JanusConfig;
  /** The output of `pnpm store path`, required only when `agents.pnpm_store` is `global`. */
  globalPnpmStore: string | null;
}

/**
 * Spec §3.3's class table plus §18.4's writable roots.
 *
 * With `agents.pnpm_store: workspace` (the default) every code-writing agent gets
 * `npm_config_store_dir=<workspace>/.pnpm-store`, so the store is inside the workspace and one extra writable root
 * suffices. §18.4: "No `.npmrc` is written, because pnpm reads `.npmrc` only from a project root." With `global`,
 * the resolved store path and `~/.cache` become writable roots instead.
 */
export function planSandbox(input: PlanSandboxInput): SandboxPlan {
  if (!RUN_ID_PATTERN.test(input.runId)) {
    throw new SandboxPlanError(
      `run id "${input.runId}" must be a single path segment (letters, digits, "_" and "-" only); it is joined ` +
        'directly into a workspace path',
    );
  }
  const unsandboxed = input.config.agents.allow_unsandboxed;
  const cls = sandboxClassFor(input.role);

  if (cls === 'read-only') {
    // §3.3 gives this class the workspace root as its cwd, and that root is not a git repository. T06 probe R2
    // confirmed that real codex refuses such a run and that `--skip-git-repo-check` is the only one of the four
    // weighed options that works without changing §3.3's table (option b) or nesting a fourth git repository
    // around `.janus/` and every `repos/<name>` (option c); a `projects.<dir>.trust_level` override does not work
    // on 0.146.0. §18.4 was amended to allow the flag for this class alone.
    return {
      sandbox: unsandboxed ? 'danger-full-access' : 'read-only',
      network: false,
      skipGitRepoCheck: true,
      cwd: input.paths.root,
      writableRoots: [],
      env: {},
    };
  }

  if (cls === 'report-writing') {
    // The directory itself is not created here: this planner is pure I/O-free. It is created in `runAgent`
    // (`src/agents/run.ts`), immediately before the runner is invoked, so `--dry-run` and any other caller that
    // only wants a plan never touches the filesystem.
    const dir = join(input.paths.janusDir, REPORTS_DIR, input.runId);
    return {
      sandbox: unsandboxed ? 'danger-full-access' : 'workspace-write',
      network: false,
      skipGitRepoCheck: false,
      cwd: dir,
      writableRoots: unsandboxed ? [] : [dir],
      env: {},
    };
  }

  if (input.repo === null) {
    throw new SandboxPlanError(`code-writing role "${input.role}" needs a repo; none was assigned to run ${input.runId}`);
  }
  const repoDir = input.paths.repoDir(input.repo);
  if (unsandboxed) {
    return { sandbox: 'danger-full-access', network: true, skipGitRepoCheck: false, cwd: repoDir, writableRoots: [], env: {} };
  }
  if (input.config.agents.pnpm_store === 'global') {
    if (input.globalPnpmStore === null) {
      throw new SandboxPlanError(
        'agents.pnpm_store is "global" but the store path was not resolved; run `pnpm store path` and pass it, ' +
          'or set agents.pnpm_store: workspace. `janus doctor` checks that the store is writable.',
      );
    }
    return {
      sandbox: 'workspace-write',
      network: true,
      skipGitRepoCheck: false,
      cwd: repoDir,
      writableRoots: [repoDir, input.globalPnpmStore, join(homedir(), '.cache')],
      env: {},
    };
  }
  return {
    sandbox: 'workspace-write',
    network: true,
    skipGitRepoCheck: false,
    cwd: repoDir,
    writableRoots: [repoDir, input.paths.pnpmStoreDir],
    env: { npm_config_store_dir: input.paths.pnpmStoreDir },
  };
}

/**
 * Spec §18.4: running with `danger-full-access` "is possible only with `agents.allow_unsandboxed: true` and is
 * recorded in every checkpoint". `handover.md` is regenerated at every checkpoint (§7), so the note lands there;
 * `src/render/handover.ts` renders this constant.
 */
export const UNSANDBOXED_NOTE =
  'Agents in this workspace run with `danger-full-access`: `agents.allow_unsandboxed` is true in config.yaml, so ' +
  'the Codex sandbox is off. The reflog audit is the only remaining guard against an agent git write (spec §18.4, §31).';

export function unsandboxedNote(config: JanusConfig): string | null {
  return config.agents.allow_unsandboxed ? UNSANDBOXED_NOTE : null;
}

/** `pnpm store path`, for `agents.pnpm_store: global`. Called by the CLI and by `janus doctor` (T07), never per run. */
export async function resolveGlobalPnpmStore(): Promise<string> {
  const { stdout } = await execFileAsync('pnpm', ['store', 'path'], { env: { ...process.env, LC_ALL: 'C' } });
  const path = stdout.trim();
  if (path === '') throw new SandboxPlanError('`pnpm store path` returned nothing; is pnpm on PATH?');
  return path;
}
