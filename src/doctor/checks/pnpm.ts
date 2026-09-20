import { skipped } from '../types.js';
import type { DoctorCheck } from '../types.js';
import { lastLine } from './codex.js';

const STORE_PATH_TIMEOUT_MS = 60_000;
const NO_WORKSPACE = 'run janus doctor from inside a janus workspace, or run janus init first';

/**
 * The write remediation, aware of which mode produced `store` so it never suggests switching to the mode that is
 * already active. Both directions have a real cost, named explicitly (the same bar as `branchSpecCheck` in
 * `src/doctor/checks/repo.ts`): `global` shares one deduplicated store across every project on the machine;
 * `workspace` needs no `pnpm` resolution but gives up that dedup and pays its own disk cost per workspace.
 */
function writeRemediation(store: string, mode: 'workspace' | 'global'): string {
  if (mode === 'global') {
    return (
      `fix the permissions or mount on ${store} directly (keeps the one shared, deduplicated pnpm store across ` +
      'every project on this machine) — or set agents.pnpm_store: workspace in .janus/config.yaml so the store ' +
      'moves inside this workspace instead, trading that shared dedup for a separate, workspace-local store and ' +
      'its own disk cost (§18.4)'
    );
  }
  return (
    `fix the permissions or mount on ${store} directly; every code-writing agent gets it as npm_config_store_dir ` +
    'and as a writable root, so nothing else needs to change (§18.4)'
  );
}

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
    const mode = ctx.config.agents.pnpm_store;
    if (mode === 'global') {
      const result = await ctx.run({ bin: 'pnpm', args: ['store', 'path'], cwd: ctx.paths.root, timeoutMs: STORE_PATH_TIMEOUT_MS });
      if (result.spawnFailed || result.exitCode !== 0 || result.stdout.trim() === '') {
        return [
          {
            id: 'pnpm.store',
            title: pnpmStoreCheck.title,
            status: 'fail',
            detail: result.spawnFailed ? 'pnpm is not on PATH' : lastLine(result.stderr) || `pnpm store path exited ${String(result.exitCode)} with no path`,
            remediation:
              'install pnpm and put it on PATH so `pnpm store path` resolves (keeps the one shared, deduplicated ' +
              'store across every project on this machine) — or set agents.pnpm_store: workspace in ' +
              '.janus/config.yaml, which needs no pnpm resolution but gives this workspace its own store, not ' +
              'deduplicated against any other project, at its own disk cost (§18.4)',
          },
        ];
      }
      store = result.stdout.trim();
    } else {
      store = ctx.paths.pnpmStoreDir;
    }

    // `probeWritable` is documented never to throw, but this check does not simply trust that promise: a
    // `DoctorFs` implementation that violates it must still produce a graceful `fail`, not an exception that
    // escapes into `runDoctor`'s generic handler and reports "this is a bug in janus doctor" for what is, in
    // fact, direct evidence of the broken environment this check exists to diagnose.
    let error: string | null;
    try {
      error = ctx.fs.probeWritable(store);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return [
        {
          id: 'pnpm.store',
          title: pnpmStoreCheck.title,
          status: 'fail',
          detail: `${store} could not be probed for writability: ${message}`,
          remediation: writeRemediation(store, mode),
        },
      ];
    }
    if (error !== null) {
      return [
        {
          id: 'pnpm.store',
          title: pnpmStoreCheck.title,
          status: 'fail',
          detail: `${store} is not writable: ${error}`,
          remediation: writeRemediation(store, mode),
        },
      ];
    }
    return [
      {
        id: 'pnpm.store',
        title: pnpmStoreCheck.title,
        status: 'pass',
        detail: `${store} is writable (agents.pnpm_store: ${mode})`,
        remediation: null,
      },
    ];
  },
};
