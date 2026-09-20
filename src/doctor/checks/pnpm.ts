import { skipped } from '../types.js';
import type { DoctorCheck } from '../types.js';
import { lastLine } from './codex.js';

const STORE_PATH_TIMEOUT_MS = 60_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * Spec §31 item 33: doctor detects "a read-only pnpm store". §18.4 gives two shapes:
 *
 * - `agents.pnpm_store: workspace` (the default): the store is `<workspace>/.pnpm-store`, handed to every
 *   code-writing agent as `npm_config_store_dir` and added as its second writable root. No `pnpm` process is
 *   needed to know where it is.
 * - `agents.pnpm_store: global`: the store is wherever `pnpm store path` says, and that path plus `~/.cache`
 *   become the writable roots instead. `src/agents/sandbox.ts` already points here for the check.
 *
 * Either way the test is a real write, not a permission-bit read: read-only mounts, full filesystems and some
 * container overlays all report writable bits and then fail the write, which is precisely the case that makes
 * every code-writing agent fail with an install error nobody can explain.
 */
export const pnpmStoreCheck: DoctorCheck = {
  id: 'pnpm.store',
  title: 'the pnpm store is writable',
  run: async (ctx) => {
    if (ctx.config === null || ctx.paths === null) {
      return [
        skipped(
          'pnpm.store',
          pnpmStoreCheck.title,
          'no workspace: the store location comes from config.yaml and the workspace layout',
          NO_WORKSPACE,
        ),
      ];
    }

    let store: string;
    if (ctx.config.agents.pnpm_store === 'global') {
      const result = await ctx.run({ bin: 'pnpm', args: ['store', 'path'], cwd: ctx.paths.root, timeoutMs: STORE_PATH_TIMEOUT_MS });
      if (result.spawnFailed || result.exitCode !== 0 || result.stdout.trim() === '') {
        return [
          {
            id: 'pnpm.store',
            title: pnpmStoreCheck.title,
            status: 'fail',
            detail: result.spawnFailed ? 'pnpm is not on PATH' : lastLine(result.stderr) || `pnpm store path exited ${String(result.exitCode)} with no path`,
            remediation: 'install pnpm and put it on PATH, or set agents.pnpm_store: workspace in .janus/config.yaml so the store lives inside the workspace (§18.4)',
          },
        ];
      }
      store = result.stdout.trim();
    } else {
      store = ctx.paths.pnpmStoreDir;
    }

    const error = ctx.fs.probeWritable(store);
    if (error !== null) {
      return [
        {
          id: 'pnpm.store',
          title: pnpmStoreCheck.title,
          status: 'fail',
          detail: `${store} is not writable: ${error}`,
          remediation: `make it writable, or move it: with agents.pnpm_store: workspace the store is <workspace>/.pnpm-store and every code-writing agent gets it as npm_config_store_dir and as a writable root (§18.4)`,
        },
      ];
    }
    return [
      {
        id: 'pnpm.store',
        title: pnpmStoreCheck.title,
        status: 'pass',
        detail: `${store} is writable (agents.pnpm_store: ${ctx.config.agents.pnpm_store})`,
        remediation: null,
      },
    ];
  },
};
