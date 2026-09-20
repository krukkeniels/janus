import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processEnv } from '../exec.js';
import { skipped } from '../types.js';
import type { DoctorCheck, DoctorCheckContext, DoctorObservation } from '../types.js';
import { CODEX_BIN, lastLine } from './codex.js';

const MAX_USER_NAMESPACES = '/proc/sys/user/max_user_namespaces';
const UNPRIVILEGED_USERNS_CLONE = '/proc/sys/kernel/unprivileged_userns_clone';

const READ_ONLY_TIMEOUT_MS = 180_000;
const WORKSPACE_WRITE_TIMEOUT_MS = 600_000;
const NG_UPDATE_TIMEOUT_MS = 300_000;
const GIT_TIMEOUT_MS = 30_000;

const UNSANDBOXED_ESCAPE =
  'if this machine genuinely cannot provide user namespaces (many containers cannot), set agents.allow_unsandboxed: true in .janus/config.yaml — it is recorded in every checkpoint and leaves the §31 reflog audit as the only guard (§18.4)';

const SCRATCH_DIR_REMEDIATION = 'ensure the system temp directory is writable, then re-run janus doctor';

/**
 * Spec §18.4: "Bubblewrap requires user namespaces ... If the sandbox cannot start (containers without user
 * namespaces), doctor reports it." Reads the two sysctls that decide it. A missing sysctl is a `skip`, not a
 * `fail`: on a kernel without `/proc` entries, the Codex probes below are the real evidence.
 */
export const userNamespacesCheck: DoctorCheck = {
  id: 'sandbox.user_namespaces',
  title: 'user namespaces are available for the Codex sandbox',
  run: async (ctx) => {
    const max = ctx.fs.readText(MAX_USER_NAMESPACES);
    if (max === null) {
      return [
        skipped(
          'sandbox.user_namespaces',
          userNamespacesCheck.title,
          `${MAX_USER_NAMESPACES} is not readable; this kernel may not expose it`,
          `rely on the codex.probe.* findings below, which start a real sandbox; ${UNSANDBOXED_ESCAPE}`,
        ),
      ];
    }
    const limit = Number.parseInt(max.trim(), 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      return [
        {
          id: 'sandbox.user_namespaces',
          title: userNamespacesCheck.title,
          status: 'fail',
          detail: `${MAX_USER_NAMESPACES} is ${max.trim()}: unprivileged user namespaces are disabled, so bubblewrap cannot start`,
          remediation: `raise it (sysctl -w user.max_user_namespaces=15000, persisted in /etc/sysctl.d/), or ${UNSANDBOXED_ESCAPE}`,
        },
      ];
    }
    const clone = ctx.fs.readText(UNPRIVILEGED_USERNS_CLONE);
    if (clone !== null && clone.trim() === '0') {
      return [
        {
          id: 'sandbox.user_namespaces',
          title: userNamespacesCheck.title,
          status: 'fail',
          detail: `${UNPRIVILEGED_USERNS_CLONE} is 0: unprivileged user namespaces are disabled, so bubblewrap cannot start`,
          remediation: `enable it (sysctl -w kernel.unprivileged_userns_clone=1), or ${UNSANDBOXED_ESCAPE}`,
        },
      ];
    }
    return [
      {
        id: 'sandbox.user_namespaces',
        title: userNamespacesCheck.title,
        status: 'pass',
        detail: `user.max_user_namespaces=${String(limit)}`,
        remediation: null,
      },
    ];
  },
};

/** A `ctx.fs.mkdtemp` failure, turned into one graceful `fail` finding instead of an exception out of `run()`. */
function scratchDirFailure(id: string, title: string, probe: string, error: unknown): DoctorObservation {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id,
    title,
    status: 'fail',
    detail: `could not create a scratch directory for the ${probe} probe: ${message}`,
    remediation: SCRATCH_DIR_REMEDIATION,
  };
}

/**
 * Spec §18.4 probe 1: "a read-only `codex exec` echo". Deliberately passes no `-m`: this probes the sandbox, not
 * the model — `codex.model[...]` owns model acceptance. The scratch directory is **not** a git repository on
 * purpose, so this is the exact §3.3 read-only shape and stays the standing regression test for T06's probe R2
 * ruling.
 */
export const codexReadOnlyProbe: DoctorCheck = {
  id: 'codex.probe.read_only',
  title: 'a read-only codex exec starts and answers',
  run: async (ctx) => {
    let scratch: string;
    try {
      scratch = ctx.fs.mkdtemp(join(tmpdir(), 'janus-doctor-ro-'));
    } catch (error) {
      return [scratchDirFailure(codexReadOnlyProbe.id, codexReadOnlyProbe.title, 'read-only', error)];
    }
    try {
      const result = await ctx.run({
        bin: CODEX_BIN,
        args: ['exec', '-C', scratch, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-'],
        cwd: scratch,
        stdin: 'Reply with the single word pong and nothing else.',
        timeoutMs: READ_ONLY_TIMEOUT_MS,
      });
      if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
        return [
          {
            id: codexReadOnlyProbe.id,
            title: codexReadOnlyProbe.title,
            status: 'pass',
            detail: 'read-only sandbox started and the turn completed',
            remediation: null,
          },
        ];
      }
      return [
        {
          id: codexReadOnlyProbe.id,
          title: codexReadOnlyProbe.title,
          status: 'fail',
          detail: result.timedOut ? `no answer within ${String(READ_ONLY_TIMEOUT_MS / 1000)}s` : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`,
          remediation:
            'check the codex.login and sandbox.user_namespaces findings first; if both pass, the Codex sandbox itself will not start on this machine (§18.4)',
        },
      ];
    } finally {
      try {
        ctx.fs.rmrf(scratch);
      } catch {
        // best-effort cleanup only; deliberately swallowed
      }
    }
  },
};

/**
 * Spec §18.4 probe 2: "a `workspace-write` install in a scratch project". Mirrors the §18.4 default exactly —
 * `npm_config_store_dir=<scratch>/.pnpm-store`, the repo and the store as the two `--add-dir` roots, no `.npmrc`
 * — which is the shape T06 probe S1b validated. A clean exit that left no `node_modules` is a failure: that is
 * what an unwritable store looks like from outside.
 *
 * The scratch tree is built entirely through `ctx.fs` (`mkdtemp`, `mkdirp`, `writeText`) and `ctx.run` (`git`) —
 * never `node:fs` directly — so every step of this probe is exercisable from a unit test with no real I/O.
 */
export const codexWorkspaceWriteProbe: DoctorCheck = {
  id: 'codex.probe.workspace_write',
  title: 'a workspace-write codex exec installs into the workspace pnpm store',
  run: async (ctx) => {
    let scratch: string;
    try {
      scratch = ctx.fs.mkdtemp(join(tmpdir(), 'janus-doctor-ww-'));
    } catch (error) {
      return [scratchDirFailure(codexWorkspaceWriteProbe.id, codexWorkspaceWriteProbe.title, 'workspace-write', error)];
    }
    try {
      const repo = join(scratch, 'repos', 'scratch');
      const store = join(scratch, '.pnpm-store');
      ctx.fs.mkdirp(repo);
      ctx.fs.mkdirp(store);
      ctx.fs.writeText(
        join(repo, 'package.json'),
        `${JSON.stringify({ name: 'janus-doctor-scratch', version: '0.0.0', private: true, dependencies: { 'is-odd': '3.0.1' } }, null, 2)}\n`,
      );
      // A git work tree, because the code-writing class always has one (§3.3) and gets no `--skip-git-repo-check`.
      for (const args of [
        ['init', '-q', '-b', 'main'],
        ['add', 'package.json'],
        ['-c', 'user.name=janus', '-c', 'user.email=janus@localhost', 'commit', '-q', '-m', 'scratch'],
      ]) {
        await ctx.run({ bin: 'git', args: ['-C', repo, ...args], cwd: repo, timeoutMs: GIT_TIMEOUT_MS });
      }

      const result = await ctx.run({
        bin: CODEX_BIN,
        args: [
          'exec',
          '-C',
          repo,
          '-s',
          'workspace-write',
          '-c',
          'sandbox_workspace_write.network_access=true',
          '--add-dir',
          repo,
          '--add-dir',
          store,
          '--ephemeral',
          '-',
        ],
        cwd: repo,
        env: { ...processEnv(), npm_config_store_dir: store },
        stdin: 'Run `pnpm install` in this directory so node_modules exists. Change nothing else. Do not commit.',
        timeoutMs: WORKSPACE_WRITE_TIMEOUT_MS,
      });

      if (result.exitCode !== 0 || result.spawnFailed || result.timedOut) {
        return [
          {
            id: codexWorkspaceWriteProbe.id,
            title: codexWorkspaceWriteProbe.title,
            status: 'fail',
            detail: result.timedOut ? `no answer within ${String(WORKSPACE_WRITE_TIMEOUT_MS / 1000)}s` : lastLine(result.stderr) || `codex exec exited ${String(result.exitCode)}`,
            remediation: 'check codex.probe.read_only and sandbox.user_namespaces first; a workspace-write sandbox needs the same namespaces plus network access (§18.4)',
          },
        ];
      }
      if (!ctx.fs.exists(join(repo, 'node_modules'))) {
        return [
          {
            id: codexWorkspaceWriteProbe.id,
            title: codexWorkspaceWriteProbe.title,
            status: 'fail',
            detail: 'the run finished cleanly but left no node_modules, so nothing was installed',
            remediation: 'see the pnpm.store finding: a store that is not writable, or a network the sandbox cannot reach, produces exactly this',
          },
        ];
      }
      return [
        {
          id: codexWorkspaceWriteProbe.id,
          title: codexWorkspaceWriteProbe.title,
          status: 'pass',
          detail: 'workspace-write sandbox installed through npm_config_store_dir with no .npmrc',
          remediation: null,
        },
      ];
    } finally {
      try {
        ctx.fs.rmrf(scratch);
      } catch {
        // best-effort cleanup only; deliberately swallowed
      }
    }
  },
};

/** The first goal repository whose `package.json` mentions `@angular/cli`, or null. */
export function angularRepo(ctx: DoctorCheckContext): string | null {
  if (ctx.paths === null || ctx.goal === null) return null;
  for (const repo of ctx.goal.repos) {
    const manifest = ctx.fs.readText(join(ctx.paths.repoDir(repo.name), 'package.json'));
    if (manifest !== null && manifest.includes('@angular/cli')) return repo.name;
  }
  return null;
}

/**
 * Spec §18.4 probe 3: "an `ng update --allow-dirty` dry run when Angular is present".
 *
 * Run **directly**, not through Codex. §18.4 names a sandbox for the other two probes and none for this one, and
 * spending a model turn (~15k input tokens and a minute) to learn whether the Angular CLI accepts a flag is not a
 * trade worth making. What this probe actually answers is: the repository is a valid Angular workspace, the CLI
 * runs on the Node that is on PATH, and `--allow-dirty` is accepted. (Interpretation of §18.4, recorded in the
 * plan's Decision 12.)
 */
export const ngUpdateProbe: DoctorCheck = {
  id: 'codex.probe.ng_update',
  title: 'ng update --allow-dirty runs in an Angular repository',
  run: async (ctx) => {
    const name = angularRepo(ctx);
    if (name === null || ctx.paths === null) {
      return [
        skipped(
          ngUpdateProbe.id,
          ngUpdateProbe.title,
          'no repository in this goal has @angular/cli in its package.json, so there is no Angular workspace to probe',
          'nothing to do; this probe applies only once an Angular repository is cloned into the workspace (§18.4)',
        ),
      ];
    }
    const cwd = ctx.paths.repoDir(name);
    const result = await ctx.run({ bin: 'pnpm', args: ['exec', 'ng', 'update', '--allow-dirty', '--dry-run'], cwd, timeoutMs: NG_UPDATE_TIMEOUT_MS });
    if (result.exitCode === 0 && !result.spawnFailed && !result.timedOut) {
      return [{ id: ngUpdateProbe.id, title: ngUpdateProbe.title, status: 'pass', detail: `ng update --allow-dirty --dry-run succeeded in ${name}`, remediation: null }];
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const nodeVersion = /Node\.js version/iu.test(output) || /requires a minimum Node\.js version/iu.test(output);
    return [
      {
        id: ngUpdateProbe.id,
        title: ngUpdateProbe.title,
        status: 'fail',
        detail: result.timedOut ? `ng update did not finish within ${String(NG_UPDATE_TIMEOUT_MS / 1000)}s` : lastLine(output) || `pnpm exec ng update exited ${String(result.exitCode)}`,
        remediation: nodeVersion
          ? `the Angular CLI in ${name} rejects the Node version on PATH; run janus (and its agents) on a Node the repository's Angular major supports`
          : `run \`pnpm exec ng update --allow-dirty --dry-run\` in repos/${name} by hand and fix what it reports; code-writing agents run the same command (§18.4)`,
      },
    ];
  },
};
